// Real Codex executor + both bridge directions, synthetic auth/upstream only.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { loadPayloads } from "./helpers/payloads.mjs";
import { codexBin } from "./helpers/codex-bin.mjs";

const bin = codexBin;
test("Code Mode compact summaries retain full registry schemas and executable nested tools", {skip: !bin, timeout: 30000}, async () => {
  const { bridge } = await loadPayloads();
  const home = mkdtempSync(join(tmpdir(), "router-context-e2e-"));
  const env = {...process.env, CODEX_HOME: home};
  delete env.OPENAI_API_KEY;
  delete env.CODEX_MODEL_ROUTER_IMPORT_ONLY;
  const bundled = JSON.parse(execFileSync(bin, ["debug", "models", "--bundled"], {env, cwd:home, encoding:"utf8"}));
  const model = {...bundled.models.find(m=>m.visibility === "list"), slug:"custom/context-fixture", tool_mode:"code_mode_only", supports_search_tool:false};
  const captures = [], failures = [], calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      let data = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "zstd") data = zstdDecompressSync(data);
      if (!req.url.includes("/responses")) {
        res.writeHead(200, {"content-type":"application/json"});
        res.end(JSON.stringify({models:[model]})); return;
      }
      if (!data.length) { res.writeHead(426); res.end(); return; }
      const body = JSON.parse(data.toString());
      const ctx = bridge.toAnthropicRequest(body, {upstreamModel:"claude-fixture"});
      captures.push({body, ctx});
      const step = captures.length;
      assert.ok(step <= 3, "unexpected retry or extra inference");
      const code = step === 1
        ? 'text(ALL_TOOLS.find(t => t.name === "research_fixture__lookup")?.description);'
        : 'text(await tools.research_fixture__lookup({city:"Taipei",options:{ids:["a","b"]}}));';
      const block = step <= 2 ? {type:"tool_use", id:`call_${step}`, name:"exec", input:{}}
        : {type:"text", text:""};
      const events = [
        {type:"message_start",message:{id:`msg_${step}`,type:"message",role:"assistant",content:[],model:"claude-fixture",usage:{input_tokens:10,output_tokens:1}}},
        {type:"content_block_start",index:0,content_block:block},
        {type:"content_block_delta",index:0,delta:step<=2?{type:"input_json_delta",partial_json:JSON.stringify({input:code})}:{type:"text_delta",text:"fixture done"}},
        {type:"content_block_stop",index:0},
        {type:"message_delta",delta:{stop_reason:step<=2?"tool_use":"end_turn"},usage:{output_tokens:1}},
        {type:"message_stop"},
      ];
      async function* stream() { yield Buffer.from(events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("")); }
      res.writeHead(200, {"content-type":"text/event-stream"});
      await bridge.bridgeAnthropicStream(stream(), e=>res.write(`data: ${JSON.stringify(e)}\n\n`), {...ctx,model:body.model,requestBody:body});
      res.end();
    } catch (e) { failures.push(e); res.end(); }
  });
  await new Promise(resolve=>server.listen(0, "127.0.0.1", resolve));
  writeFileSync(join(home,"models.json"), JSON.stringify({models:[model]}));
  writeFileSync(join(home,"config.toml"), `model = "${model.slug}"\nmodel_catalog_json = ${JSON.stringify(join(home,"models.json"))}\nopenai_base_url = "http://127.0.0.1:${server.address().port}/v1"\n[features]\napps = false\nplugins = false\n`);
  const jwt = "e30." + Buffer.from(JSON.stringify({sub:"fixture",email:"fixture@example.com","https://api.openai.com/auth":{chatgpt_account_id:"fixture",chatgpt_plan_type:"plus",chatgpt_user_id:"fixture"}})).toString("base64url") + ".fake";
  writeFileSync(join(home,"auth.json"), JSON.stringify({auth_mode:"chatgpt",last_refresh:new Date().toISOString(),tokens:{access_token:jwt,id_token:jwt,refresh_token:"fake",account_id:"fixture"}}));
  const tool = {type:"function",name:"lookup",description:"Read the fixture. " + "Detailed safe usage. ".repeat(150) + " EXPECTED_FULL_RULE",deferLoading:false,inputSchema:{type:"object",properties:{city:{type:"string"},options:{type:"object",properties:{ids:{type:"array",items:{type:"string"}}},required:["ids"]}},required:["city","options"]}};
  const app = spawn(bin, ["app-server"], {env,cwd:home,stdio:["pipe","pipe","ignore"]});
  const exited = once(app,"exit");
  const send = m=>app.stdin.write(JSON.stringify(m)+"\n");
  let buffer = "";
  try {
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("context e2e timeout")),20000);
      app.once("error",e=>{clearTimeout(timer);reject(e);});
      app.stdout.on("data",d=>{
        buffer+=d;let n;
        while((n=buffer.indexOf("\n"))>=0) {
          const m=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);
          if(m.error) {clearTimeout(timer);reject(new Error(JSON.stringify(m.error)));}
          if(m.id===1) {send({method:"initialized"});send({id:2,method:"thread/start",params:{cwd:home,model:model.slug,ephemeral:true,approvalPolicy:"never",dynamicTools:[{type:"namespace",name:"research_fixture",description:"Fixture lookup",tools:[tool]}]}});}
          if(m.id===2&&m.result) send({id:3,method:"turn/start",params:{threadId:m.result.thread.id,input:[{type:"text",text:"Read the fixture.",text_elements:[]}]}});
          if(m.method==="item/tool/call") {calls.push(m.params);send({id:m.id,result:{success:true,contentItems:[{type:"inputText",text:"FIXTURE_RESULT_OK"}]}});}
          if(m.method==="turn/completed") {clearTimeout(timer);try{assert.equal(m.params.turn.status,"completed");resolve();}catch(e){reject(e);}}
        }
      });
      send({id:1,method:"initialize",params:{clientInfo:{name:"context_test",version:"1"},capabilities:{experimentalApi:true}}});
    });
    assert.deepEqual(failures, []);
    assert.equal(captures.length, 3);
    // Bundled nested tools vary by Codex build; the fixture itself must be compacted.
    assert.ok(captures[0].ctx.toolContext.toolsDeferred >= 1);
    assert.ok(JSON.stringify(captures[0].body).includes("EXPECTED_FULL_RULE"));
    assert.ok(!JSON.stringify(captures[0].ctx.request).includes("EXPECTED_FULL_RULE"));
    assert.ok(JSON.stringify(captures[1].ctx.request.messages).includes("EXPECTED_FULL_RULE"));
    assert.ok(JSON.stringify(captures[1].ctx.request.messages).includes("options:"));
    assert.ok(JSON.stringify(captures[2].ctx.request.messages).includes("FIXTURE_RESULT_OK"));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].namespace, "research_fixture");
    assert.equal(calls[0].tool, "lookup");
    assert.deepEqual(calls[0].arguments, {city:"Taipei",options:{ids:["a","b"]}});
  } finally {app.kill();await exited;server.closeAllConnections();server.close();}
});
