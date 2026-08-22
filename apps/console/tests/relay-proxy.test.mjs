import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("公网控制台只透传候选中继签名请求所需的固定头", async (t) => {
  let observed;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = { method: request.method, url: request.url, headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8") };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"request":null}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  process.env.EVALOS_API_ORIGIN = `http://127.0.0.1:${address.port}`;
  const { handleRequest } = await import(`../serve.mjs?relay-proxy-test=${Date.now()}`);

  const body = '{"worker_id":"worker-1","lease_ms":60000}';
  const response = await handleRequest(new Request(
    "https://evalos.example/api/candidate-relay/agent-harness-v2/claim",
    { method: "POST", headers: {
      "content-type": "application/json",
      "x-evalos-relay-timestamp": "1770000000000",
      "x-evalos-relay-nonce": "nonce-1",
      "x-evalos-relay-signature": "signature-1",
      "x-untrusted-extra": "must-not-pass",
    }, body },
  ));

  assert.equal(response.status, 200);
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/api/candidate-relay/agent-harness-v2/claim");
  assert.equal(observed.body, body);
  assert.equal(observed.headers["x-evalos-relay-timestamp"], "1770000000000");
  assert.equal(observed.headers["x-evalos-relay-nonce"], "nonce-1");
  assert.equal(observed.headers["x-evalos-relay-signature"], "signature-1");
  assert.equal(observed.headers["x-untrusted-extra"], undefined);
  assert.equal(observed.headers.authorization, undefined);
});
