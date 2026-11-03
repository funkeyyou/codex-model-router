import { spawn } from "node:child_process";

// Keep diagnostics bounded: model lists and stderr can be large on a failing runner.
const tail = (value, limit = 4096) => String(value).slice(-limit);
export async function catalogPicker({ bin, args = ["app-server"], env, cwd,
  expected, migrate = false, afterFirst = null, signal, label = "picker",
  timeout = 30000, stopTimeout = 1000, diagnostic = () => "", report = () => {} }) {
  const started = Date.now();
  const app = spawn(bin, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "", buffer = "", stage = "initialize", ids = [], polls = 0;
  let settled = false, timer, pollTimer, closeResult, finish;
  // Install this immediately, including spawn failures. Never leave a rejecting exit promise.
  const closed = new Promise(resolve => app.once("close", (code, signal) => {
    closeResult = { code, signal };
    resolve();
  }));
  const describe = reason => `${label}: ${reason}; stage=${stage}; elapsed=${Date.now() - started}ms; ` +
    `polls=${polls}; expected=${tail(JSON.stringify(expected))}; lastIds=${tail(JSON.stringify(ids))}; ` +
    `exit=${JSON.stringify(closeResult ?? { code: app.exitCode, signal: app.signalCode })}; ` +
    `${tail(diagnostic())}; stderr=${stderr}`;
  const onAbort = () => finish(new Error(describe("test aborted")));
  let result, failure, cleanupFailure;
  try {
    result = await new Promise((resolve, reject) => {
      finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(pollTimer);
        signal?.removeEventListener("abort", onAbort);
        if (error) { report(error.message); reject(error); } else resolve(result);
      };
      const fail = error => finish(new Error(describe(error.message)));
      const send = message => {
        if (settled) return;
        app.stdin.write(JSON.stringify(message) + "\n", error => { if (error) fail(error); });
      };
      const list = () => { polls++; send({ id: 2, method: "model/list", params: { includeHidden: true } }); };
      app.on("error", fail);
      app.stdin.on("error", fail);
      app.stderr.setEncoding("utf8");
      app.stderr.on("data", data => { stderr = tail(stderr + data); });
      app.once("close", () => fail(new Error("app-server closed before completion")));
      app.stdout.setEncoding("utf8");
      app.stdout.on("data", data => {
        if (settled) return;
        buffer += data;
        try {
          let n;
          while (!settled && (n = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, n); buffer = buffer.slice(n + 1);
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (message.id !== 1 && message.id !== 2) continue;
            if (message.error) throw new Error(message.error.message ?? JSON.stringify(message.error));
            if (message.id === 1) {
              stage = migrate ? "config/batchWrite" : "model/list";
              send({ method: "initialized" });
              if (migrate) send({ id: 2, method: "config/batchWrite", params: { edits: [{ keyPath: "model_catalog_json", value: null, mergeStrategy: "replace" }], reloadUserConfig: false } });
              else list();
            } else if (migrate) finish(null);
            else {
              ids = message.result.data.map(model => model.id);
              const wanted = Array.isArray(expected) ? expected : [expected];
              const found = wanted.every((slug, index) => ids.includes(slug) &&
                (index === 0 || ids.indexOf(wanted[index - 1]) < ids.indexOf(slug)));
              if (found && afterFirst) {
                expected = afterFirst(); afterFirst = null;
                stage = "model/list after invalidation";
                list();
              } else if (found) finish(null, ids);
              else pollTimer = setTimeout(list, 50);
            }
          }
          if (buffer.length > 1024 * 1024) throw new Error("app-server response exceeded 1 MiB without a newline");
        } catch (error) { fail(error); }
      });
      timer = setTimeout(() => fail(new Error("picker timeout")), timeout);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      else send({ id: 1, method: "initialize", params: { clientInfo: { name: "router_test", version: "1.0.0" } } });
    });
  } catch (error) { failure = error; } finally {
    clearTimeout(timer);
    clearTimeout(pollTimer);
    signal?.removeEventListener("abort", onAbort);
    // EOF lets app-server flush files before the next restart (important on Windows).
    app.stdin.end();
    const waitForClose = async () => {
      let deadline;
      try { return await Promise.race([closed.then(() => true), new Promise(resolve => { deadline = setTimeout(() => resolve(false), stopTimeout); })]); }
      finally { clearTimeout(deadline); }
    };
    if (!closeResult && !await waitForClose()) {
      app.kill();
      if (!await waitForClose()) {
        app.kill("SIGKILL");
        if (!await waitForClose()) {
          app.stdin.destroy(); app.stdout.destroy(); app.stderr.destroy(); app.unref();
          cleanupFailure = new Error(describe("app-server did not close after forced termination"));
        }
      }
    }
  }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure], failure.message + "\n" + cleanupFailure.message);
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return result;
}
