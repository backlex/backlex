/**
 * Minimal Node http host for the pre-bundled Google Cloud Function
 * (`apps/web/dist/gcp/index.mjs`). On a real GCF deploy the Functions
 * Framework registers the `api` function via `http()` and drives its Node
 * `(req, res)` listener per request. The entry exports that exact listener as
 * `nodeListener`, so this host mounts the identical listener on a plain
 * `http.Server` — faithful to the GCF request path (it exercises the real
 * `getRequestListener(app.fetch)` wiring) without depending on the
 * functions-framework CLI, which mis-handles ESM `--source` bundles
 * (`functionModule.hasOwnProperty is not a function`).
 *
 * Run on Node (deploy reality). Environment: BUNDLE_PATH, PORT, plus the app's
 * env vars (DATABASE_URL, AUTH_SECRET, CRON_SECRET, S3_*, …).
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
const listener = mod.nodeListener;
if (typeof listener !== "function") {
  console.error(`bundle at ${bundlePath} doesn't export a \`nodeListener\``);
  process.exit(2);
}

const server = createServer((req, res) => listener(req, res));

server.listen(port, "127.0.0.1", () => {
  console.log(`[serve-gcp] hosting ${bundlePath} on http://127.0.0.1:${port}`);
});

const shutdown = (signal) => {
  console.log(`[serve-gcp] ${signal}, closing`);
  server.close(() => process.exit(0));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
