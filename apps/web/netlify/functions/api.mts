// A/B step 2 — import the Hono app but DON'T call it. If this still
// returns 200, the bug is in `app.fetch(req)` (instance call). If it
// 502s with `y.handler`, the import chain itself has side effects that
// break the v2 detection (likely a top-level export override).
import app from "../../src/server/entries/netlify";

export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  return new Response(
    JSON.stringify({
      ok: true,
      path: url.pathname,
      runtime: "v2-step2",
      hono_imported: typeof app === "object" && app !== null,
      hono_keys: app && typeof app === "object" ? Object.keys(app).slice(0, 10) : [],
      ts: Date.now(),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
