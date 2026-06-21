/**
 * Minimal Node http host for the pre-bundled AWS Lambda function
 * (`apps/web/dist/lambda/index.mjs`). Unlike the Vercel/Netlify bundles
 * (which export a fetch handler), the Lambda bundle exports `handler =
 * handle(app)` — an API-Gateway-event handler. So this host wraps each
 * incoming Node request in an **API Gateway HTTP API (payload v2.0)** event,
 * invokes the real `handle()` adapter, and maps the Lambda result back to the
 * Node response. That exercises the genuine event ↔ Request/Response bridge,
 * not just `app.fetch`.
 *
 * Run on Node (not Bun) so any Bun-only API leaking into the Node-targeted
 * bundle surfaces here as an import/runtime error, matching deploy reality.
 *
 * Environment: BUNDLE_PATH (abs path to index.mjs), PORT, plus every var the
 * Hono app reads (DATABASE_URL, AUTH_SECRET, CRON_SECRET, S3_*, …).
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const bundlePath = process.env.BUNDLE_PATH;
if (!bundlePath) {
  console.error("BUNDLE_PATH is required");
  process.exit(2);
}
const port = Number(process.env.PORT ?? 8787);

const mod = await import(pathToFileURL(bundlePath).href);
const handler = mod.handler;
if (typeof handler !== "function") {
  console.error(`bundle at ${bundlePath} doesn't export a \`handler\` function`);
  process.exit(2);
}

// Node request → API Gateway HTTP API (v2.0) event.
const toEvent = (nodeReq, bodyBuf) => {
  const url = new URL(`http://127.0.0.1:${port}${nodeReq.url}`);
  const headers = {};
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (v === undefined) continue;
    // Cookies travel in the v2 `cookies` array, not the headers map.
    if (k.toLowerCase() === "cookie") continue;
    headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  const cookieHeader = nodeReq.headers.cookie;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ""),
    headers,
    cookies: cookieHeader ? cookieHeader.split("; ") : undefined,
    requestContext: {
      http: {
        method: nodeReq.method,
        path: url.pathname,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: headers["user-agent"] ?? "",
      },
      domainName: "127.0.0.1",
    },
    body: bodyBuf ? bodyBuf.toString("base64") : undefined,
    isBase64Encoded: Boolean(bodyBuf),
  };
};

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    let bodyBuf;
    if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
      const chunks = [];
      for await (const chunk of nodeReq) chunks.push(chunk);
      if (chunks.length > 0) bodyBuf = Buffer.concat(chunks);
    }
    const event = toEvent(nodeReq, bodyBuf);
    const result = await handler(event, { awsRequestId: "smoke" });

    const headerEntries = Object.entries(result.headers ?? {});
    // v2 returns Set-Cookie values in a separate `cookies` array.
    for (const c of result.cookies ?? []) headerEntries.push(["set-cookie", c]);
    nodeRes.writeHead(result.statusCode ?? 200, headerEntries);

    if (result.body !== undefined && result.body !== null) {
      nodeRes.end(
        result.isBase64Encoded
          ? Buffer.from(result.body, "base64")
          : result.body,
      );
    } else {
      nodeRes.end();
    }
  } catch (err) {
    console.error("[serve-lambda] handler threw:", err);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { "Content-Type": "text/plain" });
    }
    nodeRes.end(`smoke host error: ${String(err)}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[serve-lambda] hosting ${bundlePath} on http://127.0.0.1:${port}`);
});

const shutdown = (signal) => {
  console.log(`[serve-lambda] ${signal}, closing`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
