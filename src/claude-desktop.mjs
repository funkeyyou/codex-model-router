// Native Anthropic ingress for Claude Desktop. No Codex history rewriting here.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, lstatSync, mkdirSync, writeFileSync, renameSync, unlinkSync, chmodSync, realpathSync } from "node:fs";
import { once } from "node:events";
import { dirname, join, win32, posix } from "node:path";
import { homedir, userInfo } from "node:os";
import { execFile } from "node:child_process";
import { promisify, isDeepStrictEqual } from "node:util";

const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function desktopDirectories({ platform = process.platform, home = homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Claude-3p");
  if (platform === "win32") return win32.join(localAppData || win32.join(home, "AppData", "Local"), "Claude-3p");
  throw new Error("Claude Desktop 自動接入目前僅支援 macOS 與 Windows。");
}

export async function detectDesktop({ platform = process.platform, home = homedir(), run = execute } = {}) {
  const directory = desktopDirectories({ platform, home });
  if (process.env.CLAUDE_USER_DATA_DIR) return { directory, available: false, reason: "Claude 使用自訂資料目錄，請改用手動連線設定。" };
  if (platform === "darwin") {
    const app = ["/Applications/Claude.app", join(home, "Applications", "Claude.app")].find(existsSync);
    if (!app) return { directory, available: false, reason: "未找到 Claude 桌面客戶端。" };
    const policies = ["/Library/Managed Preferences/com.anthropic.claudefordesktop.plist",
      `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudefordesktop.plist`];
    if (policies.some(existsSync)) return { directory, available: false, reason: "Claude 由組織政策管理，不能自動覆寫。" };
    return { directory, available: true, app, platform };
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "if ((Test-Path 'HKLM:\\SOFTWARE\\Policies\\Claude') -or (Test-Path 'HKCU:\\SOFTWARE\\Policies\\Claude')) { Write-Output '{\"managed\":true}'; exit }",
    "$paths=@((Join-Path $env:LOCALAPPDATA 'AnthropicClaude\\Claude.exe'),(Join-Path $env:LOCALAPPDATA 'Programs\\Claude\\Claude.exe'))",
    "$exe=$paths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1",
    "$id=Get-StartApps | Where-Object { $_.Name -eq 'Claude' -and $_.AppID -match '^(Claude_|AnthropicPBC.Claude_)' } | Select-Object -First 1 -ExpandProperty AppID",
    "@{app=$exe; appId=$id} | ConvertTo-Json -Compress",
  ].join("\n");
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000 });
  const info = JSON.parse(stdout.trim());
  return { directory, ...info, platform, available: !info.managed && Boolean(info.app || info.appId),
    reason: info.managed ? "Claude 由組織政策管理，不能自動覆寫。" : !info.app && !info.appId ? "未找到 Claude 桌面客戶端。" : null };
}

export function desktopLifecycle(info, { run = execute, wait = pause, timeoutMs = 30000 } = {}) {
  const ps = (text) => run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", text], { windowsHide: true, timeout: timeoutMs + 5000 });
  const osa = (text) => run("/usr/bin/osascript", ["-e", text], { timeout: timeoutMs + 5000 });
  const application = `application ${JSON.stringify(info.app || "")}`;
  const running = async () => info.platform === "darwin"
    ? (await osa(`${application} is running`)).stdout.trim() === "true"
    : (await ps("if(Get-Process -Name Claude -ErrorAction SilentlyContinue){'true'}else{'false'}")).stdout.trim() === "true";
  const until = async (expected) => {
    const deadline = Date.now() + timeoutMs;
    do { if (await running() === expected) return; await wait(300); } while (Date.now() < deadline);
    throw new Error(expected ? "Claude 未能重新啟動。" : "Claude 尚未退出，未修改設定。請先結束任務並關閉 Claude。");
  };
  return {
    async stop() {
      const wasRunning = await running();
      if (wasRunning) {
        if (info.platform === "darwin") await osa(`tell ${application} to quit`);
        else await ps("Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0} | ForEach-Object { [void]$_.CloseMainWindow() }");
        await until(false);
      }
      return wasRunning;
    },
    async start() {
      if (info.platform === "darwin") await run("/usr/bin/open", [info.app], { timeout: 10000 });
      else if (info.app) await ps(`Start-Process -FilePath '${info.app.replaceAll("'", "''")}'`);
      else {
        if (!/^(Claude_|AnthropicPBC\.Claude_)[\w.!-]+$/.test(info.appId || "")) throw new Error("Invalid Claude application ID.");
        await run("explorer.exe", [`shell:AppsFolder\\${info.appId}`], { windowsHide: true, timeout: 10000 });
      }
      await until(true);
    },
  };
}

function regularPath(path) {
  let cursor = path;
  while (true) {
    try {
      const systemAlias = (cursor === "/var" || cursor === "/tmp") && realpathSync(cursor) === "/private" + cursor;
      if (lstatSync(cursor).isSymbolicLink() && !systemAlias) throw new Error("Claude 設定路徑含符號連結，未修改。");
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(cursor);
    if (cursor === parent) break;
    cursor = parent;
  }
}

function snapshot(path) {
  regularPath(path);
  try {
    const raw = readFileSync(path, "utf8");
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude 設定格式無效，未修改。");
    return { path, raw, value, mode: lstatSync(path).mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { path, raw: null, value: {}, mode: 0o600 };
    if (error instanceof SyntaxError) throw new Error("Claude 設定格式無效，未修改。");
    throw error;
  }
}

function putFile(path, raw, mode = 0o600) {
  regularPath(path);
  if (raw === null) { if (existsSync(path)) unlinkSync(path); return; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + ".router-" + randomBytes(6).toString("hex");
  writeFileSync(temp, raw, { mode, flag: "wx" });
  try { renameSync(temp, path); chmodSync(path, mode); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}
const encoded = (value) => JSON.stringify(value, null, 2) + "\n";
const conflict = () => new Error("Claude 設定已被其他操作修改，為避免覆蓋，請先檢查備份與目前設定。");

export function integrationStatus(backupPath) {
  try { return JSON.parse(readFileSync(backupPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("Claude 接入備份無法讀取，未修改設定。"); }
}

function integrationPaths(directory, id, gatewayPath) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid Claude profile ID.");
  return [join(directory, "configLibrary", id + ".json"), join(directory, "configLibrary", "_meta.json"),
    join(directory, "claude_desktop_config.json"), gatewayPath];
}

export function planDesktopRestore(state, { directory, gatewayPath }) {
  const paths = integrationPaths(directory, state.id, gatewayPath);
  if (state.schema !== 1 || !Array.isArray(state.files) || state.files.length !== paths.length
    || state.files.some((file, index) => file.path !== paths[index])) throw new Error("Invalid Claude integration backup.");
  return state.files.map((file, index) => {
    const now = snapshot(file.path);
    if (now.raw === file.before.raw) return { ...now, restore: now.raw };
    if (isDeepStrictEqual(now.value, file.after)) return { ...now, restore: file.before.raw, mode: file.before.mode };
    // Preserve unrelated preferences and other newly saved profiles.
    const next = structuredClone(now.value);
    const keys = index === 2 ? ["deploymentMode"] : index === 1 ? ["appliedId", "hybridPointer"] : null;
    if (!keys) throw conflict();
    for (const key of keys) {
      if (!isDeepStrictEqual(now.value[key], file.after[key])) throw conflict();
      if (Object.hasOwn(file.before.value, key)) next[key] = file.before.value[key];
      else delete next[key];
    }
    if (index === 1) {
      if (!Array.isArray(next.entries)) throw conflict();
      const owned = next.entries.filter((entry) => entry.id === state.id);
      if (owned.length !== 1 || !isDeepStrictEqual(owned[0], file.after.entries.find((entry) => entry.id === state.id))) throw conflict();
      next.entries = next.entries.filter((entry) => entry.id !== state.id);
      if (!Object.hasOwn(file.before.value, "entries") && !next.entries.length) delete next.entries;
    }
    return { ...now, restore: !Object.keys(next).length && file.before.raw === null ? null : encoded(next) };
  });
}

function commitFiles(changes) {
  for (const item of changes) if (snapshot(item.path).raw !== item.raw) throw conflict();
  const written = [];
  try {
    for (const item of changes) {
      if (snapshot(item.path).raw !== item.raw) throw conflict();
      putFile(item.path, item.restore, item.mode);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) {
      if (snapshot(item.path).raw !== item.restore) throw conflict();
      putFile(item.path, item.raw, item.mode);
    }
    throw error;
  }
}

export async function connectDesktop({ directory, gatewayPath, backupPath, settings, lifecycle }) {
  if (integrationStatus(backupPath)?.status !== "restored" && integrationStatus(backupPath)) throw new Error("Claude 已有接入備份，請先回退再重新接入。");
  if (!desktopRoutes(settings).length) throw new Error("請先添加使用 Anthropic Messages 介面的 Claude API 模型。");
  const id = randomUUID(), config = newDesktopConfig(readDesktopConfig(gatewayPath));
  const paths = integrationPaths(directory, id, gatewayPath);
  const values = (before) => {
    const meta = structuredClone(before[1].value);
    if (before[0].raw !== null || (meta.entries !== undefined && (!Array.isArray(meta.entries)
      || meta.entries.some((entry) => !entry || typeof entry.id !== "string" || typeof entry.name !== "string")))
      || (before[2].value.deploymentMode !== undefined && !["1p", "3p"].includes(before[2].value.deploymentMode))) {
      throw new Error("Claude 設定格式無效，未修改。");
    }
    meta.entries = [...(meta.entries || []), { id, name: "Model Router" }];
    meta.appliedId = id;
    delete meta.hybridPointer;
    return [desktopConnection(settings, config), meta, { ...before[2].value, deploymentMode: "3p" }, config];
  };
  values(paths.map(snapshot)); // Reject corrupt/unknown configurations before closing the app.
  const wasRunning = await lifecycle.stop();
  let state;
  try {
    const before = paths.map(snapshot), after = values(before);
    state = { schema: 1, id, status: "prepared", createdAt: new Date().toISOString(),
      files: before.map((file, index) => ({ path: file.path, before: file, after: after[index] })) };
    putFile(backupPath, encoded(state));
    commitFiles(before.map((file, index) => ({ ...file, restore: encoded(after[index]), mode: 0o600 })));
    state.status = "applied";
    putFile(backupPath, encoded(state));
    await lifecycle.start();
    return { connected: true, restarted: true };
  } catch (error) {
    // A start failure can leave a partially started app. Stop before restoring.
    if (state) {
      await lifecycle.stop();
      commitFiles(planDesktopRestore(state, { directory, gatewayPath }));
      state.status = "restored";
      putFile(backupPath, encoded(state));
    }
    if (wasRunning) await lifecycle.start().catch(() => {});
    throw error;
  }
}

export async function restoreDesktop({ directory, gatewayPath, backupPath, lifecycle }) {
  const state = integrationStatus(backupPath);
  if (!state || state.status === "restored") return { restored: true, restarted: false };
  // Detect conflicts before closing Claude; check again after it exits.
  planDesktopRestore(state, { directory, gatewayPath });
  await lifecycle.stop();
  commitFiles(planDesktopRestore(state, { directory, gatewayPath }));
  state.status = "restored";
  putFile(backupPath, encoded(state));
  await lifecycle.start();
  return { restored: true, restarted: true };
}

export const DESKTOP_PREFIX = "/claude";
export const DESKTOP_TOKEN_PREFIX = "cmr-claude-";
export const DESKTOP_CONFIG_FILE = "claude-desktop.json";

export function desktopRoutes(settings) {
  const providers = new Set((settings.providers?.length ? settings.providers : settings.apiRoot ? [{ id: "default" }] : [])
    .map((provider) => provider.id || "default"));
  return (settings.routes || []).filter((route) => route.translate === "anthropic"
    && route.transport !== "claude-cli" && /(?:^|\/)claude-/.test(route.upstreamModel || "")
    && providers.has(route.providerId || "default"));
}

export function desktopModels(settings) {
  const tiers = new Set();
  const data = desktopRoutes(settings).map((route) => {
    const tier = /(?:^|\/)claude-(opus|sonnet|haiku|fable|mythos)(?:-|$)/.exec(route.upstreamModel)?.[1];
    const first = tier && !tiers.has(tier);
    if (tier) tiers.add(tier);
    return {
      id: route.pickerSlug, type: "model", display_name: route.displayName || route.upstreamModel,
      created_at: "2026-01-01T00:00:00Z",
      ...(tier ? { anthropic_family_tier: tier, is_family_default: Boolean(first) } : {}),
    };
  });
  // Context values in our catalog can be user overrides, not verified capabilities.
  // Do not advertise supports_1m from those values.
  return { data, has_more: false, first_id: data[0]?.id || null, last_id: data.at(-1)?.id || null };
}

export function readDesktopConfig(path) {
  try {
    const config = JSON.parse(readFileSync(path, "utf8"));
    return config?.enabled === true && /^cmr-claude-[a-f0-9]{48}$/.test(config.token || "") ? config : null;
  } catch { return null; }
}

export function newDesktopConfig(previous) {
  return { enabled: true, token: /^cmr-claude-[a-f0-9]{48}$/.test(previous?.token || "")
    ? previous.token : DESKTOP_TOKEN_PREFIX + randomBytes(24).toString("hex") };
}

function requestToken(headers) {
  return headers["x-api-key"] || (typeof headers.authorization === "string"
    && headers.authorization.startsWith("Bearer ") ? headers.authorization.slice(7) : "");
}

export function hasDesktopToken(headers) {
  return [headers["x-api-key"], headers.authorization].some((value) => typeof value === "string" && value.includes(DESKTOP_TOKEN_PREFIX));
}

export function desktopAuthorized(headers, config) {
  if (!config) return false;
  const token = requestToken(headers);
  if (typeof token !== "string" || !token) return false;
  const digest = (value) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(token), digest(config.token));
}

export function desktopConnection(settings, config) {
  if (!config) return null;
  return {
    inferenceProvider: "gateway", inferenceGatewayBaseUrl: `http://127.0.0.1:${settings.port}${DESKTOP_PREFIX}`,
    inferenceGatewayApiKey: config.token,
    modelDiscoveryEnabled: true,
  };
}

export function desktopHeaders(incoming, key, target) {
  const official = new URL(target).hostname.toLowerCase() === "api.anthropic.com";
  const headers = new Headers(official ? { "x-api-key": key } : { authorization: `Bearer ${key}` });
  headers.set("content-type", "application/json");
  headers.set("anthropic-version", incoming["anthropic-version"] || "2023-06-01");
  for (const name of ["anthropic-beta", "accept", "user-agent"]) {
    if (typeof incoming[name] === "string") headers.set(name, incoming[name]);
  }
  return headers;
}

function failure(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function desktopRoute(settings, model) {
  const routes = desktopRoutes(settings);
  const exact = routes.find((route) => route.pickerSlug === model);
  if (exact) return exact;
  const matching = routes.filter((route) => route.upstreamModel === model);
  if (matching.length === 1) return matching[0];
  // Never silently choose another provider when the same upstream ID exists twice.
  throw failure(404, "claude_model_not_configured", "Choose a Claude API model from the gateway model list.");
}

// Only retain usage counters. Large text/image/tool frames are forwarded untouched,
// but not retained by the observer. Lifecycle and usage frames are small.
export function desktopUsageObserver() {
  let buffer = "", skip = false, started = false, stopped = false, failed = false, stopReason = null, usage = null;
  const decoder = new TextDecoder();
  const frame = (text) => {
    const data = text.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    try {
      const event = JSON.parse(data);
      if (event.type === "message_start") { started = true; usage = { ...event.message?.usage }; }
      if (event.type === "message_delta") {
        if (event.usage) usage = { ...usage, ...event.usage };
        stopReason = event.delta?.stop_reason || stopReason;
      }
      if (event.type === "message_stop") stopped = true;
      if (event.type === "error") failed = true;
    } catch { /* Non-JSON comments/frames have no usage. */ }
  };
  return {
    push(chunk) {
      // Normalize CRLF even when the two bytes arrive in separate chunks.
      buffer += decoder.decode(chunk, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        if (!skip && match.index <= 64 * 1024) frame(buffer.slice(0, match.index).replaceAll("\r\n", "\n"));
        buffer = buffer.slice(match.index + match[0].length);
        skip = false;
      }
      if (buffer.length > 64 * 1024) { buffer = buffer.slice(-3); skip = true; }
    },
    result() {
      return { usage, status: failed || !started || !stopped ? "failed" : stopReason === "max_tokens" ? "incomplete" : "completed" };
    },
  };
}

export function desktopUsageEvent(result, model, errorCode) {
  const u = result.usage;
  const number = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
  return { type: `response.${result.status}`, response: { model,
    ...(u ? { usage: {
      input_tokens: number(u.input_tokens) + number(u.cache_read_input_tokens) + number(u.cache_creation_input_tokens),
      input_tokens_details: { cached_tokens: number(u.cache_read_input_tokens), cache_write_tokens: number(u.cache_creation_input_tokens) },
      output_tokens: number(u.output_tokens),
    } } : {}),
    ...(errorCode ? { error: { code: errorCode } } : {}),
  } };
}

export function createDesktopHandler({ settings, configPath, readBody, fetchUpstream, recordUsage, recordError,
  timeoutMs = 10 * 60 * 1000 }) {
  const json = (response, status, body) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
  };
  return async (request, response, url) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => { if (!response.writableFinished) abort(); };
    const timer = setTimeout(abort, timeoutMs);
    timer.unref();
    request.on("aborted", abort);
    response.on("close", closed);
    let context = null, recorded = false, observer = null;
    const report = (result, code) => {
      if (!context || recorded) return;
      recorded = true;
      recordUsage(context, desktopUsageEvent(result, context.upstreamModel, code));
    };
    try {
      // Electron's net stack also sends Origin / Sec-Fetch-* metadata. The
      // dedicated key is the authentication boundary, not browser-like headers.
      // No CORS response or preflight support: unrelated websites cannot read
      // responses or attach this non-cookie credential without already having it.
      if (!desktopAuthorized(request.headers, readDesktopConfig(configPath))) throw failure(401, "authentication_error", "Claude Desktop gateway is disabled or its local key is invalid.");
      const path = url.pathname.slice(DESKTOP_PREFIX.length);
      if (request.method === "GET" && path === "/v1/models") {
        json(response, 200, desktopModels(settings)); return;
      }
      const countTokens = path === "/v1/messages/count_tokens";
      if (request.method !== "POST" || (path !== "/v1/messages" && !countTokens)) throw failure(404, "not_found_error", "Unsupported Claude gateway endpoint.");
      if (request.headers["content-encoding"] && request.headers["content-encoding"] !== "identity") throw failure(415, "invalid_request_error", "Unsupported content encoding.");
      let body;
      try { body = JSON.parse((await readBody(request)).toString("utf8")); }
      catch (error) { if (error.status) throw error; throw failure(400, "invalid_request_error", "Invalid JSON request."); }
      if (!body || Array.isArray(body) || typeof body !== "object" || typeof body.model !== "string") throw failure(400, "invalid_request_error", "A model is required.");
      const route = desktopRoute(settings, body.model);
      context = { startedAt: Date.now(), model: route.pickerSlug, upstreamModel: route.upstreamModel,
        route: "custom", provider: route.providerId || "default", transport: "claude-desktop", backgroundKind: null, thread: null, recorded: false };
      const upstream = await fetchUpstream(route, countTokens ? "/messages/count_tokens" : "/messages", request.headers,
        Buffer.from(JSON.stringify({ ...body, model: route.upstreamModel })), controller.signal);
      if (!upstream.ok) throw failure(upstream.status >= 400 ? upstream.status : 502, "claude_upstream_error", `Claude upstream returned HTTP ${upstream.status}.`);
      if (body.stream === true && !countTokens) {
        if (!upstream.headers.get("content-type")?.includes("text/event-stream") || !upstream.body) throw failure(502, "invalid_upstream_response", "Expected an Anthropic event stream.");
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
        response.flushHeaders();
        observer = desktopUsageObserver();
        for await (const chunk of upstream.body) {
          observer.push(chunk);
          if (!response.write(chunk)) await once(response, "drain", { signal: controller.signal });
        }
        const result = observer.result();
        if (result.status === "failed") {
          report(result, "claude_stream_incomplete");
          throw failure(502, "claude_stream_incomplete", "Claude stream failed or ended before message_stop.");
        }
        report(result);
        response.end();
      } else {
        const value = await upstream.json();
        if (countTokens ? !Number.isFinite(value?.input_tokens) : value?.type !== "message" || !Array.isArray(value.content)) throw failure(502, "invalid_upstream_response", "Invalid Anthropic response.");
        if (!countTokens) report({ usage: value.usage, status: value.stop_reason === "max_tokens" ? "incomplete" : "completed" });
        json(response, 200, value);
      }
    } catch (error) {
      const code = controller.signal.aborted ? "claude_request_aborted" : error.code || "claude_gateway_error";
      report({ ...observer?.result(), status: "failed" }, code);
      const status = Number.isInteger(error.status) ? error.status : 502;
      const message = error.status ? error.message : "Claude gateway request failed. Check the router diagnostics.";
      recordError({ status, code, message }, context);
      if (!response.destroyed) {
        const body = { type: "error", error: { type: code, message } };
        if (response.headersSent) response.end(`event: error\ndata: ${JSON.stringify(body)}\n\n`);
        else json(response, status, body);
      }
    } finally {
      controller.abort();
      clearTimeout(timer);
      request.off("aborted", abort);
      response.off("close", closed);
    }
  };
}
