// Codex Responses API <-> OpenAI Chat Completions 雙向轉譯。
//
// 存在的理由：DeepSeek、通義千問、GLM、Kimi、Gemini 的相容介面、Ollama、vLLM 這類
// 供應商只提供 /chat/completions，沒有 /responses。Codex 只會說 Responses，這些模型
// 以前在探測時一律被跳過。
//
// 結構比照 claude-bridge.mjs：請求方向把 Responses 的 input 項目轉成 messages，
// 回應方向讀 Chat Completions 的 SSE，逐一產生 Codex 認得的 Responses 事件。
// 兩邊共用的規則——工具名稱攤平、平台內建工具的文字摘要、壓縮回合、錯誤碼——
// 直接用 claude-bridge.mjs 的同一份實作。

import {
  COMPACTION_PROMPT,
  COMPACTION_REPLAY_PREFIX,
  bridgeInputError,
  codexErrorFromUpstream,
  compactCodeModeDescription,
  decodeCompaction,
  encodeCompaction,
  flattenTools,
  flattenTopLevelSchema,
  hostedToolSummary,
  lateToolOutputNotice,
  parseToolArguments,
  randomId,
  textOf,
  toolAlias,
} from "./claude-bridge.mjs";

// 自由格式工具（type:"custom"）在 Chat Completions 沒有對應概念，
// 比照 Claude 轉譯用單一字串參數模擬。
const FREEFORM_KEY = "input";

// Codex 的推理強度對到 Chat Completions 的 reasoning_effort。OpenAI 定義的檔位只到
// high，更高的一律對到 high。
const CHAT_EFFORTS = {
  minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high", ultra: "high",
};

const NO_OUTPUT = "(no output)";

// ---------------------------------------------------------------- 推理
//
// Chat Completions 的推理是明文（delta.reasoning_content 或 delta.reasoning）。
// 轉成 Responses 的 reasoning 項目時，完整文字放進 summary——Codex 顯示的就是它；
// encrypted_content 只放一個固定標記，讓路由器認得這是本轉譯層的產物：
// 送往官方與其他路由前要剝掉，否則對方驗不過而整輪拒收。
//
// 推理只在同一輪的工具往返裡送回（最後一則使用者訊息之後）。DeepSeek、Kimi 這類
// 模型在工具往返中需要看到自己先前的推理；更早幾輪的推理它們會忽略，送了只是浪費。
export const CHAT_REASONING_MARKER = Buffer.from(
  JSON.stringify({ router_chat_reasoning: 1 }), "utf8",
).toString("base64");

export function isChatReasoning(item) {
  return item?.type === "reasoning" && item.encrypted_content === CHAT_REASONING_MARKER;
}

function reasoningText(item) {
  const parts = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ];
  return parts.map((part) => (typeof part?.text === "string" ? part.text : "")).filter(Boolean).join("\n");
}

// ---------------------------------------------------------------- 請求方向

const IMAGE_URL_PATTERN = /^(?:data:image\/[A-Za-z0-9.+-]+;base64,|https?:\/\/)/;

// Responses 的內容陣列轉成 Chat Completions 的 content parts。
function toChatParts(content) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    if (content === null || content === undefined) return [];
    const text = JSON.stringify(content);
    return text ? [{ type: "text", text }] : [];
  }
  const parts = [];
  for (const part of content) {
    if (part?.type === "resource_link") {
      parts.push({ type: "text", text: JSON.stringify({ name: part.name, title: part.title, uri: part.uri, description: part.description }) });
      continue;
    }
    if (part?.type === "resource" && typeof part.resource?.text === "string") {
      parts.push({ type: "text", text: part.resource.text });
      continue;
    }
    if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
      parts.push({ type: "image_url", image_url: { url: `data:${part.mimeType};base64,${part.data}` } });
      continue;
    }
    if (part?.type === "input_file") {
      throw bridgeInputError("Chat Completions 轉譯不支援檔案附件；請用本機檔案工具讀取內容，或改用支援檔案的模型。");
    }
    if (typeof part?.text === "string") {
      if (part.text) parts.push({ type: "text", text: part.text });
      continue;
    }
    const url = typeof part?.image_url === "string" ? part.image_url
      : (typeof part?.image_url?.url === "string" ? part.image_url.url : part?.url);
    if (typeof url === "string" && IMAGE_URL_PATTERN.test(url)) {
      parts.push({ type: "image_url", image_url: { url } });
      continue;
    }
    if (part?.type && !["text", "input_text", "output_text"].includes(part.type)) {
      throw bridgeInputError("Chat Completions 轉譯收到不支援的內容類型；請先用對應工具讀取或轉換附件，再重送文字／圖片。");
    }
  }
  return parts;
}

// 只有文字時送字串：這是所有相容介面都接受的形式，有些只接受這種。
function toChatContent(parts) {
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("\n");
  return parts;
}

function toChatTools(codexTools) {
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
      // 自由格式工具的文法（例如 apply_patch 的 patch 格式）原本由 Responses 的 format
      // 帶給模型；函式工具沒有這個欄位，併進說明裡，否則模型不知道 input 該怎麼寫。
      const grammar = tool.format?.type === "grammar" && typeof tool.format.definition === "string"
        ? tool.format.definition.replaceAll("\r\n", "\n").trim() : "";
      if (grammar) {
        description += `\n\nPut the raw payload in the \`${FREEFORM_KEY}\` string. It must follow this ${tool.format.syntax || ""} grammar:\n${grammar}`;
      }
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description,
          parameters: {
            type: "object",
            properties: {
              [FREEFORM_KEY]: { type: "string", description: "The raw payload for this tool, passed through verbatim." },
            },
            required: [FREEFORM_KEY],
          },
        },
      });
    } else if (tool.type === "function") {
      tools.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: flattenTopLevelSchema(tool.parameters),
        },
      });
    }
  }
  return { tools, freeform, toolContext };
}

function clip(text, max = 2000) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function isUserMessage(item) {
  return (item?.type === "message" || (!item?.type && item?.role)) && item.role === "user";
}

// route 可傳字串（僅模型名）或路由物件。回傳 Chat Completions 請求與回應轉譯需要的資訊。
export function toChatRequest(body, route) {
  const upstreamModel = typeof route === "string" ? route : route?.upstreamModel;
  // 探測時上游拒絕 tools 參數的模型：工具呼叫與結果都改成文字，只能以文字回答。
  const textOnlyTools = typeof route === "object" && route?.chatTools === false;
  const systemParts = typeof body.instructions === "string" && body.instructions ? [body.instructions] : [];
  const messages = [];
  let compaction = false;

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
    systemParts.push("此 Chat Completions 轉譯路由不提供以下平台內建工具：" +
      [...new Set(unavailable)].map((name) => String(name).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)).join(", ") +
      "。只能呼叫本次實際提供的 function/custom 工具。需要生圖且已安裝 router-imagegen 技能時，可使用該技能；沒有可用工具時請明確說明，勿宣稱已完成。");
  }
  if (textOnlyTools && codexTools.length) {
    systemParts.push("這個模型的介面不支援工具呼叫，本輪無法執行任何工具。請直接以文字回答；需要執行命令或修改檔案時，列出具體步驟讓使用者自行操作，勿宣稱已完成。");
  }
  const format = body.text?.format;
  if (format && !["text", "json_schema", "json_object"].includes(format.type)) {
    throw bridgeInputError("Chat Completions 轉譯尚未支援此結構化輸出格式，請改用文字或 JSON schema 輸出。");
  }

  // 推理只在這一輪（最後一則使用者訊息之後）的工具往返裡送回。
  let turnStart = 0;
  inputItems.forEach((item, index) => { if (isUserMessage(item)) turnStart = index + 1; });

  let assistant = null;
  // 最近一則 assistant 訊息裡還沒收到結果的 call_id。Chat Completions 要求帶 tool_calls 的
  // assistant 訊息後面緊接著每個呼叫各自的 tool 訊息，中間不能夾別的訊息。
  let awaiting = [];
  const answered = new Map();
  // 工具結果裡的圖片：tool 訊息只能放文字，等這一組 tool 訊息結束後再以 user 訊息附上。
  const deferredImages = [];
  let toolOutputsMerged = 0;
  let lateToolOutputs = 0;
  let placeholderToolResults = 0;

  const pushUser = (parts) => {
    if (!parts.length) return;
    const last = messages[messages.length - 1];
    if (last?.role === "user") {
      last.parts.push(...parts);
      return;
    }
    messages.push({ role: "user", parts: [...parts] });
  };
  const flushAssistant = () => {
    if (!assistant) return;
    const current = assistant;
    assistant = null;
    if (!current.text && !current.toolCalls.length) return;
    const message = { role: "assistant", content: current.text };
    if (current.toolCalls.length) message.tool_calls = current.toolCalls;
    if (current.reasoning && current.replayReasoning) message.reasoning_content = current.reasoning;
    messages.push(message);
    awaiting = current.toolCalls.map((call) => call.id);
  };
  const closeToolGroup = () => {
    flushAssistant();
    for (const id of awaiting) {
      const message = { role: "tool", tool_call_id: id, content: NO_OUTPUT };
      messages.push(message);
      answered.set(id, message);
      placeholderToolResults += 1;
    }
    awaiting = [];
    if (deferredImages.length) pushUser(deferredImages.splice(0));
  };
  const currentAssistant = (index) => {
    if (!assistant) {
      closeToolGroup();
      assistant = { text: "", toolCalls: [], reasoning: "", replayReasoning: index >= turnStart };
    }
    return assistant;
  };
  const appendAssistantText = (index, text) => {
    if (!text) return;
    const current = currentAssistant(index);
    current.text = current.text ? `${current.text}\n\n${text}` : text;
  };
  const pushToolCall = (index, callId, name, args) => {
    if (textOnlyTools || !callId) {
      appendAssistantText(index, `(呼叫工具 ${name}：${clip(args)})`);
      return;
    }
    currentAssistant(index).toolCalls.push({ id: callId, type: "function", function: { name, arguments: args } });
  };
  const handleToolOutput = (item) => {
    // local_shell_call_output 以 id 指向那次呼叫的 call_id。
    const callId = item.type === "local_shell_call_output" && !item.call_id ? item.id : item.call_id;
    const parts = toChatParts(item.output);
    const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    const images = parts.filter((part) => part.type !== "text");
    flushAssistant();
    if (!callId || textOnlyTools) {
      // 沒有 call_id 的是從其他任務轉送來的訊息，不是某次工具呼叫的結果；
      // 這條路由不支援工具時，結果同樣只能當文字給模型看。
      closeToolGroup();
      const label = callId ? `(工具呼叫 ${callId} 的結果)` : null;
      pushUser([...(label ? [{ type: "text", text: label }] : []), ...parts]);
      return;
    }
    if (awaiting.includes(callId)) {
      const message = { role: "tool", tool_call_id: callId, content: text || (images.length ? "(結果是圖片，見下一則訊息)" : NO_OUTPUT) };
      messages.push(message);
      answered.set(callId, message);
      awaiting = awaiting.filter((id) => id !== callId);
      if (images.length) deferredImages.push({ type: "text", text: `(工具呼叫 ${callId} 回傳的圖片)` }, ...images);
      if (!awaiting.length && deferredImages.length) pushUser(deferredImages.splice(0));
      return;
    }
    // Code Mode 的 exec 每呼叫一次 notify()，Codex 就替同一個 call_id 追加一筆輸出。
    // 還在同一組 tool 訊息裡就併回原本的結果；模型已經往下走的話，改成使用者文字。
    const earlier = answered.get(callId);
    const position = earlier ? messages.indexOf(earlier) : -1;
    if (position >= 0 && messages.slice(position + 1).every((message) => message.role === "tool")) {
      if (text) earlier.content = earlier.content === NO_OUTPUT ? text : `${earlier.content}\n${text}`;
      if (images.length) deferredImages.push({ type: "text", text: `(工具呼叫 ${callId} 回傳的圖片)` }, ...images);
      toolOutputsMerged += 1;
      return;
    }
    closeToolGroup();
    pushUser([{ type: "text", text: lateToolOutputNotice(item) }, ...parts]);
    lateToolOutputs += 1;
  };

  inputItems.forEach((item, index) => {
    switch (item?.type || (item?.role ? "message" : null)) {
      case "additional_tools":
        break;

      case "message": {
        if (item.role === "developer" || item.role === "system") {
          const text = textOf(item.content);
          if (text) systemParts.push(text);
          break;
        }
        if (item.role === "assistant") {
          appendAssistantText(index, textOf(item.content));
          break;
        }
        const parts = toChatParts(item.content);
        if (!parts.length) break;
        closeToolGroup();
        pushUser(parts);
        break;
      }

      case "reasoning": {
        // 官方加密推理與 Claude 的簽章在這裡都用不上；只送回本轉譯層自己產生的。
        if (!isChatReasoning(item)) break;
        const text = reasoningText(item);
        if (!text) break;
        const current = currentAssistant(index);
        current.reasoning = current.reasoning ? `${current.reasoning}\n${text}` : text;
        break;
      }

      case "function_call": {
        const args = JSON.stringify(parseToolArguments(item.arguments ?? "{}"));
        pushToolCall(index, item.call_id, toolAlias(item.namespace, item.name), args);
        break;
      }

      case "custom_tool_call":
        if (typeof item.input !== "string") throw bridgeInputError("歷史自由格式工具的 input 必須是字串，無法安全替換成空內容。");
        pushToolCall(index, item.call_id, toolAlias(item.namespace, item.name), JSON.stringify({ [FREEFORM_KEY]: item.input }));
        break;

      // 官方 GPT 回合的本機命令：轉成工具呼叫，後面那筆輸出才配得上 tool 訊息。
      case "local_shell_call": {
        const action = item.action && typeof item.action === "object" && !Array.isArray(item.action) ? item.action : {};
        if (item.call_id) pushToolCall(index, item.call_id, "local_shell", JSON.stringify(action));
        else appendAssistantText(index, hostedToolSummary(item).text);
        break;
      }

      case "local_shell_call_output":
      case "custom_tool_call_output":
      case "function_call_output":
        handleToolOutput(item);
        break;

      // 官方 GPT 回合留下的平台內建工具項目：都已完成，也沒有可轉送的執行器，轉成簡短文字。
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
        if (summary.role === "assistant") appendAssistantText(index, summary.text);
        else {
          closeToolGroup();
          pushUser([{ type: "text", text: summary.text }]);
        }
        break;
      }

      case "compaction_trigger":
        compaction = true;
        break;

      case "compaction":
      case "context_compaction": {
        const summary = decodeCompaction(item.encrypted_content);
        if (summary) {
          closeToolGroup();
          pushUser([{ type: "text", text: `${COMPACTION_REPLAY_PREFIX}${summary}` }]);
        }
        break;
      }

      default:
        if (item?.type) {
          const type = String(item.type).replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 64);
          throw bridgeInputError(`Chat Completions 轉譯收到不支援的對話項目（${type}），無法安全省略；請改用原模型繼續，或在新任務中提供工作摘要。`);
        }
        break;
    }
  });
  closeToolGroup();

  // compaction_trigger 本身沒有文字，補上與 Codex 本機壓縮同一份提示詞。
  if (compaction) pushUser([{ type: "text", text: COMPACTION_PROMPT }]);
  // 部分模型的對話範本要求第一則非 system 訊息是 user。
  if (!messages.length || messages[0].role !== "user") messages.unshift({ role: "user", parts: [{ type: "text", text: "." }] });

  const chatMessages = messages.map((message) => (message.role === "user"
    ? { role: "user", content: toChatContent(message.parts) }
    : message));
  if (systemParts.length) chatMessages.unshift({ role: "system", content: systemParts.join("\n\n") });

  const { tools, freeform, toolContext } = toChatTools(codexTools);
  const request = { model: upstreamModel, messages: chatMessages, stream: true };
  // 串流預設不回用量；要明確要求。少數閘道不認得 stream_options，探測時會記下來。
  if (route?.chatStreamOptions !== false) request.stream_options = { include_usage: true };

  // 壓縮回合只能回摘要，不送 tools。歷史裡的工具呼叫與結果照樣保留，Chat Completions
  // 不要求本輪一定要定義 tools。
  if (tools.length && !compaction && !textOnlyTools) {
    request.tools = tools;
    const choice = body.tool_choice;
    if (choice === "none") request.tool_choice = "none";
    else if (choice === "required") request.tool_choice = "required";
    else if (choice && typeof choice === "object" && ["function", "custom"].includes(choice.type)) {
      const name = toolAlias(choice.namespace, choice.name);
      if (!tools.some((tool) => tool.function.name === name)) throw bridgeInputError("指定的工具不在這次可用工具清單內。");
      request.tool_choice = { type: "function", function: { name } };
    } else if (choice && choice !== "auto") {
      throw bridgeInputError("Chat Completions 轉譯不支援這個 tool_choice，請選用本次提供的函式工具。");
    }
  } else if (!tools.length && body.tool_choice && !["auto", "none"].includes(body.tool_choice)) {
    throw bridgeInputError("指定的工具在 Chat Completions 轉譯路由中不可用。");
  }

  const effort = body?.reasoning?.effort;
  if (effort && Array.isArray(route?.efforts) && route.efforts.length && CHAT_EFFORTS[effort]) {
    request.reasoning_effort = CHAT_EFFORTS[effort];
  }
  if (Number.isSafeInteger(body.max_output_tokens) && body.max_output_tokens > 0) {
    request.max_tokens = body.max_output_tokens;
  }
  if (format?.type === "json_schema") {
    request.response_format = {
      type: "json_schema",
      json_schema: { name: format.name || "output", schema: format.schema || {}, ...(format.strict != null ? { strict: format.strict } : {}) },
    };
  } else if (format?.type === "json_object") {
    request.response_format = { type: "json_object" };
  }

  return {
    request, freeform, toolTargets, compaction, toolContext,
    toolOutputsMerged, lateToolOutputs, placeholderToolResults,
  };
}

// ---------------------------------------------------------------- 回應方向

function mapChatUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.prompt_tokens) || 0;
  // DeepSeek 以 prompt_cache_hit_tokens 回報快取命中。
  const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cached },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens) || 0 },
    total_tokens: Number(usage.total_tokens) || input + output,
  };
}

// 有些模型（例如沒開推理解析器的 vLLM、Ollama 上的 R1 類模型）把推理包在內文開頭的
// <think>…</think> 裡。拆出來當推理顯示，不然整段思考會混進回答。
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

function createThinkSplitter() {
  let state = "start";
  let buffer = "";
  return {
    push(text) {
      const out = [];
      buffer += text;
      for (;;) {
        if (state === "start") {
          const trimmed = buffer.trimStart();
          if (!trimmed) return out;
          if (trimmed.startsWith(THINK_OPEN)) {
            state = "inside";
            buffer = trimmed.slice(THINK_OPEN.length);
            continue;
          }
          if (THINK_OPEN.startsWith(trimmed)) return out;
          state = "content";
          continue;
        }
        if (state === "inside") {
          const end = buffer.indexOf(THINK_CLOSE);
          if (end >= 0) {
            if (end > 0) out.push({ kind: "reasoning", text: buffer.slice(0, end) });
            buffer = buffer.slice(end + THINK_CLOSE.length).replace(/^\s+/, "");
            state = "content";
            continue;
          }
          // 結束標記可能被切在兩個片段之間：留下可能是標記開頭的尾巴。
          let keep = 0;
          for (let length = Math.min(THINK_CLOSE.length - 1, buffer.length); length > 0; length -= 1) {
            if (THINK_CLOSE.startsWith(buffer.slice(-length))) { keep = length; break; }
          }
          if (buffer.length > keep) out.push({ kind: "reasoning", text: buffer.slice(0, buffer.length - keep) });
          buffer = buffer.slice(buffer.length - keep);
          return out;
        }
        if (buffer) out.push({ kind: "content", text: buffer });
        buffer = "";
        return out;
      }
    },
    // 串流結束時剩下的內容：還沒判斷完的開頭是內文，推理裡的殘段仍算推理。
    flush() {
      const text = buffer;
      buffer = "";
      if (!text) return [];
      return [{ kind: state === "inside" ? "reasoning" : "content", text }];
    },
  };
}

function* sseData(block) {
  const lines = block.split(/\r?\n/).filter((line) => line.startsWith("data:"));
  if (!lines.length) return;
  yield lines.map((line) => line.slice(5).replace(/^ /, "")).join("\n");
}

/**
 * 讀取 Chat Completions 的 SSE 串流，逐一產生 Codex Responses 事件。
 * @param {AsyncIterable<Uint8Array>} upstreamBody
 * @param {(event: object) => void} emit
 * @param {{model: string, requestBody: object, freeform: Set<string>, toolTargets?: Map<string, {name: string, namespace?: string}>, compaction?: boolean}} ctx
 */
export async function bridgeChatStream(upstreamBody, emit, ctx) {
  const responseId = randomId("resp_", 55);
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  let outputIndex = 0;
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

  // 壓縮回合：模型吐的內容一律不外送，收攏成一個 compaction 項目在最後補上。
  const compactionMode = Boolean(ctx.compaction);
  let compactionText = "";
  let suppress = compactionMode;
  const passthroughWhileSuppressed = new Set(["response.created", "response.in_progress"]);
  const send = (event) => {
    if (suppress && !passthroughWhileSuppressed.has(event.type)) return;
    emit({ ...event, sequence_number: seq++ });
  };

  send({ type: "response.created", response: base() });
  send({ type: "response.in_progress", response: base() });

  let reasoning = null;
  let message = null;
  const calls = new Map();
  let finishReason = null;
  let usage = null;
  let failed = false;
  let done = false;
  const splitter = createThinkSplitter();

  const fail = (error) => {
    if (failed || done) return;
    failed = true;
    suppress = false;
    const response = base();
    response.status = "failed";
    response.error = error;
    send({ type: "response.failed", response });
  };

  const closeReasoning = () => {
    if (!reasoning) return;
    const current = reasoning;
    reasoning = null;
    send({ type: "response.reasoning_summary_text.done", item_id: current.itemId, output_index: current.index, summary_index: 0, text: current.text });
    send({ type: "response.reasoning_summary_part.done", item_id: current.itemId, output_index: current.index, summary_index: 0, part: { type: "summary_text", text: current.text } });
    const item = {
      id: current.itemId,
      type: "reasoning",
      content: [],
      encrypted_content: CHAT_REASONING_MARKER,
      summary: [{ type: "summary_text", text: current.text }],
    };
    output.push(item);
    send({ type: "response.output_item.done", output_index: current.index, item });
  };

  const closeMessage = () => {
    if (!message) return;
    const current = message;
    message = null;
    if (compactionMode) compactionText += current.text;
    send({ type: "response.output_text.done", content_index: 0, item_id: current.itemId, logprobs: [], output_index: current.index, text: current.text });
    send({ type: "response.content_part.done", content_index: 0, item_id: current.itemId, output_index: current.index, part: { type: "output_text", annotations: [], logprobs: [], text: current.text } });
    const item = {
      id: current.itemId,
      type: "message",
      status: "completed",
      content: [{ type: "output_text", annotations: [], logprobs: [], text: current.text }],
      phase: "commentary",
      role: "assistant",
    };
    output.push(item);
    send({ type: "response.output_item.done", output_index: current.index, item });
  };

  const appendReasoning = (text) => {
    if (!text) return;
    closeMessage();
    if (!reasoning) {
      reasoning = { itemId: randomId("rs_", 53), index: outputIndex++, text: "" };
      send({ type: "response.output_item.added", output_index: reasoning.index, item: { id: reasoning.itemId, type: "reasoning", content: [], encrypted_content: "", summary: [] } });
      send({ type: "response.reasoning_summary_part.added", item_id: reasoning.itemId, output_index: reasoning.index, summary_index: 0, part: { type: "summary_text", text: "" } });
    }
    reasoning.text += text;
    send({ type: "response.reasoning_summary_text.delta", item_id: reasoning.itemId, output_index: reasoning.index, summary_index: 0, delta: text });
  };

  const appendContent = (text) => {
    if (!text) return;
    closeReasoning();
    if (!message) {
      message = { itemId: randomId("msg_", 54), index: outputIndex++, text: "" };
      send({ type: "response.output_item.added", output_index: message.index, item: { id: message.itemId, type: "message", status: "in_progress", content: [], phase: "commentary", role: "assistant" } });
      send({ type: "response.content_part.added", content_index: 0, item_id: message.itemId, output_index: message.index, part: { type: "output_text", annotations: [], logprobs: [], text: "" } });
    }
    message.text += text;
    send({ type: "response.output_text.delta", content_index: 0, item_id: message.itemId, output_index: message.index, delta: text });
  };

  const routeSplit = (pieces) => {
    for (const piece of pieces) {
      if (piece.kind === "reasoning") appendReasoning(piece.text);
      else appendContent(piece.text);
    }
  };

  const announce = (entry) => {
    entry.announced = true;
    entry.callId ||= randomId("call_", 29);
    entry.index = outputIndex++;
    const target = ctx.toolTargets?.get(entry.alias);
    entry.name = target?.name || entry.alias;
    entry.namespace = target?.namespace || null;
    entry.freeform = ctx.freeform.has(entry.alias);
    const identity = entry.namespace ? { name: entry.name, namespace: entry.namespace } : { name: entry.name };
    send({
      type: "response.output_item.added",
      output_index: entry.index,
      item: entry.freeform
        ? { id: entry.itemId, type: "custom_tool_call", status: "in_progress", call_id: entry.callId, input: "", ...identity }
        : { id: entry.itemId, type: "function_call", status: "in_progress", call_id: entry.callId, arguments: "", ...identity },
    });
  };

  const addToolCallFragment = (fragment, position) => {
    const key = Number.isInteger(fragment?.index) ? `i${fragment.index}`
      : (typeof fragment?.id === "string" && fragment.id ? `d${fragment.id}` : `p${position}`);
    let entry = calls.get(key);
    if (!entry) {
      entry = { itemId: randomId("fc_", 54), callId: null, alias: "", args: "", announced: false, index: null };
      calls.set(key, entry);
    }
    if (typeof fragment?.id === "string" && fragment.id && !entry.callId) entry.callId = fragment.id;
    const name = fragment?.function?.name;
    if (typeof name === "string" && name && !entry.alias) entry.alias = name;
    const args = fragment?.function?.arguments;
    if (typeof args === "string") entry.args += args;
    else if (args && typeof args === "object") entry.args += JSON.stringify(args);
    if (!entry.announced && entry.alias) announce(entry);
  };

  const finishToolCall = (entry) => {
    let parsed = null;
    const raw = entry.args.trim();
    try {
      parsed = parseToolArguments(raw || "{}");
    } catch {
      // 部分模型呼叫自由格式工具時直接給原始內容（或一個 JSON 字串），不包成物件。
      // 以 { 開頭卻解析失敗的是被截斷的 JSON，不能拿來猜。
      if (entry.freeform && raw && !raw.startsWith("{")) {
        let value = entry.args;
        try {
          const decoded = JSON.parse(raw);
          if (typeof decoded === "string") value = decoded;
        } catch { /* 原始內容就是參數。 */ }
        parsed = { [FREEFORM_KEY]: value };
      }
    }
    if (!parsed || (entry.freeform && typeof parsed[FREEFORM_KEY] !== "string")) {
      fail({ code: "invalid_tool_arguments", message: "上游工具參數不完整或格式錯誤；未產生替代參數，請重新產生該工具呼叫。" });
      return false;
    }
    const identity = entry.namespace ? { name: entry.name, namespace: entry.namespace } : { name: entry.name };
    let item;
    if (entry.freeform) {
      const input = parsed[FREEFORM_KEY];
      send({ type: "response.custom_tool_call_input.delta", delta: input, item_id: entry.itemId, output_index: entry.index });
      send({ type: "response.custom_tool_call_input.done", input, item_id: entry.itemId, output_index: entry.index });
      item = { id: entry.itemId, type: "custom_tool_call", status: "completed", call_id: entry.callId, input, ...identity };
    } else {
      const args = JSON.stringify(parsed);
      send({ type: "response.function_call_arguments.delta", delta: args, item_id: entry.itemId, output_index: entry.index });
      send({ type: "response.function_call_arguments.done", arguments: args, item_id: entry.itemId, output_index: entry.index });
      item = { id: entry.itemId, type: "function_call", status: "completed", call_id: entry.callId, arguments: args, ...identity };
    }
    output.push(item);
    send({ type: "response.output_item.done", output_index: entry.index, item });
    return true;
  };

  const finish = () => {
    if (done || failed) return;
    routeSplit(splitter.flush());
    closeReasoning();
    closeMessage();
    const pending = [...calls.values()];
    if (pending.some((entry) => !entry.announced)) {
      fail({ code: "invalid_tool_arguments", message: "上游工具呼叫缺少名稱；未執行，請重新產生該工具呼叫。" });
      return;
    }
    for (const entry of pending.sort((left, right) => left.index - right.index)) {
      if (!finishToolCall(entry)) return;
    }
    done = true;
    if (compactionMode) {
      suppress = false;
      // 摘要為空也必須送出項目，否則客戶端直接 Fatal。
      const summary = compactionText.trim() || "(compaction produced no summary)";
      const item = { id: randomId("cmp_", 54), type: "compaction", encrypted_content: encodeCompaction(summary) };
      send({ type: "response.output_item.added", output_index: 0, item: { id: item.id, type: "compaction", encrypted_content: "" } });
      send({ type: "response.output_item.done", output_index: 0, item });
      output.length = 0;
      output.push(item);
    }
    const response = base();
    response.status = "completed";
    response.completed_at = Math.floor(Date.now() / 1000);
    response.output = output;
    response.usage = mapChatUsage(usage);
    if (finishReason === "length") {
      response.status = "incomplete";
      response.incomplete_details = { reason: "max_output_tokens" };
    } else if (finishReason === "content_filter") {
      response.status = "incomplete";
      response.incomplete_details = { reason: "content_filter" };
    }
    send({ type: response.status === "incomplete" ? "response.incomplete" : "response.completed", response });
  };

  const handle = (chunk) => {
    if (failed || done) return;
    const error = chunk?.error ?? (chunk?.object === "error" ? chunk : null);
    if (error) {
      fail(codexErrorFromUpstream(typeof error === "object" ? error : { message: String(error) }));
      return;
    }
    if (chunk?.usage) usage = chunk.usage;
    const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
    for (const choice of choices) {
      if (Number.isInteger(choice?.index) && choice.index !== 0) continue;
      const delta = choice?.delta || choice?.message || {};
      const thinking = typeof delta.reasoning_content === "string" ? delta.reasoning_content
        : (typeof delta.reasoning === "string" ? delta.reasoning : "");
      if (thinking) appendReasoning(thinking);
      const content = typeof delta.content === "string" ? delta.content
        : (Array.isArray(delta.content) ? delta.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("") : "");
      if (content) routeSplit(splitter.push(content));
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        routeSplit(splitter.flush());
        closeReasoning();
        closeMessage();
        delta.tool_calls.forEach((fragment, position) => addToolCallFragment(fragment, position));
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
    }
  };

  const decoder = new TextDecoder();
  let pending = "";
  let sawDone = false;
  let sawData = false;
  // 少數伺服器即使要求串流仍回一整個 JSON；一個 data 行都沒看到時留著原文，最後整包解析。
  let whole = "";
  const maxWholeBytes = 16 * 1024 * 1024;
  const consume = (block) => {
    for (const data of sseData(block)) {
      sawData = true;
      if (data.trim() === "[DONE]") {
        sawDone = true;
        finish();
        continue;
      }
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      handle(chunk);
    }
  };
  for await (const chunk of upstreamBody) {
    const text = decoder.decode(chunk, { stream: true });
    if (!sawData && whole.length < maxWholeBytes) whole += text;
    pending += text;
    for (;;) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match) break;
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      consume(block);
    }
  }
  const rest = decoder.decode();
  if (!sawData) whole += rest;
  pending += rest;
  if (pending.trim()) consume(pending);
  if (!sawData) {
    let body = null;
    try { body = JSON.parse(whole); } catch { /* 不是 JSON，交給路由器當成截斷處理。 */ }
    if (body && typeof body === "object") {
      handle(body);
      if (Array.isArray(body.choices) && body.choices.length) finish();
    }
    return;
  }
  // 有些伺服器不送 [DONE]；看過 finish_reason 就視為正常結束。兩者都沒有代表串流被截斷，
  // 由路由器補 response.failed。
  if (!sawDone && finishReason) finish();
}
