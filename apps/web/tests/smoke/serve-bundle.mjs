/**
 * Minimal Node http host for pre-bundled Vercel / Netlify functions.
 *
 * We deliberately run the bundle on Node (not Bun) for runtime smoke
 * so Bun-only APIs leaking into the Node-targeted bundle surface as
 * import-time errors here, not at deploy time. Node 22 has Request /
 * Response / Headers / fetch globally, so the IncomingMessage→Request
 * and Response→ServerResponse adapters stay small.
 *
 * Two bundle shapes are supported:
 *   - Vercel:  `export default { fetch: (req) => Response }`
 *   - Netlify: `export default async (req, context) => Response`
 *
 * The exported handler is sniffed at boot.
 *
 * Environment:
 *   BUNDLE_PATH  absolute path to the bundle .mjs
 *   PORT         listen port (default 8787)
 *   plus every var the Hono app reads (DATABASE_URL, AUTH_SECRET, ...)
 */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const bundlePath = process.env.BUNDLE_PATH;
if (!bundlePath) {
  console.error("BUNDLE_PATH is required");
  process.exit(2);
}

const port = Number(process.env.PORT ?? 8787);

// Import the bundle. ESM dynamic import takes a URL or specifier; we
// have an absolute filesystem path so wrap it.
const mod = await import(pathToFileURL(bundlePath).href);
const exported = mod.default ?? mod;

// Sniff the shape. Vercel: object with .fetch. Netlify: bare function.
let handler;
if (typeof exported === "function") {
  handler = (req) => exported(req, {});
} else if (exported && typeof exported.fetch === "function") {
  handler = (req) => exported.fetch(req);
} else {
  console.error(
    `bundle at ${bundlePath} doesn't export { fetch } or a default function`,
  );
  process.exit(2);
}

const toWebRequest = async (nodeReq) => {
  const url = `http://127.0.0.1:${port}${nodeReq.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(nodeReq.headers)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) headers.set(k, v.join(", "));
    else headers.set(k, String(v));
  }
  let body;
  if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
    const chunks = [];
    for await (const chunk of nodeReq) chunks.push(chunk);
    if (chunks.length > 0) body = Buffer.concat(chunks);
  }
  return new Request(url, { method: nodeReq.method, headers, body });
};

const writeWebResponse = async (webRes, nodeRes) => {
  // Headers including any duplicated Set-Cookie. Node's writeHead
  // accepts an array form for that: ['Set-Cookie', ...] per cookie.
  const headerEntries = [];
  for (const [k, v] of webRes.headers.entries()) {
    headerEntries.push([k, v]);
  }
  nodeRes.writeHead(webRes.status, headerEntries);
  if (webRes.body) {
    const reader = webRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      nodeRes.write(value);
    }
  }
  nodeRes.end();
};

const server = createServer(async (nodeReq, nodeRes) => {
  try {
    const webReq = await toWebRequest(nodeReq);
    const webRes = await handler(webReq);
    await writeWebResponse(webRes, nodeRes);
  } catch (err) {
    console.error("[serve-bundle] handler threw:", err);
    if (!nodeRes.headersSent) {
      nodeRes.writeHead(500, { "Content-Type": "text/plain" });
    }
    nodeRes.end(`smoke host error: ${String(err)}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[serve-bundle] hosting ${bundlePath} on http://127.0.0.1:${port}`);
});

const shutdown = (signal) => {
  console.log(`[serve-bundle] ${signal}, closing`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
