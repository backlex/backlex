/**
 * Minimal Node http host for the pre-bundled Azure Function
 * (`apps/web/dist/azure/index.mjs`). The bundle has no fetch export — it calls
 * `app.http()` / `app.timer()` on `@azure/functions` at load. So this host
 * patches those registration methods to CAPTURE the handlers (ESM singleton:
 * the bundle imports the same `app` object), then for each Node request builds
 * a real Azure `HttpRequest`, invokes the captured handler, and maps the
 * returned `HttpResponseInit` back to the Node response. That drives the actual
 * Azure ↔ Hono shim, not `app.fetch` directly.
 *
 * Run on Node (deploy reality). Environment: BUNDLE_PATH, PORT, plus the app's
 * env vars (DATABASE_URL, AUTH_SECRET, S3_*, …).
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import * as az from "@azure/functions";

const bundlePath = process.env.BUNDLE_PATH;
if (!bundlePath) {
  console.error("BUNDLE_PATH is required");
  process.exit(2);
}
const port = Number(process.env.PORT ?? 8787);

// Capture registrations before importing the bundle (same singleton).
const captured = {};
az.app.http = (_name, opts) => {
  captured.http = opts.handler;
};
az.app.timer = (_name, opts) => {
  captured.timer = opts.handler;
};

await import(pathToFileURL(bundlePath).href);

if (typeof captured.http !== "function") {
  console.error(`bundle at ${bundlePath} didn't register an http function`);
  process.exit(2);
}

// Minimal InvocationContext — the handler only reads the request.
const fakeContext = {
  invocationId: "smoke",
  log: () => {},
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    let bodyBytes;
    if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of nodeReq) chunks.push(chunk);
      if (chunks.length > 0) bodyBytes = new Uint8Array(Buffer.concat(chunks));
    }
    const headers = {};
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (v === undefined) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
    }
    const request = new az.HttpRequest({
      method: nodeReq.method,
      url: `http://127.0.0.1:${port}${nodeReq.url}`,
      headers,
      body: bodyBytes ? { bytes: bodyBytes } : undefined,
    });

    const res = await captured.http(request, fakeContext);

    // res.headers is a `Headers`; fold out Set-Cookie so multiple cookies stay
    // distinct rather than comma-joined by Headers.entries().
    const resHeaders = res.headers;
    const headerEntries = [];
    if (resHeaders && typeof resHeaders.entries === "function") {
      for (const [k, v] of resHeaders.entries()) {
        if (k.toLowerCase() === "set-cookie") continue;
        headerEntries.push([k, v]);
      }
      const setCookies =
        typeof resHeaders.getSetCookie === "function"
          ? resHeaders.getSetCookie()
          : [];
      for (const c of setCookies) headerEntries.push(["set-cookie", c]);
    }
    nodeRes.writeHead(res.status ?? 200, headerEntries);

    // Our shim returns body as an ArrayBuffer.
    if (res.body) nodeRes.write(Buffer.from(res.body));
    nodeRes.end();
  } catch (err) {
    console.error("[serve-azure] handler threw:", err);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { "Content-Type": "text/plain" });
    }
    nodeRes.end(`smoke host error: ${String(err)}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[serve-azure] hosting ${bundlePath} on http://127.0.0.1:${port}`);
});

const shutdown = (signal) => {
  console.log(`[serve-azure] ${signal}, closing`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
