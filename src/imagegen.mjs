// 獨立圖片命令：API 走本機路由器，結果圖片另行下載；命令不讀取或儲存 API Key。
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { get as httpsGet } from "node:https";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export const GPT_IMAGE_MODELS = ["gpt-image-2", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"];
// Google 的 Nano Banana 系列（Gemini 圖片模型），ID 依 Google 官方模型清單。
export const GEMINI_IMAGE_MODELS = ["gemini-nano-banana-2.1", "gemini-3-pro-image", "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image", "gemini-2.5-flash-image"];
export const IMAGE_MODELS = [...GPT_IMAGE_MODELS, ...GEMINI_IMAGE_MODELS];
export const ARK_IMAGE_PATH = "/v2/extend/image/ark_gpt_image";
// Gemini 圖片模型經路由器轉送的兩條路徑：OpenAI 相容的 chat/completions，與 Gemini 原生 generateContent。
export const CHAT_IMAGE_PATH = "/v1/router-images/chat";
export const GEMINI_IMAGE_PATH = "/v1/router-images/gemini";
export const IMAGE_API_MODES = ["images", "ark-task", "chat", "gemini"];
// 每個模型依序嘗試的介面：GPT Image 先通用 Images API 再 Ark；Gemini 先 chat，再原生，最後 Images API。
export function imageApiModesFor(model) {
  return GEMINI_IMAGE_MODELS.includes(model) ? ["chat", "gemini", "images"] : ["images", "ark-task"];
}
// 上游名稱可以帶供應商前綴（ark/…）或 -preview 後綴（部分中轉與 Google 的預覽版名稱）。
export function validImageUpstream(model, upstream) {
  if (typeof upstream !== "string" || /[\s\x00-\x1f\x7f?#]/.test(upstream)) return false;
  const names = GEMINI_IMAGE_MODELS.includes(model) ? [model, `${model}-preview`] : [model];
  return names.some((name) => upstream === name || upstream.endsWith(`/${name}`));
}
// 路由器依這個標頭決定用哪一家供應商生圖；與 router.mjs 的 PROVIDER_HEADER 相同。
export const PROVIDER_HEADER = "x-codex-router-provider";
const PROVIDER_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/;
const MODEL_ALIASES = {
  image2: IMAGE_MODELS[0], "image-2": IMAGE_MODELS[0],
  sunburst: IMAGE_MODELS[1], "image2.5-sunburst": IMAGE_MODELS[1],
  flare: IMAGE_MODELS[2], "image2.5-flare": IMAGE_MODELS[2],
  "banana2.1": "gemini-nano-banana-2.1", "nano-banana-2.1": "gemini-nano-banana-2.1",
  "banana-pro": "gemini-3-pro-image", "nano-banana-pro": "gemini-3-pro-image",
  banana2: "gemini-3.1-flash-image", "nano-banana-2": "gemini-3.1-flash-image",
  "banana2-lite": "gemini-3.1-flash-lite-image", "nano-banana-2-lite": "gemini-3.1-flash-lite-image",
  banana: "gemini-2.5-flash-image", "nano-banana": "gemini-2.5-flash-image",
};
const HELP = `中轉 API 生圖（不需要 OPENAI_API_KEY）
  imagegen.mjs list
  imagegen.mjs generate --model flare --prompt-file prompt.txt --out output.png
  imagegen.mjs edit --model sunburst --prompt-file prompt.txt --image input.png --out output-v2.png

模型只可從設定時勾選並通過測試的模型選擇。
--model 可用完整模型 ID 或 image2 / sunburst / flare / banana2.1 / banana-pro / banana2 / banana2-lite / banana。
--image 可重複提供（最多 16 張 PNG、JPEG 或 WebP），edit 必須提供至少一張。
--prompt 與 --prompt-file 二擇一；提示詞上限 32000 字元。
--size auto 或 WIDTHxHEIGHT；--quality auto / low / medium / high / xhigh / max。
--background auto / opaque / transparent；--output-format png / jpeg / webp。
Image 2 不支援 xhigh / max。透明背景需使用 PNG 或 WebP。
Ark 任務介面：size、quality 只能 auto，background 不支援 transparent；程式會自動省略不支援的欄位。
Nano Banana（Gemini）：size、quality 只能 auto，background 不支援 transparent；輸出格式由上游決定，
與 --out 副檔名不同時會改用實際格式的副檔名儲存。
--timeout 秒數（預設 300，最多 1800）；--dry-run 只檢查、不生成圖片。
每次生成一張圖片，不覆寫已有檔案，不自動重試或切換模型。
`;

export function parseImagegenArgs(args) {
  if (!args.length || args.includes("--help") || args[0] === "help") return { action: "help" };
  const options = { action: args[0], images: [], quality: "auto", size: "auto", background: "auto", timeout: 300 };
  if (!["list", "generate", "edit"].includes(options.action)) throw new Error("未知命令；請使用 list、generate 或 edit。");
  const names = { "--model": "model", "--prompt": "prompt", "--prompt-file": "promptFile", "--out": "out",
    "--size": "size", "--quality": "quality", "--background": "background", "--output-format": "format", "--timeout": "timeout" };
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--dry-run") { options.dryRun = true; continue; }
    if (flag !== "--image" && !names[flag]) throw new Error(`未知參數：${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} 缺少值。`);
    if (flag === "--image") options.images.push(resolve(value));
    else options[names[flag]] = value;
  }
  return options;
}

export function chooseImageModel(config, requested, action) {
  const enabled = config?.models;
  if (!Array.isArray(enabled) || !enabled.length || enabled.some((id) => !IMAGE_MODELS.includes(id))) {
    throw new Error("圖片模型設定無效，請從路由器選單重新設定中轉 API 生圖。");
  }
  if (requested) {
    const name = requested.toLowerCase();
    const id = MODEL_ALIASES[name] || name;
    if (!enabled.includes(id)) throw new Error("此圖片模型未啟用；請從已勾選的模型中選擇，或在路由器選單重新設定。");
    return id;
  }
  const gemini = ["gemini-nano-banana-2.1", "gemini-3-pro-image", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image", "gemini-2.5-flash-image"];
  const priority = action === "edit"
    ? [IMAGE_MODELS[1], IMAGE_MODELS[2], IMAGE_MODELS[0], "gemini-3-pro-image", ...gemini]
    : [IMAGE_MODELS[2], IMAGE_MODELS[1], IMAGE_MODELS[0], ...gemini];
  return priority.find((id) => enabled.includes(id));
}

function fileImageFormat(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
}

async function responseJson(response) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body || []) {
    bytes += chunk.length;
    if (bytes > 128 * 1024 * 1024) throw new Error("圖片 API 回應超過 128 MiB，未保存輸出。");
    chunks.push(Buffer.from(chunk));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error(`圖片 API 返回非 JSON 內容（HTTP ${response.status}），請檢查供應商是否支援 Images API。`); }
}

function apiError(payload, status, apiKey = "") {
  // 供應商可能把敏感參數放進錯誤字串；只回傳短訊息並遮蔽常見憑證格式。
  let message = String(payload?.error?.message || (typeof payload?.error === "string" ? payload.error : "") || payload?.message || "請檢查模型支援、供應商配額與路由器狀態。");
  if (apiKey) message = message.replaceAll(apiKey, "[redacted]");
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 600);
  return new Error(`中轉圖片 API HTTP ${status}：${message}`);
}

function decodeImageResult(result, format) {
  const data = result?.data?.[0]?.b64_json;
  if (typeof data !== "string" || !data || !/^[A-Za-z0-9+/\s]+={0,2}$/.test(data)) {
    throw new Error("上游未返回有效的 b64_json 圖片，請確認供應商支援 GPT Image 的 Images API 回應格式。");
  }
  const bytes = Buffer.from(data, "base64");
  if (fileImageFormat(bytes) !== format) throw new Error("上游回傳的圖片格式與要求不符，未寫入輸出檔。");
  return bytes;
}


// ---- Gemini（Nano Banana）介面 -------------------------------------------------
const DATA_IMAGE_URL = /data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=\s]+)/;

function inlineImage(base64) {
  if (typeof base64 !== "string" || !base64) return null;
  const bytes = Buffer.from(base64.replace(/\s/g, ""), "base64");
  const format = fileImageFormat(bytes);
  return format ? { bytes, format } : null;
}

export function chatImagePayload(model, prompt, inputs = [], { modalities = true } = {}) {
  const content = inputs.length
    ? [{ type: "text", text: prompt }, ...inputs.map((image) => ({ type: "image_url",
      image_url: { url: `data:image/${image.type};base64,${image.bytes.toString("base64")}` } }))]
    : prompt;
  return { model, messages: [{ role: "user", content }], stream: false, ...(modalities ? { modalities: ["image", "text"] } : {}) };
}

export function geminiImagePayload(prompt, inputs = []) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }, ...inputs.map((image) => ({
      inlineData: { mimeType: `image/${image.type}`, data: image.bytes.toString("base64") } }))] }],
    generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
  };
}

// 中轉站回傳圖片的方式不一：message.images（OpenRouter 等）、content 陣列裡的 image_url，
// 或 Markdown 文字裡的 data URL／https 圖片網址。https 圖片以不帶憑證的安全下載取得。
export async function extractChatImage(result, { download = downloadArkImage, signal } = {}) {
  const message = result?.choices?.[0]?.message;
  const urls = [];
  const texts = [];
  for (const image of Array.isArray(message?.images) ? message.images : []) {
    urls.push(typeof image === "string" ? image : image?.image_url?.url ?? image?.image_url ?? image?.url);
  }
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      urls.push(part?.image_url?.url ?? part?.image_url);
      if (typeof part?.b64_json === "string") urls.push(`data:image/png;base64,${part.b64_json}`);
      if (typeof part?.text === "string") texts.push(part.text);
    }
  } else if (typeof content === "string") texts.push(content);
  for (const url of urls) {
    const match = typeof url === "string" ? DATA_IMAGE_URL.exec(url) : null;
    const image = match && inlineImage(match[1]);
    if (image) return image;
  }
  for (const text of texts) {
    const match = DATA_IMAGE_URL.exec(text);
    const image = match && inlineImage(match[1]);
    if (image) return image;
  }
  const remote = [...urls, ...texts.flatMap((text) => [...text.matchAll(/!\[[^\]]*\]\((https:\/\/[^)\s]+)\)/g)].map((m) => m[1]))]
    .find((url) => typeof url === "string" && /^https:\/\//.test(url));
  if (remote) {
    const bytes = await download(remote, { signal });
    const format = fileImageFormat(bytes);
    if (format) return { bytes, format };
  }
  throw new Error("上游沒有回傳圖片；請確認這個模型在該供應商支援生圖輸出。");
}

export function extractGeminiImage(result) {
  for (const candidate of Array.isArray(result?.candidates) ? result.candidates : []) {
    for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
      const image = inlineImage((part?.inlineData || part?.inline_data)?.data);
      if (image) return image;
    }
  }
  const reason = result?.promptFeedback?.blockReason || result?.candidates?.[0]?.finishReason;
  throw new Error(`上游沒有回傳圖片${reason ? `（${String(reason).slice(0, 60)}）` : ""}；請確認模型支援生圖，或調整提示詞。`);
}

// chat 介面先帶 modalities（OpenRouter 等需要它才輸出圖片）；上游明確不認這個欄位時去掉重送一次。
// 400 是在生成前被拒絕，不會重複計費。
async function postChatImage(url, build, { headers, signal, fetchImpl }) {
  const send = async (modalities) => {
    const response = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify(build(modalities)), redirect: "error", signal });
    return { response, result: await responseJson(response) };
  };
  let outcome = await send(true);
  if (outcome.response.status === 400 && /modalit/i.test(JSON.stringify(outcome.result))) outcome = await send(false);
  return outcome;
}


function publicImageAddress(address) {
  const value = String(address).toLowerCase();
  if (isIP(value) === 4) {
    const [a, b, c] = value.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  return isIP(value) === 6 && /^[23][0-9a-f]{3}:/.test(value) &&
    !/^2001:(?:0+:|db8:)/.test(value) && !value.startsWith("2002:");
}

// 圖片 URL 不帶中轉憑證。固定使用已檢查的 DNS 結果，避免重導或 DNS 重綁導向內網。
function fetchImageDownload(url, { signal, addresses }) {
  return new Promise((resolve, reject) => {
    const request = httpsGet(url, { signal, headers: { accept: "image/*" },
      lookup: (_host, options, done) => options.all
        ? done(null, addresses) : done(null, addresses[0].address, addresses[0].family),
    }, (response) => {
      try { resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers })); }
      catch (error) { response.destroy(); reject(error); }
    });
    request.on("error", reject);
  });
}

export async function downloadArkImage(source, { signal, lookupImpl = lookup, dnsFetchImpl = globalThis.fetch, requestImpl = fetchImageDownload } = {}) {
  let current;
  try { current = new URL(source); } catch { throw new Error("Ark 返回無效圖片 URL。"); }
  for (let redirects = 0; redirects <= 3; redirects++) {
    signal?.throwIfAborted();
    const host = current.hostname.replace(/^\[|\]$/g, "");
    if (current.protocol !== "https:" || current.username || current.password || current.hash ||
        host === "localhost" || /\.(?:localhost|local|internal)$/.test(host)) throw new Error("Ark 圖片 URL 必須是公開 HTTPS 位址。");
    const resolveHost = () => lookupImpl(host, { all: true });
    let addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await (signal ? new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      Promise.resolve().then(resolveHost).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    }) : resolveHost());
    signal?.throwIfAborted();
    // Clash 等代理會將公開網域解析為 198.18.0.0/15 假 IP。
    // 不放寬內網限制：只對這種網域解析改用 HTTPS DNS 取得真實位址，再檢查並固定連線 IP。
    if (!isIP(host) && addresses.length && addresses.every(({ address }) => /^198\.(?:18|19)\./.test(address))) {
      const dnsUrl = new URL("https://cloudflare-dns.com/dns-query");
      dnsUrl.searchParams.set("name", host);
      dnsUrl.searchParams.set("type", "A");
      const dnsSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
      const response = await dnsFetchImpl(dnsUrl, { headers: { accept: "application/dns-json" }, redirect: "error", signal: dnsSignal });
      if (!response.ok) { await response.body?.cancel(); throw new Error("無法解析 Ark 圖片的真實公開位址。"); }
      const answer = await responseJson(response);
      addresses = answer.Status === 0 && Array.isArray(answer.Answer)
        ? answer.Answer.filter((entry) => entry.type === 1 && isIP(entry.data) === 4).map((entry) => ({ address: entry.data, family: 4 })) : [];
    }
    signal?.throwIfAborted();
    if (!addresses.length || addresses.some((entry) => !publicImageAddress(entry.address))) {
      throw new Error("Ark 圖片 URL 不可指向本機或內網。");
    }
    const response = await requestImpl(current, { signal, addresses });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("Ark 圖片重導缺少目的地。");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Ark 圖片下載失敗（HTTP ${response.status}）。`); }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body || []) {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) throw new Error("Ark 圖片超過 64 MiB。");
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    if (!fileImageFormat(bytes)) throw new Error("Ark URL 未返回有效圖片。");
    return bytes;
  }
  throw new Error("Ark 圖片重導次數過多。");
}

export async function runArkImageTask({ origin, payload, action = "generate", apiKey = "", timeoutMs = 300000,
  fetchImpl = globalThis.fetch, downloadImpl = downloadArkImage, pollIntervalMs = 2000, extraHeaders = {} } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  const base = `${new URL(origin).origin}${ARK_IMAGE_PATH}`;
  const headers = { "content-type": "application/json", ...extraHeaders,
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  let taskId;
  const read = async (response) => {
    const result = await responseJson(response);
    if (!response.ok) throw apiError(result, response.status, apiKey);
    return result;
  };
  try {
    const submitted = await read(await fetchImpl(`${base}/${action === "edit" ? "edits" : "generations"}`, {
      method: "POST", headers, body: JSON.stringify(payload), redirect: "error", signal,
    }));
    taskId = submitted?.task_id;
    if (typeof taskId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(taskId)) throw new Error("Ark 未返回有效 task_id。");
    while (true) {
      const task = await read(await fetchImpl(`${base}/tasks/${taskId}`, { method: "GET", headers, redirect: "error", signal }));
      if (task.task_id != null && task.task_id !== taskId) throw new Error("Ark 任務編號不符。");
      if (task.status === "succeeded") {
        const url = task.result?.images?.[0]?.url;
        if (typeof url !== "string" || !url) throw new Error("Ark 任務沒有圖片 URL。");
        const bytes = await downloadImpl(url, { signal });
        if (fileImageFormat(bytes) !== payload.output_format) throw new Error("Ark 回傳圖片格式與要求不符。");
        return { bytes, taskId };
      }
      if (!["pending", "queued", "running", "processing", "in_progress"].includes(task.status)) {
        throw new Error("Ark 圖片任務未成功。");
      }
      await delay(pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    const timedOut = error.name === "TimeoutError" || error.name === "AbortError";
    let message = timedOut ? "Ark 生圖逾時，上游可能仍在處理或計費。" : String(error.message || "Ark 圖片請求失敗。");
    if (apiKey) message = message.replaceAll(apiKey, "[redacted]");
    message = message.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 600);
    throw new Error(`${message}${taskId && /^[A-Za-z0-9_-]{1,160}$/.test(taskId) ? `（task_id=${taskId}）` : ""} 未重新提交任務。`);
  }
}

// 安裝器只測已選模型；每種介面每個模型最多提交一次。
export async function probeRelayImageModel({ model, upstreamModel = model, apiRoot, apiKey,
  fetchImpl = globalThis.fetch, timeoutMs = 300000, apiMode = "images", downloadImpl, pollIntervalMs } = {}) {
  if (!IMAGE_MODELS.includes(model) || !validImageUpstream(model, upstreamModel)) {
    throw new Error("無效的圖片測試模型。");
  }
  if (!imageApiModesFor(model).includes(apiMode)) throw new Error("此模型不支援這種生圖介面。");
  const testPrompt = "A small black circle centered on a plain white background.";
  if (apiMode === "chat" || apiMode === "gemini") {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const { response, result } = apiMode === "chat"
        ? await postChatImage(`${String(apiRoot).replace(/\/$/, "")}/chat/completions`,
          (modalities) => chatImagePayload(upstreamModel, testPrompt, [], { modalities }),
          { headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, signal, fetchImpl })
        : await (async () => {
          const response = await fetchImpl(`${new URL(apiRoot).origin}/v1beta/models/${upstreamModel}:generateContent`, {
            method: "POST", redirect: "error", signal,
            headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
            body: JSON.stringify(geminiImagePayload(testPrompt)) });
          return { response, result: await responseJson(response) };
        })();
      if (!response.ok) return { ok: false, error: apiError(Array.isArray(result) ? result[0] : result, response.status, apiKey).message };
      const image = apiMode === "chat" ? await extractChatImage(result, { signal, download: downloadImpl }) : extractGeminiImage(result);
      return { ok: true, bytes: image.bytes, format: image.format };
    } catch (error) {
      return { ok: false, error: error.name === "TimeoutError" || error.name === "AbortError"
        ? "生圖測試逾時；上游可能仍在處理或計費，未自動重試。" : String(error.message || "生圖測試失敗。").slice(0, 600) };
    }
  }
  if (apiMode === "ark-task") {
    try {
      return { ok: true, ...await runArkImageTask({ origin: apiRoot, apiKey, timeoutMs, fetchImpl, downloadImpl, pollIntervalMs,
        payload: { model: upstreamModel, prompt: "A small black circle centered on a plain white background.", output_format: "png" } }) };
    } catch (error) { return { ok: false, error: error.message }; }
  }
  if (apiMode !== "images") throw new Error("未知生圖介面。");
  let response;
  try {
    response = await fetchImpl(`${String(apiRoot).replace(/\/$/, "")}/images/generations`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: upstreamModel, prompt: "A small black circle centered on a plain white background.",
        n: 1, size: "1024x1024", quality: "low", output_format: "png" }),
    });
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" || error.name === "AbortError"
      ? "生圖測試逾時；上游可能仍在處理或計費，未自動重試。"
      : "生圖測試連線失敗，請檢查網路及供應商狀態；未自動重試。" };
  }
  let result;
  try { result = await responseJson(response); }
  catch (error) {
    return { ok: false, error: error.name === "TimeoutError" || error.name === "AbortError"
      ? "生圖測試逾時；上游可能仍在處理或計費，未自動重試。"
      : `圖片回應讀取失敗（HTTP ${response.status}），可能不是有效 JSON、過大或連線中斷；未自動重試。` };
  }
  if (!response.ok) return { ok: false, error: apiError(result, response.status, apiKey).message };
  try { return { ok: true, bytes: decodeImageResult(result, "png") }; }
  catch (error) { return { ok: false, error: error.message }; }
}

export async function discoverUsableRelayImages({ candidates, onProbe = () => {}, ...options } = {}) {
  const unique = [...new Map(candidates.map((model) => [model.id, model])).values()];
  const gpt = await discoverGptImages({ candidates: unique.filter((model) => GPT_IMAGE_MODELS.includes(model.id)), onProbe, ...options });
  const checks = [...gpt.checks];
  const models = [...gpt.models];
  const apiModes = Object.fromEntries(gpt.models.map((model) => [model.id, gpt.apiMode]));
  // Gemini 每個模型各自依序試介面，通過就停；同一模型每種介面最多一次。
  const gemini = unique.filter((model) => GEMINI_IMAGE_MODELS.includes(model.id));
  for (const [index, candidate] of gemini.entries()) {
    for (const apiMode of imageApiModesFor(candidate.id)) {
      onProbe(apiMode, candidate, index);
      const result = await probeRelayImageModel({ ...options, model: candidate.id, upstreamModel: candidate.upstreamModel, apiMode });
      checks.push({ apiMode, model: candidate.upstreamModel, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
      if (result.ok) { models.push({ ...candidate, bytes: result.bytes, format: result.format || "png" }); apiModes[candidate.id] = apiMode; break; }
    }
  }
  return { apiMode: gpt.apiMode, apiModes, models, checks };
}

async function discoverGptImages({ candidates, onProbe = () => {}, ...options } = {}) {
  const selected = candidates;
  const checks = [];
  for (const apiMode of ["images", "ark-task"]) {
    const models = [];
    for (const [index, candidate] of selected.entries()) {
      const model = { ...candidate, upstreamModel: apiMode === "ark-task" ? candidate.id : candidate.upstreamModel };
      onProbe(apiMode, model, index);
      const result = await probeRelayImageModel({ ...options, model: model.id, upstreamModel: model.upstreamModel, apiMode });
      checks.push({ apiMode, model: model.upstreamModel, ok: result.ok, ...(result.ok ? {} : { error: result.error }) });
      if (result.ok) models.push({ ...model, bytes: result.bytes });
    }
    // 有任何通用模型成功就使用該流程；不為剩餘失敗模型額外發送 Ark 提交。
    if (models.length) return { apiMode, models, checks };
  }
  return { apiMode: null, models: [], checks };
}

export async function runRelayImagegen(args, {
  configPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "config.json"),
  fetchImpl = globalThis.fetch,
  downloadImpl = downloadArkImage,
  pollIntervalMs = 2000,
} = {}) {
  const options = parseImagegenArgs(args);
  if (options.action === "help") return { help: HELP };
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.managedBy !== "codex-model-router" || typeof config.routerSettingsPath !== "string") {
    throw new Error("此命令尚未由路由器安裝器配置。");
  }
  const model = chooseImageModel(config, options.model, options.action);
  // 舊版技能沒有記錄供應商：那時只有一家，路由器會用主要供應商。
  const providerId = config.providerId ?? null;
  if (providerId !== null && !(typeof providerId === "string" && PROVIDER_ID_PATTERN.test(providerId))) {
    throw new Error("生圖供應商設定無效，請從路由器選單重新設定中轉 API 生圖。");
  }
  const providerHeaders = providerId ? { [PROVIDER_HEADER]: providerId } : {};
  // 新版技能逐模型記錄介面（apiModes）；舊版只有一個共用的 apiMode。
  const apiMode = config.apiModes?.[model] || config.apiMode || "images";
  if (!IMAGE_API_MODES.includes(apiMode) || !imageApiModesFor(model).includes(apiMode)) throw new Error("生圖介面設定無效，請重新設定中轉生圖。");
  const upstreamModel = config.upstreamModels?.[model] || model;
  if (!validImageUpstream(model, upstreamModel)) {
    throw new Error("圖片模型對應無效，請重新設定中轉生圖。");
  }
  if (options.action === "list") return { models: config.models, upstreamModels: config.upstreamModels, apiMode: config.apiMode || "images",
    apiModes: Object.fromEntries(config.models.map((id) => [id, config.apiModes?.[id] || config.apiMode || "images"])), provider: providerId,
    defaultGenerate: chooseImageModel(config, null, "generate"), defaultEdit: chooseImageModel(config, null, "edit") };

  const settings = JSON.parse(readFileSync(config.routerSettingsPath, "utf8"));
  const port = Number(settings.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("路由器端口無效，請重新配置路由器。");
  if (Boolean(options.prompt) === Boolean(options.promptFile)) throw new Error("請擇一提供 --prompt 或 --prompt-file。");
  const prompt = options.promptFile ? readFileSync(resolve(options.promptFile), "utf8") : options.prompt;
  if (!prompt.trim() || [...prompt].length > 32000) throw new Error("提示詞不可為空且最多 32000 字元。");
  if (!options.out) throw new Error("請以 --out 指定新的輸出檔案。");
  const ext = extname(options.out).slice(1).toLowerCase();
  const format = options.format || (ext === "jpg" ? "jpeg" : ext) || "png";
  if (!["png", "jpeg", "webp"].includes(format)) throw new Error("輸出格式只支援 png、jpeg、webp。");
  if (ext && (ext === "jpg" ? "jpeg" : ext) !== format) throw new Error("--out 副檔名與 --output-format 不一致。");
  const out = resolve(ext ? options.out : `${options.out}.${format}`);
  if (existsSync(out)) throw new Error(`輸出檔已存在，請換一個檔名：${out}`);
  if (apiMode === "ark-task" && (options.size !== "auto" || options.quality !== "auto" || options.background === "transparent")) {
    throw new Error("Ark 任務介面由上游決定尺寸與品質：size、quality 請使用 auto，background 只可用 auto 或 opaque。");
  }
  const nativeGemini = apiMode === "chat" || apiMode === "gemini";
  if (nativeGemini && (options.size !== "auto" || options.quality !== "auto" || options.background === "transparent")) {
    throw new Error("Nano Banana 由上游決定尺寸與品質：size、quality 請使用 auto，background 只可用 auto 或 opaque；比例與構圖請寫在提示詞裡。");
  }
  const qualities = model === IMAGE_MODELS[0] ? ["auto", "low", "medium", "high"]
    : GEMINI_IMAGE_MODELS.includes(model) ? ["auto"] : ["auto", "low", "medium", "high", "xhigh", "max"];
  if (!qualities.includes(options.quality)) throw new Error(`此模型不支援 quality=${options.quality}。`);
  if (!["auto", "opaque", "transparent"].includes(options.background)) throw new Error("background 只支援 auto、opaque、transparent。");
  if (options.background === "transparent" && format === "jpeg") throw new Error("透明背景需使用 PNG 或 WebP。");
  if (options.size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(options.size);
    const [width, height] = match ? match.slice(1).map(Number) : [0, 0];
    if (!width || !height || width % 16 || height % 16 || Math.max(width, height) > 3840 ||
        Math.max(width, height) > Math.min(width, height) * 3 || width * height < 655360 || width * height > 8294400) {
      throw new Error("尺寸需為 auto 或有效的 WIDTHxHEIGHT：邊長為 16 倍數、最長 3840、比例不超過 3:1、總像素 655360–8294400。");
    }
  }
  const timeout = Number(options.timeout);
  if (!Number.isFinite(timeout) || timeout < 1 || timeout > 1800) throw new Error("timeout 必須介於 1 至 1800 秒。");
  if (options.action === "edit" && !options.images.length) throw new Error("edit 至少需要一個 --image。");
  if (options.action === "generate" && options.images.length) throw new Error("帶參考圖請使用 edit 命令。");
  if (options.images.length > 16) throw new Error("最多提供 16 張圖片。");
  const inputs = options.images.map((path) => {
    if (!statSync(path).isFile() || statSync(path).size >= 50 * 1024 * 1024) throw new Error("每張參考圖必須是小於 50 MiB 的檔案。");
    const bytes = readFileSync(path);
    const type = fileImageFormat(bytes);
    if (!type) throw new Error("參考圖只支援 PNG、JPEG 或 WebP。");
    return { path, bytes, type };
  });
  const origin = `http://127.0.0.1:${port}`;
  const endpoint = apiMode === "chat" ? `${origin}${CHAT_IMAGE_PATH}` : apiMode === "gemini" ? `${origin}${GEMINI_IMAGE_PATH}`
    : `${origin}${apiMode === "ark-task" ? ARK_IMAGE_PATH : "/v1/images"}/${options.action === "edit" ? "edits" : "generations"}`;
  const payload = { model: upstreamModel, prompt, n: 1, size: options.size,
    quality: options.quality, background: options.background, output_format: format };
  if (options.dryRun) return { dryRun: true, model, upstreamModel, apiMode, endpoint, out, inputImages: inputs.length };
  mkdirSync(dirname(out), { recursive: true });
  let health;
  try {
    const response = await fetchImpl(`${origin}/healthz`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    health = await response.json();
    if (!response.ok || health?.status !== "ok" || typeof health.stats?.imageRequests !== "number" ||
        (apiMode === "ark-task" && typeof health.stats?.arkImageRequests !== "number") ||
        (nativeGemini && typeof health.stats?.geminiImageRequests !== "number")) throw new Error("health");
  } catch { throw new Error("本機圖片路由不可用；請從路由器選單檢查狀態或執行 update，沒有送出生圖請求。"); }
  if (nativeGemini) {
    const headers = { "content-type": "application/json", ...providerHeaders };
    const signal = AbortSignal.timeout(timeout * 1000);
    let response;
    let result;
    try {
      if (apiMode === "chat") {
        ({ response, result } = await postChatImage(endpoint,
          (modalities) => chatImagePayload(upstreamModel, prompt, inputs, { modalities }), { headers, signal, fetchImpl }));
      } else {
        response = await fetchImpl(endpoint, { method: "POST", headers, redirect: "error", signal,
          body: JSON.stringify({ model: upstreamModel, ...geminiImagePayload(prompt, inputs) }) });
        result = await responseJson(response);
      }
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("圖片請求逾時；上游可能仍在處理，未自動重試以避免重複計費。");
      throw error;
    }
    if (!response.ok) throw apiError(Array.isArray(result) ? result[0] : result, response.status);
    const image = apiMode === "chat" ? await extractChatImage(result, { signal, download: downloadImpl }) : extractGeminiImage(result);
    // Gemini 自己決定輸出格式；與要求不同時改用實際格式的副檔名，不轉檔也不寫錯副檔名。
    const path = image.format === format ? out : out.replace(/\.[A-Za-z0-9]+$/, "") + (image.format === "jpeg" ? ".jpg" : `.${image.format}`);
    if (path !== out && existsSync(path)) throw new Error(`上游回傳 ${image.format}，對應的輸出檔已存在，請換一個檔名：${path}`);
    writeFileSync(path, image.bytes, { mode: 0o600, flag: "wx" });
    return { model, upstreamModel, apiMode, path, format: image.format, bytes: image.bytes.length };
  }
  if (apiMode === "ark-task") {
    const arkPayload = { model: upstreamModel, prompt, output_format: format, background: options.background };
    if (options.action === "edit") arkPayload.image_base64s = inputs.map((image) => `data:image/${image.type};base64,${image.bytes.toString("base64")}`);
    const result = await runArkImageTask({ origin, action: options.action, payload: arkPayload, fetchImpl, downloadImpl,
      timeoutMs: timeout * 1000, pollIntervalMs, extraHeaders: providerHeaders });
    writeFileSync(out, result.bytes, { mode: 0o600, flag: "wx" });
    return { model, upstreamModel, apiMode, taskId: result.taskId, path: out, bytes: result.bytes.length };
  }
  let body = JSON.stringify(payload);
  const headers = { "content-type": "application/json", ...providerHeaders };
  if (options.action === "edit") {
    body = new FormData();
    for (const [name, value] of Object.entries(payload)) body.set(name, String(value));
    for (const image of inputs) body.append("image[]", new Blob([image.bytes], { type: `image/${image.type}` }), basename(image.path));
    delete headers["content-type"];
  }
  let response;
  let result;
  try {
    response = await fetchImpl(endpoint, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(timeout * 1000) });
    result = await responseJson(response);
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") throw new Error("圖片請求逾時；上游可能仍在處理，未自動重試以避免重複計費。");
    throw error;
  }
  if (!response.ok) throw apiError(result, response.status);
  const bytes = decodeImageResult(result, format);
  writeFileSync(out, bytes, { mode: 0o600, flag: "wx" });
  return { model, upstreamModel, path: out, bytes: bytes.length };
}

if (!process.env.CODEX_MODEL_ROUTER_IMPORT_ONLY && import.meta.url.startsWith("file:")) {
  try {
    const result = await runRelayImagegen(process.argv.slice(2));
    console.log(result.help || JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`中轉生圖失敗：${error.message}`);
    process.exitCode = 1;
  }
}
