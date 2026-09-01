import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

test("公网控制台只向单个 Trial 的 AI Judge 入口注入服务端认证", async (t) => {
  let observed;
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = { method: request.method, url: request.url, headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8") };
    response.writeHead(201, { "content-type": "application/json" });
    response.end('{"judge_ref":"judge-test"}');
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const address = upstream.address();
  process.env.EVALOS_API_ORIGIN = `http://127.0.0.1:${address.port}`;
  process.env.EVALOS_API_TOKEN = "server-side-test-token";
  const { handleRequest } = await import(`../serve.mjs?judge-proxy-test=${Date.now()}`);

  const response = await handleRequest(new Request(
    "https://evalos.example/api/trials/trial_abc-123/judge",
    { method: "POST", headers: {
      origin: "https://evalos.example",
      authorization: "Bearer untrusted-browser-token",
      "x-untrusted-extra": "must-not-pass",
    } },
  ));

  assert.equal(response.status, 201);
  assert.equal(observed.method, "POST");
  assert.equal(observed.url, "/api/trials/trial_abc-123/judge");
  assert.equal(observed.body, "");
  assert.equal(observed.headers.authorization, "Bearer server-side-test-token");
  assert.equal(observed.headers["x-untrusted-extra"], undefined);
});

test("公网控制台不开放任意 Trial 子路径", async () => {
  process.env.EVALOS_API_TOKEN = "server-side-test-token";
  const { handleRequest } = await import(`../serve.mjs?judge-proxy-deny-test=${Date.now()}`);
  const response = await handleRequest(new Request(
    "https://evalos.example/api/trials/trial_abc-123/delete",
    { method: "POST", headers: { origin: "https://evalos.example" } },
  ));
  assert.equal(response.status, 405);
});

