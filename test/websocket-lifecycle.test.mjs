// Codex 與路由器之間的 WebSocket 連線生命週期。
//
// http.Server 的連線允許半關閉。Codex 行程被終止等情況下，用戶端不送 Close 訊框就
// 結束 TCP 連線，路由器這一端只收到 end；以前沒處理，連線（以及它的上游 WebSocket）
// 就一直留著，路由器也無法正常關閉。

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { loadRouterWith } from "./helpers/payloads.mjs";

test("用戶端沒送 Close 訊框就結束連線時，路由器會收掉這條連線", { timeout: 10000 }, async () => {
  const instance = await loadRouterWith({ upstreamWebSocket: false });
  const server = instance.routerServer;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;

  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    `GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
  );
  const [handshake] = await once(socket, "data");
  assert.match(handshake.toString(), /^HTTP\/1\.1 101/);

  // 只送 FIN，不送 WebSocket Close 訊框。
  socket.end();
  await once(socket, "close");

  const connections = () => new Promise((resolve, reject) =>
    server.getConnections((error, count) => (error ? reject(error) : resolve(count))));
  for (let attempt = 0; attempt < 50 && (await connections()) > 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await connections(), 0, "路由器這一端的連線應該已經關閉");
  await new Promise((resolve) => server.close(resolve));
});
