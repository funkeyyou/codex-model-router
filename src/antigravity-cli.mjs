import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const agent = "coding-host";
const hookCommand = "node deny.cjs";
const instructions = [
  "Answer the coding agent request encoded as chat messages and host tool definitions.",
  "Use no local actions. Return one JSON object with text (string) and calls (array).",
  "Do not invoke native tools, including send_message or any host tool name. Host tools are data: request them only as entries in calls.",
  "Put all progress and answer prose inside text, never before or after the JSON object. Do not emit native function calls alongside it.",
  "JSON-escape quotes, backslashes and line breaks inside strings, including inside Markdown code and tool arguments.",
  "Each call has name (exact host function name) and arguments (a JSON object matching its schema).",
  "When requesting host tools during multi-step work, put a brief user-facing progress update in text before calls: what you found or what the next action will check. Use the user's language.",
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

const renameAgent = text => text.replace(/\bYou are Codex\b/gi, "You are a coding agent").replace(/\bCodex\b/gi, "coding agent");

// Adapt only instruction prose. User messages, tool names, schemas and results are data
// and must remain byte-for-byte intact for host calls and history replay.
function adaptMessages(messages) {
  return messages.map(({ reasoning_content: _thoughts, ...message }) => {
    if (!["system", "developer"].includes(message.role)) return message;
    const content = typeof message.content === "string" ? renameAgent(message.content)
      : Array.isArray(message.content)
        ? message.content.map(part => part?.type === "text" ? { ...part, text: renameAgent(part.text) } : part)
        : message.content;
    return { ...message, content };
  });
}

function hostSettings(request) {
  const settings = {};
  for (const field of ["tools", "tool_choice", "parallel_tool_calls", "response_format"]) {
    if (request[field] !== undefined) settings[field] = request[field];
  }
  return settings;
}

const callLimit = request => request.parallel_tool_calls === false
  ? "\nReturn at most ONE call this turn, even if the user asks for several. Wait for its result before the next call."
  : "";

// agy truncates one user message near 190 KB (text and embedded resources together), while the
// session system prompt has no such cap. Instructions, tools and handled history go there.
const promptByteLimit = 150000;
const isStanding = message => ["system", "developer"].includes(message.role);
// The CLI's own system prompt outweighs appended text, so every user prompt restates the reply
// format; tool definitions and handled history stay in the system context.
const protocol = request => instructions + callLimit(request) +
  "\nThe host tool definitions and earlier chat messages are in the system context.\n";
const respondTo = messages => "New chat messages (respond to these):\n" + JSON.stringify(messages);
const toolName = tool => tool?.function?.name ?? tool?.name;

// Images travel as ACP image blocks with the user prompt; the JSON keeps a numbered marker in place.
function attachImages(messages, images) {
  if (!images) return messages;
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(part => {
      if (part?.type === "text") return part;
      const url = part?.type === "image_url" ? (typeof part.image_url === "string" ? part.image_url : part.image_url?.url) : null;
      const data = typeof url === "string" && /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(url);
      if (data) {
        images.push({ type: "image", mimeType: data[1].toLowerCase(), data: data[2].replace(/\s+/g, "") });
        return { type: "text", text: "[Image " + images.length + ": attached to the latest user prompt]" };
      }
      if (typeof url === "string") return { type: "text", text: "[Image URL: " + url + "]" };
      return { type: "text", text: "[" + (part?.type || "content") + " omitted]" };
    }) };
  });
}

// A new session separates handled history (system prompt) from the messages awaiting an
// answer (user prompt), so a rebuilt conversation answers the newest request, not the first.
export function antigravityPrompt(request, images = null) {
  const messages = attachImages(adaptMessages(request.messages), images);
  const split = messages.findLastIndex(message => message.role === "assistant") + 1;
  const latest = messages.slice(split);
  const earlier = [...messages.slice(0, split), ...latest.filter(isStanding)];
  const system = instructions + callLimit(request) +
    "\nHost settings and tools:\n" + JSON.stringify(hostSettings(request)) +
    (earlier.length ? "\nEarlier chat messages (standing instructions and context; earlier requests were already answered):\n" +
      JSON.stringify(earlier) : "");
  const prompt = protocol(request) + respondTo(latest.filter(message => !isStanding(message)));
  if (Buffer.byteLength(prompt) <= promptByteLimit) return { system, prompt };
  return { system: system + "\n" + respondTo(latest.filter(message => !isStanding(message))),
    prompt: protocol(request) + "Respond to the new chat messages at the end of the system context." };
}

// Tool lists grow during a Codex task (tool search, MCP startup). Only the difference is sent so
// the conversation and its cache continue. Codex also rewrites top-level descriptions of nearly
// every app tool once plugins load (appending plugin attribution); those edits are not resent.
const toolShape = tool => tool?.function
  ? { ...tool, function: { ...tool.function, description: undefined } }
  : { ...tool, description: undefined };
const settingsShape = settings => ({ ...settings, tools: settings?.tools?.map(toolShape) });

function settingsUpdate(previous, current) {
  const reminder = "Reply with one JSON object with text and calls, as instructed. " +
    "All progress belongs inside text. Do not invoke native tools; encode host tool requests only in calls.\n";
  if (isDeepStrictEqual(settingsShape(previous), settingsShape(current))) return "Continue using the same instructions and tools. " + reminder;
  const before = new Map((previous?.tools || []).map(tool => [toolName(tool), tool]));
  const names = new Set((current.tools || []).map(toolName));
  const changed = (current.tools || []).filter(tool => !before.has(toolName(tool)) ||
    !isDeepStrictEqual(toolShape(before.get(toolName(tool))), toolShape(tool)));
  const removed = [...before.keys()].filter(name => !names.has(name));
  return "Host settings changed. Use these from now on:\n" + JSON.stringify({
    tool_choice: current.tool_choice ?? "auto", parallel_tool_calls: current.parallel_tool_calls ?? true,
    response_format: current.response_format ?? null,
    ...(changed.length ? { added_or_updated_tools: changed } : {}), ...(removed.length ? { removed_tools: removed } : {}),
  }) + callLimit(current) + "\n" + reminder;
}

class EnvelopeSyntaxError extends SyntaxError {
  constructor(kind) {
    super("Invalid Antigravity response JSON");
    this.kind = kind;
  }
}

class CliExecutionError extends Error {
  constructor(kind) {
    // The CLI can include arbitrary request content after its executor error prefix.
    // Keep only the classification, not that message, in exceptions, logs and SSE.
    super("Antigravity CLI execution failed");
    this.kind = kind;
  }
}

const contextBudgetError = message => /^(?:generating and executing: )?serializing trajectory: (?:no messages fit within the context token budget|maxMessageTokens must be positive, got -?\d+)$/.test(message);

function providerFailureKind(message) {
  if (/\bRESOURCE_EXHAUSTED\b|\b(?:HTTP|code)\s+429\b|\b(?:quota|rate limit)\b[^\r\n]{0,40}\b(?:reached|exhausted|exceeded)\b|\b(?:reached|exhausted|exceeded)\b[^\r\n]{0,40}\b(?:quota|rate limit)\b/i.test(message)) return "rate_limited";
  if (/\bUNAUTHENTICATED\b|\b(?:HTTP|code)\s+401\b/i.test(message)) return "auth_required";
  if (/\bPERMISSION_DENIED\b|\b(?:HTTP|code)\s+403\b/i.test(message)) return "permission_denied";
  if (/\bSAFETY\b|\bpolicy.violation\b|\bblocked.by.policy\b/i.test(message)) return "policy_rejected";
  return null;
}

// Recovery may retain plain progress, never discard JSON, arrays, fences, a quoted example
// or a previous CLI error. A deliberately narrow prefix keeps ambiguous replies fail-closed.
function plainProgress(text) {
  const prose = text.trim().replace(/^\[P\]\s*/, "");
  return text.length <= 16384 && /^\p{L}/u.test(prose) &&
    !/[{}[\]⚠]|```|[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(prose) && !prose.endsWith(":");
}

function cliExecutionFailure(raw) {
  // agy also emits short quota warnings (and may have sent plain progress already)
  // as ordinary message chunks with end_turn. Only a complete final warning line is
  // inspected; JSON text, examples, trailing calls and arbitrary prose are not errors.
  const match = /(?:^|\n)[ \t]*⚠\uFE0F? ([^\r\n]+)[ \t]*(?:\r?\n)?[ \t]*$/.exec(raw);
  if (!match) return null;
  const prefix = raw.slice(0, match.index);
  if (prefix.trim() && !plainProgress(prefix)) return null;
  const message = match[1].trim();
  const executor = message.startsWith("agent executor error: ");
  const cause = executor ? message.slice("agent executor error: ".length) : message;
  const kind = contextBudgetError(cause) ? "context_length_exceeded" : providerFailureKind(cause);
  return kind || executor ? new CliExecutionError(kind || "cli_execution_error") : null;
}

function jsonEscapeLength(text, index) {
  const next = text[index + 1];
  if (next === "u") return /^[0-9a-f]{4}$/i.test(text.slice(index + 2, index + 6)) ? 6 : 0;
  return next && '"\\/bfnrt'.includes(next) ? 2 : 0;
}

// Diagnose a strictly decoded text prefix followed by the calls field. Never salvage calls:
// a repeated envelope could repeat an action, and guessing an escape can change a command.
function rejectMalformedCalls(tail) {
  const field = /^[ \t\r\n]*,[ \t\r\n]*"calls"[ \t\r\n]*:[ \t\r\n]*\[/.exec(tail);
  if (!field) return;
  let depth = 1, quoted = false;
  for (let index = field[0].length; index < tail.length; index++) {
    const char = tail[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "[") depth++;
    else if (char === "]" && --depth === 0) {
      const rest = tail.slice(index + 1).trimStart();
      if (!rest.startsWith("}")) return;
      try { JSON.parse(tail.slice(field[0].length - 1, index + 1)); }
      catch { throw new EnvelopeSyntaxError("invalid_tool_call_json"); }
      if (rest.length > 1 && rest.slice(1).trim()) throw new EnvelopeSyntaxError("extra_response_content");
      return;
    }
  }
}

// On JSON syntax failure, only repair the first string of a single, otherwise exact
// text-only envelope. Stop at the *first* plausible object boundary; looking for the
// last `calls: []` could swallow an earlier envelope or an invalid tool call as prose.
function recoverTextOnlyEnvelope(payload) {
  if (payload.length > 1024 * 1024) return null; // Bound work on malformed replies, not valid JSON.
  const head = /^\{[ \t\r\n]*"text"[ \t\r\n]*:[ \t\r\n]*"/.exec(payload);
  if (!head) return null;
  const boundary = /[ \t\r\n]*(?:\}|,[ \t\r\n]*"(?:[^"\\]|\\[\s\S])*"[ \t\r\n]*:)/y;
  let encoded = "", changed = false;
  for (let index = head[0].length; index < payload.length; index++) {
    const char = payload[index];
    if (char === '"') {
      boundary.lastIndex = index + 1;
      if (boundary.test(payload)) {
        const tail = payload.slice(index + 1);
        if (changed && /^[ \t\r\n]*,[ \t\r\n]*"calls"[ \t\r\n]*:[ \t\r\n]*\[[ \t\r\n]*\][ \t\r\n]*\}$/.test(tail)) {
          return { text: JSON.parse('"' + encoded + '"'), calls: [] };
        }
        if (!changed) rejectMalformedCalls(tail);
        return null;
      }
      encoded += '\\"';
      changed = true;
    } else if (char === "\\") {
      const length = jsonEscapeLength(payload, index);
      if (length) {
        encoded += payload.slice(index, index + length);
        index += length - 1;
      } else {
        encoded += "\\\\";
        changed = true;
      }
    } else if (char.charCodeAt(0) < 32) {
      encoded += JSON.stringify(char).slice(1, -1);
      changed = true;
    } else encoded += char;
  }
  return null;
}

function rejectExtraObjectContent(payload) {
  if (!payload.startsWith("{") || payload.length > 1024 * 1024) return;
  let depth = 0, quoted = false;
  for (let index = 0; index < payload.length; index++) {
    const char = payload[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      if (!payload.slice(index + 1).trim()) return;
      try { JSON.parse(payload.slice(0, index + 1)); } catch { return; }
      throw new EnvelopeSyntaxError("extra_response_content");
    }
  }
}

function recoverPrefacedEnvelope(payload) {
  if (payload.length > 1024 * 1024) return null;
  const start = payload.indexOf("{");
  if (start <= 0 || !plainProgress(payload.slice(0, start))) return null;
  let reply;
  // Parse the *entire* suffix strictly: never search for a later object, repair tool
  // arguments, pick one of repeated replies or discard any extra trailing bytes.
  try { reply = JSON.parse(payload.slice(start)); } catch { return null; }
  if (typeof reply?.text !== "string" || !Array.isArray(reply.calls) ||
      Object.keys(reply).length !== 2) return null;
  return { ...reply, text: payload.slice(0, start) + reply.text };
}

export function parseAntigravityEnvelope(raw) {
  const cliError = cliExecutionFailure(raw);
  if (cliError) throw cliError;
  const payload = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return { reply: JSON.parse(payload), recovered: false }; }
  catch {
    rejectExtraObjectContent(payload);
    const reply = recoverTextOnlyEnvelope(payload);
    if (reply) return { reply, recovered: true };
    const prefaced = !raw.trimStart().startsWith("```") && recoverPrefacedEnvelope(payload);
    if (prefaced) return { reply: prefaced, recovered: true };
    throw new EnvelopeSyntaxError("invalid_response_json");
  }
}

function chatMessage(raw, request) {
  const { reply, recovered } = parseAntigravityEnvelope(raw);
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
  const message = { role: "assistant", content: reply.text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
  return { message, recovered };
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

// History comparison covers what the CLI conversation actually depends on: instructions,
// user input, tool results and the call IDs the model produced. Assistant prose may come back
// reformatted (thinking moved to the reasoning panel, reasoning replay fields), and the router's
// image budget may swap old screenshots for a note; neither means the conversation branched.
const imageBudgetNote = "(較舊的工具截圖已移出本輪請求";
function comparable(message) {
  if (message.role === "assistant") return { role: "assistant", calls: (message.tool_calls || []).map(call => call.id) };
  const parts = typeof message.content === "string" ? [message.content]
    : Array.isArray(message.content)
      ? message.content.filter(part => part?.type === "text" && !part.text.startsWith(imageBudgetNote)).map(part => part.text)
      : [];
  return { role: message.role, text: parts.join("\n"), id: message.tool_call_id ?? null };
}

// Codex appends developer text mid-task (for example an incremental tool update), and the Chat
// translation merges it into the leading system message. Appended standing text continues the
// conversation and is sent as an addition.
function sameOrExtended(previous, next) {
  if (isDeepStrictEqual(previous, next)) return true;
  return isStanding(previous) && previous.role === next?.role && previous.id === next.id &&
    typeof next.text === "string" && next.text.startsWith(previous.text);
}

const continues = (history, incoming) => incoming.length > history.length &&
  history.every((message, index) => sameOrExtended(message, incoming[index]));

function standingAdditions(history, incoming) {
  return history.flatMap((message, index) => isStanding(message) && incoming[index].text !== message.text
    ? [incoming[index].text.slice(message.text.length).trim()] : []).filter(Boolean);
}

// One stderr line per session decision, like the router's image budget log, so cache misses can
// be traced to a rebuild and its cause.
function logSession(event, detail = {}) {
  process.stderr.write("model-router-antigravity:" + event + " " + JSON.stringify(detail) + "\n");
}

function responseShape(raw) {
  const text = raw.trimStart();
  if (!text) return "empty";
  if (text.startsWith("{")) return "object_prefix";
  if (text.startsWith("```")) return "fence_prefix";
  if (/(?:^|\n)[ \t]*⚠/.test(text)) return "warning_line";
  return text.includes("{") ? "text_then_object" : "plain_text";
}

// Only fixed categories reach router.err.log. ACP errors can echo request content, so never
// record an exception message, response text, tool arguments, or a raw stop reason here.
export function antigravityFailureKind(error, { stage, abortReason, closeReason } = {}) {
  if (abortReason === "timeout") return "turn_timeout";
  if (abortReason === "local_tool") return "local_tool_attempt";
  if (abortReason === "cancelled") return "request_cancelled";
  if (abortReason === "response_limit") return "response_too_large";
  if (closeReason === "invalid_json") return "acp_invalid_json";
  if (closeReason === "buffer_limit") return "acp_buffer_limit";
  if (closeReason === "stdin_error") return "acp_stdin_error";
  if (closeReason === "process_error") return "acp_process_error";
  if (closeReason === "process_exit") return "acp_process_exit";
  // JSON.parse error messages can quote model text. Do not look for provider keywords there.
  if (stage === "parse_response") {
    if (error instanceof EnvelopeSyntaxError || error instanceof CliExecutionError) return error.kind;
    return error instanceof SyntaxError ? "invalid_response_json" : "invalid_response_format";
  }
  if (stage === "stream_consistency") return "stream_changed";
  if (stage === "stop_reason") return "early_stop";
  const message = typeof error?.message === "string" ? error.message : "";
  if ((stage === "prompt" || stage === "set_model") && contextBudgetError(message.trim())) return "context_length_exceeded";
  const providerKind = providerFailureKind(message);
  if (providerKind) return providerKind;
  if (stage === "set_model" || stage === "prompt") return "acp_request_failed";
  return "unexpected_failure";
}

const turnFailureMessages = {
  context_length_exceeded: "Antigravity CLI could not fit this conversation, tools and images within the model's context token budget. Compact or shorten the conversation, or start a new task with a brief summary. Retrying the same request will not help.",
  cli_execution_error: "Antigravity CLI reported an executor failure before a valid reply. No tool calls from this turn were forwarded.",
  turn_timeout: "Antigravity CLI did not finish within 5 minutes. Try a shorter request or a lower reasoning effort.",
  local_tool_attempt: "Antigravity CLI tried to use its own tools, so the turn was stopped. Retry; if it repeats, start a new task.",
  invalid_response_json: "Antigravity CLI returned an invalid JSON reply. No tool calls from this turn were forwarded.",
  invalid_tool_call_json: "Antigravity CLI returned malformed host tool call JSON. No tool calls from this turn were forwarded.",
  extra_response_content: "Antigravity CLI sent extra content after its JSON reply. No tool calls from this turn were forwarded.",
  invalid_response_format: "Antigravity CLI returned a reply or tool call that did not match the host settings. No tool calls from this turn were forwarded.",
  stream_changed: "The completed Antigravity CLI reply did not match the streamed text. Start a new task if it repeats.",
  rate_limited: "Antigravity CLI reported a quota or rate limit (429). Try again later.",
  auth_required: "Antigravity CLI reported that sign-in is required. Open agy and sign in, then retry.",
  permission_denied: "Antigravity CLI reported that access was denied. Check the account's access to this model.",
  policy_rejected: "Antigravity CLI reported a policy rejection.",
  response_too_large: "The Antigravity CLI reply exceeded the router's size limit. Try a shorter request.",
};

function divergence(history, incoming) {
  if (incoming.length <= history.length) return { reason: "shorter", history: history.length, incoming: incoming.length };
  const index = history.findIndex((message, position) => !isDeepStrictEqual(incoming[position], message));
  const role = message => message?.role + (message?.calls ? ":" + message.calls.length : "") + (message?.text !== undefined ? ":" + message.text.length : "");
  return { reason: "changed", index, history: role(history[index]), incoming: role(incoming[index]) };
}

// Every session shares one workspace. The CLI's own system prompt names the workspace path, so a
// shared path keeps that prefix, the host instructions and tool definitions cacheable across
// Codex tasks and across resumes. The policy is written once, not while other sessions read it.
let policyWrite = null;
async function sharedWorkspace() {
  const directory = join(tmpdir(), "codex-model-router-agy");
  if (!policyWrite || !existsSync(join(directory, ".agents", "hooks.json"))) {
    policyWrite = writeAntigravityPolicy(directory).catch(error => { policyWrite = null; throw error; });
  }
  await policyWrite;
  return directory;
}

function startAcp(binary, directory) {
  const child = spawn(binary, ["acp", "--agent", agent], { cwd: directory, windowsHide: true,
    env: { ...process.env, PATH: dirname(process.execPath) + delimiter + (process.env.PATH || "") },
    stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let nextId = 0, buffer = "";
  const client = { closed: false, closeReason: null, exitCode: null, onUpdate: null, onViolation: null };
  const reply = (id, payload) => { if (!client.closed) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, ...payload }) + "\n"); };
  client.close = (reason = "requested") => {
    if (client.closed) return;
    client.closed = true;
    client.closeReason = reason;
    child.kill("SIGKILL");
    for (const request of pending.values()) request.reject(Error("Antigravity CLI session ended"));
    pending.clear();
  };
  client.call = (method, params) => new Promise((resolve, reject) => {
    if (client.closed) { reject(Error("Antigravity CLI session ended")); return; }
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  child.stderr.resume();
  child.stdin.on("error", () => client.close("stdin_error"));
  child.on("error", () => client.close("process_error"));
  child.on("close", code => {
    client.exitCode = Number.isInteger(code) ? code : null;
    client.close("process_exit");
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (buffer.length > 16 * 1024 * 1024) { client.close("buffer_limit"); return; }
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { client.close("invalid_json"); return; }
      if (message.method === "session/update") {
        client.onUpdate?.(message.params?.update);
      } else if (message.method) {
        // The host owns every action: permission prompts and client file or terminal requests
        // are refused, and the turn is stopped.
        if (message.id !== undefined) {
          reply(message.id, message.method === "session/request_permission"
            ? { result: { outcome: { outcome: "cancelled" } } }
            : { error: { code: -32601, message: "Not supported by the coding agent host" } });
        }
        client.onViolation?.(message.method);
      } else if (pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) request.reject(Object.assign(Error(message.error.message || "Antigravity CLI request failed"),
          { acpCode: Number.isInteger(message.error.code) ? message.error.code : null }));
        else request.resolve(message.result ?? {});
      }
    }
  });
  return client;
}

const sessions = new Map();
const resumable = new Map();
const initializing = new Set();
const idleMs = 10 * 60 * 1000;
const resumableMs = 12 * 60 * 60 * 1000;
const maxResumable = 64;

function rememberResumable(key, session) {
  resumable.delete(key);
  resumable.set(key, { sessionId: session.sessionId, history: session.history,
    settings: session.settings, system: session.system, at: Date.now() });
  for (const [oldKey, record] of resumable) {
    if (resumable.size <= maxResumable && Date.now() - record.at < resumableMs) break;
    resumable.delete(oldKey);
  }
}

function findResumable(key) {
  const record = resumable.get(key);
  if (record && Date.now() - record.at >= resumableMs) { resumable.delete(key); return null; }
  return record || null;
}

async function openSession(binary, record, system) {
  const directory = await sharedWorkspace();
  let client;
  let stage = "initialize";
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; client?.close("timeout"); }, 60000);
  try {
    client = startAcp(binary, directory);
    const init = await client.call("initialize", { protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    const capabilities = init?.agentCapabilities;
    if (!capabilities?._meta?.antigravity?.systemPrompt?.append) {
      throw Object.assign(Error("Antigravity CLI is too old for the router. Run agy update and try again."), { code: "AGY_OUTDATED" });
    }
    const meta = text => ({ _meta: { antigravity: { systemPrompt: { append: text } } } });
    let result = null;
    if (record && capabilities.sessionCapabilities?.resume) {
      stage = "resume";
      result = await client.call("session/resume", { sessionId: record.sessionId, cwd: directory, mcpServers: [],
        ...meta(record.system) }).catch(() => null);
    }
    const resumed = Boolean(result);
    stage = "new";
    if (!result) result = await client.call("session/new", { cwd: directory, mcpServers: [], ...meta(system) });
    const sessionId = result.sessionId || (resumed ? record.sessionId : null);
    if (!sessionId) throw Error("Antigravity CLI did not create a session");
    return { client, sessionId, resumed,
      imageInput: capabilities.promptCapabilities?.image === true,
      models: new Set((result.models?.availableModels || []).map(model => model.modelId)),
      model: null, history: resumed ? record.history : [], settings: resumed ? record.settings : null,
      system: resumed ? record.system : system, busy: false, closed: false, timer: null };
  } catch (error) {
    logSession("init-failed", { stage, kind: antigravityFailureKind(error, { stage, abortReason: timedOut ? "timeout" : null,
      closeReason: client?.closeReason }), acpCode: error?.acpCode ?? null, exitCode: client?.exitCode ?? null });
    client?.close();
    throw error;
  } finally { clearTimeout(timer); }
}

function closeSession(key, session, { keepResumable = false } = {}) {
  clearTimeout(session.timer);
  session.closed = true;
  session.client.close();
  if (sessions.get(key) === session) sessions.delete(key);
  if (keepResumable && session.history.length) rememberResumable(key, session);
  else resumable.delete(key);
}

export function closeAntigravitySessions() {
  for (const [key, session] of sessions) closeSession(key, session);
  sessions.clear();
  resumable.clear();
}

// Ends idle CLI processes while keeping their conversations resumable.
export function suspendAntigravitySessions() {
  for (const [key, session] of sessions) if (!session.busy) closeSession(key, session, { keepResumable: true });
}

export async function fetchAntigravityChat(request, route, binary, effort, signal, sessionKey = null, onTextDelta = () => {}) {
  const model = (effort && route.effortModels?.[effort]) || route.defaultCliModel;
  if (!binary || !model) throw Error("Antigravity CLI model configuration is incomplete");
  const key = JSON.stringify([sessionKey || randomUUID(), binary]);
  const settings = hostSettings(request);
  const incoming = request.messages.map(comparable);
  if (initializing.has(key)) return Response.json({ error: { message: "Antigravity session is starting." } }, { status: 409 });
  let session = sessions.get(key);
  if (session?.busy) return Response.json({ error: { message: "Antigravity conversation already has an active request." } }, { status: 409 });
  if (session && (session.closed || !continues(session.history, incoming))) {
    logSession("rebuild", session.closed ? { reason: "closed" } : divergence(session.history, incoming));
    closeSession(key, session); session = null;
  }
  const replay = () => { const images = []; return { ...antigravityPrompt(request, images), images }; };
  const open = async resume => {
    if (sessions.size >= 16) throw Error("Too many active Antigravity conversations. Retry after an idle session expires.");
    const fresh = replay();
    initializing.add(key);
    try { session = await openSession(binary, resume, fresh.system); }
    finally { initializing.delete(key); }
    sessions.set(key, session);
    return session.resumed ? null : fresh;
  };
  let plan = null;
  try {
    if (!session) {
      const record = findResumable(key);
      const resume = record && continues(record.history, incoming) ? record : null;
      resumable.delete(key);
      if (record && !resume) logSession("rebuild", { ...divergence(record.history, incoming), resumable: true });
      plan = await open(resume);
      logSession(session.resumed ? "resume" : "new", { messages: incoming.length, keyed: Boolean(sessionKey),
        ...(resume && !session.resumed ? { reason: "resume-failed" } : {}) });
    }
    if (!plan) {
      const images = [];
      const additions = standingAdditions(session.history, incoming);
      const prompt = (additions.length ? "Standing instructions were extended:\n" + renameAgent(additions.join("\n\n")) + "\n" : "") +
        settingsUpdate(session.settings, settings) +
        respondTo(attachImages(adaptMessages(request.messages.slice(session.history.length)), images));
      if (Buffer.byteLength(prompt) <= promptByteLimit) {
        plan = { prompt, images };
        logSession("continue", { messages: incoming.length - session.history.length,
          settingsChanged: !isDeepStrictEqual(settingsShape(session.settings), settingsShape(settings)), standingAdditions: additions.length });
      } else {
        logSession("rebuild", { reason: "oversize", bytes: Buffer.byteLength(prompt) });
        closeSession(key, session); session = null; plan = await open(null);
      }
    }
  } catch (error) {
    if (session) closeSession(key, session);
    return Response.json({ error: { message: error.code === "AGY_OUTDATED" ? error.message : "Antigravity CLI initialization failed." } }, { status: 502 });
  }
  if (session.models.size && !session.models.has(model)) {
    closeSession(key, session);
    return Response.json({ error: { message: "Antigravity CLI no longer offers " + model + ". Refresh the model list in the manager." } }, { status: 422 });
  }
  const { prompt, images } = plan;
  if (images.length && !session.imageInput) {
    closeSession(key, session, { keepResumable: true });
    return Response.json({ error: { message: "This Antigravity CLI version does not accept images. Update agy and try again." } }, { status: 422 });
  }
  const blocks = [{ type: "text", text: prompt }];
  images.forEach((image, index) => blocks.push({ type: "text", text: "Image " + (index + 1) + ":" }, image));
  clearTimeout(session.timer);
  session.busy = true;
  const { client } = session;
  const encoder = new TextEncoder();
  let abortReason = null;
  const abort = (reason = "cancelled") => {
    abortReason ||= reason;
    closeSession(key, session);
  };
  const onAbort = () => abort("cancelled");
  const stream = new ReadableStream({
    start(controller) {
      const send = chunk => controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
      let raw = "", sent = "", violation = null;
      let stage = session.model === model ? "prompt" : "set_model";
      let reasoningChunks = 0, stopReason = null;
      const startedAt = Date.now();
      const timeout = setTimeout(() => abort("timeout"), 300000);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      client.onViolation = method => { violation ||= method; abort("local_tool"); };
      client.onUpdate = update => {
        if (update?.sessionUpdate === "tool_call" || update?.sessionUpdate === "tool_call_update") {
          violation ||= "tool"; abort("local_tool"); return;
        }
        const delta = typeof update?.content?.text === "string" ? update.content.text : "";
        if (!delta) return;
        if (update.sessionUpdate === "agent_thought_chunk") {
          reasoningChunks += 1;
          send({ choices: [{ index: 0, delta: { reasoning_content: delta } }] });
        } else if (update.sessionUpdate === "agent_message_chunk") {
          raw += delta;
          if (raw.length > 16 * 1024 * 1024) { abort("response_limit"); return; }
          const text = envelopeText(raw);
          if (text.length > sent.length) {
            send({ choices: [{ index: 0, delta: { content: text.slice(sent.length) } }] });
            onTextDelta();
            sent = text;
          }
        }
      };
      const task = session.closed ? Promise.reject(Error("Session aborted")) : (async () => {
        if (session.model !== model) {
          await client.call("session/set_model", { sessionId: session.sessionId, modelId: model });
          session.model = model;
        }
        stage = "prompt";
        return client.call("session/prompt", { sessionId: session.sessionId, prompt: blocks });
      })();
      task.then(result => {
        stage = "stop_reason";
        stopReason = ["end_turn", "cancelled", "error", "max_turns"].includes(result?.stopReason) ? result.stopReason : "other";
        if (violation) throw Error("Antigravity attempted a local action");
        if (result?.stopReason !== "end_turn") throw Error("Antigravity turn ended early: " + result?.stopReason);
        stage = "parse_response";
        const { message, recovered } = chatMessage(raw, request);
        stage = "stream_consistency";
        if (!message.content.startsWith(sent)) throw Error("Antigravity response changed during streaming");
        if (recovered) logSession("envelope-recovered", { responseChars: raw.length, emittedChars: sent.length });
        stage = "emit_final";
        send({ choices: [{ index: 0, delta: { ...message, content: message.content.slice(sent.length) },
          finish_reason: message.tool_calls ? "tool_calls" : "stop" }] });
        const usage = result.usage;
        if (usage) {
          send({ choices: [], usage: { prompt_tokens: (usage.inputTokens || 0) + (usage.cachedReadTokens || 0),
            completion_tokens: usage.outputTokens || 0, prompt_tokens_details: { cached_tokens: usage.cachedReadTokens || 0 },
            completion_tokens_details: { reasoning_tokens: usage.thoughtTokens || 0 } } });
        }
        session.history = [...request.messages, message].map(comparable);
        session.settings = settings;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }).catch(error => {
        const kind = antigravityFailureKind(error, { stage, abortReason, closeReason: client.closeReason });
        logSession("turn-failed", { at: new Date().toISOString(), stage, kind, stopReason, responseShape: responseShape(raw),
          acpCode: error?.acpCode ?? null, exitCode: client.exitCode,
          elapsedMs: Date.now() - startedAt, responseChars: raw.length, emittedChars: sent.length, reasoningChunks });
        closeSession(key, session);
        if (!signal?.aborted) {
          const code = kind === "rate_limited" ? "rate_limit_exceeded" : kind;
          const message = turnFailureMessages[kind] || "Antigravity CLI turn failed. Check the router log for its failure stage.";
          try { send({ error: { code, message } }); controller.close(); } catch { /* canceled */ }
        } else { try { controller.error(Error("Request aborted")); } catch { /* canceled */ } }
      }).finally(() => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        client.onUpdate = null;
        client.onViolation = null;
        session.busy = false;
        if (session.closed) return;
        if (!sessionKey) { closeSession(key, session); return; }
        session.timer = setTimeout(() => closeSession(key, session, { keepResumable: true }), idleMs);
        session.timer.unref?.();
      });
    },
    cancel: onAbort,
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream" } });
}
