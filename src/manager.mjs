// 網頁管理介面的伺服器端：本機 HTTP、存取權杖、背景工作與輸出擷取。
//
// 這裡只負責「網頁這一層」。讀設定、探測模型、寫檔與重啟都由安裝器以 ops 物件傳入，
// 終端選單與網頁走同一套實作，不會出現兩邊行為不一致。
//
// 路由器本身拒絕一切瀏覽器請求；管理頁必須服務瀏覽器，因此另外把關：
//   1. 只聽 127.0.0.1，Host 必須是本機名稱加上本頁的埠，擋 DNS rebinding。
//   2. /api/* 一律要求存取權杖標頭。其他網頁讀不到權杖，也帶不了自訂標頭
//      （會觸發 CORS 預檢，而這裡從不回 CORS 標頭）。
//   3. 帶 Origin 的請求必須來自本頁；POST 只收 application/json。
//   4. 頁面送 CSP（腳本與樣式只認本次回應的 nonce）、no-referrer 與禁止嵌入，
//      網址片段裡的權杖不會隨外部連結送出。

import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, timingSafeEqual } from "node:crypto";

export const TOKEN_HEADER = "x-router-manager-token";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_JOB_OUTPUT = 512 * 1024;
const KEEP_FINISHED_JOBS = 20;
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function createToken() {
  return randomBytes(24).toString("base64url");
}

export function stripAnsi(text) {
  return String(text ?? "")
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

// 瀏覽器對非 80 埠一定會在 Host 帶上埠號；不帶或埠號不符都拒絕。
export function isAllowedHost(value, port) {
  if (typeof value !== "string" || !Number.isInteger(port)) return false;
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(value.trim());
  if (!match) return false;
  return LOOPBACK_NAMES.has(match[1].toLowerCase().replace(/\.$/, "")) && Number(match[2]) === port;
}

// 同源的 GET 不帶 Origin；帶了就必須是本頁。"null"（沙箱、檔案頁）一律拒絕。
export function isAllowedOrigin(value, port) {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK_NAMES.has(url.hostname.toLowerCase()) && Number(url.port) === port;
  } catch {
    return false;
  }
}

export function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string" || !expected) return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

// 背景工作：同一時間只跑一項會改設定的操作。輸出由 installOutputCapture 依
// AsyncLocalStorage 歸到對應的工作，網頁以 offset 輪詢增量內容。
export function createJobRunner({ maxOutput = MAX_JOB_OUTPUT, keep = KEEP_FINISHED_JOBS, now = () => Date.now() } = {}) {
  const jobs = new Map();
  const storage = new AsyncLocalStorage();
  let active = null;
  let counter = 0;

  const prune = () => {
    const finished = [...jobs.values()].filter((job) => job.status !== "running");
    for (const job of finished.slice(0, Math.max(0, finished.length - keep))) jobs.delete(job.id);
  };

  const runner = {
    storage,
    active: () => active,
    get: (id) => jobs.get(id) || null,
    append(job, text) {
      if (!job || text == null || text === "") return;
      job.output += stripAnsi(text).replace(/\r(?!\n)/g, "\n");
      if (job.output.length > maxOutput) {
        const drop = job.output.length - maxOutput;
        job.output = job.output.slice(drop);
        job.base += drop;
      }
    },
    start(type, title, run) {
      if (active) throw httpError(409, `「${active.title}」正在進行中，請等它完成。`);
      counter += 1;
      const job = {
        id: `${now().toString(36)}-${counter}-${randomBytes(3).toString("hex")}`,
        type, title, status: "running", output: "", base: 0,
        result: null, error: null, startedAt: new Date(now()).toISOString(), finishedAt: null,
      };
      jobs.set(job.id, job);
      active = job;
      prune();
      storage.run(job, () => {
        Promise.resolve()
          .then(() => run(job))
          .then(
            (result) => {
              job.result = result ?? null;
              job.status = "succeeded";
            },
            (error) => {
              job.error = messageOf(error);
              job.status = "failed";
              console.error(`\n錯誤：${job.error}`);
            },
          )
          .finally(() => {
            job.finishedAt = new Date(now()).toISOString();
            if (active === job) active = null;
          });
      });
      return job;
    },
    view(job, offset = 0) {
      const start = Math.max(0, Math.min(job.output.length, Number(offset) - job.base));
      return {
        id: job.id, type: job.type, title: job.title, status: job.status,
        output: job.output.slice(start), offset: job.base + job.output.length,
        result: job.result, error: job.error, startedAt: job.startedAt, finishedAt: job.finishedAt,
      };
    },
  };
  return runner;
}

// 工作期間的終端輸出（console.log、探測進度、子行程輸出）同時寫進該工作的記錄。
// 終端照常顯示，網頁看到的是同一份內容。
export function installOutputCapture(runner, streams = [process.stdout, process.stderr]) {
  const originals = streams.map((stream) => {
    const write = stream.write;
    stream.write = function captureWrite(chunk, encoding, callback) {
      const job = runner.storage.getStore();
      if (job) {
        const text = typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString(typeof encoding === "string" ? encoding : "utf8");
        runner.append(job, text);
      }
      return write.call(this, chunk, encoding, callback);
    };
    return [stream, write];
  });
  return () => {
    for (const [stream, write] of originals) stream.write = write;
  };
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function sendJson(response, status, payload) {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(payload));
}

export function pageWithNonce(html, nonce) {
  return String(html).replace(/<(script|style)(?=[\s>])/g, `<$1 nonce="${nonce}"`);
}

function sendPage(response, html, headOnly = false) {
  const nonce = randomBytes(16).toString("base64");
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "img-src data:",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
  });
  response.end(headOnly ? undefined : pageWithNonce(html, nonce));
}

async function readJson(request) {
  const type = String(request.headers["content-type"] || "").toLowerCase();
  if (!type.startsWith("application/json")) throw httpError(415, "請求必須是 JSON。");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, "請求內容過大。");
    chunks.push(chunk);
  }
  if (size === 0) return {};
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "請求不是有效的 JSON。");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "請求格式無效。");
  return value;
}

// ops：state、version、errors、discover、providerDraft、queries（唯讀查詢，{ type: run }）
// 與 jobs（會改設定的背景工作，{ type: { title, run } }）。
// restartBlocked() 回傳字串時拒絕重新啟動管理頁，回傳 null 才呼叫 onRestart。
export function createManagerServer({
  html, token, version, ops, jobs,
  onActivity = () => {}, onShutdown = () => {}, onRestart = null, restartBlocked = () => null,
}) {
  if (!html || !token || !ops || !jobs) throw new Error("createManagerServer 缺少必要參數。");
  let port = null;
  const activeSummary = () => {
    const job = jobs.active();
    return job ? { id: job.id, type: job.type, title: job.title } : null;
  };

  async function handle(request, response) {
    if (!isAllowedHost(request.headers.host, port)) {
      sendJson(response, 403, { error: "只接受以 127.0.0.1 或 localhost 開啟的管理頁。" });
      return;
    }
    const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
    const { pathname } = url;
    const method = request.method;
    if (pathname === "/" || pathname === "/index.html") {
      if (method !== "GET" && method !== "HEAD") {
        sendJson(response, 405, { error: "不支援的方法。" });
        return;
      }
      sendPage(response, html, method === "HEAD");
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (!pathname.startsWith("/api/")) {
      sendJson(response, 404, { error: "找不到這個頁面。" });
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, port)) {
      sendJson(response, 403, { error: "拒絕來自其他網站的請求。" });
      return;
    }
    if (!tokenMatches(request.headers[TOKEN_HEADER], token)) {
      sendJson(response, 401, { error: "存取權杖無效：請從終端機顯示的網址重新開啟管理頁。" });
      return;
    }
    if (method !== "GET" && method !== "POST") {
      sendJson(response, 405, { error: "不支援的方法。" });
      return;
    }
    onActivity();
    const body = method === "POST" ? await readJson(request) : null;
    const route = `${method} ${pathname}`;

    if (route === "GET /api/state") {
      sendJson(response, 200, { ...(await ops.state()), manager: { version, activeJob: activeSummary() } });
      return;
    }
    if (route === "GET /api/version") {
      sendJson(response, 200, await ops.version({ refresh: url.searchParams.get("refresh") === "1" }));
      return;
    }
    if (route === "GET /api/errors") {
      sendJson(response, 200, await ops.errors());
      return;
    }
    if (route === "POST /api/ping") {
      sendJson(response, 200, { ok: true, version, activeJob: activeSummary() });
      return;
    }
    if (route === "POST /api/discover") {
      sendJson(response, 200, await ops.discover(body));
      return;
    }
    if (route === "POST /api/provider-draft") {
      sendJson(response, 200, await ops.providerDraft(body));
      return;
    }
    if (route === "POST /api/query") {
      const run = typeof body.type === "string" && ops.queries && Object.hasOwn(ops.queries, body.type) ? ops.queries[body.type] : null;
      if (!run) {
        sendJson(response, 400, { error: "不支援的查詢。" });
        return;
      }
      const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
      sendJson(response, 200, await run(params));
      return;
    }
    if (route === "POST /api/jobs") {
      const spec = typeof body.type === "string" && Object.hasOwn(ops.jobs, body.type) ? ops.jobs[body.type] : null;
      if (!spec) {
        sendJson(response, 400, { error: "不支援的操作。" });
        return;
      }
      const params = body.params && typeof body.params === "object" && !Array.isArray(body.params) ? body.params : {};
      const job = jobs.start(body.type, spec.title, () => spec.run(params));
      sendJson(response, 202, jobs.view(job, 0));
      return;
    }
    const jobMatch = /^\/api\/jobs\/([A-Za-z0-9-]{1,64})$/.exec(pathname);
    if (method === "GET" && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        sendJson(response, 404, { error: "找不到這項操作，管理頁可能已重新啟動。" });
        return;
      }
      sendJson(response, 200, jobs.view(job, Number(url.searchParams.get("offset")) || 0));
      return;
    }
    if (route === "POST /api/restart" || route === "POST /api/shutdown") {
      if (jobs.active()) {
        sendJson(response, 409, { error: "還有操作正在進行，請等它完成。" });
        return;
      }
      const restart = route === "POST /api/restart";
      const blocked = restart ? (onRestart ? restartBlocked() : "目前無法重新啟動管理頁。") : null;
      if (blocked) {
        sendJson(response, 400, { error: blocked });
        return;
      }
      sendJson(response, 202, { ok: true });
      setImmediate(() => (restart ? onRestart() : onShutdown()));
      return;
    }
    sendJson(response, 404, { error: "找不到這個 API。" });
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error) => {
      // 安裝器以 fail() 丟出的是給使用者看的錯誤（名稱無效、探測未通過）；程式錯誤才算 500。
      const programming = error instanceof TypeError || error instanceof ReferenceError || error instanceof SyntaxError;
      const status = Number.isInteger(error?.status) ? error.status : programming ? 500 : 400;
      if (!response.headersSent) sendJson(response, status, { error: messageOf(error) });
      else response.end();
    });
  });
  server.on("listening", () => {
    port = server.address().port;
  });
  return server;
}
