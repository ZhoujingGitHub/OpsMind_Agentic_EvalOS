import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import worker from "./dist/server/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_ROOT = path.join(ROOT, "dist", "client");
const API_ORIGIN = process.env.EVALOS_API_ORIGIN ?? "http://127.0.0.1:8787";
const API_TOKEN = process.env.EVALOS_API_TOKEN ?? "";
const MIME = new Map([[".js", "text/javascript; charset=utf-8"], [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"], [".svg", "image/svg+xml"], [".png", "image/png"],
  [".jpg", "image/jpeg"], [".jpeg", "image/jpeg"], [".webp", "image/webp"], [".ico", "image/x-icon"]]);

function assetPath(url) {
  const decoded = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, "");
  const candidate = path.resolve(CLIENT_ROOT, decoded);
  const relative = path.relative(CLIENT_ROOT, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? candidate : null;
}

async function assetFetch(request) {
  const file = assetPath(request.url);
  if (!file || !existsSync(file) || !statSync(file).isFile()) return new Response("Not found", { status: 404 });
  return new Response(Readable.toWeb(createReadStream(file)), { headers: {
    "content-type": MIME.get(path.extname(file).toLowerCase()) ?? "application/octet-stream",
    "cache-control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "public, max-age=300",
  } });
}

export async function handleRequest(request) {
  const url = new URL(request.url);
  const relayPath = url.pathname.startsWith("/api/candidate-relay/");
  const candidateObservationPath = url.pathname.startsWith("/api/candidate-observation/");
  const proxied = url.pathname === "/health" || url.pathname === "/api/runtime/capabilities"
    || url.pathname.startsWith("/api/m2/") || url.pathname.startsWith("/api/workbench/")
    || url.pathname === "/api/analysis-runs" || url.pathname.startsWith("/api/analysis-runs/")
    || relayPath || candidateObservationPath;
  if (["GET", "POST"].includes(request.method) && proxied) {
    const protectedPath = url.pathname.startsWith("/api/workbench/") || url.pathname.startsWith("/api/analysis-runs");
    if (protectedPath && !API_TOKEN) return new Response(JSON.stringify({ error: "工作台服务端认证尚未配置" }), {
      status: 503, headers: { "content-type": "application/json; charset=utf-8" },
    });
    if (request.method === "POST") {
      const origin = request.headers.get("origin");
      const expected = new URL(request.url).origin;
      if (origin && origin !== expected) return new Response(JSON.stringify({ error: "拒绝跨站写请求" }), {
        status: 403, headers: { "content-type": "application/json; charset=utf-8" },
      });
    }
    const headers = new Headers({ accept: request.headers.get("accept") ?? "application/json" });
    if (protectedPath) headers.set("authorization", `Bearer ${API_TOKEN}`);
    const contentType = request.headers.get("content-type");
    const idempotencyKey = request.headers.get("idempotency-key");
    if (contentType) headers.set("content-type", contentType);
    if (idempotencyKey) headers.set("idempotency-key", idempotencyKey);
    if (relayPath) {
      for (const name of ["x-evalos-relay-timestamp", "x-evalos-relay-nonce", "x-evalos-relay-signature"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
    }
    if (candidateObservationPath) {
      for (const name of ["authorization", "x-opsmind-identity-role"]) {
        const value = request.headers.get(name);
        if (value) headers.set(name, value);
      }
    }
    const upstream = await fetch(new URL(`${url.pathname}${url.search}`, API_ORIGIN), {
      method: request.method, headers, body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    });
    return new Response(upstream.body, { status: upstream.status, headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8",
      "cache-control": "no-store",
    } });
  }
  if (!['GET', 'HEAD'].includes(request.method)) return new Response("Method not allowed", { status: 405 });
  const directAsset = assetPath(request.url);
  if (directAsset && existsSync(directAsset) && statSync(directAsset).isFile()) return assetFetch(request);
  return worker.fetch(request, { ASSETS: { fetch: assetFetch } }, { waitUntil() {}, passThroughOnException() {} });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.CONSOLE_HOST ?? "0.0.0.0";
  const port = Number(process.env.CONSOLE_PORT ?? 3000);
  createServer(async (request, response) => {
    try {
      const forwardedProto = request.headers["x-forwarded-proto"];
      const protocol = forwardedProto === "https" ? "https" : "http";
      const origin = `${protocol}://${request.headers.host ?? `${host}:${port}`}`;
      const chunks = [];
      if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) for await (const chunk of request) chunks.push(chunk);
      const webResponse = await handleRequest(new Request(new URL(request.url ?? "/", origin), {
        method: request.method, headers: request.headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      }));
      response.statusCode = webResponse.status;
      webResponse.headers.forEach((value, key) => response.setHeader(key, value));
      if (!webResponse.body) return response.end();
      Readable.fromWeb(webResponse.body).pipe(response);
    } catch (error) {
      console.error("Console request failed", {
        method: request.method,
        url: request.url,
        host: request.headers.host,
        error: error instanceof Error ? error.message : String(error),
      });
      response.statusCode = 502;
      response.end("Console upstream unavailable");
    }
  }).listen(port, host, () => console.log(`OpsMind EvalOS M3 console listening at http://${host}:${port}`));
}
