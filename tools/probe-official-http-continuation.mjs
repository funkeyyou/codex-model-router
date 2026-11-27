// Manual, billable live interoperability test. No user conversation, tools or provider keys.
// node tools/probe-official-http-continuation.mjs --live
import { randomBytes, randomUUID } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

if (process.argv.length !== 3 || process.argv[2] !== "--live") {
  console.error("Pass --live to send synthetic test turns to the official Codex backend using the signed-in account.");
  process.exit(2);
}
const endpoint = "https://chatgpt.com/backend-api/codex/responses";
const model = "gpt-6-astra";
const { tokens } = JSON.parse(readFileSync(join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json"), "utf8"));
if (!tokens?.access_token || !tokens.account_id) throw new Error("No signed-in ChatGPT account.");
const base = { model, instructions: "Follow the user's short memory test exactly. No explanation.", store: false, stream: true, reasoning: { effort: "low" } };
const msg = (role, content) => ({ role, content });
const question = msg("user", "Return exactly the random marker from my first message, with nothing else.");
const timeout = 60000;

// Only retain diagnostic categories. Never log bearer tokens, routing hints, IDs or raw replies.
function failure(raw) {
  const data = raw?.error ?? raw?.detail ?? raw ?? {};
  const message = typeof data === "string" ? data : data.message || "";
  const code = /^[a-z0-9_]{1,64}$/.test(data.code || "") ? data.code : null;
  const previous = /previous_response_id/i.test(message) || data.param === "previous_response_id" || code === "previous_response_not_found";
  return { code, previousIdMentioned: previous, reason:
    previous && /unsupported|not supported|unknown parameter|unrecognized/i.test(message) ? "unsupported_parameter" :
    previous && (/not found|not_found|cannot find|invalid/i.test(message) || code === "previous_response_not_found") ? "unresolved_id" : "other" };
}
function observe(r, event) {
  if (event.type === "response.output_text.delta") r.text += event.delta || "";
  if (event.type === "response.completed") {
    r.completed = true; r.id = event.response?.id;
    if (!r.text) r.text = (event.response?.output || []).flatMap(i => i.content || []).filter(p => p.type === "output_text").map(p => p.text).join("");
    return true;
  }
  if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
    r.error = failure(event.response?.error || event.error || event);
    return true;
  }
  return false;
}
function captureHint(session, value) { if (typeof value === "string" && value) session.hint = value; }
function headers(session) {
  return { authorization: "Bearer " + tokens.access_token, "chatgpt-account-id": tokens.account_id,
    originator: "codex_cli_rs", "session_id": session.id, "thread-id": session.id,
    ...(session.hint ? { "x-codex-turn-state": session.hint } : {}) };
}
async function httpTurn(session, body) {
  const response = await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(timeout),
    headers: { ...headers(session), accept: "text/event-stream", "content-type": "application/json" }, body: JSON.stringify(body) });
  captureHint(session, response.headers.get("x-codex-turn-state"));
  const r = { status: response.status, text: "" }, text = await response.text();
  if (!response.ok) { let raw; try { raw = JSON.parse(text); } catch { raw = text; } r.error = failure(raw); return r; }
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
    if (data && data !== "[DONE]" && observe(r, JSON.parse(data))) break;
  }
  return r;
}
async function wsParent(session, body) {
  // Preserve any server-supplied turn-state hint on the HTTP follow-up, but never persist it.
  const dc = channel("undici:websocket:open");
  const listener = ({ websocket, handshakeResponse }) => {
    if (websocket !== ws) return;
    for (const [name, value] of Object.entries(handshakeResponse?.headers || {})) {
      if (name.toLowerCase() === "x-codex-turn-state") captureHint(session, value);
    }
  };
  const ws = new WebSocket(endpoint.replace(/^https:/, "wss:"), {
    headers: { ...headers(session), "OpenAI-Beta": "responses_websockets=2026-02-06" },
  });
  dc.subscribe(listener);
  try {
    await once(ws, "open", { signal: AbortSignal.timeout(timeout) });
    const r = { status: 101, text: "" };
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(Error("ws_turn_timeout")), timeout);
      function done(err) {
        clearTimeout(timer); ws.onmessage = ws.onerror = ws.onclose = null;
        if (err) reject(err); else resolve();
      }
      ws.onmessage = e => { try { if (observe(r, JSON.parse(e.data))) done(); } catch { done(Error("invalid_ws_event")); } };
      ws.onerror = ws.onclose = () => done(Error("ws_disconnected"));
      ws.send(JSON.stringify({ type: "response.create", ...body }));
    });
    return r;
  } finally {
    dc.unsubscribe(listener);
    if (ws.readyState === WebSocket.OPEN) {
      const closed = once(ws, "close", { signal: AbortSignal.timeout(10000) });
      ws.close(1000, "probe complete"); await closed;
    } else ws.close();
  }
}
const summary = (r, expected) => ({ status: r.status, completed: r.completed === true, matches: r.completed === true && r.text.trim() === expected, ...(r.error ? { error: r.error } : {}) });
async function probe(parentTransport) {
  const session = { id: randomUUID() }, marker = randomBytes(12).toString("hex");
  const first = msg("user", "Remember this random marker: " + marker + ". Reply only ACK.");
  const parent = await (parentTransport === "WS" ? wsParent : httpTurn)(session, { ...base, input: [first] });
  const result = { from: parentTransport, to: "HTTP", parent: summary(parent, "ACK"), parentTurnHint: Boolean(session.hint) };
  if (!parent.id || !result.parent.matches) return result;
  const delta = await httpTurn(session, { ...base, previous_response_id: parent.id, input: [question] });
  result.delta = summary(delta, marker);
  if (!result.delta.matches) {
    result.fullHistoryControl = summary(await httpTurn(session, { ...base, input: [first, msg("assistant", parent.text), question] }), marker);
  }
  return result;
}
const results = [];
for (const transport of ["WS", "HTTP"]) {
  try { results.push(await probe(transport)); }
  catch (error) { results.push({ from: transport, to: "HTTP", transportError: String(error?.name || "Error").slice(0, 40) }); }
}
console.log(JSON.stringify({ at: new Date().toISOString(), endpoint, model, store: false, results }, null, 2));
if (!results.every(r => r.delta?.matches || (r.delta?.error?.previousIdMentioned && r.fullHistoryControl?.matches))) process.exitCode = 1;
