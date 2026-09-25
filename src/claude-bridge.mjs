import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
// Codex Responses API <-> Anthropic Messages API 雙向轉譯。
//
// 存在的理由：部分閘道的 /v1/responses 與 /v1/chat/completions 相容層對
// Claude 模型有缺陷（串流回 400 stream_options、非串流 content 恆為空），
// 但 /v1/messages 原生端點完全正常。因此改由本機轉譯。
//
// 兩側格式皆取自實際擷取的封包，見 capture/ 目錄。

const EFFORT_BUDGET = {
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
  // Codex 的 ultra 帶「自動任務委派」語意，Claude 這側無對應概念。
  // 路由不對外宣告 ultra，但全域 model_reasoning_effort 可能飄進來，
  // 因此仍需對應一個預算，否則會靜默地完全不送 thinking。
  ultra: 49152,
};
const DEFAULT_MAX_TOKENS = 32000;
// 留給實際回答的餘裕：max_tokens 必須大於 thinking budget。
const OUTPUT_HEADROOM = 4096;

// Anthropic 的 output_config.effort 接受的檔位。Codex 的五檔剛好同名，
// 因此支援這個參數的模型可以直接透傳，不必再換算成 token 預算。
const ANTHROPIC_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// ---------------------------------------------------------------- 請求方向

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part?.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

// Codex 會把截圖等圖片以 data URL 放進訊息或工具結果。若整包 JSON.stringify
// 成文字，base64 會以「約 1 個 token 對 1 個字元」的比率計費——一張 867 KB 的
// 截圖就要 82 萬 token，兩張就把 100 萬的上下文撐爆，且完全看不出原因。
// 轉成原生 image 區塊後，同一張圖只要約 (寬 x 高) / 750 個 token。
const DATA_URL_PATTERN = /^data:([^;,]+);base64,([\s\S]*)$/;

function toImageBlock(url) {
  if (typeof url !== "string" || !url) return null;
  const match = DATA_URL_PATTERN.exec(url);
  if (match) {
    return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
  }
  if (/^https?:\/\//.test(url)) return { type: "image", source: { type: "url", url } };
  return null;
}

// 單次請求的圖片數量一旦超過 20 張，Anthropic 會把每張圖的尺寸上限從 8000
// 收緊到 2000 像素。實測（同一張合成 PNG，只改高度與張數）：
//   20 張 / 2048px -> 通過
//   21 張 / 2048px -> exceed max allowed size for many-image requests: 2000 pixels
//   21 張 / 1800px -> 通過
// iPhone 截圖是 942 x 2048，只超出 48 個像素就整輪被打回來。
//
// 路由器是純 Node 行程，沒有影像解碼器可以縮圖（macOS 有 sips，Windows 沒有
// 對應的東西，兩邊行為會不一致），因此改為控制張數。提示快取啟用時，
// 超過 20 張就整批省略最舊的 8 張；接下來 7 張不會再改動歷史前綴，
// 避免每張新截圖都讓整段訊息快取失效。未啟用快取仍只省略超額張數。
// 張數壓到上限以內之後尺寸限制自動回到 8000 像素。
const MAX_IMAGES_PER_REQUEST = 20;
const IMAGE_PRUNE_BATCH = 8;
// 就算只有一張，超過 8000 像素一樣會被拒；整頁長截圖很容易超過。
const MAX_IMAGE_DIMENSION = 8000;
const IMAGE_OMITTED_COUNT = "(圖片已省略：超出單次請求的圖片數量上限)";
const IMAGE_OMITTED_SIZE = "(圖片已省略：尺寸超過單張上限)";

// 只讀檔頭就夠了，不需要解碼整張圖。認不出來的格式回 null，一律當作合規，
// 寧可讓上游去判斷，也不要在這裡誤刪使用者的圖。
function imageDimensions(base64) {
  if (typeof base64 !== "string" || !base64) return null;
  let head;
  try {
    head = Buffer.from(base64.slice(0, 4096), "base64");
  } catch {
    return null;
  }
  if (head.length >= 24 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e) {
    return [head.readUInt32BE(16), head.readUInt32BE(20)];
  }
  if (head.length >= 10 && head[0] === 0xff && head[1] === 0xd8) {
    let i = 2;
    while (i + 9 < head.length) {
      if (head[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = head[i + 1];
      // SOF0..SOF15，扣掉 DHT(c4) / JPG(c8) / DAC(cc) 這幾個不是框架標頭的。
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return [head.readUInt16BE(i + 7), head.readUInt16BE(i + 5)];
      }
      const length = head.readUInt16BE(i + 2);
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }
  if (head.length >= 10 && head.subarray(0, 3).toString("latin1") === "GIF") {
    return [head.readUInt16LE(6), head.readUInt16LE(8)];
  }
  return null;
}

// 圖片可能直接掛在訊息底下，也可能包在 tool_result 的 content 陣列裡，兩種都要
// 找得到。回傳的順序就是對話順序，因此「最舊的」永遠排在前面。
function collectImageSlots(messages) {
  const slots = [];
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, index) => {
      if (block?.type === "image") slots.push({ blocks, index });
      else if (Array.isArray(block?.content)) walk(block.content);
    });
  };
  for (const message of messages) walk(message.content);
  return slots;
}

// Anthropic 不接受最後一個區塊是 thinking 的 assistant 訊息：
//   messages.N: The final block in an assistant message cannot be `thinking`.
// 一輪被中斷、或那一輪只產出推理就換使用者說話時，歷史裡就會留下這種訊息。
// 沒有後續內容的推理留著也沒有意義（簽章要配合同一輪的輸出才有用），直接剝掉。
// 剝完可能整則變空，空訊息同樣會被拒，因此順手移除並把相鄰的同角色訊息合併——
// Anthropic 要求 user 與 assistant 交替出現。
const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);

export function normalizeAssistantMessages(messages) {
  let trimmed = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    while (
      message.content.length > 0 &&
      THINKING_BLOCK_TYPES.has(message.content[message.content.length - 1]?.type)
    ) {
      message.content.pop();
      trimmed += 1;
    }
  }
  const merged = [];
  for (const message of messages) {
    if (!Array.isArray(message.content) || message.content.length === 0) continue;
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content.push(...message.content);
    else merged.push(message);
  }
  messages.splice(0, messages.length, ...merged);
  return trimmed;
}

// Anthropic 要求同一則 user 訊息裡的 tool_result 全部排在最前面，文字與圖片只能
// 接在後面，否則整輪 400（tool_use ids were found without tool_result blocks
// immediately after）。遲到的工具輸出改成文字後，後面可能還接著其他呼叫的結果；
// 工具呼叫與結果之間若夾了 user 內容也會如此。這裡把 tool_result 穩定地往前移，
// 其餘區塊維持原本的相對順序。回傳調整過的訊息數。
export function orderToolResultsFirst(messages) {
  let reordered = 0;
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    const firstOther = message.content.findIndex((block) => block?.type !== "tool_result");
    if (firstOther < 0) continue;
    if (!message.content.slice(firstOther).some((block) => block?.type === "tool_result")) continue;
    const results = message.content.filter((block) => block?.type === "tool_result");
    const others = message.content.filter((block) => block?.type !== "tool_result");
    message.content.splice(0, message.content.length, ...results, ...others);
    reordered += 1;
  }
  return reordered;
}

// 平台內建工具項目的簡短文字描述。只摘要已知欄位並截斷長內容，
// 仍不認得的項目由呼叫端照舊拒絕，不默默刪除。
const HOSTED_TOOL_LABELS = {
  web_search_call: "網頁搜尋",
  file_search_call: "檔案搜尋",
  code_interpreter_call: "程式碼執行",
  image_generation_call: "生圖",
  local_shell_call: "本機命令",
  computer_call: "電腦操作",
  computer_call_output: "電腦操作結果",
  mcp_call: "MCP 工具",
  mcp_list_tools: "MCP 工具清單",
  mcp_approval_request: "MCP 授權請求",
  mcp_approval_response: "MCP 授權回覆",
  tool_search_call: "工具搜尋",
  tool_search_output: "工具搜尋結果",
};

function clipText(value, max = 300) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function hostedToolSummary(item) {
  const label = HOSTED_TOOL_LABELS[item?.type];
  if (!label) return null;
  const action = item.action && typeof item.action === "object" ? item.action : {};
  let detail = "";
  if (item.type === "web_search_call") {
    if (action.type === "search") detail = `：${clipText(action.query ?? action.queries ?? "")}`;
    else if (action.type === "open_page" && action.url) detail = `：開啟 ${clipText(action.url)}`;
    else if (action.url && action.pattern) detail = `：在 ${clipText(action.url)} 中尋找 ${clipText(action.pattern)}`;
  } else if (item.type === "image_generation_call" && typeof item.revised_prompt === "string" && item.revised_prompt) {
    detail = `，提示詞：${clipText(item.revised_prompt)}`;
  } else if (item.type === "local_shell_call" && action.command) {
    detail = `：${clipText(Array.isArray(action.command) ? action.command.join(" ") : action.command)}`;
  } else if (item.type === "mcp_call") {
    detail = `：${clipText(`${item.server_label ?? ""}/${item.name ?? ""}`, 120)}`;
    if (item.output) detail += `，結果：${clipText(item.output, 800)}`;
    if (item.error) detail += `，錯誤：${clipText(item.error)}`;
  } else if (item.type === "code_interpreter_call" && item.code) {
    detail = `：${clipText(item.code, 800)}`;
  } else if (item.type === "file_search_call" && Array.isArray(item.queries)) {
    detail = `：${clipText(item.queries.join("；"))}`;
  }
  return {
    role: /_(?:output|response)$/.test(item.type) ? "user" : "assistant",
    text: `(先前的回合使用了平台內建的${label}${detail})`,
  };
}

// 模型往下走之後才送達的工具輸出，標明它屬於哪一次呼叫，免得被當成使用者的話。
function lateToolOutputNotice(item) {
  const name = typeof item.name === "string" && item.name ? `（${item.name.slice(0, 64)}）` : " ";
  return `(工具呼叫 ${item.call_id}${name}的結果已先回傳；以下是之後才送達的後續輸出)`;
}

function applyImageBudget(messages, { batchCachePruning = false } = {}) {
  const slots = collectImageSlots(messages);
  if (slots.length === 0) return 0;
  let omitted = 0;
  const omit = (slot, text) => {
    slot.blocks[slot.index] = { type: "text", text };
    omitted += 1;
  };
  // 先處理單張就超標的，這種無論總數多少都會被拒。
  const kept = [];
  for (const slot of slots) {
    const image = slot.blocks[slot.index];
    const size = image?.source?.type === "base64" ? imageDimensions(image.source.data) : null;
    if (size && (size[0] > MAX_IMAGE_DIMENSION || size[1] > MAX_IMAGE_DIMENSION)) {
      omit(slot, IMAGE_OMITTED_SIZE);
    } else {
      kept.push(slot);
    }
  }
  // 到門檻時整批省略舊圖，讓後續幾輪的歷史前綴不再變動。頂層
  // cache_control 的滾動斷點便能命中上一輪，不需要新增上游相容性參數。
  const excess = kept.length - MAX_IMAGES_PER_REQUEST;
  if (excess > 0) {
    const count = batchCachePruning
      ? Math.min(kept.length, Math.ceil(excess / IMAGE_PRUNE_BATCH) * IMAGE_PRUNE_BATCH)
      : excess;
    for (let i = 0; i < count; i += 1) omit(kept[i], IMAGE_OMITTED_COUNT);
  }
  return omitted;
}

function bridgeInputError(message) {
  return Object.assign(new Error(message), { name: "BridgeRequestError" });
}

function parseToolArguments(value) {
  let parsed;
  try { parsed = typeof value === "string" ? JSON.parse(value || "{}") : value; }
  catch { throw bridgeInputError("工具參數不是完整 JSON；未產生替代參數，請重新產生該工具呼叫。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw bridgeInputError("工具參數必須是 JSON 物件；未執行該工具呼叫。");
  }
  return parsed;
}

function toAnthropicBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ type: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return [];
    const text = JSON.stringify(content);
    return text ? [{ type: "text", text }] : [];
  }
  const blocks = [];
  for (const part of content) {
    if (part?.type === "resource_link") {
      blocks.push({ type: "text", text: JSON.stringify({ name: part.name, title: part.title, uri: part.uri, description: part.description }) });
      continue;
    }
    if (part?.type === "resource" && typeof part.resource?.text === "string") {
      blocks.push({ type: "text", text: part.resource.text });
      continue;
    }
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      const image = toImageBlock(`data:${part.mimeType};base64,${part.data}`);
      if (!image) throw bridgeInputError("Claude 無法解析這個工具圖片格式，請轉成 PNG、JPEG、GIF 或 WebP。");
      blocks.push(image);
      continue;
    }
    if (part?.type === "input_file") {
      const data = typeof part.file_data === "string" && /^data:application\/pdf;base64,([A-Za-z0-9+/=\r\n]+)$/.exec(part.file_data);
      if (data) blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data[1] } });
      else if (typeof part.file_url === "string" && /^https?:\/\//.test(part.file_url)) {
        blocks.push({ type: "document", source: { type: "url", url: part.file_url } });
      } else throw bridgeInputError("Claude 轉譯不支援這種檔案引用；請用本機檔案工具讀取內容，或提供 PDF data URL／公開文件 URL。");
      continue;
    }
    if (typeof part?.text === "string" && part.text) {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    const image = toImageBlock(part?.image_url ?? part?.url);
    if (image) { blocks.push(image); continue; }
    if (part?.type && !["text", "input_text", "output_text"].includes(part.type)) {
      throw bridgeInputError("Claude 轉譯收到不支援的內容類型；請先用對應工具讀取或轉換附件，再重送文字／圖片。");
    }
  }
  return blocks;
}

// Anthropic 沒有 Responses 的 namespace 工具型別，所以送往上游時要用唯一別名攤平；
// 回到 Codex 時再靠 targets 拆回 { namespace, name }。Codex 的 function_call /
// custom_tool_call 把 namespace 放在獨立欄位，不能把完整別名直接塞進 name。
export function toolAlias(namespace, name) {
  const ns = namespace && namespace !== "functions" ? namespace : null;
  const alias = ns ? `${ns}__${name}` : name;
  // 保留一般工具的既有名稱；有歧義、過長或含非法字元者改用固定長度別名。
  if (typeof name === "string" && !name.includes("__") &&
      typeof alias === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(alias) && !alias.startsWith("cmr_")) return alias;
  return "cmr_" + createHash("sha256").update(JSON.stringify([ns, name])).digest("hex").slice(0, 60);
}

function flattenTools(items, out = [], namespace = null, targets = new Map()) {
  for (const tool of items || []) {
    if (tool?.type === "namespace") {
      const nested = !tool.name || (tool.name === "functions" && !namespace)
        ? namespace
        : (namespace ? `${namespace}__${tool.name}` : tool.name);
      flattenTools(tool.tools, out, nested, targets);
    } else if (tool?.name) {
      const effectiveNamespace = namespace || tool.namespace || null;
      const alias = toolAlias(effectiveNamespace, tool.name);
      const previous = out.findIndex((item) => item.name === alias);
      if (previous >= 0) out.splice(previous, 1);
      out.push(alias === tool.name ? tool : { ...tool, name: alias });
      targets.set(alias, effectiveNamespace && effectiveNamespace !== "functions"
        ? { name: tool.name, namespace: effectiveNamespace }
        : { name: tool.name });
    }
  }
  return { tools: out, targets };
}

// Codex 的 type:"custom" 是自由格式工具（input 為原始字串），
// Anthropic 沒有對應概念，用單一 string 參數的 schema 模擬。
const FREEFORM_KEY = "input";

// Anthropic 的 input_schema 不接受「頂層」的 oneOf / allOf / anyOf
// （錯誤訊息：input_schema does not support oneOf, allOf, or anyOf at the top level）。
// 巢狀在 properties 裡的組合關鍵字是合法的，因此只攤平最外層。
//
// allOf → 合併所有分支（properties 聯集、required 聯集）
// oneOf / anyOf → properties 取聯集，required 取交集（只保留每個分支都必填的）
function flattenTopLevelSchema(schema) {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const combinators = ["allOf", "oneOf", "anyOf"].filter(
    (k) => Array.isArray(schema[k]) && schema[k].length > 0,
  );
  if (combinators.length === 0) {
    // 仍需確保是 object 型別，Anthropic 只接受物件 schema。
    if (schema.type && schema.type !== "object") {
      return { type: "object", properties: { value: schema }, required: ["value"] };
    }
    return { ...schema, type: "object", properties: schema.properties || {} };
  }

  const rest = { ...schema };
  const properties = { ...(schema.properties || {}) };
  let required = Array.isArray(schema.required) ? [...schema.required] : null;

  for (const key of combinators) {
    const branches = schema[key].map((b) => flattenTopLevelSchema(b));
    delete rest[key];
    for (const b of branches) Object.assign(properties, b.properties || {});
    const branchRequired = branches.map((b) =>
      Array.isArray(b.required) ? b.required : [],
    );
    if (key === "allOf") {
      const union = new Set(required || []);
      for (const r of branchRequired) for (const k of r) union.add(k);
      required = [...union];
    } else {
      // 分支互斥，只有每個分支都必填的欄位才能安全地標為必填。
      let inter = branchRequired[0] || [];
      for (const r of branchRequired.slice(1)) inter = inter.filter((k) => r.includes(k));
      required = required ? required.filter((k) => inter.includes(k)) : inter;
    }
  }

  const out = { ...rest, type: "object", properties };
  if (required && required.length) out.required = required;
  else delete out.required;
  return out;
}

const CODE_MODE_DISCOVERY_MARKER = "## On-demand nested tool definitions";
const CODE_MODE_DISCOVERY = `${CODE_MODE_DISCOVERY_MARKER}
Some nested tool definitions below are summaries only. All tools remain registered and callable.
Before first using a summarized tool, read its FULL description from ALL_TOOLS by exact name;
that description includes its parameter schema, usage rules, restrictions and approval requirements.
Follow those rules in full. A summary is NOT sufficient to call the tool.
For discovery, search names first, then descriptions if needed. Show at most 5 candidate names
and short summaries (at most 120 characters each), then retrieve only the selected full definition.
Do not print ALL_TOOLS or all matching full descriptions. Use additional targeted searches if needed.
Example: text(ALL_TOOLS.filter(t => /keyword/i.test(t.name)).slice(0, 5)
  .map(t => ({ name: t.name, summary: t.description.slice(0, 120) })));
Then: text(ALL_TOOLS.find(t => t.name === "exact_tool_name")?.description);
Only after reading it, call the unchanged tools.exact_tool_name with its documented arguments.
`;

// Only change the model-facing copy of Codex's documented Code Mode registry.
// The actual executor and ALL_TOOLS retain full descriptions, schemas and permissions.
// Unknown formats are left intact; headings inside code examples are never boundaries.
export function compactCodeModeDescription(description) {
  const unchanged = { description, toolsDeferred: 0, charsSaved: 0 };
  if (typeof description !== "string" ||
      !description.startsWith("Run JavaScript code to orchestrate/compose tool calls") ||
      !description.includes("All nested tools are available on the global `tools` object") ||
      !description.includes("`ALL_TOOLS`: metadata for the enabled nested tools") ||
      description.includes(CODE_MODE_DISCOVERY_MARKER)) return unchanged;

  const headings = [];
  let fence = null;
  for (const match of description.matchAll(/^.*(?:\n|$)/gm)) {
    const line = match[0].replace(/\r?\n$/, "");
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) { fence = open[1]; continue; }
    const heading = /^### `([a-zA-Z0-9_]+)`$/.exec(line);
    if (heading) headings.push({ name: heading[1], start: match.index, content: match.index + match[0].length });
  }
  if (fence || !headings.length) return unchanged;

  const edits = [];
  for (let i = 0; i < headings.length; i += 1) {
    const { name, start, content } = headings[i];
    // Keep core tools and the complete web/image instructions eagerly visible.
    if (!name.includes("__") || name.startsWith("web__") || name.startsWith("image_gen__")) continue;
    const end = headings[i + 1]?.start ?? description.length;
    const block = description.slice(content, end);
    const declarations = [...block.matchAll(/\nexec tool declaration:\n```ts\n([\s\S]*?)\n```(?=\n|$)/g)];
    if (declarations.length !== 1) continue;
    const declaration = declarations[0];
    if (!declaration[1].startsWith(`declare const tools: { ${name}(`) ||
        !declaration[1].trimEnd().endsWith("};")) continue;
    // Do not consume following namespace headings or instructions after the declaration.
    const stop = content + declaration.index + declaration[0].length;
    const summary = block.slice(0, declaration.index).trim().split(/\r?\n/, 1)[0].trim();
    if (!summary || summary.startsWith("#") || summary.startsWith("```")) continue;
    const short = summary.length > 180 ? summary.slice(0, 177) + "..." : summary;
    const replacement = `### \`${name}\`\nSummary only: ${short}\nRead the full ALL_TOOLS definition before use.`;
    if (stop - start <= replacement.length + 96) continue;
    edits.push({ start, stop, replacement });
  }
  if (!edits.length) return unchanged;
  let result = description;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.stop);
  const insertion = headings[0].start;
  result = result.slice(0, insertion) + CODE_MODE_DISCOVERY + "\n" + result.slice(insertion);
  if (result.length >= description.length) return unchanged;
  return { description: result, toolsDeferred: edits.length, charsSaved: description.length - result.length };
}

function toAnthropicTools(codexTools) {
  const tools = [];
  const freeform = new Set();
  const toolContext = { toolsDeferred: 0, originalChars: 0, forwardedChars: 0, charsSaved: 0 };
  for (const tool of codexTools) {
    if (tool.type === "custom") {
      freeform.add(tool.name);
      let description = tool.description || "";
      if (tool.name === "exec") {
        const compacted = compactCodeModeDescription(description);
        toolContext.toolsDeferred += compacted.toolsDeferred;
        toolContext.originalChars += description.length;
        toolContext.forwardedChars += compacted.description.length;
        toolContext.charsSaved += compacted.charsSaved;
        description = compacted.description;
      }
      tools.push({
        name: tool.name,
        description,
        input_schema: {
          type: "object",
          properties: {
            [FREEFORM_KEY]: {
              type: "string",
              description:
                "The raw payload for this tool, passed through verbatim.",
            },
          },
          required: [FREEFORM_KEY],
        },
      });
    } else if (tool.type === "function") {
      tools.push({
        name: tool.name,
        description: tool.description || "",
        input_schema: flattenTopLevelSchema(tool.parameters),
      });
    }
  }
  return { tools, freeform, toolContext };
}

// Codex 會把舊 reasoning.encrypted_content 的字串長度當成額外的歷史推理 token。
// Claude 的 input_tokens 已包含這些推理；把整段 thinking/signature 放在欄位裡
// 會讓 Codex 重複計數，在實際用量約一半時提早精簡。只交給 Codex 短索引，
// 原文以內容雜湊持久保存，下一輪仍可完整送回 Anthropic。
// 檔案留在安裝目錄，update 原地換程式碼不會移走；不能按 TTL 淘汰，
// 否則舊任務恢復後會找不到簽章。
const reasoningStoreDir = join(dirname(fileURLToPath(import.meta.url)), "reasoning-store");
const REASONING_REF_VERSION = 1;
const reasoningRefPattern = /^[a-f0-9]{64}$/;
let warnedReasoningStore = false;

function parseReasoningPayload(raw) {
  const parsed = JSON.parse(raw);
  if (typeof parsed?.redacted_thinking === "string" && parsed.redacted_thinking) {
    return { type: "redacted_thinking", data: parsed.redacted_thinking };
  }
  if (!parsed || typeof parsed.thinking !== "string" || !parsed.signature) return null;
  return { type: "thinking", thinking: parsed.thinking, signature: parsed.signature };
}

function decodeReasoning(encrypted) {
  if (typeof encrypted !== "string" || !encrypted) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(encrypted, "base64").toString("utf8")); }
  catch { return null; }
  if (parsed?.router_reasoning_ref != null) {
    if (parsed.router_reasoning_ref !== REASONING_REF_VERSION ||
        !reasoningRefPattern.test(parsed.sha256)) {
      throw bridgeInputError("Claude 歷史推理索引格式無效；請還原原任務歷史或提供工作摘要。");
    }
    try {
      const compressed = readFileSync(join(reasoningStoreDir, parsed.sha256 + ".json.gz"));
      const raw = gunzipSync(compressed);
      const digest = createHash("sha256").update(raw).digest("hex");
      if (digest !== parsed.sha256) throw new Error("digest mismatch");
      const block = parseReasoningPayload(raw.toString("utf8"));
      if (!block) throw new Error("invalid reasoning payload");
      return block;
    } catch {
      // 不能靜默丟棄 thinking：工具呼叫的簽章與歷史就不再一致。
      throw bridgeInputError(
        "Claude 歷史推理檔案遺失或損壞；請還原 model-router/reasoning-store，或在新任務中提供工作摘要。",
      );
    }
  }
  try { return parseReasoningPayload(JSON.stringify(parsed)); }
  catch { return null; }
}

export function encodeReasoning(thinking, signature) {
  const raw = Buffer.from(JSON.stringify({ thinking, signature }), "utf8");
  if (typeof thinking !== "string" || !signature) return raw.toString("base64");
  return storeReasoning(raw);
}

// 安全系統遮蔽的推理（redacted_thinking）只有一段不透明的密文，同樣必須原樣送回：
// 工具回合裡少了它，Anthropic 會以「最後一則 assistant 訊息必須以 thinking 開頭」拒收。
export function encodeRedactedReasoning(data) {
  const raw = Buffer.from(JSON.stringify({ redacted_thinking: String(data ?? "") }), "utf8");
  if (typeof data !== "string" || !data) return raw.toString("base64");
  return storeReasoning(raw);
}

function storeReasoning(raw) {
  const digest = createHash("sha256").update(raw).digest("hex");
  try {
    mkdirSync(reasoningStoreDir, { recursive: true, mode: 0o700 });
    try {
      writeFileSync(join(reasoningStoreDir, digest + ".json.gz"), gzipSync(raw),
        { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // 同一段推理重試時可以複用；已有檔案若損壞，這一輪回退原格式。
      const saved = gunzipSync(readFileSync(join(reasoningStoreDir, digest + ".json.gz")));
      if (createHash("sha256").update(saved).digest("hex") !== digest) {
        throw new Error("digest mismatch");
      }
    }
    return Buffer.from(JSON.stringify({
      // 舊版路由至少能識別並剝除這個 reasoning，避免回退後切到官方模型時
      // 把不受信任的索引送給官方；新版會先識別 ref，從檔案還原真正簽章。
      thinking: "", signature: "r",
      router_reasoning_ref: REASONING_REF_VERSION, sha256: digest,
    }), "utf8").toString("base64");
  } catch (error) {
    if (!warnedReasoningStore) {
      warnedReasoningStore = true;
      process.stderr.write(`model-router-reasoning-store-fallback:${error.code || "invalid"}\n`);
    }
    // 磁碟不可寫時至少保住這一輪的簽章與回應；只是早期精簡問題仍可能出現。
    return raw.toString("base64");
  }
}

// --- remote compaction v2 -----------------------------------------------
// Codex 上下文滿了會發一輪壓縮請求：input 末端附一個 {"type":"compaction_trigger"}，
// 並要求輸出「恰好一個」{"type":"compaction"} 項目，否則整輪 Fatal
// （remote compaction v2 expected exactly one compaction output item, got 0 ...）。
// 那個項目在官方是後端合成的，模型本身不會吐，因此轉譯層必須自己補。
//
// encrypted_content 對客戶端是不透明字串，只會被原樣塞回後續請求的 input，
// 所以比照 reasoning 的做法把摘要編碼進去，下一輪再解出來還原成訊息。
const COMPACTION_PROMPT =
  "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.\n\n" +
  "Include:\n" +
  "- Current progress and key decisions made\n" +
  "- Important context, constraints, or user preferences\n" +
  "- What remains to be done (clear next steps)\n" +
  "- Any critical data, examples, or references needed to continue\n\n" +
  "Be concise, structured, and focused on helping the next LLM seamlessly continue the work.\n";

export const COMPACTION_REPLAY_PREFIX =
  "Summary of the earlier conversation, compacted. Continue the task from here.\n\n";

export function encodeCompaction(summary) {
  return Buffer.from(JSON.stringify({ compaction: summary }), "utf8").toString("base64");
}

export function decodeCompaction(encrypted) {
  if (typeof encrypted !== "string" || !encrypted) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encrypted, "base64").toString("utf8"));
    if (parsed && typeof parsed.compaction === "string") return parsed.compaction;
  } catch {}
  return null;
}

// route 可傳字串（僅模型名）或路由物件（含探測到的 maxOutputTokens）。
export function toAnthropicRequest(body, route) {
  const upstreamModel = typeof route === "string" ? route : route?.upstreamModel;
  const modelMaxOutput =
    typeof route === "object" && Number.isFinite(route?.maxOutputTokens) && route.maxOutputTokens > 0
      ? route.maxOutputTokens
      : null;
  const systemParts = typeof body.instructions === "string" && body.instructions ? [body.instructions] : [];
  const messages = [];
  let compaction = false;

  // 同 role 的連續區塊必須合併，否則 Anthropic 會拒絕。
  const push = (role, block) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };

  // Anthropic 規定每個 tool_use 只能有一個 tool_result。記住已產生的區塊，
  // 同一個 call_id 的後續輸出才能併回去，而不是再生出一個重複的結果。
  const toolResults = new Map();
  const placeholderResults = new WeakSet();
  let toolOutputsMerged = 0;
  let lateToolOutputs = 0;

  // body.input 允許是純字串（簡易呼叫），統一成項目陣列。
  const inputItems = typeof body.input === "string"
    ? [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }]
    : (Array.isArray(body.input) ? body.input : []);

  // 同時接受標準 Responses 頂層 tools 與 Codex 的 additional_tools；後出現的同名定義優先。
  const toolDefinitions = [...(Array.isArray(body.tools) ? body.tools : [])];
  for (const item of inputItems) if (item?.type === "additional_tools") toolDefinitions.push(...(item.tools || []));
  const { tools: codexTools, targets: toolTargets } = flattenTools(toolDefinitions);
  const unavailable = [];
  const inspectTools = (tools) => {
    for (const tool of tools) {
      if (tool?.type === "namespace") inspectTools(tool.tools || []);
      else if (!["function", "custom"].includes(tool?.type)) unavailable.push(tool?.type || "unknown");
    }
  };
  inspectTools(toolDefinitions);
  if (unavailable.length) {
    // 平台內建工具沒有可轉送的本機執行器。不可假裝已啟用，也不可改投另一個付費供應商。
    systemParts.push("此 Claude 轉譯路由不提供以下平台內建工具：" +
      [...new Set(unavailable)].map((name) => String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)).join(", ") +
      "。只能呼叫本次實際提供的 function/custom 工具。需要生圖且已安裝 router-imagegen 技能時，可使用該技能；沒有可用工具時請明確說明，勿宣稱已完成。");
  }
  if (body.text?.format && body.text.format.type !== "text") {
    throw bridgeInputError("Claude 轉譯尚未支援此結構化輸出格式，請改用文字或函式工具輸出。");
  }
  for (const item of inputItems) {
    switch (item?.type || (item?.role ? "message" : null)) {
      case "additional_tools": {
        break;
      }

      case "message": {
        if (item.role === "developer" || item.role === "system") {
          // system 只接受純文字。
          const text = textOf(item.content);
          if (text) systemParts.push(text);
          break;
        }
        const blocks = toAnthropicBlocks(item.content);
        if (!blocks.length) break;
        if (item.role === "assistant") {
          // Anthropic 的 assistant 訊息不接受圖片區塊。
          for (const block of blocks) if (block.type === "text") push("assistant", block);
        } else {
          for (const block of blocks) push("user", block);
        }
        break;
      }

      case "reasoning": {
        const block = decodeReasoning(item.encrypted_content);
        if (block) push("assistant", block);
        break;
      }

      case "custom_tool_call":
        if (typeof item.input !== "string") throw bridgeInputError("歷史自由格式工具的 input 必須是字串，無法安全替換成空內容。");
        push("assistant", {
          type: "tool_use",
          id: item.call_id,
          name: toolAlias(item.namespace, item.name),
          input: { [FREEFORM_KEY]: item.input },
        });
        break;

      case "function_call": {
        const input = parseToolArguments(item.arguments ?? "{}");
        push("assistant", {
          type: "tool_use",
          id: item.call_id,
          name: toolAlias(item.namespace, item.name),
          input,
        });
        break;
      }

      // 官方 GPT 回合的本機命令：轉成 tool_use，後面那筆輸出才配得上 tool_result。
      case "local_shell_call": {
        const action = item.action && typeof item.action === "object" && !Array.isArray(item.action) ? item.action : {};
        if (item.call_id) push("assistant", { type: "tool_use", id: item.call_id, name: "local_shell", input: action });
        else push("assistant", { type: "text", text: hostedToolSummary(item).text });
        break;
      }

      case "local_shell_call_output":
      case "custom_tool_call_output":
      case "function_call_output": {
        // local_shell_call_output 以 id 指向那次呼叫的 call_id。
        const output = item.type === "local_shell_call_output" && !item.call_id ? { ...item, call_id: item.id } : item;
        const blocks = toAnthropicBlocks(output.output);
        // 從另一個 Codex 任務轉送進來的訊息會以 function_call_output 表示，
        // 但沒有 call_id；它不是某次工具呼叫的結果，不能產生缺 tool_use_id 的
        // Anthropic tool_result。保留成普通 user 內容，模型才能收到轉送的指示。
        if (!output.call_id) {
          for (const block of blocks) push("user", block);
          break;
        }
        // Code Mode 的 exec 每呼叫一次 notify()，Codex 就替同一個 call_id 追加一筆
        // 輸出（實際案例：最終結果後面接 6 則「CI 仍在建置」）。Responses 接受這種
        // 歷史，Anthropic 卻會整輪 400：each tool_use must have a single result。
        // 之後每一輪都重送同一段歷史，連壓縮請求也一樣，對話等於卡死。
        const earlier = toolResults.get(output.call_id);
        if (earlier) {
          if (!blocks.length) break;
          const last = messages[messages.length - 1];
          if (last?.role === "user" && last.content.includes(earlier)) {
            // 還在同一則 user 訊息裡：依序併入原本的結果。
            if (placeholderResults.has(earlier)) {
              earlier.content = [];
              placeholderResults.delete(earlier);
            }
            earlier.content.push(...blocks);
            toolOutputsMerged += 1;
          } else {
            // 模型已經往下走了（例如背景執行中的 exec 之後才送來通知）。改寫舊的
            // tool_result 會讓那之後的提示快取全部失效，因此照時間順序改成 user 文字。
            push("user", { type: "text", text: lateToolOutputNotice(output) });
            for (const block of blocks) push("user", block);
            lateToolOutputs += 1;
          }
          break;
        }
        const result = {
          type: "tool_result",
          tool_use_id: output.call_id,
          content: blocks.length ? blocks : [{ type: "text", text: "(no output)" }],
        };
        if (!blocks.length) placeholderResults.add(result);
        toolResults.set(output.call_id, result);
        push("user", result);
        break;
      }

      // 官方 GPT 回合留下的平台內建工具項目（網頁搜尋、生圖等）。切到 Claude 繼續同一條
      // 對話時它們都已完成，也沒有可轉送的執行器；轉成簡短文字，否則每一輪都會 422。
      case "web_search_call":
      case "file_search_call":
      case "code_interpreter_call":
      case "image_generation_call":
      case "computer_call":
      case "computer_call_output":
      case "mcp_call":
      case "mcp_list_tools":
      case "mcp_approval_request":
      case "mcp_approval_response":
      case "tool_search_call":
      case "tool_search_output": {
        const summary = hostedToolSummary(item);
        push(summary.role, { type: "text", text: summary.text });
        break;
      }

      // 這一輪是壓縮回合（項目本身不帶內容，純粹是請求控制）。
      case "compaction_trigger":
        compaction = true;
        break;

      // 前一次壓縮的產物，會一直跟著後續每一輪回來；還原成文字才不會遺失上下文。
      case "compaction":
      case "context_compaction": {
        const summary = decodeCompaction(item.encrypted_content);
        if (summary) push("user", { type: "text", text: `${COMPACTION_REPLAY_PREFIX}${summary}` });
        break;
      }

      default:
        if (item?.type) {
          const type = String(item.type).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64);
          throw bridgeInputError(`Claude 轉譯收到不支援的對話項目（${type}），無法安全省略；請改用原模型繼續，或在新任務中提供工作摘要。`);
        }
        break;
    }
  }

  // compaction_trigger 本身沒有文字，模型不會知道要做什麼；補上與 Codex 本機
  // 壓縮同一份提示詞，產出的摘要格式才會跟官方一致。
  if (compaction) push("user", { type: "text", text: COMPACTION_PROMPT });

  const thinkingTrimmed = normalizeAssistantMessages(messages);
  const toolResultsReordered = orderToolResultsFirst(messages);

  // Anthropic 要求首個訊息必須是 user。
  if (!messages.length || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "." }] });
  }

  const imagesOmitted = applyImageBudget(messages, { batchCachePruning: route?.promptCache === true });

  const { tools, freeform, toolContext } = toAnthropicTools(codexTools);

  const effort = body?.reasoning?.effort;
  // 推理強度有兩種控制方式，安裝時探測出哪一種可用：
  //
  //   output_config  新式。Codex 的五檔與 Anthropic 的 effort 同名，直接透傳。
  //                  thinking 交給模型自己決定（現行模型預設就是開著的）。
  //   thinking_budget 舊式。budget_tokens 只在較舊的模型上有效；在 Opus 5 這類
  //                  模型上官方直接 400，部分閘道則是靜默丟掉——結果就是使用者
  //                  在 Codex 裡選 low 或 max 完全沒有差別，且一律跑在高強度。
  const useOutputConfig = route?.effortControl === "output_config";

  let budget = useOutputConfig ? 0 : EFFORT_BUDGET[effort] || 0;
  let maxTokens = Math.max(
    Number(body.max_output_tokens) || DEFAULT_MAX_TOKENS,
    budget + OUTPUT_HEADROOM,
  );
  // 不可超過該模型實際允許的輸出上限，否則上游直接 400。
  if (modelMaxOutput) maxTokens = Math.min(maxTokens, modelMaxOutput);
  // 夾過之後 budget 可能反超 max_tokens，需同步縮小以維持 budget < max_tokens。
  // 這裡不能設下限：閘道回報的輸出上限若小到連 headroom 都放不下，硬撐一個
  // 1024 的 budget 會等於甚至超過 max_tokens，Anthropic 直接回 400。
  // 縮到 1024 以下就讓下面的門檻自己關掉 thinking，換取這一輪仍能正常回答。
  if (budget && budget + OUTPUT_HEADROOM > maxTokens) {
    budget = maxTokens - OUTPUT_HEADROOM;
  }

  const request = {
    model: upstreamModel,
    max_tokens: maxTokens,
    messages,
    stream: true,
  };

  // 滾動快取斷點：Anthropic 的快取前綴是 tools -> system -> messages，只在
  // system 掛斷點的話，會長大的對話歷史每輪都要重算。頂層 cache_control 會把
  // 斷點自動推到最新一輪，後續請求整段歷史都能命中快取。
  // 必須是明確探測過的 true：升級前裝的路由沒有這個欄位，若預設開啟，遇到不吃
  // 頂層 cache_control 的閘道會讓每一條 Claude 請求都 400。
  if (route?.promptCache === true) request.cache_control = { type: "ephemeral" };

  if (systemParts.length) {
    // 最後一段掛 cache_control，讓穩定的前綴可被快取。
    const blocks = systemParts.map((text) => ({ type: "text", text }));
    blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
    request.system = blocks;
  }
  // 壓縮回合只能回一個 compaction 項目，模型不能改去呼叫工具；tool_choice:"none" 亦然。
  // 但 tools 不能拿掉：歷史裡有 tool_use／tool_result 時，Anthropic 要求請求必須定義
  // tools，否則整輪 400（Requests which include tool_use or tool_result blocks must
  // define tools）；拿掉 tools 也會讓 tools → system 這段快取前綴失效。
  // 改用 tool_choice:{type:"none"} 禁止呼叫，tools 與一般回合完全相同。
  if (tools.length) {
    request.tools = tools;
    if (compaction || body.tool_choice === "none") request.tool_choice = { type: "none" };
    else if (body.tool_choice === "auto" || !body.tool_choice) request.tool_choice = { type: "auto" };
    else if (body.tool_choice === "required") request.tool_choice = { type: "any" };
    else if (typeof body.tool_choice === "object" && ["function", "custom"].includes(body.tool_choice?.type)) {
      const name = toolAlias(body.tool_choice.namespace, body.tool_choice.name);
      if (!tools.some((tool) => tool.name === name)) throw bridgeInputError("指定的工具不在這次可用工具清單內。");
      request.tool_choice = { type: "tool", name };
    } else throw bridgeInputError("Claude 轉譯不支援這個 tool_choice，請選用本次提供的函式工具。");
    if (body.parallel_tool_calls === false && request.tool_choice.type !== "none") {
      request.tool_choice.disable_parallel_tool_use = true;
    }
  } else {
    // 這一輪沒有提供任何工具，歷史裡卻有工具呼叫：補上只供對應歷史的佔位定義，
    // 並禁止呼叫，否則同樣會被 Anthropic 以「必須定義 tools」拒收。
    const historical = [...new Set(messages.flatMap((message) => message.content)
      .filter((block) => block?.type === "tool_use" && typeof block.name === "string")
      .map((block) => block.name))];
    if (historical.length) {
      request.tools = historical.map((name) => ({
        name,
        description: "此工具在本輪不可用，只用來對應歷史中的工具呼叫。",
        input_schema: { type: "object", properties: {} },
      }));
      request.tool_choice = { type: "none" };
    }
  }
  if (!tools.length && body.tool_choice && !["auto", "none"].includes(body.tool_choice)) {
    throw bridgeInputError("指定的工具在 Claude 轉譯路由中不可用。");
  }
  if (useOutputConfig) {
    // Codex 的 ultra 帶「自動任務委派」語意，Anthropic 沒有對應檔位，對到 max。
    const mapped = effort === "ultra" ? "max" : effort;
    if (ANTHROPIC_EFFORTS.has(mapped)) request.output_config = { effort: mapped };
    // 這些模型預設 display 是 omitted：thinking 區塊照樣送來，但文字是空的。
    // 要在 Codex 裡看到推理摘要就得明確要 summarized。
    if (route?.reasoningSummary === true) {
      request.thinking = { type: "adaptive", display: "summarized" };
    }
  } else if (budget >= 1024) {
    request.thinking = { type: "enabled", budget_tokens: budget };
  }

  return {
    request, freeform, toolTargets, compaction, imagesOmitted, thinkingTrimmed, toolContext,
    toolOutputsMerged, lateToolOutputs, toolResultsReordered,
  };
}

// ---------------------------------------------------------------- 回應方向

// Codex 只看 response.failed 的 error.code 決定怎麼處理：
//   context_length_exceeded       上下文已滿，不重試
//   insufficient_quota 等         額度用盡，不重試
//   server_is_overloaded          伺服器過載，重試
//   rate_limit_exceeded           限流，依訊息裡的「try again in Ns」等待後重試
// 其餘 code 一律當一般串流錯誤。上游若只給 HTTP 狀態碼或 Anthropic 的錯誤型別
// （overloaded_error、rate_limit_error），不換成上面這些 code 的話，上下文爆掉
// 也會被白白重試，限流也不會照上游要求的時間等待。
const CODEX_ERROR_CODES = new Set([
  "context_length_exceeded", "insufficient_quota", "credit_balance_exhausted",
  "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "usage_not_included",
  "invalid_prompt", "server_is_overloaded", "rate_limit_exceeded", "slow_down",
]);
const CONTEXT_OVERFLOW_PATTERN =
  /prompt is too long|maximum context length|context (?:window|length)|input is too long|exceeds? the context/i;

// 輸入可以是 Anthropic 的 {type, message}、OpenAI 的 {type, code, message}，
// 或只有 HTTP 狀態碼；回傳 Codex 認得的 { code, message }。
export function codexErrorFromUpstream(error = {}, { status = null, retryAfterSeconds = null } = {}) {
  const source = error && typeof error === "object" ? error : { message: error };
  const message = typeof source.message === "string" && source.message
    ? source.message
    : (status ? `上游返回 HTTP ${status}` : "上游錯誤");
  const kinds = [source.code, source.type]
    .filter((value) => typeof value === "string" && value)
    .map((value) => value.toLowerCase());
  let code = kinds.find((kind) => CODEX_ERROR_CODES.has(kind)) || null;
  if (!code) {
    if (kinds.some((kind) => /context_length|context_window/.test(kind)) || CONTEXT_OVERFLOW_PATTERN.test(message)) {
      code = "context_length_exceeded";
    } else if (kinds.some((kind) => /insufficient_(?:user_)?quota|billing|credit_balance/.test(kind)) || status === 402) {
      code = "insufficient_quota";
    } else if (kinds.includes("overloaded_error") || status === 529) {
      code = "server_is_overloaded";
    } else if (kinds.includes("rate_limit_error") || status === 429) {
      code = "rate_limit_exceeded";
    }
  }
  let text = message;
  if (code === "rate_limit_exceeded" && retryAfterSeconds > 0 && !/try again in/i.test(text)) {
    text += ` Please try again in ${retryAfterSeconds}s.`;
  }
  return {
    code: code || kinds[0] || (status ? String(status) : "upstream_error"),
    message: text,
  };
}

function randomId(prefix, length) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = prefix;
  while (out.length < length) out += chars[Math.floor(Math.random() * chars.length)];
  return out.slice(0, length);
}

function mapUsage(anthropicUsage) {
  const u = anthropicUsage || {};
  const input = Number(u.input_tokens) || 0;
  const cached = Number(u.cache_read_input_tokens) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  return {
    input_tokens: input + cached + cacheWrite,
    input_tokens_details: { cached_tokens: cached, cache_write_tokens: cacheWrite },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: Number(u.output_tokens_details?.thinking_tokens) || 0,
    },
    total_tokens: input + cached + cacheWrite + output,
  };
}

/**
 * 讀取 Anthropic 的 SSE 串流，逐一產生 Codex Responses 事件。
 * @param {AsyncIterable<Uint8Array>} upstreamBody
 * @param {(event: object) => void} emit
 * @param {{model: string, requestBody: object, freeform: Set<string>, toolTargets?: Map<string, {name: string, namespace?: string}>, compaction?: boolean}} ctx
 */
export async function bridgeAnthropicStream(upstreamBody, emit, ctx) {
  const responseId = randomId("resp_", 55);
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  let outputIndex = 0;
  let usage = null;
  let stopReason = null;
  const output = [];

  const base = () => ({
    id: responseId,
    object: "response",
    created_at: createdAt,
    status: "in_progress",
    background: false,
    completed_at: null,
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model: ctx.model,
    output: [],
    parallel_tool_calls: false,
    previous_response_id: null,
    prompt_cache_key: ctx.requestBody?.prompt_cache_key ?? null,
    reasoning: ctx.requestBody?.reasoning ?? null,
    store: false,
    temperature: 1.0,
    text: ctx.requestBody?.text ?? { format: { type: "text" }, verbosity: "low" },
    tool_choice: ctx.requestBody?.tool_choice ?? "auto",
    tools: [],
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {},
  });

  // 壓縮回合：模型吐的 reasoning / message / tool_use 一律不外送，
  // 全部收攏成一個 compaction 項目，於 message_stop 一次補上。
  const compactionMode = Boolean(ctx.compaction);
  let compactionText = "";
  let suppress = compactionMode;
  const passthroughWhileSuppressed = new Set([
    "response.created",
    "response.in_progress",
    "error",
  ]);

  const send = (event) => {
    if (suppress && !passthroughWhileSuppressed.has(event.type)) return;
    emit({ ...event, sequence_number: seq++ });
  };

  send({ type: "response.created", response: base() });
  send({ type: "response.in_progress", response: base() });

  // 目前正在組裝的 content block
  let cur = null;
  let failed = false;

  const decoder = new TextDecoder();
  let pending = "";

  const handle = (event) => {
    if (failed) return;
    switch (event.type) {
      case "content_block_start": {
        const block = event.content_block || {};
        if (block.type === "thinking") {
          cur = { kind: "thinking", itemId: randomId("rs_", 53), thinking: "", signature: "", index: outputIndex };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { id: cur.itemId, type: "reasoning", content: [], encrypted_content: "", summary: [] },
          });
        } else if (block.type === "redacted_thinking") {
          cur = { kind: "redacted", itemId: randomId("rs_", 53), data: typeof block.data === "string" ? block.data : "", index: outputIndex };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { id: cur.itemId, type: "reasoning", content: [], encrypted_content: "", summary: [] },
          });
        } else if (block.type === "text") {
          cur = { kind: "text", itemId: randomId("msg_", 54), text: block.text || "", index: outputIndex };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { id: cur.itemId, type: "message", status: "in_progress", content: [], phase: "commentary", role: "assistant" },
          });
          send({
            type: "response.content_part.added",
            content_index: 0,
            item_id: cur.itemId,
            output_index: outputIndex,
            part: { type: "output_text", annotations: [], logprobs: [], text: "" },
          });
        } else if (block.type === "tool_use") {
          const isFreeform = ctx.freeform.has(block.name);
          const target = ctx.toolTargets?.get(block.name);
          cur = {
            kind: isFreeform ? "custom_tool" : "function_tool",
            itemId: randomId("fc_", 54),
            callId: block.id,
            name: target?.name || block.name,
            namespace: target?.namespace || null,
            json: "",
            initialInput: block.input ?? {},
            index: outputIndex,
          };
          const identity = cur.namespace
            ? { name: cur.name, namespace: cur.namespace }
            : { name: cur.name };
          send({
            type: "response.output_item.added",
            output_index: outputIndex,
            item: isFreeform
              ? { id: cur.itemId, type: "custom_tool_call", status: "in_progress", call_id: cur.callId, input: "", ...identity }
              : { id: cur.itemId, type: "function_call", status: "in_progress", call_id: cur.callId, arguments: "", ...identity },
          });
        }
        break;
      }

      case "content_block_delta": {
        if (!cur) break;
        const d = event.delta || {};
        if (d.type === "thinking_delta" && cur.kind === "thinking") {
          cur.thinking += d.thinking || "";
          // display=summarized 時 thinking 才有文字。Codex 顯示的是 reasoning 的
          // summary，不是 encrypted_content，所以要另外把摘要串出去。
          if (d.thinking) {
            if (!cur.summaryStarted) {
              cur.summaryStarted = true;
              send({
                type: "response.reasoning_summary_part.added",
                item_id: cur.itemId,
                output_index: cur.index,
                summary_index: 0,
                part: { type: "summary_text", text: "" },
              });
            }
            send({
              type: "response.reasoning_summary_text.delta",
              item_id: cur.itemId,
              output_index: cur.index,
              summary_index: 0,
              delta: d.thinking,
            });
          }
        } else if (d.type === "signature_delta" && cur.kind === "thinking") {
          cur.signature += d.signature || "";
        } else if (d.type === "text_delta" && cur.kind === "text") {
          cur.text += d.text || "";
          send({
            type: "response.output_text.delta",
            content_index: 0,
            item_id: cur.itemId,
            output_index: cur.index,
            delta: d.text || "",
          });
        } else if (d.type === "input_json_delta") {
          // 自由格式工具的參數包在 JSON 字串裡，無法逐段安全解碼，
          // 因此先累積，於 content_block_stop 一次送出。
          cur.json += d.partial_json || "";
        }
        break;
      }

      case "content_block_stop": {
        if (!cur) break;
        if (cur.kind === "redacted") {
          const item = {
            id: cur.itemId,
            type: "reasoning",
            content: [],
            encrypted_content: encodeRedactedReasoning(cur.data),
            summary: [],
          };
          output.push(item);
          send({ type: "response.output_item.done", output_index: cur.index, item });
        } else if (cur.kind === "thinking") {
          if (cur.summaryStarted) {
            send({
              type: "response.reasoning_summary_text.done",
              item_id: cur.itemId,
              output_index: cur.index,
              summary_index: 0,
              text: cur.thinking,
            });
            send({
              type: "response.reasoning_summary_part.done",
              item_id: cur.itemId,
              output_index: cur.index,
              summary_index: 0,
              part: { type: "summary_text", text: cur.thinking },
            });
          }
          const item = {
            id: cur.itemId,
            type: "reasoning",
            content: [],
            encrypted_content: encodeReasoning(cur.thinking, cur.signature),
            // 摘要放進 summary 才會被顯示；encrypted_content 只負責往返。
            summary: cur.summaryStarted
              ? [{ type: "summary_text", text: cur.thinking }]
              : [],
          };
          output.push(item);
          send({ type: "response.output_item.done", output_index: cur.index, item });
        } else if (cur.kind === "text") {
          if (compactionMode) compactionText += cur.text;
          send({
            type: "response.output_text.done",
            content_index: 0,
            item_id: cur.itemId,
            logprobs: [],
            output_index: cur.index,
            text: cur.text,
          });
          send({
            type: "response.content_part.done",
            content_index: 0,
            item_id: cur.itemId,
            output_index: cur.index,
            part: { type: "output_text", annotations: [], logprobs: [], text: cur.text },
          });
          const item = {
            id: cur.itemId,
            type: "message",
            status: "completed",
            content: [{ type: "output_text", annotations: [], logprobs: [], text: cur.text }],
            phase: "commentary",
            role: "assistant",
          };
          output.push(item);
          send({ type: "response.output_item.done", output_index: cur.index, item });
        } else if (cur.kind === "custom_tool" || cur.kind === "function_tool") {
          let parsed;
          try {
            parsed = parseToolArguments(cur.json || cur.initialInput);
            if (cur.kind === "custom_tool" && typeof parsed[FREEFORM_KEY] !== "string") throw bridgeInputError("自由格式工具缺少字串 input。");
          } catch {
            failed = true;
            suppress = false;
            const response = base();
            response.status = "failed";
            response.error = { code: "invalid_tool_arguments", message: "上游工具參數不完整或格式錯誤；未產生替代參數，請重新產生該工具呼叫。" };
            send({ type: "response.failed", response });
            break;
          }
          if (cur.kind === "custom_tool") {
            const input = typeof parsed[FREEFORM_KEY] === "string" ? parsed[FREEFORM_KEY] : (cur.json || "");
            send({ type: "response.custom_tool_call_input.delta", delta: input, item_id: cur.itemId, output_index: cur.index });
            send({ type: "response.custom_tool_call_input.done", input, item_id: cur.itemId, output_index: cur.index });
            const item = {
              id: cur.itemId,
              type: "custom_tool_call",
              status: "completed",
              call_id: cur.callId,
              input,
              name: cur.name,
              ...(cur.namespace ? { namespace: cur.namespace } : {}),
            };
            output.push(item);
            send({ type: "response.output_item.done", output_index: cur.index, item });
          } else {
            const args = JSON.stringify(parsed);
            send({ type: "response.function_call_arguments.delta", delta: args, item_id: cur.itemId, output_index: cur.index });
            send({ type: "response.function_call_arguments.done", arguments: args, item_id: cur.itemId, output_index: cur.index });
            const item = {
              id: cur.itemId,
              type: "function_call",
              status: "completed",
              call_id: cur.callId,
              arguments: args,
              name: cur.name,
              ...(cur.namespace ? { namespace: cur.namespace } : {}),
            };
            output.push(item);
            send({ type: "response.output_item.done", output_index: cur.index, item });
          }
        }
        outputIndex += 1;
        cur = null;
        break;
      }

      case "message_start":
        usage = event.message?.usage || null;
        break;

      case "message_delta":
        stopReason = event.delta?.stop_reason ?? stopReason;
        if (event.usage) usage = { ...(usage || {}), ...event.usage };
        break;

      case "message_stop": {
        if (compactionMode) {
          suppress = false;
          // 摘要為空也必須送出項目，否則客戶端直接 Fatal。
          const summary = compactionText.trim() || "(compaction produced no summary)";
          const item = {
            id: randomId("cmp_", 54),
            type: "compaction",
            encrypted_content: encodeCompaction(summary),
          };
          send({
            type: "response.output_item.added",
            output_index: 0,
            item: { id: item.id, type: "compaction", encrypted_content: "" },
          });
          send({ type: "response.output_item.done", output_index: 0, item });
          output.length = 0;
          output.push(item);
        }
        const response = base();
        response.status = "completed";
        response.completed_at = Math.floor(Date.now() / 1000);
        response.output = output;
        response.usage = mapUsage(usage);
        if (stopReason === "max_tokens") {
          response.status = "incomplete";
          response.incomplete_details = { reason: "max_output_tokens" };
        }
        send({ type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response });
        break;
      }

      // Anthropic 在串流中途出錯（最常見的是 overloaded_error）時送這個事件，然後結束串流。
      // 只轉成頂層 error 的話 Codex 會忽略它：WebSocket 上要空等閒置逾時才重試。
      case "error": {
        failed = true;
        suppress = false;
        const response = base();
        response.status = "failed";
        response.error = codexErrorFromUpstream(event.error || {});
        send({ type: "response.failed", response });
        break;
      }

      default:
        break; // ping 等忽略
    }
  };

  for await (const chunk of upstreamBody) {
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match) break;
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      const line = /^data:\s*(.*)$/m.exec(block);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line[1]); } catch { continue; }
      handle(event);
    }
  }
}
