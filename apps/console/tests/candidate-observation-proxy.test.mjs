import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";


test("公网控制台只向候选观察后端透传独立短期身份和请求体", async (t) => {
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
  const { handleRequest } = await import(`../serve.mjs?candidate-observation-proxy-test=${Date.now()}`);

  const headers = {
    authorization: "Bearer short-candidate-session",
    "x-opsmind-identity-role": "candidate_observer",
    "x-untrusted-extra": "must-not-pass",
  };
  const health = await handleRequest(new Request(
    "https://evalos.example/api/candidate-observation/agent-harness-v2/health", { headers },
  ));
  assert.equal(health.status, 200);

  const body = '{"request_id":"candidate-observe-1","capability":"runtime_state"}';
  const observation = await handleRequest(new Request(
    "https://evalos.example/api/candidate-observation/agent-harness-v2/observe",
    { method: "POST", headers: { ...headers, "content-type": "application/json" }, body },
  ));
  assert.equal(observation.status, 200);
  assert.deepEqual(observed.map((item) => [item.method, item.url]), [
    ["GET", "/api/candidate-observation/agent-harness-v2/health"],
    ["POST", "/api/candidate-observation/agent-harness-v2/observe"],
  ]);
  assert.equal(observed[1].body, body);
  for (const item of observed) {
    assert.equal(item.headers.authorization, "Bearer short-candidate-session");
    assert.equal(item.headers["x-opsmind-identity-role"], "candidate_observer");
    assert.equal(item.headers["x-untrusted-extra"], undefined);
  }
});
