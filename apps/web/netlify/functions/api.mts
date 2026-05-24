// Minimal v2 handler — temporary A/B test to confirm Netlify's runtime
// is wrapping us as v2 (Web Standard) and not v1 (`y.handler is not a
// function`). Once verified, this swaps back to the real Hono entry.
export default async (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  return new Response(
    JSON.stringify({ ok: true, path: url.pathname, runtime: "v2-test", ts: Date.now() }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};
