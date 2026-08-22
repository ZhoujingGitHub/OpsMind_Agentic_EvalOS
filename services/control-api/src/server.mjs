import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "./app.mjs";

let candidateRelayConfig = { candidates: {} };
try { candidateRelayConfig = JSON.parse(readFileSync(path.resolve("config/candidate-relay-public-keys.json"), "utf8")); }
catch { /* A server without registered real products remains in engineering-test-only mode. */ }

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp({
  databasePath: process.env.EVALOS_DATABASE_PATH || undefined,
  privateLabelDatabasePath: process.env.EVALOS_PRIVATE_LABEL_DATABASE_PATH || undefined,
  runtimeRoot: process.env.EVALOS_RUNTIME_ROOT || undefined,
  artifactsRoot: process.env.EVALOS_ARTIFACTS_ROOT || undefined,
  m2ArtifactsRoot: process.env.EVALOS_M2_ARTIFACTS_ROOT || undefined,
  m2ExecutorArtifactsRoot: process.env.EVALOS_M2_EXECUTOR_ARTIFACTS_ROOT || undefined,
  m2AgentArtifactsRoot: process.env.EVALOS_M2_AGENT_ARTIFACTS_ROOT || undefined,
  m2QualificationArtifactsRoot: process.env.EVALOS_M2_QUALIFICATION_ARTIFACTS_ROOT || undefined,
  apiToken: process.env.EVALOS_API_TOKEN || undefined,
  allowedOrigin: process.env.EVALOS_ALLOWED_ORIGIN || undefined,
  bootstrapM3Design: true,
  bootstrapEngineeringTestDesign: true,
  candidateRelayConfig,
});

const server = createServer(async (request, response) => {
  const origin = `http://${request.headers.host ?? `${host}:${port}`}`;
  const body = ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : Readable.toWeb(request);
  const webRequest = new Request(new URL(request.url ?? "/", origin), {
    method: request.method,
    headers: request.headers,
    body,
    duplex: body ? "half" : undefined,
  });
  const webResponse = await app.handler(webRequest);
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  if (!webResponse.body) return response.end();
  Readable.fromWeb(webResponse.body).pipe(response);
});

server.listen(port, host, () => {
  console.log(`OpsMind EvalOS control API listening at http://${host}:${port}`);
});

const shutdown = () => {
  server.close(() => {
    app.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
