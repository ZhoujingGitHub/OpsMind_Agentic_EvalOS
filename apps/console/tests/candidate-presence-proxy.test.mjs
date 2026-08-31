import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";


test("公网控制台只向候选报到后端透传产品签名和请求体", async (t) => {
  const observed = [];
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed.push({ method: request.method, url: request.url, headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  process.env.EVALOS_API_ORIGIN = `http://127.0.0.1:${address.port}`;
  const { handleRequest } = await import(`../serve.mjs?candidate-presence-proxy-test=${Date.now()}`);

  const headers = {
    "x-opsmind-key-id": "agent-presence-key",
    "x-opsmind-signature": "signed-presence-value",
    "x-untrusted-extra": "must-not-pass",
  };
  const body = '{"candidate_ref":"agent-harness-v2","status":"ready"}';
  const response = await handleRequest(new Request(
    "https://evalos.example/api/candidate-presence",
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body },
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(observed.map((item) => [item.method, item.url]), [
    ["POST", "/api/candidate-presence"],
  ]);
  assert.equal(observed[0].body, body);
  for (const item of observed) {
    assert.equal(item.headers["x-opsmind-key-id"], "agent-presence-key");
    assert.equal(item.headers["x-opsmind-signature"], "signed-presence-value");
    assert.equal(item.headers["x-untrusted-extra"], undefined);
  }
});
