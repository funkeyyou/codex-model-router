import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fetchAntigravityChat, closeAntigravitySessions, suspendAntigravitySessions, envelopeText } from "../src/antigravity-cli.mjs";

test("streaming envelope decodes split escapes and buffers tool arguments", () => {
  assert.equal(envelopeText('{"text":"hello\\nworld\\u4'), "hello\nworld");
  assert.equal(envelopeText('{"text":"hello\\nworld\\u4f60"'), "hello\nworld你");
  assert.equal(envelopeText('{"calls":[{"arguments":{"text":"hidden"}}]}'), "");
});

test("Antigravity ACP sessions continue, resume after idle, switch depth and carry images", {
  skip: process.platform === "win32", timeout: 20000,
}, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agy-session-test-"));
  const log = join(directory, "prompts.jsonl");
  const store = join(directory, "sessions.json");
  const binary = join(directory, "agy");
  t.after(async () => { closeAntigravitySessions(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(binary, `#!/usr/bin/env node
const fs=require('node:fs');
const log=${JSON.stringify(log)},store=${JSON.stringify(store)};
const read=()=>{try{return JSON.parse(fs.readFileSync(store,'utf8'))}catch{return {}}};
const out=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');
const models={availableModels:[{modelId:'flash-low'},{modelId:'flash-high'}]};
let model='flash-high',system=null;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);if(!m.method)return;const p=m.params||{};
 if(m.method==='initialize')return out({id:m.id,result:{protocolVersion:1,agentCapabilities:{promptCapabilities:{image:true},sessionCapabilities:{resume:{}},_meta:{antigravity:{systemPrompt:{append:true}}}}}});
 if(m.method==='session/new'){const s=read();const id='s'+Object.keys(s).length;s[id]=0;fs.writeFileSync(store,JSON.stringify(s));system=p._meta.antigravity.systemPrompt.append;return out({id:m.id,result:{sessionId:id,models}})}
 if(m.method==='session/resume'){if(!(p.sessionId in read()))return out({id:m.id,error:{code:-32602,message:'unknown'}});system=p._meta.antigravity.systemPrompt.append;return out({id:m.id,result:{sessionId:p.sessionId,models}})}
 if(m.method==='session/set_model'){model=p.modelId;return out({id:m.id,result:{}})}
 if(m.method==='session/prompt'){
  const s=read();const turn=++s[p.sessionId];fs.writeFileSync(store,JSON.stringify(s));
  const text=p.prompt[0].text;
  fs.appendFileSync(log,JSON.stringify({pid:process.pid,session:p.sessionId,turn,model,text,system,images:p.prompt.filter(b=>b.type==='image').length})+'\\n');
  const update=u=>out({method:'session/update',params:{sessionId:p.sessionId,update:u}});
  if(text.includes('LOCAL_TOOL')){update({sessionUpdate:'tool_call',name:'run_command'});return}
  const response=JSON.stringify({text:'hello world',calls:[]});
  update({sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'thinking'}});
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:response.slice(0,12)}});
  setTimeout(()=>{update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:response.slice(12)}});
   out({id:m.id,result:{stopReason:'end_turn',usage:{inputTokens:20,cachedReadTokens:80*(turn-1),outputTokens:10,thoughtTokens:2}}})},15);
 }
});
`, { mode: 0o700 });
  const route = { defaultCliModel: "flash-low", effortModels: { high: "flash-high" } };
  const shell = { type: "function", function: { name: "shell", parameters: { type: "object" } } };
  const first = { tools: [shell], messages: [{ role: "system", content: "You are Codex" }, { role: "user", content: "first" }] };
  const reply = { role: "assistant", content: "hello world" };
  async function ask(request, key, effort = null) {
    const response = await fetchAntigravityChat(request, route, binary, effort, null, key);
    const wire = await response.text();
    return wire.split("\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
  }
  const prompts = async () => (await readFile(log, "utf8")).trim().split("\n").map(JSON.parse);

  const a = await ask(first, "one");
  assert.equal(a.find(x => x.usage).usage.prompt_tokens_details.cached_tokens, 0);
  assert.ok(a.some(x => x.choices?.[0]?.delta?.reasoning_content === "thinking"));
  // Thinking extracted into the reasoning panel changes the replayed assistant prose only.
  // Tool search adds a tool mid-task: only the new definition is sent, in the same session.
  const search = { type: "function", function: { name: "search", parameters: { type: "object" } } };
  // Codex also appends developer text, merged into the leading system message by the Chat bridge.
  // Plugin attribution appended to a description is not resent.
  const attributed = { ...shell, function: { ...shell.function, description: "This tool is part of plugin `X`." } };
  const second = { tools: [attributed, search], messages: [{ role: "system", content: "You are Codex\n\nCodex tools were updated." },
    ...first.messages.slice(1),
    { ...reply, content: "world", reasoning_content: "hello" }, { role: "user", content: "second" }] };
  const b = await ask(second, "one");
  const usage = b.find(x => x.usage).usage;
  assert.deepEqual([usage.prompt_tokens, usage.completion_tokens, usage.prompt_tokens_details.cached_tokens], [100, 10, 80]);
  assert.equal(b.filter(x => x.choices?.[0]?.delta?.content).length, 2);

  suspendAntigravitySessions();
  const third = { tools: second.tools, messages: [...second.messages, reply, { role: "user", content: [
    { type: "text", text: "third" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }] };
  await ask(third, "one", "high");
  await ask(first, "two");
  await ask({ messages: [{ role: "user", content: "LOCAL_TOOL" }] }, "one").then(x => assert.ok(x.some(y => y.error)));
  await ask(third, "one");
  const oversized = { tools: third.tools, messages: [...third.messages, reply, { role: "user", content: "y".repeat(160000) }] };
  await ask(oversized, "one");

  const log1 = await prompts();
  assert.equal(log1[0].pid, log1[1].pid, "continuation reuses the CLI process");
  assert.equal(log1[1].session, log1[0].session);
  assert.match(log1[0].system, /Host settings and tools:\n.*"shell".*\nEarlier chat messages[^\n]*\n.*You are a coding agent/);
  assert.match(log1[0].text, /^Answer the coding agent request[\s\S]*\nNew chat messages \(respond to these\):\n\[\{"role":"user","content":"first"\}\]$/);
  assert.doesNotMatch(log1[0].text, /"shell"/);
  assert.match(log1[1].text, /^Standing instructions were extended:\ncoding agent tools were updated\.\nHost settings changed[^\n]*\n\{[^\n]*"added_or_updated_tools":\[\{[^\n]*"search"/);
  assert.doesNotMatch(log1[1].text, /"shell"|You are|first|Codex/);
  assert.match(log1[1].text, /New chat messages \(respond to these\):\n\[\{"role":"user","content":"second"\}\]$/);
  assert.notEqual(log1[2].pid, log1[1].pid, "idle sessions end their process");
  assert.equal(log1[2].session, log1[0].session, "and resume the same conversation");
  assert.equal(log1[2].system, log1[0].system, "with the same system prompt for cache reuse");
  assert.match(log1[2].text, /^Continue using the same instructions and tools/);
  assert.equal(log1[2].turn, 3);
  assert.equal(log1[2].model, "flash-high");
  assert.equal(log1[2].images, 1);
  assert.match(log1[2].text, /\[Image 1: attached to the latest user prompt\]/);
  assert.doesNotMatch(log1[2].text, /AAAA/);
  assert.notEqual(log1[3].session, log1[0].session, "chats are isolated");
  const rebuilt = log1.at(-2);
  assert.notEqual(rebuilt.session, log1[0].session, "a failed turn is never resumed");
  assert.equal(rebuilt.turn, 1);
  assert.equal(rebuilt.images, 1);
  assert.match(rebuilt.system, /Earlier chat messages[^\n]*\n.*"first".*"second"/);
  assert.match(rebuilt.text, /\nNew chat messages \(respond to these\):\n.*third/);
  const large = log1.at(-1);
  assert.notEqual(large.session, rebuilt.session, "a continuation over the user-message cap rebuilds");
  assert.match(large.system, /New chat messages \(respond to these\):\n.*y{1000}/);
  assert.ok(large.text.length < 1000);
});
