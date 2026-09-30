// Experimental Claude Code transport. The CLI owns authentication; this module
// never reads OAuth credentials. Codex remains the only tool executor.
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

// One TTL for the CLI's own breakpoints and the history breakpoint added below.
// Anthropic rejects a longer TTL after a shorter one, so the two must match.
export const CLI_CACHE_TTL = "1h";
const CACHE_MARKER_COOLDOWN_MS = 30 * 60 * 1000;
let cacheMarkerDisabledUntil = 0;

export function cliCacheMarkerEnabled(now = Date.now()) {
  return now >= cacheMarkerDisabledUntil;
}

export function disableCliCacheMarker(now = Date.now()) {
  cacheMarkerDisabledUntil = now + CACHE_MARKER_COOLDOWN_MS;
}

export function resetCliCacheMarker() {
  cacheMarkerDisabledUntil = 0;
}

// A request rejected for its cache breakpoints is safe to resend without the
// router's marker: the API validates the request before any generation.
export function cacheControlRejected(text) {
  return /cache[_ ]control|prompt[_ ]cach|\bttl\b/i.test(String(text || ""));
}

export function claudeCliEnvironment(source = process.env) {
  const env = { ...source };
  // A subscription route must not silently use an inherited API key, proxy
  // provider, or a different model. HTTP(S)_PROXY is deliberately retained.
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_|CLAUDE_CONFIG_DIR$|CLAUDECODE$|ENABLE_TOOL_SEARCH$|FORCE_PROMPT_CACHING_|ENABLE_PROMPT_CACHING_|DISABLE_PROMPT_CACHING)/.test(key)) delete env[key];
  }
  return { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_PROMPT_CACHE_TTL: CLI_CACHE_TTL,
    // Codex Code Mode documents its nested tools in the exec description; the
    // CLI otherwise truncates every MCP tool description at 2,048 characters.
    CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "1048576",
    // Keep every Codex tool directly callable. Deferred MCP tools would need the
    // CLI's own search tool, which this isolated route does not provide.
    ENABLE_TOOL_SEARCH: "false" };
}

const isolationArgs = ["--setting-sources", "", "--settings", '{"disableAllHooks":true}'];

// SDK initialize exposes ModelInfo[] without sending a user/model turn.
// Return only models, never the account metadata also present in this response.
export async function discoverClaudeCliModels(binary, { timeoutMs = 15000, env = claudeCliEnvironment() } = {}) {
  if (!isAbsolute(binary || "")) throw new Error("Claude CLI 路徑必須是絕對路徑。");
  const directory = await mkdtemp(join(tmpdir(), "codex-claude-models-"));
  let child, closedPromise;
  try {
    return await new Promise((resolve, reject) => {
      const id = randomUUID();
      let pending = "", settled = false, killTimer;
      const finish = (error, models) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
        if (error) reject(error); else resolve(models);
      };
      child = spawn(binary, ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
        "--no-session-persistence", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands", "--no-chrome", ...isolationArgs],
      { cwd: directory, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      closedPromise = new Promise((resolve) => child.once("close", resolve));
      const timer = setTimeout(() => finish(new Error("讀取 Claude CLI 模型清單逾時。")), timeoutMs);
      child.once("error", () => finish(new Error("無法啟動 Claude CLI 模型查詢。")));
      child.once("close", () => {
        if (!settled) finish(new Error("Claude CLI 未回傳模型清單。"));
        clearTimeout(killTimer);
      });
      child.stderr.resume();
      child.stdin.on("error", () => finish(new Error("Claude CLI 模型查詢中斷。")));
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        pending += chunk;
        if (pending.length > 4 * 1024 * 1024) return finish(new Error("Claude CLI 模型清單過大。"));
        let newline;
        while (!settled && (newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { finish(new Error("Claude CLI 模型清單格式不相容。")); return; }
          if (message?.type !== "control_response" || message.response?.request_id !== id) continue;
          const models = message.response?.response?.models;
          if (message.response.subtype !== "success" || !Array.isArray(models) || !models.length) {
            finish(new Error("Claude CLI 未提供可用的模型清單。")); return;
          }
          finish(null, models);
        }
      });
      child.stdin.write(JSON.stringify({ type: "control_request", request_id: id, request: { subtype: "initialize" } }) + "\n");
    });
  } finally {
    if (closedPromise) await closedPromise;
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export async function claudeCliAuth(binary, { login = false, signal } = {}) {
  if (!isAbsolute(binary || "")) throw new Error("Claude CLI 路徑必須是絕對路徑。");
  const directory = await mkdtemp(join(tmpdir(), "codex-claude-auth-"));
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(binary, ["auth", login ? "login" : "status"], {
        cwd: directory, env: claudeCliEnvironment(), windowsHide: !login,
        ...(signal ? { signal } : {}),
        stdio: login ? "inherit" : ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout?.on("data", (chunk) => { if (output.length < 65536) output += chunk; });
      child.stderr?.resume();
      const timer = setTimeout(() => child.kill(), login ? 300000 : 20000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (login) return code === 0 ? resolve({ loggedIn: true }) : reject(new Error("Claude 登入未完成。"));
        try {
          const status = JSON.parse(output);
          resolve({ loggedIn: code === 0 && status.loggedIn === true,
            authMethod: status.authMethod, apiProvider: status.apiProvider });
        } catch { reject(new Error("無法讀取 Claude 登入狀態，請確認 CLI 支援 claude auth status。")); }
      });
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

// Blocks that accept cache_control. Thinking blocks cannot carry a breakpoint.
const CACHEABLE_BLOCKS = new Set(["text", "image", "document", "tool_use", "tool_result"]);

function cacheMarkerBlock(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (typeof message.content === "string") {
      if (!message.content.trim()) continue;
      message.content = [{ type: "text", text: message.content }];
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (let position = content.length - 1; position >= 0; position--) {
      const block = content[position];
      if (!CACHEABLE_BLOCKS.has(block?.type)) continue;
      if (block.type === "text" && !(typeof block.text === "string" && block.text.trim())) continue;
      return block;
    }
  }
  return null;
}

export function prepareCliConversation(request, cwd, { cacheTtl = CLI_CACHE_TTL } = {}) {
  const sessionId = randomUUID();
  let parentUuid = null;
  const names = new Map();
  const reverseNames = new Map();
  const tools = (request.tools || []).map((tool, index) => {
    // Use short stable MCP names, independent of namespace/length restrictions.
    const name = `t${index}`;
    names.set(tool.name, `mcp__codex__${name}`);
    reverseNames.set(`mcp__codex__${name}`, tool.name);
    return { name, description: `${tool.name}\n${tool.description || ""}`, inputSchema: tool.input_schema };
  });
  const messages = structuredClone(request.messages || []);
  if (!messages.length || messages.at(-1).role !== "user") throw new Error("Claude CLI 需要以 user 或工具結果結尾的完整歷史。");
  for (const message of messages) {
    for (const block of Array.isArray(message.content) ? message.content : []) {
      delete block.cache_control;
      if (block.type === "tool_use") block.name = names.get(block.name) || block.name;
    }
  }
  // Resume sanitizes an unfinished tool_use before reading stdin. Keep paired
  // results IN the transcript, otherwise the CLI drops both the call and result.
  const endsInToolResult = messages.at(-1).content?.some?.((block) => block.type === "tool_result");
  const last = endsInToolResult ? { role: "user", content: [{ type: "text",
    text: "Continue from the tool results above and answer the pending user request." }] } : messages.pop();
  const rows = messages.map((message) => {
    const uuid = randomUUID();
    const row = { type: message.role, uuid, parentUuid, sessionId, cwd, isSidechain: false,
      timestamp: new Date().toISOString(), version: "2.1.231", userType: "external",
      message: { ...message, ...(message.role === "assistant" ? {
        id: `msg_${randomUUID()}`, type: "message", model: request.model,
        stop_reason: message.content?.some?.((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      } : {}) } };
    parentUuid = uuid;
    return row;
  });
  // The CLI puts its last breakpoint on an environment block that it appends
  // after this history and rebuilds for every process, so the next turn cannot
  // reuse it. Mark the end of the replayed history instead; the next turn
  // replays the same prefix and reads it from cache.
  const markerBlock = cacheTtl ? cacheMarkerBlock(rows.map((row) => row.message)) : null;
  const plainTranscript = rows.map((row) => JSON.stringify(row)).join("\n");
  if (markerBlock) markerBlock.cache_control = { type: "ephemeral", ttl: cacheTtl };
  const transcript = markerBlock ? rows.map((row) => JSON.stringify(row)).join("\n") : plainTranscript;
  const system = typeof request.system === "string" ? request.system
    : (request.system || []).map((block) => block.text || "").join("\n\n");
  // The CLI has no native tool_choice option. Keep the same definitions during
  // replay, including when tools are forbidden, so previous calls remain known.
  // Enforce the choice on output before forwarding any disallowed tool to Codex.
  // The instruction belongs to this turn only; placing it in the system prompt
  // would invalidate the cached tools/system/history prefix.
  const choice = request.tool_choice?.type;
  const constraint = choice === "none" ? "For this response, do not call any tools. Respond using the conversation and tool results already provided."
    : choice === "tool" ? `For this response, call only the tool ${names.get(request.tool_choice.name)}.`
    : choice === "any" ? "For this response, call at least one of the provided tools." : "";
  if (constraint) {
    const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : (last.content || []);
    last.content = [...content, { type: "text", text: constraint }];
  }
  return { tools, reverseNames, transcript, plainTranscript, cacheMarker: Boolean(markerBlock), system,
    input: JSON.stringify({ type: "user", session_id: sessionId, parent_tool_use_id: null, message: last }) + "\n" };
}

// Only tool schemas are exposed. Even if Claude calls this endpoint before it
// is stopped, it cannot execute anything or manufacture a successful result.
export async function startCliToolServer(tools) {
  const token = randomBytes(32).toString("hex");
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.url !== "/mcp") {
      res.writeHead(403); res.end(); return;
    }
    if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
      }
      const message = JSON.parse(body);
      if (message.id == null) { res.writeHead(202); res.end(); return; }
      let result;
      if (message.method === "initialize") result = { protocolVersion: "2024-11-05",
        capabilities: { tools: {} }, serverInfo: { name: "codex-router", version: "1" } };
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/call") result = { isError: true,
        content: [{ type: "text", text: "Tool execution belongs to Codex. No action was performed." }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...(result ? { result }
        : { error: { code: -32601, message: "Method not found" } }) }));
    } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { config: { mcpServers: { codex: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp`,
    headers: { Authorization: `Bearer ${token}` } } } },
  close: () => { server.closeAllConnections(); server.close(); } };
}

export function requiredCliVersion(record) {
  const content = record?.message?.content;
  const text = Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
    : typeof content === "string" ? content : "";
  return /Claude Code[\s\S]*?version (\d+\.\d+\.\d+) or newer is required/i.exec(text)?.[1] || null;
}

export function cliFailure(code, requiredVersion = null) {
  const messages = {
    authentication_failed: "Claude CLI 尚未登入或授權已過期，請從「連接 Claude 訂閱帳號」重新登入。",
    rate_limit: "Claude 訂閱用量已達上限，請等待重置或切換其他模型。",
    timeout: "Claude CLI 等待逾時，請重試或檢查 Claude 登入與網路。",
    invalid_tool: "Claude CLI 傳回未註冊的工具，已停止此回合。",
    protocol: "Claude CLI 回應格式不相容或回應中斷，請檢查 CLI 版本。",
    unavailable: "無法啟動 Claude CLI，請重新設定 CLI 路徑。",
    tool_choice: "Claude CLI 未遵守本次工具選擇限制，已停止此回合。",
    context_length_exceeded: "Claude CLI 上下文已超過模型限制，請壓縮對話或調低模型的上下文設定。",
    upgrade_required: `這個模型需要較新版本的 Claude CLI${requiredVersion ? `（至少 ${requiredVersion}）` : ""}，請執行 claude update 或重新執行添加流程。`,
  };
  return { type: "error", error: { type: `claude_cli_${code}`, message: messages[code] || messages.protocol,
    ...(requiredVersion ? { requiredVersion } : {}),
    ...(code === "rate_limit" ? { code: "rate_limit_exceeded" } : {}) } };
}

// One fresh CLI invocation per Responses request. Replaying a private transcript
// preserves roles, signed thinking, tool IDs/results and images, without sharing
// mutable CLI sessions between threads, retries, or model switches.
export async function fetchClaudeCli(request, configuration, signal, { env: testEnv, onDiagnostic } = {}) {
  if (!isAbsolute(configuration?.binary || "")) return Response.json(cliFailure("unavailable"), { status: 503 });
  signal?.throwIfAborted();
  if (!testEnv) {
    let auth;
    try { auth = await claudeCliAuth(configuration.binary, { signal }); }
    catch { signal?.throwIfAborted(); return Response.json(cliFailure("unavailable"), { status: 503 }); }
    if (!auth.loggedIn || auth.authMethod !== "claude.ai") {
      return Response.json(cliFailure("authentication_failed"), { status: 401 });
    }
    signal?.throwIfAborted();
  }
  const directory = await mkdtemp(join(tmpdir(), "codex-claude-turn-"));
  let mcp, child = null, timer, terminal = false, streamController;
  let cleanupPromise;
  const processes = new Set();
  // Resolves after the process exits; escalates if it ignores the first signal.
  const terminate = (proc) => proc.routerClosed ? Promise.resolve() : new Promise((resolve) => {
    const killTimer = setTimeout(() => proc.kill("SIGKILL"), 1500);
    proc.once("close", () => { clearTimeout(killTimer); resolve(); });
    proc.kill();
  });
  const cleanup = () => cleanupPromise ||= (async () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    mcp?.close();
    await Promise.all([...processes].map(terminate));
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  })();
  const send = (event) => streamController.enqueue(Buffer.from(`data: ${JSON.stringify(event)}\n\n`));
  const finish = (failure, requiredVersion = null) => {
    if (terminal) return;
    terminal = true;
    if (failure) send(cliFailure(failure, requiredVersion));
    streamController.close();
    void cleanup().catch(() => process.stderr.write("model-router-claude-cli-cleanup-failed\n"));
  };
  const abort = () => finish("protocol");
  try {
    const conversation = prepareCliConversation(request, directory,
      { cacheTtl: cliCacheMarkerEnabled() ? CLI_CACHE_TTL : null });
    await writeFile(join(directory, "system.txt"), conversation.system, { mode: 0o600 });
    const historyPath = join(directory, "history.jsonl");
    if (conversation.transcript) await writeFile(historyPath, conversation.transcript + "\n", { mode: 0o600 });
    mcp = await startCliToolServer(conversation.tools);
    await writeFile(join(directory, "mcp.json"), JSON.stringify(mcp.config), { mode: 0o600 });
    const baseArgs = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--include-partial-messages", "--no-session-persistence", "--tools", "", "--strict-mcp-config",
      "--mcp-config", join(directory, "mcp.json"), "--disable-slash-commands", "--no-chrome",
      "--permission-mode", "dontAsk", "--max-turns", "1", ...isolationArgs,
      // Claude 5 系列預設不回傳思考文字（display: omitted）。要求摘要後 Codex 才能顯示
      // 思考過程；計費不變。這個參數不在 --help 中，2.1.231 起可用，且只附加在
      // adaptive／enabled 思考設定上，不會與關閉思考同時送出。
      "--thinking-display", "summarized",
      "--system-prompt-file", join(directory, "system.txt"), "--model", request.model];
    const stream = new ReadableStream({ start(controller) { streamController = controller; },
      cancel() { terminal = true; return cleanup(); } });
    const env = testEnv || { ...claudeCliEnvironment(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.max_tokens || 32000) };
    let started = false, stopReason = null, toolCount = 0, cacheRetried = false;
    const launch = (history) => {
      const args = [...baseArgs];
      if (history) args.push("--resume", history, "--fork-session");
      if (configuration.effort) args.push("--effort", configuration.effort);
      const proc = spawn(configuration.binary, args, { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env });
      processes.add(proc);
      child = proc;
      let pending = "";
      proc.stderr.resume(); // Never log CLI stderr: it can contain prompts or credentials.
      proc.stdin.on("error", () => { if (proc === child && !terminal) finish("protocol"); });
      proc.on("error", () => { if (proc === child) finish("unavailable"); });
      proc.on("close", () => { proc.routerClosed = true; if (proc === child && !terminal) finish("protocol"); });
      proc.stdout.setEncoding("utf8");
      proc.stdout.on("data", (chunk) => {
        if (terminal || proc !== child) return;
        pending += chunk.toString("utf8");
        if (pending.length > 16 * 1024 * 1024) { finish("protocol"); return; }
        let newline;
        while (!terminal && proc === child && (newline = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          let record;
          try { record = JSON.parse(line); } catch { finish("protocol"); return; }
          if (!record || typeof record.type !== "string") { finish("protocol"); return; }
          onDiagnostic?.({ type: record.type, event: record.event?.type, stop: record.event?.delta?.stop_reason,
            block: record.event?.content_block?.type, error: record.error, subtype: record.subtype,
            model: record.event?.message?.model, assistantStop: record.message?.stop_reason,
            ...(record.message?.stop_reason === "refusal" ? { refusal: record.message.content?.filter((block) => block.type === "text")
              .map((block) => block.text).join("\n").slice(0, 1000) } : {}) });
          if (record.type === "assistant" && record.error) {
            const requiredVersion = requiredCliVersion(record);
            if (requiredVersion) { finish("upgrade_required", requiredVersion); return; }
            if (record.message?.stop_reason === "refusal") {
              if (!started) send({ type: "message_start", message: { usage: {} } });
              send({ type: "message_delta", delta: { stop_reason: "refusal" }, stop_details: record.message.stop_details });
              send({ type: "message_stop" });
              finish(); return;
            }
            const detail = JSON.stringify(record.message?.content || "");
            if (conversation.cacheMarker && !cacheRetried && !started && cacheControlRejected(detail)) {
              // An older CLI may ignore the TTL setting, or a newer one may already
              // use every breakpoint. Nothing reached Codex yet: resend once without
              // the router's breakpoint and pause it for later turns.
              cacheRetried = true;
              disableCliCacheMarker();
              onDiagnostic?.({ type: "cache_marker_fallback" });
              child = null;
              void terminate(proc);
              void relaunchWithoutMarker();
              return;
            }
            finish(record.error === "authentication_failed" ? "authentication_failed"
              : record.error === "rate_limit" ? "rate_limit"
              : /context.*(?:length|window)|prompt is too long/i.test(detail) ? "context_length_exceeded" : "protocol"); return;
          }
          if (record.type === "result") { finish("protocol"); return; }
          if (record.type !== "stream_event" || record.parent_tool_use_id) continue;
          const event = record.event;
          if (!event || typeof event.type !== "string") { finish("protocol"); return; }
          if (event.type === "message_start") {
            if (started) { finish("protocol"); return; }
            started = true;
          }
          if (!started) { finish("protocol"); return; }
          if (event.type === "message_delta" && event.delta?.stop_reason) stopReason = event.delta.stop_reason;
          if (event.type === "message_stop" && !stopReason) { finish("protocol"); return; }
          if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            const name = conversation.reverseNames.get(event.content_block.name);
            if (!name) { finish("invalid_tool"); return; }
            toolCount++;
            if (request.tool_choice?.type === "none" || (request.tool_choice?.type === "tool" && name !== request.tool_choice.name)
              || (request.tool_choice?.disable_parallel_tool_use && toolCount > 1)) { finish("tool_choice"); return; }
            event.content_block.name = name;
          }
          if (event.type === "message_stop" && ["any", "tool"].includes(request.tool_choice?.type) && !toolCount) {
            finish("tool_choice"); return;
          }
          send(event);
          if (event.type === "message_stop") finish();
        }
      });
      if (!terminal) proc.stdin.end(conversation.input);
    };
    const relaunchWithoutMarker = async () => {
      try {
        const plainPath = join(directory, "history-plain.jsonl");
        await writeFile(plainPath, conversation.plainTranscript + "\n", { mode: 0o600 });
        if (!terminal) launch(plainPath);
      } catch { finish("protocol"); }
    };
    timer = setTimeout(() => finish("timeout"), configuration.timeoutMs || 180000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (!terminal) launch(conversation.transcript ? historyPath : null);
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } catch (error) { await cleanup(); throw error; }
}
