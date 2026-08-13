import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createApp } from "./app.mjs";

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
const app = createApp({
  databasePath: process.env.EVALOS_DATABASE_PATH || undefined,
  runtimeRoot: process.env.EVALOS_RUNTIME_ROOT || undefined,
  artifactsRoot: process.env.EVALOS_ARTIFACTS_ROOT || undefined,
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
