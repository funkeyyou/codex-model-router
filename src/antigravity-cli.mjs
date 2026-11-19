import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

const execute = promisify(execFile);
const agent = "coding-host";
const hookCommand = "node deny.cjs";
const policy = JSON.stringify({ toolPermission: "strict", allowNonWorkspaceAccess: false });
const instructions = [
  "Answer the coding agent request encoded as chat messages and host tool definitions.",
  "Use no local actions. Return one JSON object with text (string) and calls (array).",
  "Each call has name (exact host function name) and arguments (a JSON object matching its schema).",
  "Request independent actions together when parallel_tool_calls permits. The host executes all calls.",
  "Use the supplied tool results to continue. For a final answer set calls to [].",
].join("\n");

// A nonempty, explicit allowlist avoids CLI versions treating an empty list as the default.
export async function writeAntigravityPolicy(directory) {
  const root = join(directory, ".agents");
  await mkdir(join(root, "agents"), { recursive: true });
  await writeFile(join(root, "agents", agent + ".md"), [
    "---", "name: " + agent, "description: Respond to the coding agent host", "mainAgent: true",
    "subagent: false", "tools: [send_message]", 'commandExecutionPolicy: "off"',
    "inheritMcp: false", "inheritCustomizations: false", "---", instructions,
  ].join("\n"));
  await writeFile(join(root, "deny.cjs"), 'process.stdout.write(JSON.stringify({decision:"deny",reason:"The host owns tool execution"}))');
  await writeFile(join(root, "hooks.json"), JSON.stringify({ [agent]: { enabled: true,
    PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: hookCommand }] }] } }));
}

// Adapt only instruction prose. User messages, tool names, schemas and results are data
// and must remain byte-for-byte intact for host calls and history replay.
export function antigravityPrompt(request) {
  const messages = request.messages.map(message => {
    if (!["system", "developer"].includes(message.role)) return message;
    const replaceName = text => text.replace(/\bYou are Codex\b/gi, "You are a coding agent")
      .replace(/\bCodex\b/gi, "coding agent");
    const content = typeof message.content === "string" ? replaceName(message.content)
      : message.content.map(part => part.type === "text" ? { ...part, text: replaceName(part.text) } : part);
    return { ...message, content };
  });
  const callLimit = request.parallel_tool_calls === false
    ? "\nReturn at most ONE call this turn, even if the user asks for several. Wait for its result before the next call."
    : "";
  return instructions + callLimit + "\n" + JSON.stringify({ ...request, messages });
}

function chatMessage(raw, request) {
  const reply = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  if (typeof reply?.text !== "string" || !Array.isArray(reply.calls)) throw Error("Invalid Antigravity response format");
  const allowed = new Set(request.tools?.map(tool => tool.function.name));
  if (request.parallel_tool_calls === false && reply.calls.length > 1) throw Error("Parallel calls disabled");
  const toolCalls = reply.calls.map(call => {
    if (!allowed.has(call?.name) || !call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))
      throw Error("Invalid Antigravity host tool call");
    return { id: "call_" + randomUUID(), type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } };
  });
  const choice = request.tool_choice;
  if ((choice === "none" && toolCalls.length) || (choice === "required" && !toolCalls.length) ||
      (choice?.function && (!toolCalls.length || toolCalls.some(call => call.function.name !== choice.function.name))))
    throw Error("Antigravity did not respect tool_choice");
  return { role: "assistant", content: reply.text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
}

const sessions = new Map();
const initializing = new Set();
const idleMs = 5 * 60 * 1000;

function canonicalMessages(messages) {
  return messages.map(message => structuredClone({ ...message, content: message.content ?? "" }));
}

// Only decode the text field at the beginning of the envelope. Calls remain buffered
// until the entire response has been validated, so partial arguments never execute.
export function envelopeText(buffer) {
  const match = /^\s*(?:```json\s*)?\{\s*"text"\s*:\s*"/.exec(buffer);
  if (!match) return "";
  let encoded = "";
  for (let index = match[0].length; index < buffer.length; index += 1) {
    const char = buffer[index];
    if (char === '"') break;
    if (char === "\\") {
      const length = buffer[index + 1] === "u" ? 6 : 2;
      if (index + length > buffer.length) break;
      encoded += buffer.slice(index, index + length);
      index += length - 1;
    } else encoded += char;
  }
  try { return JSON.parse('"' + encoded + '"'); } catch { return ""; }
}

async function createSession(binary, model) {
  const directory = await mkdtemp(join(tmpdir(), "codex-agy-"));
  const options = { cwd: directory, windowsHide: true,
    env: { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH || "") } };
  let child;
  const state = { history: [], usage: {}, busy: false, closed: false, timer: null, pending: null };
  state.close = () => {
    if (state.closed) return;
    state.closed = true;
    clearTimeout(state.timer);
    child?.kill("SIGKILL");
    state.pending?.reject(Error("Antigravity CLI session ended"));
    state.pending = null;
    void rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  };
  try {
    await writeAntigravityPolicy(directory);
    const base = ["--agent", agent, "--settings", policy, "--model", model];
    const hooks = await execute(binary, [...base, "-p", "/hooks", "--output-format", "json"], { ...options, timeout: 15000 });
    const loaded = JSON.parse(hooks.stdout).command?.data?.hooks?.find(h => h.name === agent && h.enabled);
    if (!loaded || await realpath(loaded.source) !== await realpath(join(directory, ".agents", "hooks.json")) ||
        !loaded.actions?.some(a => a.event === "PreToolUse" && a.matcher === ".*" && a.command === hookCommand))
      throw Error("Antigravity CLI tool guard is unavailable");
    child = spawn(binary, [...base, "--disable-slash-commands", "--input-format", "stream-json",
      "--output-format", "stream-json", "--print-timeout", "180s"], { ...options, stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.resume();
    child.stdin.on("error", state.close);
    child.on("error", state.close);
    child.on("close", state.close);
    child.stdout.setEncoding("utf8");
    let buffer = "";
    child.stdout.on("data", chunk => {
      buffer += chunk;
      if (buffer.length > 16 * 1024 * 1024) { state.close(); return; }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (record.event === "init") {
            const init = record.init;
            if (init?.model !== model || init.agent !== agent || init.permission_mode !== "strict") throw Error("Session mismatch");
            state.initialized = true;
          } else if (record.event === "step_update") {
            if (record.step_update?.step_type === "tool") throw Error("Local tool attempted");
            state.pending?.onStep(record.step_update);
          } else if (record.event === "result") {
            if (!state.initialized || record.result?.status !== "SUCCESS") throw Error("Incomplete turn");
            const pending = state.pending;
            state.pending = null;
            pending?.resolve(record.result);
          }
        } catch { state.close(); return; }
      }
    });
    state.ask = (prompt, onStep) => new Promise((resolve, reject) => {
      state.pending = { resolve, reject, onStep };
      child.stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n");
    });
    return state;
  } catch (error) { state.close(); throw error; }
}

export function closeAntigravitySessions() {
  for (const session of sessions.values()) session.close();
  sessions.clear();
}

export async function fetchAntigravityChat(request, route, binary, effort, signal, sessionKey = null, onTextDelta = () => {}) {
  const model = (effort && route.effortModels?.[effort]) || route.defaultCliModel;
  if (!binary || !model) throw Error("Antigravity CLI model configuration is incomplete");
  if (request.messages.some(m => Array.isArray(m.content) && m.content.some(part => part.type !== "text")))
    return Response.json({ error: { message: "Antigravity CLI currently accepts text input only." } }, { status: 422 });
  const key = JSON.stringify([sessionKey || randomUUID(), binary, model]);
  const signature = antigravityPrompt({ ...request, messages: [] });
  const incoming = canonicalMessages(request.messages);
  if (initializing.has(key)) return Response.json({ error: { message: "Antigravity session is starting." } }, { status: 409 });
  let session = sessions.get(key);
  if (session?.busy) return Response.json({ error: { message: "Antigravity conversation already has an active request." } }, { status: 409 });
  if (session && (session.closed || session.signature !== signature ||
      !session.history.every((message, index) => isDeepStrictEqual(incoming[index], message)))) {
    session.close(); sessions.delete(key); session = null;
  }
  try {
    if (!session) {
      for (const [oldKey, oldSession] of sessions) {
        if (oldSession.closed) sessions.delete(oldKey);
      }
      if (sessions.size >= 16) throw Error("Too many active Antigravity conversations. Retry after an idle session expires.");
      initializing.add(key);
      try { session = await createSession(binary, model); }
      finally { initializing.delete(key); }
      session.signature = signature;
      sessions.set(key, session);
    }
  } catch (error) {
    return Response.json({ error: { message: error.cmd ? "Antigravity CLI initialization failed." : error.message } }, { status: 502 });
  }
  clearTimeout(session.timer);
  session.busy = true;
  const prompt = session.history.length
    ? "Continue using the same instructions and tools. New chat messages:\n" + JSON.stringify(request.messages.slice(session.history.length))
    : antigravityPrompt(request);
  const encoder = new TextEncoder();
  const abort = () => session.close();
  const stream = new ReadableStream({
    start(controller) {
      const send = chunk => controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
      let raw = "", sent = "";
      const timeout = setTimeout(abort, 190000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const task = session.closed ? Promise.reject(Error("Session aborted")) : session.ask(prompt, step => {
        if (step?.step_type !== "agent_response" || typeof step.text_delta !== "string") return;
        raw += step.text_delta;
        if (raw.length > 16 * 1024 * 1024) throw Error("Antigravity reply too large");
        const text = envelopeText(raw);
        if (text.length > sent.length) {
          send({ choices: [{ index: 0, delta: { content: text.slice(sent.length) } }] });
          onTextDelta();
          sent = text;
        }
      });
      task.then(result => {
        const message = chatMessage(result.response, request);
        if (!message.content.startsWith(sent)) throw Error("Antigravity response changed during streaming");
        send({ choices: [{ index: 0, delta: { ...message, content: message.content.slice(sent.length) },
          finish_reason: message.tool_calls ? "tool_calls" : "stop" }] });
        if (result.usage) {
          const delta = field => Math.max(0, (result.usage[field] || 0) - (session.usage[field] || 0));
          send({ choices: [], usage: { prompt_tokens: delta("input_tokens") + delta("cache_read_tokens"),
            completion_tokens: delta("output_tokens"), prompt_tokens_details: { cached_tokens: delta("cache_read_tokens") },
            completion_tokens_details: { reasoning_tokens: delta("thinking_tokens") } } });
          session.usage = result.usage;
        }
        session.history = canonicalMessages([...request.messages, message]);
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }).catch(() => {
        session.close();
        if (!signal?.aborted) {
          try { send({ error: { message: "Antigravity CLI turn failed. Check CLI login, quota and compatibility." } }); controller.close(); } catch { /* canceled */ }
        } else { try { controller.error(Error("Request aborted")); } catch { /* canceled */ } }
      }).finally(() => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        session.busy = false;
        if (!sessionKey || session.closed) { session.close(); sessions.delete(key); }
        else session.timer = setTimeout(() => { session.close(); sessions.delete(key); }, idleMs).unref();
      });
    },
    cancel: abort,
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}
