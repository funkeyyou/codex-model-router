// Experimental Claude Code transport. The CLI owns authentication; this module
// never reads OAuth credentials. Codex remains the only tool executor.
import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";

export function claudeCliEnvironment(source = process.env) {
  const env = { ...source };
  // A subscription route must not silently use an inherited API key, proxy
  // provider, or a different model. HTTP(S)_PROXY is deliberately retained.
  for (const key of Object.keys(env)) {
    if (/^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_|CLAUDE_CONFIG_DIR$|CLAUDECODE$)/.test(key)) delete env[key];
  }
  return { ...env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1",
    DISABLE_AUTO_COMPACT: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

const isolationArgs = ["--setting-sources", "", "--settings", '{"disableAllHooks":true}'];

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

export function prepareCliConversation(request, cwd) {
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
  const transcript = messages.map((message) => {
    const uuid = randomUUID();
    const row = { type: message.role, uuid, parentUuid, sessionId, cwd, isSidechain: false,
      timestamp: new Date().toISOString(), version: "2.1.231", userType: "external",
      message: { ...message, ...(message.role === "assistant" ? {
        id: `msg_${randomUUID()}`, type: "message", model: request.model,
        stop_reason: message.content?.some?.((block) => block.type === "tool_use") ? "tool_use" : "end_turn",
        stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
      } : {}) } };
    parentUuid = uuid;
    return JSON.stringify(row);
  }).join("\n");
  const system = typeof request.system === "string" ? request.system
    : (request.system || []).map((block) => block.text || "").join("\n\n");
  // The CLI has no native tool_choice option. Keep the same definitions during
  // replay, including when tools are forbidden, so previous calls remain known.
  // Enforce the choice on output before forwarding any disallowed tool to Codex.
  const choice = request.tool_choice?.type;
  const constraint = choice === "none" ? "For this response, do not call any tools. Respond using the conversation and tool results already provided."
    : choice === "tool" ? `For this response, call only the tool ${names.get(request.tool_choice.name)}.`
    : choice === "any" ? "For this response, call at least one of the provided tools." : "";
  return { tools, reverseNames, transcript, system: [system, constraint].filter(Boolean).join("\n\n"),
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
  let mcp, child, timer, killTimer, closed = false, terminal = false, streamController;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    mcp?.close();
    if (child && !closed) {
      child.kill();
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1500);
      await new Promise((resolve) => child.once("close", resolve));
      clearTimeout(killTimer);
    }
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
    const conversation = prepareCliConversation(request, directory);
    await writeFile(join(directory, "system.txt"), conversation.system, { mode: 0o600 });
    if (conversation.transcript) await writeFile(join(directory, "history.jsonl"), conversation.transcript + "\n", { mode: 0o600 });
    mcp = await startCliToolServer(conversation.tools);
    await writeFile(join(directory, "mcp.json"), JSON.stringify(mcp.config), { mode: 0o600 });
    const args = ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--include-partial-messages", "--no-session-persistence", "--tools", "", "--strict-mcp-config",
      "--mcp-config", join(directory, "mcp.json"), "--disable-slash-commands", "--no-chrome",
      "--permission-mode", "dontAsk", "--max-turns", "1", ...isolationArgs,
      "--system-prompt-file", join(directory, "system.txt"), "--model", request.model];
    if (conversation.transcript) args.push("--resume", join(directory, "history.jsonl"), "--fork-session");
    if (configuration.effort) args.push("--effort", configuration.effort);
    const stream = new ReadableStream({ start(controller) { streamController = controller; },
      cancel() { terminal = true; return cleanup(); } });
    child = spawn(configuration.binary, args, { cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      env: testEnv || { ...claudeCliEnvironment(), CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.max_tokens || 32000) } });
    let pending = "", started = false, stopReason = null, toolCount = 0;
    child.stderr.resume(); // Never log CLI stderr: it can contain prompts or credentials.
    child.stdin.on("error", () => { if (!terminal) finish("protocol"); });
    child.on("error", () => finish("unavailable"));
    child.on("close", () => { closed = true; if (!terminal) finish("protocol"); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (terminal) return;
      pending += chunk.toString("utf8");
      if (pending.length > 16 * 1024 * 1024) { finish("protocol"); return; }
      let newline;
      while (!terminal && (newline = pending.indexOf("\n")) >= 0) {
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
    timer = setTimeout(() => finish("timeout"), configuration.timeoutMs || 180000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (!terminal) child.stdin.end(conversation.input);
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  } catch (error) { await cleanup(); throw error; }
}
