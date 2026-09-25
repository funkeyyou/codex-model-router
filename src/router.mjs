import http from "node:http";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import tls from "node:tls";
import { readFileSync, mkdirSync, writeFileSync, appendFileSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { zstdDecompressSync } from "node:zlib";
import {
  toAnthropicRequest,
  bridgeAnthropicStream,
  decodeCompaction,
  codexErrorFromUpstream,
  COMPACTION_REPLAY_PREFIX,
} from "./claude-bridge.mjs";

const routerDirectory = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(routerDirectory, "settings.json");
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
const listenHost = "127.0.0.1";
const listenPort = Number(settings.port);
const apiRoot = String(settings.apiRoot).replace(/\/$/, "");
const officialBase = String(settings.officialBaseUrl).replace(/\/$/, "");
const keychainService = settings.keychainService;
const keychainAccount = settings.keychainAccount || "codex";
const credentialPath = settings.credentialPath || null;
const routeMap = new Map(settings.routes.map((route) => [route.pickerSlug, route]));
const execFileAsync = promisify(execFile);
const tokenCacheTtlMs = 5 * 60 * 1000;
// Windows 以密文檔的修改時間判斷 Key 有沒有換，快取可以放久一點。
const credentialCacheTtlMs = 12 * 60 * 60 * 1000;
const authValidationTtlMs = 5 * 60 * 1000;
const maxRememberedThreads = 2048;
const maxValidatedAuthDigests = 64;
const maxPendingMessages = 8;
const maxHttpBodyBytes = Number.isSafeInteger(settings.maxHttpBodyBytes) && settings.maxHttpBodyBytes > 0
  ? Math.min(settings.maxHttpBodyBytes, 512 * 1024 * 1024) : 128 * 1024 * 1024;

// 在 Buffer.concat / 解壓 / JSON.parse 之前限制接收量；不可截掉內容後繼續送模型。
export async function readRequestBody(request, limit = maxHttpBodyBytes) {
  const chunks = [];
  let bytes = 0;
  const input = request.iterator ? request.iterator({ destroyOnReturn: false }) : request;
  for await (const chunk of input) {
    bytes += chunk.length;
    if (bytes > limit) throw new RouterRequestError(413, "router_request_too_large", "本機接收的請求過大，請縮小附件或分批處理。", "request");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function decodeRequestBody(raw, encoding, limit = maxHttpBodyBytes) {
  if (encoding && encoding !== "identity" && encoding !== "zstd") {
    throw new RouterRequestError(415, "unsupported_content_encoding", "不支援的請求內容編碼。", "request");
  }
  if (raw.length > limit) throw new RouterRequestError(413, "router_request_too_large", "本機接收的請求過大。", "request");
  if (encoding !== "zstd") return raw;
  try { return zstdDecompressSync(raw, { maxOutputLength: limit }); }
  catch (error) {
    if (error.code === "ERR_BUFFER_TOO_LARGE") throw new RouterRequestError(413, "router_request_too_large", "解壓後的請求過大，請縮小附件。", "request");
    throw new RouterRequestError(400, "invalid_compressed_body", "無法解壓請求內容。", "request");
  }
}
// --- 診斷用擷取（settings.captureDir 有值時才啟用，預設關閉）---
const captureDir = typeof settings.captureDir === "string" && settings.captureDir
  ? settings.captureDir
  : null;
let captureSeq = 0;
function captureNext(kind) {
  if (!captureDir) return null;
  const id = `${String(++captureSeq).padStart(3, "0")}-${kind}`;
  try { mkdirSync(captureDir, { recursive: true }); } catch {}
  return id;
}
function captureWrite(id, suffix, data) {
  if (!captureDir || !id) return;
  try { writeFileSync(join(captureDir, `${id}.${suffix}`), data); } catch {}
}
function captureAppend(id, suffix, data) {
  if (!captureDir || !id) return;
  try { appendFileSync(join(captureDir, `${id}.${suffix}`), data); } catch {}
}

const closeOnUpstreamError = settings.closeOnUpstreamError === true;

// 上游對單次請求有尺寸上限（Anthropic 的 Messages API 是 32 MB）。超過時閘道只會
// 回一個通用的 5xx，客戶端看不出原因，而且會一直重試——每次重試都把整份歷史再上傳
// 一遍。實測一條長對話：完整歷史 37.6 MB，其中 91% 是累積的工具輸出，重試 31 次等於
// 白傳 1.1 GB，而且不可能成功。這裡在送出前就擋下來，並且說清楚是什麼原因。
//
// 只擋自訂路由：官方後端的上限不同，不該拿 Anthropic 的數字去限制它。
const maxUpstreamRequestBytes =
  Number(settings.maxUpstreamRequestBytes) > 0
    ? Number(settings.maxUpstreamRequestBytes)
    : 32 * 1024 * 1024;

export function upstreamRequestTooLarge(bytes, limit = maxUpstreamRequestBytes) {
  return Number.isFinite(bytes) && bytes > limit;
}

export function oversizeMessage(bytes, limit) {
  const mb = (value) => (value / (1024 * 1024)).toFixed(1);
  return (
    `這一輪要送往上游的請求仍有 ${mb(bytes)} MB，超過路由器設定的 ${mb(limit)} MB 上限。` +
    "已嘗試縮減舊工具截圖；使用者圖片、近期截圖與文字內容會保留。" +
    "請縮小近期圖片或附件，或將工作摘要帶到新對話；重試相同內容不會解除限制。"
  );
}

// token 預算無法控制 Base64 圖片的傳輸大小。先以最終上游 JSON 的 75% 上限
// 作為目標，為後續工具往返留空間；只替換較舊的工具截圖，不碰使用者附件與文字。
const recentToolImagesToKeep = 4;
const historyImageDirectory = join(routerDirectory, "history-images");

function inlineToolImage(block) {
  if (block?.type === "image" && block.source?.type === "base64") {
    return { data: block.source.data, mediaType: block.source.media_type };
  }
  if (block?.type !== "input_image") return null;
  const url = block.image_url ?? block.url;
  if (typeof url !== "string") return null;
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/.exec(url);
  return match ? { data: match[2], mediaType: match[1] } : null;
}

// 省略前保存原始圖片，檔名依內容定址，重試不會反覆寫出相同圖片。
// 不下載 URL、不修改 Codex 歷史；若無法保存就留下圖片，不能給出不存在的回讀路徑。
export function archiveHistoryImage(image, directory = historyImageDirectory) {
  const extension = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }[image?.mediaType];
  if (!extension || typeof image.data !== "string" || !image.data) return null;
  const buffer = Buffer.from(image.data, "base64");
  if (!buffer.length || buffer.toString("base64") !== image.data) return null;
  const digest = createHash("sha256").update(buffer).digest("hex");
  const target = join(directory, `${digest}.${extension}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(target, buffer, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST" || !readFileSync(target).equals(buffer)) throw error;
  }
  return target;
}

function toolImageSlots(payload, anthropic) {
  const slots = [];
  const walk = (blocks, group) => {
    if (!Array.isArray(blocks)) return;
    blocks.forEach((block, index) => {
      const image = inlineToolImage(block);
      if (image) slots.push({ blocks, index, image, group });
      else if (Array.isArray(block?.content)) walk(block.content, group);
    });
  };
  if (anthropic) {
    for (const message of payload.messages || []) {
      for (const block of message.content || []) {
        if (block.type === "tool_result") walk(block.content, block);
      }
    }
  } else if (Array.isArray(payload.input)) {
    for (const item of payload.input) {
      if (item?.call_id && ["function_call_output", "custom_tool_call_output"].includes(item.type)) {
        walk(item.output, item);
      }
    }
  }
  return slots;
}

export function budgetToolImages(payload, {
  anthropic = false,
  maxBytes = maxUpstreamRequestBytes,
  archive = archiveHistoryImage,
} = {}) {
  const originalBuffer = Buffer.from(JSON.stringify(payload));
  const result = {
    request: payload, buffer: originalBuffer, originalBytes: originalBuffer.length,
    imagesOmitted: 0, bytesSaved: 0, archiveFailures: 0,
  };
  const targetBytes = Math.floor(maxBytes * 0.75);
  if (!Number.isFinite(targetBytes) || targetBytes <= 0 || originalBuffer.length <= targetBytes) return result;

  // 只改送出的副本。Codex 與本機的增量重建仍保留完整歷史，之後可重新讀圖。
  const copy = structuredClone(payload);
  const slots = toolImageSlots(copy, anthropic);
  const latestGroup = slots.at(-1)?.group;
  let bytes = originalBuffer.length;
  for (const slot of slots.slice(0, -recentToolImagesToKeep)) {
    if (bytes <= targetBytes) break;
    // 最新一次工具結果中的圖片可能是一組比較圖，整組保留，即使超過四張。
    if (slot.group === latestGroup) continue;
    const originalSize = Buffer.byteLength(JSON.stringify(slot.blocks[slot.index]));
    if (originalSize < 1024) continue;
    let savedPath;
    try { savedPath = archive(slot.image); } catch { /* 保留無法封存的圖片。 */ }
    if (typeof savedPath !== "string" || !savedPath) {
      result.archiveFailures += 1;
      continue;
    }
    const replacement = {
      type: anthropic ? "text" : "input_text",
      text: `(較舊的工具截圖已移出本輪請求以控制大小；原圖：${savedPath}。需要細節時可重新讀取原圖。)`,
    };
    const saved = originalSize - Buffer.byteLength(JSON.stringify(replacement));
    if (saved <= 0) continue;
    slot.blocks[slot.index] = replacement;
    bytes -= saved;
    result.imagesOmitted += 1;
  }
  if (result.imagesOmitted) {
    result.request = copy;
    result.buffer = Buffer.from(JSON.stringify(copy));
    result.bytesSaved = originalBuffer.length - result.buffer.length;
  }
  return result;
}

function recordImageBudget(result) {
  stats.toolImagesOmitted += result.imagesOmitted;
  stats.toolImageBytesSaved += result.bytesSaved;
  stats.imageArchiveFailures += result.archiveFailures;
  stats.lastRequestBytesBeforeBudget = result.originalBytes;
  stats.lastRequestBytesAfterBudget = result.buffer.length;
  if (result.imagesOmitted || result.archiveFailures) {
    process.stderr.write(
      `model-router-image-budget:${result.originalBytes}->${result.buffer.length}` +
      ` omitted=${result.imagesOmitted} archiveFailures=${result.archiveFailures}\n`,
    );
  }
}

// --- 模型目錄的自動更新 -----------------------------------------------------
//
// Codex 啟動時透過 /models 取得清單。官方資料必須來自該請求的帳號，不能只用
// bundled 快照，也不能跨重啟用 TTL 略過查詢。models.json 保留作為離線回退及
// 自訂模型的來源，不再由 model_catalog_json 鎖住 Codex 的模型管理器。
const catalogRefreshEnabled = settings.catalogRefresh !== false;

// 官方項目整批換新，自訂項目沿用檔案裡既有的那份——那是安裝時探測出來的結果，
// 路由器沒有重新探測的條件，也不該重複實作 customCatalogEntry（複製一份必然漂移）。
export function mergeCatalog(freshCatalog, currentCatalog, forceListed = []) {
  const isCustom = (model) => String(model?.slug || "").startsWith("custom/");
  const forced = new Set(forceListed);
  const official = (freshCatalog?.models || [])
    .filter((model) => !isCustom(model))
    // bundled 目錄把尚未普及的模型標成 hide，實際能不能用是後端依帳號決定的。
    // model_catalog_json 會蓋掉那個決定，於是帳號明明有權限也看不到（手機看得到
    // 就是因為它直接問後端）。這裡讓使用者把特定模型強制列出來。
    .map((model) => (forced.has(model.slug) ? { ...model, visibility: "list" } : model));
  const custom = (currentCatalog?.models || []).filter(isCustom);
  if (official.length === 0) throw new Error("bundled 目錄沒有官方模型");
  // 自訂項目要排在新的官方模型之後，否則新模型會把它們擠掉。
  const maxPriority = Math.max(0, ...official.map((model) => Number(model.priority) || 0));
  const renumbered = custom.map((model, index) => ({
    ...model,
    priority: maxPriority + index + 1,
  }));
  return { ...freshCatalog, models: [...official, ...renumbered] };
}

export function mergeOfficialCatalog(fresh, current, forceListed = []) {
  // 拒絕截斷、空清單、重複或冒充自訂模型的資料，不讓壞回應覆寫離線備份。
  const seen = new Set();
  if (!Array.isArray(fresh?.models) || !fresh.models.length) throw new Error("invalid_catalog");
  for (const model of fresh.models) {
    if (typeof model?.slug !== "string" || !model.slug || model.slug.startsWith("custom/") ||
        seen.has(model.slug) || typeof model.display_name !== "string" ||
        !["list", "hide"].includes(model.visibility) || !Array.isArray(model.supported_reasoning_levels)) {
      throw new Error("invalid_catalog");
    }
    seen.add(model.slug);
  }
  // 只有使用者明確要求強制顯示的舊項目可補回；其他官方項目以帳號最新清單為準。
  const forced = new Set(forceListed);
  const retained = (current.models || []).filter(m => forced.has(m.slug) &&
    !m.slug.startsWith("custom/") && !seen.has(m.slug));
  return mergeCatalog({ ...fresh, models: [...fresh.models, ...retained] }, current, forceListed);
}

// 只合併同帳號、同 client_version 同時進行的查詢；完成後立刻移除，不會讓下一次
// Codex 啟動命中路由器的舊快取。憑證只存在本次 fetch，不寫檔也不寫日誌。
const catalogRequests = new Map();
export async function refreshOfficialCatalog(requestHeaders, searchParams, fetchImpl = fetch) {
  const current = () => JSON.parse(readFileSync(settings.catalogPath, "utf8"));
  if (!catalogRefreshEnabled) return current();
  const incoming = new Headers(requestHeaders);
  const authorization = incoming.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return current();
  const version = searchParams.get("client_version");
  if (!version || !/^[0-9A-Za-z.+_-]{1,80}$/.test(version)) return current();
  const headers = new Headers({ authorization, accept: "application/json" });
  for (const name of ["chatgpt-account-id", "openai-organization", "openai-project", "user-agent", "originator"]) {
    if (incoming.has(name)) headers.set(name, incoming.get(name));
  }
  const key = createHash("sha256").update(JSON.stringify([...headers])).update(version).digest("hex");
  if (catalogRequests.has(key)) return catalogRequests.get(key);
  // 本機異常客戶端也不能製造無上限的背景查詢。
  if (catalogRequests.size >= 8) return current();
  const pending = (async () => {
    let status = null;
    try {
      const url = new URL(`${officialBase}/models`);
      url.searchParams.set("client_version", version);
      const upstream = await fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10000) });
      status = upstream.status;
      if (!upstream.ok) { await upstream.body?.cancel(); throw new Error("upstream_status"); }
      const chunks = [];
      let bytes = 0;
      for await (const chunk of upstream.body) {
        bytes += chunk.length;
        if (bytes > 8 * 1024 * 1024) throw new Error("catalog_too_large");
        chunks.push(chunk);
      }
      // 網路等待期間安裝器可能添加了模型；合併前重讀，不覆蓋它剛完成的變更。
      const before = current();
      const merged = mergeOfficialCatalog(JSON.parse(Buffer.concat(chunks).toString("utf8")), before,
        Array.isArray(settings.forceListedModels) ? settings.forceListedModels : []);
      if (JSON.stringify(merged) !== JSON.stringify(before)) {
        const temporary = settings.catalogPath + ".tmp";
        writeFileSync(temporary, JSON.stringify(merged), { mode: 0o600 });
        renameSync(temporary, settings.catalogPath);
      }
      stats.catalogRefreshes += 1;
      stats.catalogModels = merged.models.length;
      stats.lastCatalogSync = { source: "official", status, at: new Date().toISOString() };
      return merged;
    } catch {
      stats.catalogRefreshFailures += 1;
      stats.lastCatalogSync = { source: "cache", status, at: new Date().toISOString() };
      process.stderr.write(`model-router-catalog-refresh-failed:status=${status ?? "unavailable"};using-cache\n`);
      return current();
    }
  })();
  catalogRequests.set(key, pending);
  try { return await pending; }
  finally { catalogRequests.delete(key); }
}

// --- 生圖結果的轉譯 ---------------------------------------------------------
//
// 部分閘道會自己啟用 image_generation，回應裡因此帶著 image_generation_call
// 與整張圖的 base64。Codex 收得到、也會原樣存進歷史再送回來，但它只在自己
// 主動要求生圖時才有顯示路徑，於是圖就這樣沉在歷史裡，使用者永遠看不到。
//
// 這裡把它翻成 Codex 本來就會顯示的東西：把圖落地成檔案，再合成一個
// view_image 工具呼叫（view_image 是 Codex 的內建用戶端工具）。
//
// 連鎖問題：Codex 執行完會把 function_call_output 送回來，但上游從沒宣告過
// 這個工具，原樣轉發會讓下一輪被拒。因此本機合成的呼叫用可辨識的 call_id
// 前綴，送往上游前連同它的輸出一起剝掉——與既有的 stripBridgeArtifacts 同一套路。
const viewImageBridgeEnabled = settings.viewImageBridge !== false;
const imageOutputDir =
  typeof settings.imageOutputDir === "string" && settings.imageOutputDir
    ? settings.imageOutputDir
    : join(homedir(), "Downloads");
const ROUTER_IMAGE_CALL_PREFIX = "call_rtrimg_";

// 只認副檔名，不做完整解析：認不出來就當 png，反正 Codex 是靠內容判讀。
function imageExtension(buffer) {
  if (buffer.length >= 8 && buffer.readUInt32BE(0) === 0x89504e47) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return "jpg";
  if (buffer.length >= 12 && buffer.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (buffer.length >= 6 && buffer.subarray(0, 3).toString("latin1") === "GIF") return "gif";
  return "png";
}

export function saveGeneratedImage(item, directory = imageOutputDir) {
  if (typeof item?.result !== "string" || item.result.length < 32) return null;
  let buffer;
  try {
    buffer = Buffer.from(item.result, "base64");
  } catch {
    return null;
  }
  if (buffer.length < 16) return null;
  try {
    mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = join(
      directory,
      `codex-image-${stamp}-${randomBytes(3).toString("hex")}.${imageExtension(buffer)}`,
    );
    writeFileSync(target, buffer);
    return target;
  } catch {
    return null;
  }
}

// 本機合成的 view_image 呼叫，供上游剝除時辨識。
export function isRouterImageCallId(value) {
  return typeof value === "string" && value.startsWith(ROUTER_IMAGE_CALL_PREFIX);
}

// 上游沒有這個工具，因此本機合成的呼叫與它的輸出都不能送出去。
export function stripRouterImageCalls(input) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  const kept = input.filter(
    (item) => !(item && typeof item === "object" && isRouterImageCallId(item.call_id)),
  );
  const removed = input.length - kept.length;
  // 與其他剝除函式一致：沒有要動的東西就回傳原陣列，不做無謂配置。
  return { input: removed > 0 ? kept : input, removed };
}

// 官方後端支援 Responses 的 WebSocket 模式：同一條上游連線可以用
// previous_response_id 接續，每輪只送新項目，不必重送完整歷史。
// 設 settings.upstreamWebSocket = false 可退回全 HTTP 行為。
const upstreamWebSocketEnabled = settings.upstreamWebSocket !== false;

// 上游 WebSocket 不通時的全域冷卻。
//
// upstreamDisabled 只記在單一條 Codex 連線上，所以上游持續回 404 的期間，
// 每開一條新連線都會再賠一次 TLS 連線加握手才回退——成本落在每個新對話的
// 第一輪。這裡改記在模組層：連續失敗達門檻就整個路由器暫停嘗試一段時間，
// 期間直接走 HTTP，時間到再放行一次探測。
// 握手成功會立刻清除，所以上游恢復後最多只慢一個冷卻週期。
const upstreamWebSocketFailureThreshold =
  Number(settings.upstreamWebSocketFailureThreshold) > 0
    ? Number(settings.upstreamWebSocketFailureThreshold)
    : 2;
const upstreamWebSocketCooldownMs =
  Number(settings.upstreamWebSocketCooldownMs) > 0
    ? Number(settings.upstreamWebSocketCooldownMs)
    : 5 * 60 * 1000;
let upstreamWebSocketFailureStreak = 0;
let upstreamWebSocketCooldownUntil = 0;

export function upstreamWebSocketInCooldown() {
  if (upstreamWebSocketCooldownUntil === 0) return false;
  if (Date.now() < upstreamWebSocketCooldownUntil) return true;
  // 冷卻到期：放行一次探測。成功就清零，失敗會再進一次冷卻。
  upstreamWebSocketCooldownUntil = 0;
  upstreamWebSocketFailureStreak = 0;
  return false;
}

export function noteUpstreamWebSocketConnectFailure() {
  upstreamWebSocketFailureStreak += 1;
  if (upstreamWebSocketFailureStreak < upstreamWebSocketFailureThreshold) return;
  upstreamWebSocketCooldownUntil = Date.now() + upstreamWebSocketCooldownMs;
  stats.upstreamWebSocketCooldowns += 1;
  process.stderr.write(
    "model-router-upstream-ws-cooldown:" +
      `連續 ${upstreamWebSocketFailureStreak} 次握手失敗，暫停 ` +
      `${Math.round(upstreamWebSocketCooldownMs / 1000)} 秒內的上游 WebSocket 嘗試\n`,
  );
}

export function noteUpstreamWebSocketConnected() {
  upstreamWebSocketFailureStreak = 0;
  upstreamWebSocketCooldownUntil = 0;
}

// Codex 的 WebSocket response.create 訊息含有若干「協定層」欄位，它們在
// WebSocket 上合法，但不是 HTTP Responses API 的參數。本路由對上游一律使用
// HTTP，若原樣轉送，上游會回 "Unsupported parameter: ..." 並導致預熱與工具
// 接續回合失敗（官方後端與第三方閘道皆然）。
const websocketOnlyFields = [
  "generate",
  "ws_request_header_traceparent",
  "ws_request_header_trace",
];

// --- 有狀態接續的本機重建 ---------------------------------------------------
// Codex 在工具接續回合只送工具結果並倚賴伺服器保存狀態（previous_response_id），
// 但部分閘道不支援。由於 Codex 自己仍持有完整歷史（下一個完整請求會補齊），
// 這裡以「上次完整輸入 + 該輪產生的輸出 + 本次新項目」在本機重建等價請求。
const threadHistories = new Map();
const maxRememberedHistories = 32;
const maxResponsesPerHistory = 4;
const maxHistoryBytes = Number.isSafeInteger(settings.maxHistoryBytes) && settings.maxHistoryBytes > 0
  ? settings.maxHistoryBytes : 128 * 1024 * 1024;
const historyTtlMs = Number.isSafeInteger(settings.historyTtlMs) && settings.historyTtlMs > 0
  ? settings.historyTtlMs : 30 * 60 * 1000;

export function historyCacheInfo(now = Date.now()) {
  let bytes = 0;
  let count = 0;
  for (const [key, responses] of threadHistories) {
    for (const [id, history] of responses) {
      if (history.expiresAt <= now) responses.delete(id);
      else { bytes += history.bytes; count += 1; }
    }
    if (!responses.size) threadHistories.delete(key);
  }
  return { bytes, count, maxBytes: maxHistoryBytes, ttlMs: historyTtlMs };
}

// 轉譯層為了讓 Anthropic 的 thinking 簽章能往返，把 {thinking, signature}
// 編碼進 reasoning 的 encrypted_content。官方後端驗不過這種內容
// （The encrypted content for item ... could not be verified），
// 因此送往非 Anthropic 路由時必須先剝除，否則碰過 Claude 的對話就切不回官方。
function isBridgeReasoning(item) {
  if (item?.type !== "reasoning") return false;
  const enc = item.encrypted_content;
  if (typeof enc !== "string" || !enc) return false;
  try {
    const parsed = JSON.parse(Buffer.from(enc, "base64").toString("utf8"));
    return Boolean(parsed && (
      (typeof parsed.thinking === "string" && parsed.signature) ||
      typeof parsed.redacted_thinking === "string" ||
      (parsed.router_reasoning_ref === 1 && /^[a-f0-9]{64}$/.test(parsed.sha256))
    ));
  } catch {
    return false;
  }
}

export function stripBridgeReasoning(input) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  const kept = input.filter((item) => !isBridgeReasoning(item));
  return { input: kept, removed: input.length - kept.length };
}

// 轉譯層必須替它合成的 message / function_call 補上 item id（串流協定要求），
// 但那是本機隨機鑄的混合大小寫字串。官方後端只認自己發過的 id 格式，會整輪回
// Invalid 'input[n].id'：碰過 Claude 的對話一切回官方模型就卡死。
// 上游發的 id 一律是小寫十六進位，因此「後綴帶大寫」足以辨識出自鑄的 id。
// 這裡只拿掉 id 欄位而不動整個項目：Responses API 的輸入項本來就可以沒有 id，
// 工具配對靠的是 call_id，內容因此完整保留。
export function isBridgeMintedId(value) {
  if (typeof value !== "string") return false;
  const match = /^(?:msg|fc|rs|resp|cmp)_([A-Za-z0-9]{20,})$/.exec(value);
  return match !== null && /[A-Z]/.test(match[1]);
}

export function stripBridgeItemIds(input) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  let removed = 0;
  const mapped = input.map((item) => {
    if (!item || typeof item !== "object" || !isBridgeMintedId(item.id)) {
      return item;
    }
    removed += 1;
    const { id, ...rest } = item;
    return rest;
  });
  return { input: removed > 0 ? mapped : input, removed };
}

// 轉譯層自己合成的 compaction 項目，其 encrypted_content 只有本機解得開。
// 官方後端與其他供應商都認不得，必須在離開 Anthropic 路由前還原成一般訊息，
// 否則壓縮過的對話一切回官方模型就整輪被拒。
export function rewriteBridgeCompaction(input) {
  if (!Array.isArray(input)) return { input, removed: 0 };
  let removed = 0;
  const mapped = input.map((item) => {
    if (item?.type !== "compaction" && item?.type !== "context_compaction") return item;
    const summary = decodeCompaction(item.encrypted_content);
    if (summary === null) return item;
    removed += 1;
    return {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `${COMPACTION_REPLAY_PREFIX}${summary}` }],
    };
  });
  return { input: removed > 0 ? mapped : input, removed };
}

export function historyKeyFor(body, headers, connectionNamespace = null) {
  const sessionId = body?.client_metadata?.session_id;
  let logicalKey = typeof sessionId === "string" && sessionId ? sessionId : null;
  for (const name of ["thread-id", "session-id"]) {
    const value = headers?.[name];
    if (!logicalKey && typeof value === "string" && value) logicalKey = value;
  }
  // client_metadata.session_id 不是 WebSocket 連線識別；背景任務可能和目前 task
  // 重複使用它。歷史重建若只靠 session_id，兩條連線會互相覆蓋完整提示詞。
  // WebSocket 路徑因此以連線 namespace 隔離；HTTP 才沿用既有 logical key。
  if (connectionNamespace) {
    return logicalKey ? `${connectionNamespace}\0${logicalKey}` : connectionNamespace;
  }
  return logicalKey;
}

// 每次嘗試持有自己的暫存副本。只有成功終止才保存，失敗、取消或換傳輸重送
// 都不會改到 previous_response_id 指向的歷史，也不會把同一份工具結果再加一次。
function prepareHistory(key, input, previousId = null) {
  if (!key) return null;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : input;
  return { key, input: Array.isArray(items) ? items.slice() : [], output: [], previousId };
}

function rememberHistoryEvent(history, event) {
  if (!history || history.completed || history.disabled) return;
  const replayable = (item) => item && typeof item === "object" &&
    (item.type !== "reasoning" || item.encrypted_content);
  if (event?.type === "response.output_item.done" && replayable(event.item)) {
    history.outputBytes = (history.outputBytes || 0) + Buffer.byteLength(JSON.stringify(event.item));
    if (history.outputBytes > maxHistoryBytes) {
      history.disabled = true;
      history.input = [];
      history.output = [];
      return;
    }
    history.output.push(event.item);
  }
  if (event?.type !== "response.completed" && event?.type !== "response.incomplete") return;
  const responseId = event.response?.id;
  if (typeof responseId !== "string" || !responseId) return;
  if (Array.isArray(event.response.output) && event.response.output.length) {
    history.output = event.response.output.filter(replayable);
  }
  history.completed = true;
  historyCacheInfo();
  const serialized = JSON.stringify({ input: history.input, output: history.output });
  // 用位元組計帳的不可變快照，避免共享物件被後續轉譯修改；超限不保存半份歷史。
  const bytes = Buffer.byteLength(serialized);
  if (bytes > maxHistoryBytes) return;
  const snapshot = { serialized, bytes, expiresAt: Date.now() + historyTtlMs };
  const responses = history.previousId
    ? threadHistories.get(history.key) || new Map()
    : new Map();
  responses.delete(responseId);
  responses.set(responseId, snapshot);
  while (responses.size > maxResponsesPerHistory) responses.delete(responses.keys().next().value);
  threadHistories.delete(history.key);
  threadHistories.set(history.key, responses);
  while (threadHistories.size > maxRememberedHistories) {
    threadHistories.delete(threadHistories.keys().next().value);
  }
  let total = historyCacheInfo().bytes;
  while (total > maxHistoryBytes) {
    const [key, oldest] = threadHistories.entries().next().value;
    const [id, snapshot] = oldest.entries().next().value;
    total -= snapshot.bytes;
    oldest.delete(id);
    if (!oldest.size) threadHistories.delete(key);
  }
}

function rebuildStatefulInput(key, incomingInput, previousId) {
  historyCacheInfo();
  const snapshot = key ? threadHistories.get(key)?.get(previousId) : null;
  const history = snapshot ? JSON.parse(snapshot.serialized) : null;
  if (!history || history.input.length === 0) return null;
  const incoming = typeof incomingInput === "string" ? [{ role: "user", content: incomingInput }]
    : Array.isArray(incomingInput) ? incomingInput : [];
  return [...history.input, ...history.output, ...incoming];
}

// 從 Claude 轉譯路由切出去時，必須清掉轉譯層合成的內容，否則官方與其他供應商
// 會整輪拒收。官方路由不論走 HTTP 或 WebSocket 都要做這一步。
function stripBridgeArtifacts(body) {
  let result = body;
  const stripped = stripBridgeReasoning(result.input);
  if (stripped.removed > 0) {
    result = { ...result, input: stripped.input };
    stats.bridgeReasoningStripped += stripped.removed;
  }
  const reidentified = stripBridgeItemIds(result.input);
  if (reidentified.removed > 0) {
    result = { ...result, input: reidentified.input };
    stats.bridgeIdsStripped += reidentified.removed;
  }
  const recompacted = rewriteBridgeCompaction(result.input);
  if (recompacted.removed > 0) {
    result = { ...result, input: recompacted.input };
    stats.bridgeCompactionRewritten += recompacted.removed;
  }
  return result;
}

// 本機合成的 view_image 呼叫與它的輸出不能送去上游——那個工具是路由器自己
// 生出來的，上游不認得。所有離開本機的請求都要先過這一關。
function stripRouterImageArtifacts(body) {
  const stripped = stripRouterImageCalls(body?.input);
  if (stripped.removed === 0) return body;
  stats.viewImageCallsStripped += stripped.removed;
  return { ...body, input: stripped.input };
}
const heartbeatIntervalMs =
  Number(settings.heartbeatIntervalMs) > 0 ? Number(settings.heartbeatIntervalMs) : 15000;

const requestHopByHopHeaders = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const responseHeadersToStrip = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);
const customForwardHeaders = new Set([
  "accept",
  "content-type",
  "user-agent",
  "x-client-request-id",
]);

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  websockets: 0,
  websocketResponses: 0,
  websocketEvents: 0,
  heartbeats: 0,
  authProbeFailures: 0,
  authProbeGraceUsed: 0,
  upstreamErrorCloses: 0,
  statefulFallbacks: 0,
  responseFailedSent: 0,
  truncatedUpstreamStreams: 0,
  upstreamErrorsWithoutTerminal: 0,
  oversizeRejects: 0,
  toolImagesOmitted: 0,
  toolImageBytesSaved: 0,
  imageArchiveFailures: 0,
  lastRequestBytesBeforeBudget: null,
  lastRequestBytesAfterBudget: null,
  websocketOnlyFieldsStripped: 0,
  queuedResponses: 0,
  responseInProgressRejects: 0,
  bridgeReasoningStripped: 0,
  bridgeIdsStripped: 0,
  bridgeCompactionRewritten: 0,
  statefulRebuilds: 0,
  statefulRebuildMisses: 0,
  upstreamWebSocketConnects: 0,
  upstreamWebSocketTurns: 0,
  upstreamWebSocketIncremental: 0,
  upstreamWebSocketReplays: 0,
  upstreamWebSocketFallbacks: 0,
  upstreamWebSocketCooldowns: 0,
  imagesSaved: 0,
  imageRequests: 0,
  arkImageRequests: 0,
  catalogRefreshes: 0,
  catalogRefreshFailures: 0,
  catalogModels: 0,
  lastImageStatus: null,
  viewImageCallsInjected: 0,
  viewImageCallsStripped: 0,
  translatedRequests: 0,
  claudeToolDefinitionsDeferred: 0,
  claudeToolDescriptionCharsSaved: 0,
  lastClaudeToolContext: null,
  imagesOmitted: 0,
  officialPassthroughs: 0,
  trailingThinkingTrimmed: 0,
  claudeToolOutputsMerged: 0,
  claudeLateToolOutputs: 0,
  claudeToolResultsReordered: 0,
  lastAuthProbeStatus: null,
  credentialReads: 0,
  foreignHostRejects: 0,
  browserRequestsRejected: 0,
  models: 0,
  official: 0,
  custom: 0,
  reasoningRewrites: 0,
  failures: 0,
  lastOfficialStatus: null,
  lastCustomStatus: null,
  lastWebSocketStatus: null,
  lastRoute: null,
  lastModel: null,
  lastReasoningEffort: null,
  lastForwardedReasoningEffort: null,
  lastError: null,
};
const validatedAuthDigests = new Map();
// 驗證探測只是用來證明呼叫端是已登入的 Codex。chatgpt.com 暫時連不上（網路、代理、
// 官方故障）時，不該連帶讓中轉模型也不能用——那正是最需要中轉當備援的時候。
// 同一組憑證在寬限期內真的驗證成功過，探測遇到網路錯誤或 401/403 以外的失敗就放行；
// 401/403 代表憑證本身被拒，照樣拒絕並清掉寬限紀錄。
const authProbeGraceMs = Number.isSafeInteger(settings.authProbeGraceMs) && settings.authProbeGraceMs >= 0
  ? settings.authProbeGraceMs : 24 * 60 * 60 * 1000;
const lastAuthSuccess = new Map();
const threadRoutes = new Map();

class RouterRequestError extends Error {
  constructor(status, code, message, phase = "request", upstreamStatus = null) {
    super(message);
    Object.assign(this, { status, code, phase, upstreamStatus });
  }
}

export function describeRouterError(error) {
  if (error?.name === "BridgeRequestError") {
    return { status: 422, code: "unsupported_bridge_input", message: error.message, phase: "translation", upstreamStatus: null, causeCode: null };
  }
  if (error instanceof RouterRequestError) {
    const { status, code, message, phase, upstreamStatus } = error;
    return { status, code, message, phase, upstreamStatus, causeCode: null };
  }
  const chain = [];
  const visit = (value, depth = 0) => {
    if (!value || depth > 5 || chain.includes(value)) return;
    chain.push(value);
    visit(value.cause, depth + 1);
    for (const nested of Array.isArray(value.errors) ? value.errors.slice(0, 8) : []) {
      visit(nested, depth + 1);
    }
  };
  visit(error);
  const codes = chain.map((item) => item.code).filter(
    (code) => typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code),
  );
  let status = 502;
  let code = "upstream_network_error";
  let message = "無法完成上游請求，請檢查網路或稍後重試。";
  let causeCode = codes.find((value) => /TIMEOUT|ETIMEDOUT/.test(value));
  if (causeCode || chain.some((item) => item.name === "TimeoutError")) {
    status = 504;
    code = "upstream_timeout";
    message = "上游請求逾時，請檢查網路或稍後重試。";
  } else if ((causeCode = codes.find((value) => /^(ENOTFOUND|EAI_AGAIN)$/.test(value)))) {
    code = "upstream_dns_error";
    message = "無法解析上游主機名稱（DNS），請檢查網路、DNS 或 Base URL。";
  } else if ((causeCode = codes.find((value) => /CERT|TLS|SSL|VERIFY_LEAF|SELF_SIGNED/.test(value)))) {
    code = "upstream_tls_error";
    message = "上游 TLS／憑證驗證失敗，請檢查伺服器憑證、系統時間或代理設定。";
  } else if ((causeCode = codes.find((value) => /^(ECONNREFUSED|ECONNRESET|EPIPE|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET)$/.test(value)))) {
    code = "upstream_connection_error";
    message = "上游連線失敗或中斷，請檢查上游服務、網路或代理設定。";
  }
  return {
    status, code, message, phase: error?.phase || "request",
    causeCode: causeCode || codes[0] || null, upstreamStatus: null,
  };
}

function recordRouterError(error, context = {}, countFailure = true) {
  const details = describeRouterError(error);
  const requestId = randomBytes(8).toString("hex");
  const endpoint = details.phase === "auth_probe" || context.route !== "custom" ? officialBase : apiRoot;
  const record = {
    at: new Date().toISOString(), requestId,
    transport: context.transport || null, route: context.route || null,
    model: typeof context.model === "string" ? context.model.slice(0, 160) : null,
    upstreamHost: new URL(endpoint).host,
    ...details,
  };
  // 不記錄原始例外訊息、標頭、Key 或請求內文；cause.code 已足夠定位網路故障。
  stats.lastError = record;
  if (countFailure) stats.failures += 1;
  process.stderr.write(`model-router-error:${JSON.stringify(record)}\n`);
  return { ...details, requestId };
}

function recordUpstreamFailure(upstream, context) {
  if (upstream.status < 400) return;
  const status = upstream.status;
  const code = status === 401 || status === 403 ? "upstream_auth_rejected"
    : status === 429 ? "upstream_rate_limited" : "upstream_http_error";
  recordRouterError(new RouterRequestError(
    status, code, `上游服務返回 HTTP ${status}。`, "upstream", status,
  ), context);
}

function writeJson(response, status, payload) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

// 憑證來源：macOS 讀鑰匙圈；Windows 解 DPAPI 密文檔（entropy 就是 keychainService）。
//
// 一定要非同步：Windows 起 powershell.exe 解 DPAPI 每次要 1 秒以上，同步呼叫期間
// 整個路由器（所有對話的串流、WebSocket 心跳）都會停住。
async function runSecretCommand(file, args, options = {}) {
  const pending = execFileAsync(file, args, { encoding: "utf8", maxBuffer: 1024 * 1024, ...options });
  // 不給子行程任何輸入；PowerShell 在 stdin 是未關閉的管線時可能一直等待。
  pending.child.stdin?.end();
  const { stdout } = await pending;
  return stdout.trim();
}

export async function readStoredSecret() {
  if (process.platform !== "win32") {
    return runSecretCommand("/usr/bin/security", [
      "find-generic-password",
      "-a",
      keychainAccount,
      "-s",
      keychainService,
      "-w",
    ]);
  }
  if (!credentialPath) throw new Error("設定中缺少憑證檔案路徑");
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Security",
    "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false",
    `$blob = [Convert]::FromBase64String(([IO.File]::ReadAllText(${quote(credentialPath)})).Trim())`,
    `$entropy = [Text.Encoding]::UTF8.GetBytes(${quote(keychainService)})`,
    "$plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))",
  ].join("\n");
  return runSecretCommand("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ], { windowsHide: true });
}

// 金鑰快取。fingerprint 變了（Windows 的密文檔被重新寫入）就重讀，否則在 TTL 內沿用；
// 同時間的多個請求共用同一次讀取。reload 用在上游回 401/403 時強制重讀。
export function createSecretCache({ read, fingerprint = () => null, ttlMs, now = Date.now }) {
  let cached = null;
  let pending = null;
  return async function get({ reload = false } = {}) {
    const current = fingerprint();
    if (!reload && cached && cached.fingerprint === current && cached.expiresAt > now()) return cached.value;
    if (!pending) {
      pending = (async () => {
        try {
          const value = await read();
          if (!value) throw new Error("自訂供應商的憑證為空");
          cached = { value, fingerprint: current, expiresAt: now() + ttlMs };
          return value;
        } finally {
          pending = null;
        }
      })();
    }
    return pending;
  };
}

// Windows 的密文檔只在安裝器換 Key 時改寫；stat 幾乎不花時間，可以每次檢查。
// macOS 的鑰匙圈沒有等價的廉價檢查，沿用較短的 TTL（讀取本身只要數十毫秒）。
function credentialFingerprint() {
  if (process.platform !== "win32" || !credentialPath) return null;
  try {
    const info = statSync(credentialPath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

const cachedApiKey = createSecretCache({
  read: async () => {
    stats.credentialReads += 1;
    return readStoredSecret();
  },
  fingerprint: credentialFingerprint,
  ttlMs: process.platform === "win32" && credentialPath ? credentialCacheTtlMs : tokenCacheTtlMs,
});

async function getApiKey(reload = false) {
  if (process.env.CODEX_MODEL_ROUTER_TEST_API_KEY) {
    return process.env.CODEX_MODEL_ROUTER_TEST_API_KEY;
  }
  return cachedApiKey({ reload });
}

function appendHeader(headers, name, value) {
  if (Array.isArray(value)) {
    for (const entry of value) headers.append(name, entry);
  } else {
    headers.set(name, value);
  }
}

function buildOfficialHeaders(requestHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(requestHeaders)) {
    const normalized = name.toLowerCase();
    if (
      requestHopByHopHeaders.has(normalized) ||
      normalized.startsWith("sec-websocket-") ||
      value == null
    ) {
      continue;
    }
    appendHeader(headers, name, value);
  }
  return headers;
}

function buildCustomHeaders(requestHeaders, apiKey) {
  const headers = new Headers({ authorization: `Bearer ${apiKey}` });
  for (const [name, value] of Object.entries(requestHeaders)) {
    if (!customForwardHeaders.has(name.toLowerCase()) || value == null) continue;
    appendHeader(headers, name, value);
  }
  if (!headers.has("accept")) headers.set("accept", "text/event-stream");
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

function filteredResponseHeaders(upstreamHeaders) {
  const headers = {};
  for (const [name, value] of upstreamHeaders) {
    if (!responseHeadersToStrip.has(name.toLowerCase())) headers[name] = value;
  }
  return headers;
}

function authDigest(headers) {
  const authorization = headers.authorization;
  const accountId = headers["chatgpt-account-id"];
  if (
    typeof authorization !== "string" ||
    !authorization.startsWith("Bearer ") ||
    typeof accountId !== "string" ||
    !accountId
  ) {
    return null;
  }
  return createHash("sha256")
    .update(authorization)
    .update("\0")
    .update(accountId)
    .digest("hex");
}

// verified=false 只延長短期快取（寬限期放行時用），不會把寬限期本身往後延。
export function markAuthValidated(headers, { verified = true } = {}) {
  const digest = authDigest(headers);
  if (!digest) return;
  if (verified) {
    lastAuthSuccess.delete(digest);
    lastAuthSuccess.set(digest, Date.now());
    while (lastAuthSuccess.size > maxValidatedAuthDigests) lastAuthSuccess.delete(lastAuthSuccess.keys().next().value);
  }
  // 過期項目只在「同一個摘要再被查一次」時才會被刪。憑證輪替後舊摘要再也不會
  // 被查到，就會一直留著。這裡在成長到上限時掃一次，掃完仍超出就汰換最舊的。
  if (validatedAuthDigests.size >= maxValidatedAuthDigests) {
    const now = Date.now();
    for (const [key, expiresAt] of validatedAuthDigests) {
      if (expiresAt <= now) validatedAuthDigests.delete(key);
    }
    while (validatedAuthDigests.size >= maxValidatedAuthDigests) {
      const oldest = validatedAuthDigests.keys().next().value;
      if (oldest === undefined) break;
      validatedAuthDigests.delete(oldest);
    }
  }
  validatedAuthDigests.delete(digest);
  validatedAuthDigests.set(digest, Date.now() + authValidationTtlMs);
}

export function hasValidatedAuth(headers) {
  const digest = authDigest(headers);
  if (!digest) return false;
  const expiresAt = validatedAuthDigests.get(digest);
  if (!expiresAt || expiresAt <= Date.now()) {
    validatedAuthDigests.delete(digest);
    return false;
  }
  return true;
}

function allowDuringAuthOutage(headers, reason) {
  const digest = authDigest(headers);
  const lastSuccess = digest ? lastAuthSuccess.get(digest) : undefined;
  if (lastSuccess === undefined || Date.now() - lastSuccess > authProbeGraceMs) return false;
  stats.authProbeGraceUsed += 1;
  process.stderr.write(`model-router-auth-probe-grace:${reason}\n`);
  // 探測持續失敗期間，不必每個請求都再等一次逾時。
  markAuthValidated(headers, { verified: false });
  return true;
}

async function validateOfficialAuth(requestHeaders, signal) {
  if (hasValidatedAuth(requestHeaders)) return true;
  if (!authDigest(requestHeaders)) {
    throw new RouterRequestError(401, "chatgpt_auth_required", "需要 ChatGPT 身份驗證。", "auth_probe");
  }
  let upstream;
  const timeout = AbortSignal.timeout(15000);
  const probeSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  stats.lastAuthProbeStatus = null;
  try {
    upstream = await fetch(`${officialBase}/models`, {
      headers: buildOfficialHeaders(requestHeaders),
      redirect: "manual",
      signal: probeSignal,
    });
    await upstream.arrayBuffer();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    stats.authProbeFailures += 1;
    if (allowDuringAuthOutage(requestHeaders, "network")) return true;
    throw Object.assign(new Error("ChatGPT 驗證探測失敗", { cause: error }), { phase: "auth_probe" });
  }
  stats.lastAuthProbeStatus = upstream.status;
  if (upstream.status === 401 || upstream.status === 403) {
    stats.authProbeFailures += 1;
    lastAuthSuccess.delete(authDigest(requestHeaders));
    throw new RouterRequestError(
      upstream.status, "chatgpt_auth_rejected",
      `ChatGPT 身份驗證遭拒（HTTP ${upstream.status}），請檢查登入狀態或帳號權限。`,
      "auth_probe", upstream.status,
    );
  }
  // 缺少 client_version 會回 400，沿用相容處理；服務故障或重新導向不能快取成驗證成功。
  if (!upstream.ok && upstream.status !== 400) {
    stats.authProbeFailures += 1;
    if (allowDuringAuthOutage(requestHeaders, `http-${upstream.status}`)) return true;
    throw new RouterRequestError(
      upstream.status === 429 ? 429 : 503, "auth_probe_unavailable",
      `ChatGPT 驗證服務暫時不可用（HTTP ${upstream.status}），請稍後重試。`,
      "auth_probe", upstream.status,
    );
  }
  markAuthValidated(requestHeaders);
  return true;
}

function rememberRoute(headers, route) {
  for (const headerName of ["thread-id", "session-id"]) {
    const id = headers[headerName];
    if (typeof id !== "string" || !id) continue;
    threadRoutes.delete(id);
    threadRoutes.set(id, route);
  }
  while (threadRoutes.size > maxRememberedThreads) {
    const first = threadRoutes.keys().next().value;
    if (!first) break;
    threadRoutes.delete(first);
  }
}

function rememberedRoute(headers) {
  for (const headerName of ["thread-id", "session-id"]) {
    const id = headers[headerName];
    if (typeof id === "string" && threadRoutes.has(id)) return threadRoutes.get(id);
  }
  return null;
}

function chooseRoute(headers, body) {
  if (typeof body?.model === "string" && routeMap.has(body.model)) {
    return routeMap.get(body.model);
  }
  if (typeof body?.model === "string" && body.model.startsWith("custom/")) {
    throw new RouterRequestError(
      404, "custom_model_not_configured",
      "此自訂模型未配置或路由已遺失，請重新添加模型，並在新任務中選擇已配置的模型。",
      "routing",
    );
  }
  if (typeof body?.model === "string") return null;
  return rememberedRoute(headers);
}

function fallbackEffort(efforts) {
  for (const effort of ["max", "xhigh", "high", "medium", "low"]) {
    if (efforts.includes(effort)) return effort;
  }
  return null;
}

function rewriteCustomBody(body, route) {
  const rewritten = { ...body, model: route.upstreamModel };
  const requestedEffort = body?.reasoning?.effort;
  if (route.stripReasoning || route.efforts.length === 0) {
    delete rewritten.reasoning;
    if (body?.reasoning) stats.reasoningRewrites += 1;
    return rewritten;
  }
  if (requestedEffort && !route.efforts.includes(requestedEffort)) {
    const effort = fallbackEffort(route.efforts);
    rewritten.reasoning = effort ? { ...body.reasoning, effort } : undefined;
    stats.reasoningRewrites += 1;
  }
  return rewritten;
}

// Codex 只設定一個 base URL，凡是送到這裡而路由器沒有特別處理的路徑，本來就都是
// 要給官方後端的：網路查詢走 POST /v1/alpha/search，筆記與歷史走
// /v1/alpha/notes/v2/* 與 /v1/alpha/history/v2/*。原本一律回 404，等於把這幾組
// 功能整組打掉，而且失敗得很安靜——只有呼叫端看得到那個 404。
//
// 這裡不自己驗證身分，原樣轉送即可：官方後端本來就會自己判斷。
async function proxyToOfficial(request, response, incomingUrl) {
  const body = decodeRequestBody(await readRequestBody(request), request.headers["content-encoding"]);
  const controller = new AbortController();
  response.on("close", () => { if (!response.writableFinished) controller.abort(); });
  const init = {
    method: request.method,
    headers: buildOfficialHeaders(request.headers),
    redirect: "manual",
    signal: controller.signal,
  };
  if (body.length > 0) init.body = body;
  const upstream = await fetch(targetUrl(false, incomingUrl), init);
  stats.officialPassthroughs += 1;
  stats.lastOfficialStatus = upstream.status;
  await streamUpstream(upstream, response);
}

export function targetUrl(custom, incomingUrl) {
  const path = incomingUrl.pathname.startsWith("/v1/")
    ? incomingUrl.pathname.slice(3)
    : incomingUrl.pathname;
  const base = custom ? apiRoot : officialBase;
  return new URL(`${base}${path}${incomingUrl.search}`);
}

export async function streamUpstream(upstream, response, history = null, responsesStream = false) {
  response.writeHead(upstream.status, filteredResponseHeaders(upstream.headers));
  if (!upstream.body) {
    response.end();
    return;
  }
  let sawTerminal = false;
  let upstreamError = null;
  const observe = (responsesStream || history) && upstream.ok && upstream.headers.get("content-type")?.includes("text/event-stream")
    ? observeResponsesSse((event) => {
      if (isTerminalEvent(event)) { sawTerminal = true; response.routerTerminalSent = true; }
      else if (event?.type === "error") upstreamError = event;
      rememberHistoryEvent(history, event);
    })
    : null;
  response.routerResponsesStream = Boolean(observe);
  let jsonChunks = history && upstream.ok && !observe ? [] : null;
  let jsonBytes = 0;
  for await (const chunk of upstream.body) {
    observe?.write(chunk);
    if (jsonChunks) {
      jsonBytes += chunk.length;
      if (jsonBytes > maxHistoryBytes) jsonChunks = null;
      else jsonChunks.push(Buffer.from(chunk));
    }
    if (!response.write(chunk)) await once(response, "drain");
  }
  observe?.finish();
  if (observe && !sawTerminal) {
    let event;
    if (upstreamError) event = responseFailedFromErrorEvent(upstreamError);
    else {
      noteTruncatedStream();
      event = responseFailedEvent("upstream_stream_truncated", truncatedStreamMessage);
    }
    response.write("\n\nevent: response.failed\ndata: " + JSON.stringify(event) + "\n\n");
    response.routerTerminalSent = true;
  }
  if (jsonChunks) {
    try {
      const result = JSON.parse(Buffer.concat(jsonChunks).toString("utf8"));
      if (result.status === "completed" || result.status === "incomplete") {
        rememberHistoryEvent(history, { type: `response.${result.status}`, response: result });
      }
    } catch { /* 非 Responses JSON 不作歷史保存，仍原樣回傳。 */ }
  }
  response.end();
}

async function fetchCustom(target, headers, body, signal) {
  let apiKey = await getApiKey(false);
  let upstream = await fetch(target, {
    method: "POST",
    headers: buildCustomHeaders(headers, apiKey),
    body,
    redirect: "manual",
    signal,
  });
  if (upstream.status !== 401 && upstream.status !== 403) return upstream;
  await upstream.arrayBuffer();
  apiKey = await getApiKey(true);
  return fetch(target, {
    method: "POST",
    headers: buildCustomHeaders(headers, apiKey),
    body,
    redirect: "manual",
    signal,
  });
}

export async function fetchModelUpstream(
  requestHeaders,
  incomingUrl,
  body,
  bodyBuffer,
  signal,
  meta = {},
) {
  const route = chooseRoute(requestHeaders, body);
  rememberRoute(requestHeaders, route);
  const isCustom = route != null;

  // HTTP 回退與第三方上游不保證支援 previous_response_id，從對應的成功回合重播。
  const historyKey = historyKeyFor(body, requestHeaders, meta.connectionNamespace);
  meta.historyKey = historyKey;
  let effectiveBody = body;
  if (body?.previous_response_id) {
    const rebuilt = rebuildStatefulInput(historyKey, body.input, body.previous_response_id);
    if (rebuilt) {
      effectiveBody = { ...body, input: rebuilt };
      delete effectiveBody.previous_response_id;
      stats.statefulRebuilds += 1;
    } else {
      stats.statefulRebuildMisses += 1;
      throw new RouterRequestError(
        409, "router_history_unavailable",
        "找不到 previous_response_id 對應的完整歷史，請重連並重送完整對話。",
        "history",
      );
    }
  }
  meta.history = prepareHistory(historyKey, effectiveBody.input, body?.previous_response_id);

  // 只有 Anthropic 轉譯路由能解讀自己產生的 reasoning，其餘路由一律剝除；
  // 自鑄的 item id 同理，留著會讓上游拒收整輪請求。
  if (route?.translate !== "anthropic") {
    effectiveBody = stripBridgeArtifacts(effectiveBody);
  }

  // 這一步對每一條路由都要做：view_image 是路由器自己合成的，沒有任何上游認得它。
  effectiveBody = stripRouterImageArtifacts(effectiveBody);

  let outboundBodyObject = isCustom
    ? rewriteCustomBody(effectiveBody, route)
    : effectiveBody;
  let outboundBody = Buffer.from(JSON.stringify(outboundBodyObject));

  stats.lastRoute = isCustom ? "custom" : "official";
  stats.lastModel = body?.model ?? null;
  stats.lastReasoningEffort = body?.reasoning?.effort ?? null;
  stats.lastForwardedReasoningEffort =
    outboundBodyObject?.reasoning?.effort ?? null;

  if (isCustom) {
    await validateOfficialAuth(requestHeaders, signal);
    stats.custom += 1;
    if (route.translate === "anthropic") {
      // 部分閘道的 Responses 相容層對 Claude 有缺陷，改走原生 /messages 並本機轉譯。
      const { request: anthropicRequest, freeform, toolTargets, compaction, imagesOmitted,
        thinkingTrimmed, toolContext, toolOutputsMerged, lateToolOutputs,
        toolResultsReordered } = toAnthropicRequest(effectiveBody, route);
      if (imagesOmitted > 0) stats.imagesOmitted += imagesOmitted;
      if (thinkingTrimmed > 0) stats.trailingThinkingTrimmed += thinkingTrimmed;
      // 同一個 call_id 的多筆輸出（例如 Code Mode 的 notify()）如何被收斂成
      // Anthropic 可接受的單一 tool_result；每次轉譯都會重算，同一段歷史重送會再累加。
      stats.claudeToolOutputsMerged += toolOutputsMerged;
      stats.claudeLateToolOutputs += lateToolOutputs;
      stats.claudeToolResultsReordered += toolResultsReordered;
      stats.claudeToolDefinitionsDeferred += toolContext.toolsDeferred;
      stats.claudeToolDescriptionCharsSaved += toolContext.charsSaved;
      stats.lastClaudeToolContext = toolContext;
      meta.translate = "anthropic";
      meta.freeform = freeform;
      meta.toolTargets = toolTargets;
      meta.compaction = compaction;
      meta.model = body.model;
      meta.requestBody = effectiveBody;
      const budget = budgetToolImages(anthropicRequest, { anthropic: true });
      recordImageBudget(budget);
      meta.anthropicRequest = budget.request;
      stats.translatedRequests += 1;
      const anthropicBody = budget.buffer;
      if (upstreamRequestTooLarge(anthropicBody.length)) {
        return oversizeResponse(anthropicBody.length);
      }
      const translated = await fetchCustom(
        new URL(`${apiRoot}/messages`),
        requestHeaders,
        anthropicBody,
        signal,
      );
      stats.lastCustomStatus = translated.status;
      recordUpstreamFailure(translated, { transport: meta.transport, route: "custom", model: body?.model });
      return translated;
    }
    const budget = budgetToolImages(outboundBodyObject);
    recordImageBudget(budget);
    outboundBody = budget.buffer;
    if (upstreamRequestTooLarge(outboundBody.length)) {
      return oversizeResponse(outboundBody.length);
    }
    const upstream = await fetchCustom(
      targetUrl(true, incomingUrl),
      requestHeaders,
      outboundBody,
      signal,
    );
    stats.lastCustomStatus = upstream.status;
    recordUpstreamFailure(upstream, { transport: meta.transport, route: "custom", model: body?.model });
    return upstream;
  }

  if (!authDigest(requestHeaders)) {
    return new Response(
      JSON.stringify({
        error: { message: "需要 ChatGPT 身份驗證", type: "auth_error" },
      }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }
  stats.official += 1;
  const upstream = await fetch(targetUrl(false, incomingUrl), {
    method: "POST",
    headers: buildOfficialHeaders(requestHeaders),
    body: outboundBody.length > 0 ? outboundBody : bodyBuffer, // outboundBody 已含重建結果
    redirect: "manual",
    signal,
  });
  stats.lastOfficialStatus = upstream.status;
  recordUpstreamFailure(upstream, { transport: meta.transport, route: "official", model: body?.model });
  if (upstream.status === 200) markAuthValidated(requestHeaders);
  return upstream;
}

// Codex 內建的 image_gen 工具打的是 /v1/images/generations。路由器原本只認
// /healthz、/models 與 /responses，其餘一律回自己的 404——所以使用者看到的
// 「內建圖片生成服務回傳 404」其實是路由器擋掉的，跟上游無關。
//
// 官方後端沒有這條路徑（officialBase 是 .../backend-api/codex），但自訂閘道有，
// 因此一律轉給自訂閘道。閘道若不支援，它自己的錯誤訊息也比路由器的 404 有用。
export const IMAGE_PATH_PATTERN = /^\/(?:v1\/)?images\/(?:generations|edits|variations)$/;
export const ARK_IMAGE_PATH_PATTERN = /^\/v2\/extend\/image\/ark_gpt_image\/(?:generations|edits|tasks\/[A-Za-z0-9_-]{1,160})$/;

// 路由器只聽 127.0.0.1，但瀏覽器裡的任何網頁都能對它發請求：跨站的「簡單請求」
// （text/plain、multipart/form-data 的 POST）不會觸發 CORS 預檢，照樣送達；
// DNS rebinding 更能讓惡意網頁以同源身分送出請求並讀到回應。兩層防護：
//
//   1. Host 只接受本機名稱。DNS rebinding 的請求帶的是攻擊者的網域。
//   2. 花費中轉額度、又不要求 ChatGPT 憑證的端點（生圖、Ark）拒絕瀏覽器請求。
//      瀏覽器的 POST 一定帶 Origin，現行瀏覽器的每個請求也都帶 Sec-Fetch-Site；
//      Codex 本身與 imagegen 命令（Node fetch）兩者都不帶。
//
// /responses 不必另外擋：自訂路由本來就要求 ChatGPT 憑證，瀏覽器頁面拿不到。
const loopbackHostnames = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function isLoopbackHost(value) {
  // HTTP/1.0 等不帶 Host 的用戶端不會是瀏覽器。
  if (typeof value !== "string" || !value) return true;
  const host = value.trim().toLowerCase();
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.replace(/:\d+$/, "");
  return loopbackHostnames.has(name.replace(/\.$/, ""));
}

export function isBrowserRequest(headers) {
  if (headers?.origin != null) return true;
  const site = headers?.["sec-fetch-site"];
  // none 代表使用者自己在網址列開啟，不是網頁發起的請求。
  return typeof site === "string" && site !== "none";
}

function rejectBrowserRequest(request, response) {
  if (!isBrowserRequest(request.headers)) return false;
  stats.browserRequestsRejected += 1;
  writeJson(response, 403, {
    error: {
      message: "拒絕來自瀏覽器網頁的生圖請求：這個端點會使用中轉 API Key，只接受 Codex 與本機命令。",
      type: "router_error",
      code: "browser_request_rejected",
    },
  });
  return true;
}

async function handleArkImages(request, response, incomingUrl) {
  const taskQuery = incomingUrl.pathname.includes("/tasks/");
  if (!ARK_IMAGE_PATH_PATTERN.test(incomingUrl.pathname) || request.method !== (taskQuery ? "GET" : "POST")) {
    writeJson(response, 404, { error: { message: "未知的 Ark 圖片任務端點。" } });
    return;
  }
  if (rejectBrowserRequest(request, response)) return;
  request.routerContext.route = "custom";
  if (authDigest(request.headers)) await validateOfficialAuth(request.headers);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxUpstreamRequestBytes) { writeJson(response, 413, { error: { message: "Ark 圖片請求過大。" } }); return; }
    chunks.push(chunk);
  }
  const controller = new AbortController();
  request.on("aborted", () => controller.abort());
  response.on("close", () => { if (!response.writableFinished) controller.abort(); });
  // 此路徑相對於已配置的供應商 origin，不接在 /v1 後，也不轉送官方後端。
  // 任務提交只發一次，不以 401/403 為由重送付費提交。Key 由快取提供：Windows 的密文檔
  // 一改寫就會重讀，不必每次都起 PowerShell（任務輪詢每 2 秒一次，以前每次都卡住路由器）。
  const apiKey = await getApiKey();
  const upstream = await fetch(new URL(incomingUrl.pathname, new URL(apiRoot).origin), {
    method: request.method, headers: buildCustomHeaders(request.headers, apiKey),
    body: taskQuery ? undefined : Buffer.concat(chunks), redirect: "manual", signal: controller.signal,
  });
  stats.arkImageRequests += 1;
  stats.lastImageStatus = upstream.status;
  await streamUpstream(upstream, response);
}

async function handleImages(request, response, incomingUrl) {
  // 與自訂模型同一套驗證，但只在請求真的帶了 ChatGPT 憑證時才驗。
  // image_gen 是用戶端工具，未必會帶上 /responses 那組標頭；若因為缺標頭就擋下，
  // 使用者只會從一個 404 換成一個 401，問題沒解決。路由器只聽 127.0.0.1，
  // 因此放行沒有標頭的請求；但瀏覽器網頁發起的請求一律拒絕（見 isBrowserRequest）。
  if (rejectBrowserRequest(request, response)) return;
  request.routerContext.route = "custom";
  if (authDigest(request.headers)) await validateOfficialAuth(request.headers);
  const rawBody = await readRequestBody(request);

  const abortController = new AbortController();
  request.on("aborted", () => abortController.abort());
  response.on("close", () => { if (!response.writableFinished) abortController.abort(); });

  // 影像請求可能是 multipart（edits），因此原樣轉發位元組，不做解析。
  const path = incomingUrl.pathname.startsWith("/v1/")
    ? incomingUrl.pathname.slice(3)
    : incomingUrl.pathname;
  const upstream = await fetchCustom(
    new URL(`${apiRoot}${path}${incomingUrl.search}`),
    request.headers,
    rawBody,
    abortController.signal,
  );
  stats.imageRequests += 1;
  stats.lastImageStatus = upstream.status;
  await streamUpstream(upstream, response);
}

async function handleResponses(request, response, incomingUrl) {
  const encoding = request.headers["content-encoding"];
  if (encoding && encoding !== "identity" && encoding !== "zstd") {
    writeJson(response, 415, {
      error: { message: "不支援的請求內容編碼", type: "router_error" },
    });
    return;
  }
  const encodedBody = await readRequestBody(request);
  const decodedBody = decodeRequestBody(encodedBody, encoding);
  let body;
  try {
    body = JSON.parse(decodedBody.toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid request object");
  } catch {
    writeJson(response, 400, { error: { message: "JSON 格式無效", type: "router_error" } });
    return;
  }
  request.routerContext.model = body?.model;
  request.routerContext.route = typeof body?.model === "string" && body.model.startsWith("custom/")
    ? "custom" : "official";

  const abortController = new AbortController();
  let finished = false;
  request.on("aborted", () => abortController.abort());
  response.on("finish", () => {
    finished = true;
  });
  response.on("close", () => {
    if (!finished) abortController.abort();
  });

  const meta = { transport: "http" };
  // 擷取原本只蓋 WebSocket 路徑。但 Codex 反覆握手失敗後會退回 HTTPS，之後所有
  // 請求都走這裡——上游在這條路上出錯時，開了擷取也一個檔案都拿不到。
  const captureId = captureNext(
    typeof body.model === "string" && routeMap.has(body.model) ? "custom-http" : "official-http",
  );
  captureWrite(captureId, "request.json", JSON.stringify(body, null, 2));
  const upstream = await fetchModelUpstream(
    request.headers,
    incomingUrl,
    body,
    decodedBody,
    abortController.signal,
    meta,
  );
  if (meta.anthropicRequest) {
    captureWrite(
      captureId,
      "anthropic-request.json",
      JSON.stringify(meta.anthropicRequest, null, 2),
    );
  }
  captureWrite(captureId, "upstream-status.txt", `${upstream.status}\n`);
  if (meta.translate === "anthropic" && upstream.status >= 200 && upstream.status < 300) {
    await bridgeAnthropicToHttp(upstream, response, meta);
    return;
  }
  // Anthropic 的錯誤內文是 {type:"error", error:{type, message}}，Codex 看的是 OpenAI
  // 形狀的 error.code。改寫成它認得的值，例如 prompt is too long → context_length_exceeded。
  if (meta.translate === "anthropic") {
    const text = await upstream.text();
    captureWrite(captureId, "upstream-error.txt", text);
    const retryAfter = upstream.headers.get("retry-after");
    const details = upstreamErrorDetails(upstream.status, text, retryAfter);
    response.writeHead(upstream.status, {
      "content-type": "application/json",
      ...(retryAfter ? { "retry-after": retryAfter } : {}),
    });
    response.end(JSON.stringify({ error: { ...details.error, code: details.code, message: details.message } }));
    return;
  }
  // 只有開了擷取才走這條：把上游的錯誤內文留下來再原樣回覆。上游錯誤的正文
  // 常比客戶端顯示的那一行詳細，而它一旦串出去就沒了。
  if (captureId && (upstream.status < 200 || upstream.status >= 300)) {
    const text = await upstream.text();
    captureWrite(captureId, "upstream-error.txt", text);
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") || "application/json",
    });
    response.end(text);
    return;
  }
  await streamUpstream(upstream, response, meta.history, true);
}

const websocketMagic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
// 本機必須先收得到含舊截圖的完整請求，才有機會縮減；與上游 32 MB 門檻分開。
// 仍設有限的接收上限，避免依不合理的訊框長度配置記憶體。
const maxWebSocketMessageBytes = 128 * 1024 * 1024;

export function encodeWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length <= 125) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

function sendWebSocketFrame(socket, opcode, payload) {
  if (!socket.destroyed && socket.writable) {
    socket.write(encodeWebSocketFrame(opcode, payload));
  }
}

// Codex 不處理 type:"error"（日誌: unhandled responses event），只送它會無聲卡死。
// 413 會被既有的錯誤路徑接住：HTTP 那條原樣轉發，WebSocket 那條轉成
// type:"error" 加 response.failed。因此這裡不必自己處理兩種傳輸。
function oversizeResponse(bytes) {
  stats.oversizeRejects += 1;
  process.stderr.write(`model-router-request-too-large:${bytes}\n`);
  return new Response(
    JSON.stringify({
      error: {
        message: oversizeMessage(bytes, maxUpstreamRequestBytes),
        type: "router_error",
        code: "request_too_large",
      },
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}

// response.failed 是 Responses API 標準的失敗終止事件，Codex 有對應處理。
// 所有錯誤路徑都必須經過這裡，否則就會留下卡死的缺口。
function responseFailedEvent(code, message) {
  return {
    type: "response.failed",
    sequence_number: 0,
    response: {
      id: `resp_router_${Date.now().toString(36)}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "failed",
      error: { code: String(code), message: String(message) },
      incomplete_details: null,
      output: [],
      usage: null,
    },
  };
}

function sendResponseFailed(socket, code, message) {
  sendWebSocketJson(socket, responseFailedEvent(code, message));
  stats.responseFailedSent += 1;
}

// 上游串流可以在沒送出任何終止事件的情況下「乾淨」結束——代理把串流丟掉時，
// 讀取端看到的是 EOF 而不是例外，所以 catch 接不到；非 2xx 的檢查也早就過了，
// 因為標頭當初是 200。此時若就這樣收工關閉連線，Codex 只會看到
// 「websocket closed by server before response.completed」，等同無聲卡死。
// 凡是逐塊讀上游串流的地方，讀完都要確認終止事件真的送出去了。
//
// 頂層的 error 不算終止事件：Codex 只認下面三種，單獨的 error 會被直接忽略，
// WebSocket 上要空等閒置逾時（預設 300 秒）才重試。上游送了 error 就結束串流時，
// 用 responseFailedFromErrorEvent 把它的內容轉成 response.failed 補上。
const terminalEventTypes = new Set([
  "response.completed",
  "response.failed",
  "response.incomplete",
]);

export function isTerminalEvent(event) {
  return terminalEventTypes.has(event?.type);
}

// 上游 error 事件有兩種形狀：Responses 串流的 {type, code, message}，以及包一層的
// {type, error: {type, code, message}, status}。錯誤碼換成 Codex 認得的值。
export function responseFailedFromErrorEvent(event) {
  const source = event?.error && typeof event.error === "object" ? event.error : event;
  const { code, message } = codexErrorFromUpstream({
    code: source?.code,
    type: source?.type === "error" ? null : source?.type,
    message: source?.message,
  }, { status: Number.isInteger(event?.status) ? event.status : null });
  stats.upstreamErrorsWithoutTerminal += 1;
  return responseFailedEvent(code, message);
}

// 非 2xx 回應的內文：OpenAI 形狀 {error: {...}}、Anthropic 形狀 {type, error: {...}}、
// 少數閘道的 {error: "文字"}，或根本不是 JSON。error 保留上游原樣，code／message
// 換成 Codex 認得的形式。
export function upstreamErrorDetails(status, rawText, retryAfter = null) {
  let payload = null;
  try { payload = JSON.parse(rawText); } catch {}
  const error = typeof payload?.error === "string"
    ? { message: payload.error }
    : (payload?.error && typeof payload.error === "object" ? payload.error : null);
  const seconds = Number(retryAfter);
  const mapped = codexErrorFromUpstream(error || { message: rawText || "" }, {
    status,
    retryAfterSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : null,
  });
  return {
    error: error || { type: "router_upstream_error", code: String(status), message: mapped.message },
    ...mapped,
  };
}

const truncatedStreamMessage = "上游串流在送出終止事件前就結束";

function noteTruncatedStream() {
  stats.truncatedUpstreamStreams += 1;
  process.stderr.write("model-router-upstream-stream-truncated\n");
}

function sendWebSocketJson(socket, payload) {
  sendWebSocketFrame(socket, 0x1, JSON.stringify(payload));
}

function closeWebSocket(socket, code = 1000, reason = "") {
  if (socket.destroyed || !socket.writable) return;
  const reasonBytes = Buffer.from(reason).subarray(0, 123);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  sendWebSocketFrame(socket, 0x8, payload);
  socket.end();
}

// buffer 開頭那個訊框總共需要幾個位元組；標頭還不完整時，回傳至少還要讀到的長度。
export function webSocketFrameLength(buffer, limit = maxWebSocketMessageBytes) {
  if (buffer.length < 2) return 2;
  const second = buffer[1];
  let payloadLength = second & 0x7f;
  let header = 2;
  if (payloadLength === 126) {
    header = 4;
    if (buffer.length < header) return header;
    payloadLength = buffer.readUInt16BE(2);
  } else if (payloadLength === 127) {
    header = 10;
    if (buffer.length < header) return header;
    const longLength = buffer.readBigUInt64BE(2);
    if (longLength > BigInt(limit)) throw new Error("WebSocket 訊息超過路由器限制");
    payloadLength = Number(longLength);
  }
  if (payloadLength > limit) throw new Error("WebSocket 訊息超過路由器限制");
  if (second & 0x80) header += 4;
  return header + payloadLength;
}

// 逐塊累積 TCP 資料，湊滿一個完整訊框才合併並解析。
//
// 以前每收到一塊就把整個緩衝區 Buffer.concat 再從頭解析：Codex 送來的一則 30 MB
// response.create（長對話帶著 base64 截圖很常見）以 64 KiB 分塊到達，累計要複製
// 約 7 GiB，實測 1.3 秒；先讀標頭算出訊框長度、收齊再合併只要約 50 毫秒。
// 標頭一到就檢查長度上限，不必等整個超大訊框收完才拒絕。
export function createWebSocketFrameReader(initial = Buffer.alloc(0), limit = maxWebSocketMessageBytes) {
  let chunks = initial.length ? [initial] : [];
  let buffered = initial.length;
  // 不在這裡解析 initial：建構時丟出例外（例如超過上限的標頭）沒有人接得住，
  // 留到下一次 push，由呼叫端既有的錯誤處理關閉連線。
  let needed = 2;
  const reader = {
    // 合併時複製的累計位元組數，供測試確認不再是平方成長。
    copiedBytes: 0,
    push(chunk) {
      if (chunk.length) {
        chunks.push(chunk);
        buffered += chunk.length;
      }
      if (buffered < needed) {
        // 標頭可能還沒到齊：湊到能算出長度為止（標頭最多 14 個位元組，複製成本可忽略）。
        if (chunks.length > 1 && buffered <= 14) {
          chunks = [Buffer.concat(chunks, buffered)];
          needed = webSocketFrameLength(chunks[0], limit);
        }
        if (buffered < needed) return [];
      }
      const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
      if (chunks.length > 1) reader.copiedBytes += buffered;
      const { frames, remainder } = parseWebSocketFrames(buffer, limit);
      // remainder 是大緩衝區的切片；複製一份，免得一小段殘餘資料留住整個緩衝區。
      const rest = remainder.length && remainder.length < buffer.length ? Buffer.from(remainder) : remainder;
      chunks = rest.length ? [rest] : [];
      buffered = rest.length;
      needed = webSocketFrameLength(rest, limit);
      return frames;
    },
  };
  return reader;
}

export function parseWebSocketFrames(buffer, limit = maxWebSocketMessageBytes) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let payloadLength = second & 0x7f;
    let cursor = offset + 2;
    if (payloadLength === 126) {
      if (cursor + 2 > buffer.length) break;
      payloadLength = buffer.readUInt16BE(cursor);
      cursor += 2;
    } else if (payloadLength === 127) {
      if (cursor + 8 > buffer.length) break;
      const longLength = buffer.readBigUInt64BE(cursor);
      if (longLength > BigInt(limit)) {
        throw new Error("WebSocket 訊息超過路由器限制");
      }
      payloadLength = Number(longLength);
      cursor += 8;
    }
    if (payloadLength > limit) {
      throw new Error("WebSocket 訊息超過路由器限制");
    }
    const masked = (second & 0x80) !== 0;
    let mask = null;
    if (masked) {
      if (cursor + 4 > buffer.length) break;
      mask = buffer.subarray(cursor, cursor + 4);
      cursor += 4;
    }
    if (cursor + payloadLength > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(cursor, cursor + payloadLength));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    frames.push({
      fin: (first & 0x80) !== 0,
      opcode: first & 0x0f,
      payload,
    });
    offset = cursor + payloadLength;
  }
  return { frames, remainder: buffer.subarray(offset) };
}

function sseData(block) {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

function observeResponsesSse(onEvent) {
  const decoder = new TextDecoder();
  let pending = "";
  const parse = (block) => {
    const data = sseData(block);
    if (data && data !== "[DONE]") onEvent(JSON.parse(data));
  };
  return {
    write(chunk) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const match = /\r?\n\r?\n/.exec(pending);
        if (!match) break;
        parse(pending.slice(0, match.index));
        pending = pending.slice(match.index + match[0].length);
      }
    },
    finish() {
      pending += decoder.decode();
      if (pending.trim()) parse(pending);
    },
  };
}

function sendSseBlockToWebSocket(socket, block, onEvent = null, imageState = null) {
  const data = sseData(block);
  if (!data || data === "[DONE]") return;
  const parsed = JSON.parse(data);
  if (onEvent) onEvent(parsed);

  // response.completed 要補上合成的項目，Codex 的最終狀態才與串流一致。
  if (imageState && parsed?.type === "response.completed" && imageState.pending.length > 0) {
    for (const injection of imageState.pending) emitViewImageCall(socket, injection);
    const rewritten = structuredClone(parsed);
    if (Array.isArray(rewritten.response?.output)) {
      for (const injection of imageState.pending) rewritten.response.output.push(injection.item);
    }
    imageState.pending = [];
    sendWebSocketJson(socket, rewritten);
    stats.websocketEvents += 1;
    return;
  }

  // 原樣轉發：不重新序列化，避免動到上游的位元組。
  sendWebSocketFrame(socket, 0x1, data);
  stats.websocketEvents += 1;

  if (imageState) noteImageGenerationItem(parsed, imageState);
}

// 記下這一輪出現過的最大 output_index，合成項目才不會撞號。
function noteImageGenerationItem(event, imageState) {
  if (Number.isFinite(event?.output_index)) {
    imageState.maxIndex = Math.max(imageState.maxIndex, event.output_index);
  }
  if (event?.type !== "response.output_item.done") return;
  const item = event.item;
  if (item?.type !== "image_generation_call" || item.status !== "completed") return;
  const path = saveGeneratedImage(item);
  if (!path) return;
  stats.imagesSaved += 1;
  if (!viewImageBridgeEnabled) return;
  const callId = ROUTER_IMAGE_CALL_PREFIX + randomBytes(12).toString("hex");
  imageState.pending.push({
    path,
    item: {
      id: "fc_" + randomBytes(24).toString("hex"),
      type: "function_call",
      call_id: callId,
      name: "view_image",
      arguments: JSON.stringify({ path }),
      status: "completed",
    },
  });
}

// 合成一次 view_image 呼叫的完整事件序列，讓 Codex 當成正常工具呼叫執行。
function emitViewImageCall(socket, injection) {
  const index = injection.outputIndex;
  const { item } = injection;
  sendWebSocketJson(socket, {
    type: "response.output_item.added",
    output_index: index,
    item: { ...item, arguments: "", status: "in_progress" },
  });
  sendWebSocketJson(socket, {
    type: "response.function_call_arguments.delta",
    item_id: item.id,
    output_index: index,
    delta: item.arguments,
  });
  sendWebSocketJson(socket, {
    type: "response.function_call_arguments.done",
    item_id: item.id,
    output_index: index,
    arguments: item.arguments,
  });
  sendWebSocketJson(socket, { type: "response.output_item.done", output_index: index, item });
  stats.websocketEvents += 4;
  stats.viewImageCallsInjected += 1;
}

export async function bridgeSseToWebSocket(upstream, socket, captureId = null, history = null) {
  stats.lastWebSocketStatus = upstream.status;
  if (upstream.status < 200 || upstream.status >= 300) {
    const rawText = await upstream.text();
    // 狀態碼字串（"400"、"429"）Codex 不認得：上下文爆掉會被白白重試，限流也不會等。
    const details = upstreamErrorDetails(upstream.status, rawText, upstream.headers?.get?.("retry-after"));
    sendWebSocketJson(socket, { type: "error", error: details.error });
    sendResponseFailed(socket, details.code, details.message);
    // 關閉連線的策略需要區分兩種錯誤：
    //
    // 1) 預熱請求（websocket.warmup=true）在部分閘道上必定失敗，但 Codex 會忽略
    //    並在同一條連線上送出真正的請求。此時關閉連線只會讓每次工具往返多付
    //    一次斷線重試，所以不能關。
    //
    // 2) previous_response_id 不被支援：Codex 在工具接續回合只送工具結果並倚賴
    //    伺服器保存狀態，而它是以「連線」為單位判斷伺服器是否具備該能力。
    //    此時若不關閉，Codex 收到它不認得的 type:"error" 會無聲卡死；關閉後
    //    它會重連，並在新連線上重送完整歷史 —— 因此這種錯誤必須關。
    const isStatefulUnsupported =
      typeof rawText === "string" && rawText.includes("previous_response_id");
    if (isStatefulUnsupported || closeOnUpstreamError) {
      stats.upstreamErrorCloses += 1;
      if (isStatefulUnsupported) stats.statefulFallbacks += 1;
      closeWebSocket(socket, 1011, `upstream ${upstream.status}`);
    }
    return;
  }
  if (!upstream.body) throw new Error("WebSocket 上游響應沒有內文");

  let sawTerminal = false;
  let upstreamError = null;
  const onEvent = (event) => {
    if (isTerminalEvent(event)) sawTerminal = true;
    else if (event?.type === "error") upstreamError = event;
    rememberHistoryEvent(history, event);
  };
  const imageState = { pending: [], maxIndex: -1 };
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of upstream.body) {
    captureAppend(captureId, "response.sse", Buffer.from(chunk));
    pending += decoder.decode(chunk, { stream: true });
    for (;;) {
      const match = /\r?\n\r?\n/.exec(pending);
      if (!match) break;
      const block = pending.slice(0, match.index);
      pending = pending.slice(match.index + match[0].length);
      assignInjectionIndices(imageState);
      sendSseBlockToWebSocket(socket, block, onEvent, imageState);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) {
    assignInjectionIndices(imageState);
    sendSseBlockToWebSocket(socket, pending, onEvent, imageState);
  }
  if (!sawTerminal) {
    if (upstreamError) {
      sendWebSocketJson(socket, responseFailedFromErrorEvent(upstreamError));
      stats.responseFailedSent += 1;
    } else {
      noteTruncatedStream();
      sendResponseFailed(socket, "upstream_stream_truncated", truncatedStreamMessage);
    }
  }
}

// 合成項目排在這一輪所有真實項目之後，避免與上游的 output_index 相撞。
function assignInjectionIndices(imageState) {
  for (const injection of imageState.pending) {
    if (injection.outputIndex === undefined) {
      imageState.maxIndex += 1;
      injection.outputIndex = imageState.maxIndex;
    }
  }
}

function startWebSocketHeartbeat(socket) {
  const timer = setInterval(() => {
    if (socket.destroyed || !socket.writable) return;
    sendWebSocketFrame(socket, 0x9, Buffer.alloc(0));
    stats.heartbeats += 1;
  }, heartbeatIntervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// --- 上游 WebSocket（僅官方路由）-------------------------------------------
// 官方後端支援 Responses 的 WebSocket 模式，同一條連線可用 previous_response_id
// 接續，每輪只送新項目。實測（2026-09-02，官方 backend）：
//   - 同一條連線接續：成功
//   - 換一條連線沿用舊 id：Invalid previous_response_id
//   - generate:false 預熱：成功，且其 id 可被接續
// 因此接續狀態必須以「上游連線」為單位追蹤；跨連線、跨模型或找不到來源時，
// 一律改送本機重建的完整歷史，等價於原本的 HTTP 行為。
//
// 客戶端送出的訊框必須加遮罩（RFC 6455），與伺服器端的 encodeWebSocketFrame 不同。
export function encodeMaskedWebSocketFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length <= 125) {
    header = Buffer.from([0x80 | opcode, 0x80 | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const mask = randomBytes(4);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function officialWebSocketTarget() {
  const url = new URL(officialBase + "/responses");
  return {
    host: url.hostname,
    port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
    path: url.pathname + url.search,
    secure: url.protocol === "https:",
  };
}

function connectUpstreamWebSocket(requestHeaders, timeoutMs = 15000) {
  const target = officialWebSocketTarget();
  if (!target.secure) throw new Error("上游 WebSocket 需要 HTTPS 端點");
  const key = randomBytes(16).toString("base64");
  const expectedAccept = createHash("sha1").update(key + websocketMagic).digest("base64");
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
    });
    let settled = false;
    let buffer = Buffer.alloc(0);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const timer = setTimeout(() => fail(Object.assign(
      new Error("上游 WebSocket 握手逾時"), { code: "ETIMEDOUT" },
    )), timeoutMs);
    const onHandshakeData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const headerText = buffer.subarray(0, boundary).toString("utf8");
      const remainder = buffer.subarray(boundary + 4);
      const status = Number(/^HTTP\/1\.[01]\s+(\d+)/.exec(headerText)?.[1]);
      if (status !== 101) {
        fail(new RouterRequestError(
          502, "upstream_websocket_rejected", `上游 WebSocket 握手失敗（HTTP ${status || "未知"}）。`,
          "websocket_handshake", status || null,
        ));
        return;
      }
      const acceptLine = /sec-websocket-accept:\s*(\S+)/i.exec(headerText)?.[1];
      if (acceptLine !== expectedAccept) {
        fail(new Error("上游 WebSocket 握手驗證失敗"));
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off("data", onHandshakeData);
      socket.off("error", fail);
      resolve(createUpstreamSession(socket, remainder));
    };
    socket.on("data", onHandshakeData);
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      const headers = new Headers(buildOfficialHeaders(requestHeaders));
      const lines = ["GET " + target.path + " HTTP/1.1", "Host: " + target.host];
      for (const [name, value] of headers) {
        if (name.toLowerCase() === "host") continue;
        lines.push(name + ": " + value);
      }
      lines.push("Connection: Upgrade");
      lines.push("Upgrade: websocket");
      lines.push("Sec-WebSocket-Key: " + key);
      lines.push("Sec-WebSocket-Version: 13");
      socket.write(lines.join("\r\n") + "\r\n\r\n");
    });
  });
}

function createUpstreamSession(socket, leftover) {
  const session = {
    socket,
    closed: false,
    // 這條上游連線產生過的 response id；只有命中才可以安全地接續。
    responseIds: new Set(),
    onEvent: null,
    onClosed: null,
  };
  // 握手回應後面若已帶著訊框，先放進讀取器，與下一塊資料一起解析。
  const frameReader = createWebSocketFrameReader(leftover ?? Buffer.alloc(0));
  let fragments = [];
  const markClosed = (reason) => {
    if (session.closed) return;
    session.closed = true;
    const notify = session.onClosed;
    session.onClosed = null;
    if (notify) notify(reason);
  };
  socket.on("data", (chunk) => {
    let frames;
    try {
      frames = frameReader.push(chunk);
    } catch (error) {
      socket.destroy();
      markClosed(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === 0x9) {
        socket.write(encodeMaskedWebSocketFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x8) {
        socket.destroy();
        markClosed("上游 WebSocket 已關閉");
        return;
      }
      if (frame.opcode === 0x1) fragments = [frame.payload];
      else if (frame.opcode === 0x0) fragments.push(frame.payload);
      else continue;
      if (!frame.fin) continue;
      const text = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      let event;
      try {
        event = JSON.parse(text);
      } catch {
        continue;
      }
      if (session.onEvent) session.onEvent(event);
    }
  });
  socket.on("error", markClosed);
  socket.on("close", () => markClosed("上游 WebSocket 連線結束"));
  session.send = (payload) => {
    if (session.closed || socket.destroyed || !socket.writable) {
      throw new Error("上游 WebSocket 不可寫");
    }
    socket.write(encodeMaskedWebSocketFrame(0x1, JSON.stringify(payload)));
  };
  session.destroy = () => {
    if (!socket.destroyed) socket.destroy();
    markClosed("本機關閉");
  };
  return session;
}

// 送出一輪並轉發事件。回傳 { ok, retryWithReplay }。
// 在收到 response.in_progress 之前先緩衝：若此時上游拒絕接續，Codex 尚未看到
// 本輪任何事件，可以安全地改用完整歷史重送，不會產生半截輸出。
export function runUpstreamWebSocketTurn(session, payload, { onEvent, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let flushed = false;
    const buffered = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      session.onEvent = null;
      session.onClosed = null;
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const failHard = (error) => {
      if (settled) return;
      settled = true;
      session.onEvent = null;
      session.onClosed = null;
      signal?.removeEventListener("abort", onAbort);
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.eventsForwarded = flushed;
      reject(failure);
    };
    const onAbort = () => {
      if (settled) return;
      try {
        session.send({ type: "response.cancel" });
      } catch {}
      failHard(new Error("已取消"));
      // 取消確認可能晚於下一輪，不能再共用這條連線的事件回呼。
      session.destroy();
    };
    const flush = () => {
      if (flushed) return;
      flushed = true;
      for (const event of buffered.splice(0)) onEvent(event);
    };
    const isInvalidChain = (event) => {
      const message = String(
        event?.error?.message || event?.response?.error?.message || "",
      );
      return message.includes("previous_response_id");
    };

    session.onClosed = (reason) => failHard(reason instanceof Error ? reason : Object.assign(
      new Error(reason || "上游 WebSocket 中斷"), { code: "ECONNRESET" },
    ));
    session.onEvent = (event) => {
      const type = String(event?.type || "");
      if (!flushed && (type === "error" || type === "response.failed") && isInvalidChain(event)) {
        finish({ ok: false, retryWithReplay: true });
        return;
      }
      if (flushed) onEvent(event);
      else buffered.push(event);
      if (type === "response.in_progress") flush();
      if (type === "response.completed" || type === "response.incomplete") {
        flush();
        const responseId = event?.response?.id;
        if (typeof responseId === "string" && responseId) {
          session.responseIds.add(responseId);
          session.responseModels ||= new Map();
          session.responseModels.set(responseId, payload.model);
          while (session.responseIds.size > 64) {
            const oldest = session.responseIds.values().next().value;
            session.responseIds.delete(oldest);
            session.responseModels.delete(oldest);
          }
        }
        finish({ ok: true, retryWithReplay: false });
        return;
      }
      if (type === "response.failed" || type === "error") {
        flush();
        finish({ ok: true, retryWithReplay: false });
      }
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      session.send(payload);
    } catch (error) {
      failHard(error);
    }
  });
}

// HTTP 傳輸同樣需要轉譯。Codex 預設走 WebSocket，但連線反覆失敗後會退回
// HTTPS；此時若把 Anthropic 的原生事件原樣送回，客戶端解不開，該對話就會
// 永遠停在「正在重新連線」，而且再也回不來——因為每次重試都是同一個結果。
export async function bridgeAnthropicToHttp(upstream, response, meta) {
  stats.lastCustomStatus = upstream.status;
  if (!upstream.body) throw new Error("上游響應沒有內文");
  response.routerResponsesStream = true;
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  let sawTerminal = false;
  await bridgeAnthropicStream(
    upstream.body,
    (event) => {
      if (isTerminalEvent(event)) { sawTerminal = true; response.routerTerminalSent = true; }
      rememberHistoryEvent(meta.history, event);
      response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
    },
    meta,
  );
  if (!sawTerminal) {
    noteTruncatedStream();
    const event = responseFailedEvent("upstream_stream_truncated", truncatedStreamMessage);
    response.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
  }
  response.end();
}

export async function bridgeAnthropicToWebSocket(upstream, socket, meta, captureId = null) {
  stats.lastWebSocketStatus = upstream.status;
  if (!upstream.body) throw new Error("WebSocket 上游響應沒有內文");
  const tee = captureId
    ? async function* (src) {
        for await (const chunk of src) {
          captureAppend(captureId, "anthropic-response.sse", Buffer.from(chunk));
          yield chunk;
        }
      }
    : null;
  let sawTerminal = false;
  await bridgeAnthropicStream(
    tee ? tee(upstream.body) : upstream.body,
    (event) => {
      captureAppend(captureId, "response.sse", `data: ${JSON.stringify(event)}\n\n`);
      if (isTerminalEvent(event)) sawTerminal = true;
      rememberHistoryEvent(meta.history, event);
      sendWebSocketJson(socket, event);
      stats.websocketEvents += 1;
    },
    meta,
  );
  if (!sawTerminal) {
    noteTruncatedStream();
    sendResponseFailed(socket, "upstream_stream_truncated", truncatedStreamMessage);
  }
}

async function handleWebSocketResponse(
  request,
  socket,
  incomingUrl,
  message,
  abortController,
  connectionState = null,
) {
  // 走上游 WebSocket 的那一輪，決定要透傳接續還是重播完整歷史。
  // 回傳 true 表示本輪已完整處理；false 表示尚未送出任何事件，可安全回退。
  return await handleWebSocketResponseInner(
    request,
    socket,
    incomingUrl,
    message,
    abortController,
    connectionState,
  );
}

async function tryUpstreamWebSocketTurn(
  request,
  socket,
  message,
  abortController,
  connectionState,
) {
  const probe = { ...message };
  delete probe.type;
  const historyKey = historyKeyFor(
    probe,
    request.headers,
    connectionState.connectionNamespace,
  );
  const previousId =
    typeof message.previous_response_id === "string" && message.previous_response_id
      ? message.previous_response_id
      : null;

  let session = connectionState.session;
  if (!session || session.closed) {
    try {
      session = await connectUpstreamWebSocket(request.headers);
    } catch (error) {
      connectionState.upstreamDisabled = true;
      connectionState.session = null;
      stats.upstreamWebSocketFallbacks += 1;
      // 握手失敗代表這個端點現在不可用，是全域現象而非這條連線的問題。
      noteUpstreamWebSocketConnectFailure();
      recordRouterError(error, { transport: "upstream-websocket", route: "official", model: message?.model }, false);
      return false;
    }
    connectionState.session = session;
    noteUpstreamWebSocketConnected();
    stats.upstreamWebSocketConnects += 1;
  }

  // 只有這條上游連線自己產生過的 id 才能接續；其餘情況一律重播完整歷史。
  const canChain = Boolean(previousId && session.responseIds.has(previousId) && session.responseModels?.get(previousId) === message.model);
  const fullInput = previousId
    ? rebuildStatefulInput(historyKey, message.input, previousId)
    : message.input;
  let history = null;
  const buildPayload = (chain) => {
    let outgoing = { ...message };
    history = fullInput ? prepareHistory(historyKey, fullInput, previousId) : null;
    if (chain) {
      stats.upstreamWebSocketIncremental += 1;
    } else {
      outgoing = { ...outgoing, input: fullInput };
      delete outgoing.previous_response_id;
      if (previousId) stats.upstreamWebSocketReplays += 1;
    }
    const sanitized = stripRouterImageArtifacts(stripBridgeArtifacts({ input: outgoing.input }));
    outgoing.input = sanitized.input;
    outgoing.type = "response.create";
    return outgoing;
  };

  const forward = (event) => {
    rememberHistoryEvent(history, event);
    sendWebSocketJson(socket, event);
    stats.websocketEvents += 1;
  };

  for (const chain of canChain ? [true, false] : [false]) {
    // 沒有完整歷史時，交給 HTTP 回退的明確錯誤處理，不能把增量冒充完整輸入。
    if (!chain && previousId && !fullInput) return false;
    let outcome;
    try {
      outcome = await runUpstreamWebSocketTurn(session, buildPayload(chain), {
        onEvent: forward,
        signal: abortController.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "已取消") return true;
      connectionState.upstreamDisabled = true;
      connectionState.session = null;
      session.destroy();
      // 已把本輪內容送給 Codex 時不能再透明重播，否則會產生兩套輸出／工具呼叫。
      if (error.eventsForwarded) throw error;
      stats.upstreamWebSocketFallbacks += 1;
      recordRouterError(error, { transport: "upstream-websocket", route: "official", model: message?.model }, false);
      return false;
    }
    if (outcome.ok) {
      stats.upstreamWebSocketTurns += 1;
      stats.lastWebSocketStatus = 200;
      stats.official += 1;
      stats.lastRoute = "official-ws";
      stats.lastModel = message?.model ?? null;
      stats.lastReasoningEffort = message?.reasoning?.effort ?? null;
      stats.lastForwardedReasoningEffort = message?.reasoning?.effort ?? null;
      markAuthValidated(request.headers);
      return true;
    }
  }
  return false;
}

export async function handleWebSocketResponseInner(
  request,
  socket,
  incomingUrl,
  message,
  abortController,
  connectionState = null,
) {
  // 官方路由優先走上游 WebSocket；只有它支援連線內的 previous_response_id 接續。
  // 任何一步失敗都會回退到既有的 HTTP/SSE 路徑，且此時 Codex 尚未收到本輪事件。
  if (
    upstreamWebSocketEnabled &&
    connectionState &&
    !connectionState.upstreamDisabled &&
    !upstreamWebSocketInCooldown() &&
    message?.type === "response.create" &&
    chooseRoute(request.headers, message) == null &&
    authDigest(request.headers)
  ) {
    const handled = await tryUpstreamWebSocketTurn(
      request,
      socket,
      message,
      abortController,
      connectionState,
    );
    if (handled) return;
  }

  const body = { ...message, stream: true };
  delete body.type;
  for (const field of websocketOnlyFields) {
    if (field in body) {
      delete body[field];
      stats.websocketOnlyFieldsStripped += 1;
    }
  }
  const bodyBuffer = Buffer.from(JSON.stringify(body));
  const captureId = captureNext(
    typeof body.model === "string" && routeMap.has(body.model) ? "custom" : "official",
  );
  captureWrite(captureId, "request.json", JSON.stringify(body, null, 2));
  const stopHeartbeat = startWebSocketHeartbeat(socket);
  const meta = { connectionNamespace: connectionState?.connectionNamespace ?? null, transport: "websocket" };
  try {
    const upstream = await fetchModelUpstream(
      request.headers,
      incomingUrl,
      body,
      bodyBuffer,
      abortController.signal,
      meta,
    );
    stats.websocketResponses += 1;
    if (meta.anthropicRequest) {
      captureWrite(captureId, "anthropic-request.json", JSON.stringify(meta.anthropicRequest, null, 2));
    }
    if (meta.translate === "anthropic" && upstream.status >= 200 && upstream.status < 300) {
      await bridgeAnthropicToWebSocket(upstream, socket, meta, captureId);
    } else {
      await bridgeSseToWebSocket(upstream, socket, captureId, meta.history);
    }
  } finally {
    stopHeartbeat();
  }
}

// 升級前就拒絕的連線：回應要先送完再關。write 之後立刻 destroy 可能把還沒送出的
// 狀態列一起丟掉，用戶端只看到連線被切斷。
function rejectUpgrade(socket, statusLine) {
  socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`, () => socket.destroy());
}

function handleWebSocketUpgrade(request, socket, head) {
  if (!isLoopbackHost(request.headers.host)) {
    stats.foreignHostRejects += 1;
    rejectUpgrade(socket, "403 Forbidden");
    return;
  }
  let incomingUrl;
  try {
    incomingUrl = new URL(request.url || "/", `http://${listenHost}:${listenPort}`);
  } catch {
    socket.destroy();
    return;
  }
  if (
    incomingUrl.pathname !== "/responses" &&
    incomingUrl.pathname !== "/v1/responses"
  ) {
    rejectUpgrade(socket, "404 Not Found");
    return;
  }

  const websocketKey = request.headers["sec-websocket-key"];
  if (typeof websocketKey !== "string") {
    rejectUpgrade(socket, "400 Bad Request");
    return;
  }
  const accept = createHash("sha1")
    .update(websocketKey + websocketMagic)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  stats.websockets += 1;

  const frameReader = createWebSocketFrameReader();
  let fragmentOpcode = null;
  let fragmentChunks = [];
  let activeAbortController = null;
  const pendingMessages = [];
  let pendingMessageBytes = 0;
  // 每條 Codex 連線對應一條上游 WebSocket；接續狀態不能跨連線共用。
  const connectionState = {
    session: null,
    upstreamDisabled: false,
    connectionNamespace: randomBytes(16).toString("hex"),
  };

  const handleMessage = (payload) => {
    let message;
    try {
      message = JSON.parse(payload.toString("utf8"));
    } catch {
      closeWebSocket(socket, 1007, "JSON 無效");
      return;
    }
    if (message?.type === "response.cancel") {
      activeAbortController?.abort();
      return;
    }
    if (message?.type !== "response.create") {
      sendWebSocketJson(socket, {
        type: "error",
        error: {
          type: "unsupported_event",
          code: "unsupported_event",
          message: "僅支援 response.create 和 response.cancel",
        },
      });
      return;
    }
    // 上游送出 response.completed 之後，本路由仍在讀完串流尾端；Codex 一看到
    // completed 就會在同一條連線上送出下一個請求。若此時直接回 response_in_progress，
    // Codex 不處理該錯誤事件而會無聲卡死。因此改為排隊，仍維持逐一序列化執行。
    if (activeAbortController) {
      if (pendingMessages.length >= maxPendingMessages || pendingMessageBytes + payload.length > maxWebSocketMessageBytes) {
        sendWebSocketJson(socket, {
          type: "error",
          error: {
            type: "response_in_progress",
            code: "response_in_progress",
            message: "當前連線的待處理請求過多",
          },
        });
        stats.responseInProgressRejects += 1;
        return;
      }
      pendingMessages.push({ message, bytes: payload.length });
      pendingMessageBytes += payload.length;
      stats.queuedResponses += 1;
      return;
    }

    startResponse(message);
  };

  function startResponse(message) {
    activeAbortController = new AbortController();
    void handleWebSocketResponse(
      request,
      socket,
      incomingUrl,
      message,
      activeAbortController,
      connectionState,
    )
      .catch((error) => {
        const aborted = error instanceof Error && error.name === "AbortError";
        if (!aborted) {
          const detail = recordRouterError(error, {
            transport: "websocket", model: message?.model,
            route: typeof message?.model === "string" && message.model.startsWith("custom/") ? "custom" : "official",
          });
          const messageText = `${detail.message}（診斷 ID：${detail.requestId}）`;
          sendWebSocketJson(socket, {
            type: "error",
            error: {
              type: "router_error",
              code: detail.code,
              message: messageText,
            },
          });
          // 網路層例外（fetch failed / terminated）同樣要送終止事件，
          // 否則 Codex 會停在「思考中」直到 idle timeout 才重試。
          sendResponseFailed(socket, detail.code, messageText);
          if (detail.code === "router_history_unavailable") {
            stats.statefulFallbacks += 1;
            closeWebSocket(socket, 1011, "history unavailable");
          }
        }
      })
      .finally(() => {
        activeAbortController = null;
        const next = pendingMessages.shift();
        if (next) {
          pendingMessageBytes -= next.bytes;
          if (!socket.destroyed && socket.writable) startResponse(next.message);
        }
      });
  }

  const consume = (chunk) => {
    try {
      for (const frame of frameReader.push(chunk)) {
        if (frame.opcode === 0x8) {
          activeAbortController?.abort();
          closeWebSocket(socket);
          return;
        }
        if (frame.opcode === 0x9) {
          sendWebSocketFrame(socket, 0x0a, frame.payload);
          continue;
        }
        if (frame.opcode === 0x0a) continue;
        if (frame.opcode === 0x1 || frame.opcode === 0x2) {
          fragmentOpcode = frame.opcode;
          fragmentChunks = [frame.payload];
        } else if (frame.opcode === 0x0 && fragmentOpcode != null) {
          fragmentChunks.push(frame.payload);
        } else {
          closeWebSocket(socket, 1002, "幀類型不受支援");
          return;
        }
        const fragmentBytes = fragmentChunks.reduce(
          (total, item) => total + item.length,
          0,
        );
        if (fragmentBytes > maxWebSocketMessageBytes) {
          closeWebSocket(socket, 1009, "訊息過大");
          return;
        }
        if (frame.fin) {
          const messagePayload = Buffer.concat(fragmentChunks);
          fragmentOpcode = null;
          fragmentChunks = [];
          handleMessage(messagePayload);
        }
      }
    } catch {
      closeWebSocket(socket, 1002, "幀無效");
    }
  };

  socket.on("data", consume);
  const teardown = () => {
    activeAbortController?.abort();
    connectionState.session?.destroy();
    connectionState.session = null;
  };
  socket.on("close", teardown);
  socket.on("error", teardown);
  // http.Server 的連線允許半關閉：用戶端沒送 Close 訊框就結束（例如行程被終止）時，
  // 這一端只會收到 end，連線與上游 WebSocket 會一直留著。WebSocket 不使用半關閉，直接收掉。
  socket.on("end", () => socket.destroy());
  if (head.length > 0) consume(head);
}

const server = http.createServer(async (request, response) => {
  stats.requests += 1;
  request.routerContext = { transport: "http", route: "official" };
  if (!isLoopbackHost(request.headers.host)) {
    stats.foreignHostRejects += 1;
    writeJson(response, 403, {
      error: { message: "只接受以 127.0.0.1 或 localhost 連線的請求。", type: "router_error", code: "forbidden_host" },
    });
    return;
  }
  try {
    const incomingUrl = new URL(request.url || "/", `http://${listenHost}:${listenPort}`);
    if (request.method === "GET" && incomingUrl.pathname === "/healthz") {
      writeJson(response, 200, {
        status: "ok",
        version: settings.version,
        uptimeSeconds: Math.floor(process.uptime()),
        historyCache: historyCacheInfo(),
        stats,
      });
      return;
    }
    if (
      request.method === "GET" &&
      (incomingUrl.pathname === "/models" || incomingUrl.pathname === "/v1/models")
    ) {
      stats.models += 1;
      const catalog = await refreshOfficialCatalog(request.headers, incomingUrl.searchParams);
      response.setHeader("cache-control", "no-store");
      writeJson(response, 200, catalog);
      return;
    }
    if (
      request.method === "POST" &&
      (incomingUrl.pathname.startsWith("/responses") ||
        incomingUrl.pathname.startsWith("/v1/responses"))
    ) {
      await handleResponses(request, response, incomingUrl);
      return;
    }
    if (request.method === "POST" && IMAGE_PATH_PATTERN.test(incomingUrl.pathname)) {
      await handleImages(request, response, incomingUrl);
      return;
    }
    if (incomingUrl.pathname.startsWith("/v2/extend/image/ark_gpt_image/")) {
      await handleArkImages(request, response, incomingUrl);
      return;
    }
    await proxyToOfficial(request, response, incomingUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const aborted =
      (error instanceof Error && error.name === "AbortError") ||
      message === "This operation was aborted";
    if (aborted) {
      if (!response.writableEnded) response.end();
      return;
    }
    const detail = recordRouterError(error, request.routerContext);
    if (!response.headersSent) {
      writeJson(response, detail.status, {
        error: {
          message: `${detail.message}（診斷 ID：${detail.requestId}）`,
          type: "router_error", code: detail.code, request_id: detail.requestId,
        },
      });
    } else if (!response.writableEnded) {
      if (response.routerResponsesStream && !response.routerTerminalSent) {
        const event = responseFailedEvent(detail.code, `${detail.message}（診斷 ID：${detail.requestId}）`);
        response.write("\n\nevent: response.failed\ndata: " + JSON.stringify(event) + "\n\n");
      }
      response.end();
    }
  }
});

server.on("upgrade", handleWebSocketUpgrade);
export { server as routerServer };

// launchd 與 schtasks 都只是把 stderr 以附加模式導進同一個檔案，沒有任何輪替。
// 上游長時間出錯時會持續寫入，因此啟動時把過大的日誌就地截斷——同一個 inode，
// 附加模式的後續寫入會從 0 重新開始，不會弄丟服務手上的檔案描述子。
// 只在啟動時檢查一次就夠：日誌長得最快的情境正好是服務反覆重啟。
const maxLogBytes =
  Number(settings.maxLogBytes) > 0 ? Number(settings.maxLogBytes) : 5 * 1024 * 1024;

export function truncateOversizedLog(logPath = settings.logPath) {
  if (typeof logPath !== "string" || !logPath) return false;
  try {
    if (statSync(logPath).size <= maxLogBytes) return false;
    writeFileSync(logPath, "");
    return true;
  } catch {
    // 日誌不存在或不可寫都不該擋住啟動。
    return false;
  }
}

// 測試會 import 本檔以驗證純函式，但不能讓它真的佔用連接埠。
// 這個旗標只跳過監聽與訊號處理，其餘模組載入行為完全一致。
if (!process.env.CODEX_MODEL_ROUTER_IMPORT_ONLY) {
  if (truncateOversizedLog()) {
    process.stderr.write(`model-router-log-truncated:${settings.logPath}\n`);
  }

  // /models 在 Codex 啟動時同步官方資料；不再以 bundled 背景覆蓋較新的官方目錄。
  const historyTimer = setInterval(historyCacheInfo, Math.min(historyTtlMs, 60000));
  historyTimer.unref();

  server.listen(listenPort, listenHost, () => {
    process.stderr.write(`model-router-ready:${listenHost}:${listenPort}\n`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
