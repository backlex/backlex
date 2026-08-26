/**
 * Every route group the app mounts is either in the published OpenAPI document
 * or listed below with the reason it is not.
 *
 * `SUBAPPS` in `routes/openapi.ts` is hand-maintained, so a new `app.route(…)`
 * joins the API and never joins its contract — silently, because nothing
 * compares the two. Measured when this test was written: 110 mounts, 89 in
 * SUBAPPS, 19 absent from the spec. Among the absent were `/api/agents`,
 * `/api/uploads` and the whole `/api/t` app plane — all of which answer 200
 * with real data on a live tenant, and all of which a customer is expected to
 * integrate against.
 *
 * `/api/t` is the expensive one to lose: the admin plane is consumed by the
 * admin SPA, which ships with the product, while the app plane is consumed by
 * the customer's OWN application — the surface most in need of a generated
 * client, and the one with no machine-readable description at all.
 *
 * This test does not document anything. It makes the gap an inventory instead
 * of a hole: every exemption below is a decision someone wrote down, and a new
 * undocumented mount fails until it is either described or deliberately added
 * here.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/**
 * Mounts that are deliberately outside the REST contract, each with the reason.
 * Removing an entry is how a group gets documented; adding one is a decision.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  ["/.well-known", "Protocol discovery (JWKS, OAuth metadata) — described by its own RFCs, not by us."],
  ["/mcp", "Model Context Protocol — its own JSON-RPC schema, not REST."],
  ["/api/admin/mcp", "MCP admin surface; same protocol, same reason."],
  ["/s3", "S3-compatible endpoint — the contract is the S3 API, deliberately."],
  ["/api/scim/v2", "SCIM 2.0 — RFC 7644 defines the shapes; a second description would only drift."],
  ["/api/_internal/sandbox-rpc", "Internal RPC between the worker and the functions sandbox. Not public."],
  ["/api/webhook", "INBOUND webhooks from third parties. The payload is the sender's contract, not ours."],
  ["/api/site", "Serves the marketing/docs site assets, not an API."],
  ["/api/admin/demo", "Playground/demo-mode controls; only meaningful on the demo instance."],

  // ── Genuine gaps, tracked rather than hidden ──────────────────────────────
  // Each of these answers 200 with real data and has an SDK client, and each
  // is a plain Hono router with no `.openapi()` metadata, so describing it
  // means writing the path items (the sibling-metadata pattern in
  // `collections.openapi.ts`). Listed here so the absence is reviewed rather
  // than discovered by a customer.
  ["/api/agents", "TODO: undocumented. AI agents — SDK `agents`, 11 MCP tools, docs/agents.md."],
  ["/api/t", "TODO: undocumented. The workspace END-USER plane — the surface customer applications call."],
  ["/api/admin/schema", "TODO: undocumented. Schema versions / branching — SDK `schema`."],
  ["/api/admin/migrate", "TODO: undocumented. External-DB migration — SDK `migrate`."],
  ["/api/consent", "TODO: undocumented. Public consent-record ingest from the banner."],
  ["/api/integrations", "TODO: undocumented. Public OAuth callback leg for integrations."],
  ["/api/payments", "TODO: undocumented. Provider webhook + public checkout return leg."],
  ["/api/admin/ai", "TODO: undocumented. Ask-AI admin surface."],
]);

const mounts = (): string[] => {
  const src = read("src/server/app.ts");
  return [...new Set([...src.matchAll(/app\.route\(\s*"([^"]+)"/g)].map((m) => m[1]!))].sort();
};

const specPaths = (): string[] =>
  Object.keys(JSON.parse(read("src/server/lib/openapi-static.generated.json")).paths as object);

const covered = (mount: string, paths: string[]): boolean =>
  paths.some((p) => p === mount || p.startsWith(`${mount}/`) || p.startsWith(`${mount}{`));

describe("OpenAPI mount coverage", () => {
  test("every mounted route group is described or explicitly exempt", () => {
    const paths = specPaths();
    const undocumented = mounts().filter((m) => !covered(m, paths) && !EXEMPT.has(m));
    expect(undocumented).toEqual([]);
  });

  test("no exemption outlives the gap it describes", () => {
    // A group that HAS been documented must lose its exemption, or the list
    // rots into a place where real gaps hide behind stale entries.
    const paths = specPaths();
    const stale = [...EXEMPT.keys()].filter((m) => covered(m, paths));
    expect(stale).toEqual([]);
  });

  test("the scan can actually see the mounts it is checking", () => {
    // A guard whose input is empty passes for the wrong reason. This is the
    // positive control: the extraction must find the app's real mount list,
    // and a group known to be documented must read as covered.
    const all = mounts();
    expect(all.length).toBeGreaterThan(80);
    expect(all).toContain("/api/collections");
    expect(covered("/api/collections", specPaths())).toBe(true);
    expect(covered("/api/definitely-not-mounted", specPaths())).toBe(false);
  });
});
