/**
 * No list endpoint may return an unbounded result set — and this is the file
 * that notices when a new one does.
 *
 * WHAT WAS MEASURED FIRST (2026-08-30, against the app this harness boots).
 * The premise "nearly everything already paginates" was checked before anything
 * was built, and it is false:
 *
 *   246  distinct GET routes in the running Hono route table
 *   187  of them described by the app's own OpenAPI document
 *    59  described nowhere in it — plain-Hono mounts whose sub-app never reached
 *        `routes/openapi.ts`'s SUBAPPS list. `/api/agents`,
 *        `/api/admin/migrate/runs`, `/api/admin/schema/snapshots`,
 *        `/api/scim/v2/Users` and `/api/t/:slug/orgs` are all list endpoints that
 *        no published contract mentions.
 *
 * and the 187 documented ones break down as:
 *
 *    21  declare a page size WITH a ceiling — bounded by contract
 *     1  declares a page size with NO ceiling (`/api/admin/db/tables`)
 *    75  return a collection and offer no page at all — no `limit`, no cursor
 *    25  publish `z.any()` for their 200, so nothing can tell what they return
 *    65  return a single object
 *
 * So 21 of the 96 routes that visibly hand back rows — 22% — are bounded. This is
 * not a tidy surface with one hole in it; the unbounded shape is the majority,
 * and `/api/users`, `/api/uploads`, `/api/collections`, `/api/comments`,
 * `/api/webhooks`, `/api/tenants/:id/members` are all in it. Each is fine on a
 * demo workspace and a memory cliff on a real one — and on Workers the isolate
 * has a hard ceiling, so one large tenant takes down every request sharing it.
 *
 * WHAT THIS FILE DOES ABOUT IT. Nothing, deliberately. Adding pagination to a
 * shipped public endpoint is a behaviour change and belongs in its own commit.
 * This file FREEZES the 75 + the 25 + the 59 and fails on the next one. It is a
 * ratchet: the three ledgers may only shrink.
 *
 * THREE LAYERS, AND WHAT EACH ONE ACTUALLY PROVES.
 *
 *  1. The inventory is the RUNNING APP, not a hand-written list. The universe is
 *     `app.routes` — every GET the app answers — so a new route is in scope the
 *     moment it is mounted, whether or not anybody documented it. The floors in
 *     the first describe exist because a guard that enumerates nothing passes
 *     everything: if the route table or the OpenAPI route ever stops answering,
 *     these fail loudly instead of going quietly green.
 *
 *  2. A declared ceiling is ENFORCED, not decorative — proven by driving the real
 *     endpoint. `?limit=<max+1>` must be REFUSED.
 *
 *     This layer is not belt-and-braces, and the reason is worth spelling out.
 *     Outside dev, `buildOpenApiDoc` does NOT read the live zod schemas: it
 *     serves `src/server/lib/openapi-static.generated.json`, a 900 KB artifact
 *     built by `bun run --cwd apps/web gen:openapi-static` and committed to the
 *     repo. So the document is a SNAPSHOT of the contract, and it can disagree
 *     with the code in both directions. Measured, not assumed — deleting
 *     `.max(200)` from `routes/notifications.ts`'s query schema left the
 *     published `maximum: 200` completely intact, and `GET /api/notifications
 *     ?limit=201` started answering 200 OK. Layer 1 saw nothing. This layer
 *     named the route. A ceiling nobody validates is what this catches.
 *
 *  3. The ledger is not a formality: `/api/folders` is filled past any plausible
 *     page size and asserted to return the lot. The claim "this endpoint is
 *     unbounded" is demonstrated on one of them rather than only asserted on 75.
 *
 * WHAT THIS FILE DOES NOT PROVE, said plainly. The classification in layer 1 is
 * read off the committed spec, so it describes the CONTRACT and not the code —
 * layer 2 is the only part that touches a running handler. Layer 2 in turn covers
 * the 15 bounded endpoints that take no path parameter; the 6 that do
 * (`/api/items/:slug` and friends) are covered only for `/api/items/:slug`, with
 * real rows. And membership of `UNPAGED_LISTS` means "the CONTRACT offers no
 * bounded page" — NOT "the result set is unbounded". Some of those clamp below
 * the route where no contract can see it; the ones that were actually read are
 * in `CAPPED_BELOW_THE_CONTRACT`, which pins the clamp to a file. The rest were
 * frozen, not triaged, and the ledger says so rather than pretending otherwise.
 *
 * The 25 in `OPAQUE_RESPONSES` are the honest gap: they publish `z.any()`, so
 * whether they are lists at all is unknown to anything that reads the contract.
 * They are ledgered rather than ignored precisely so the gap is countable.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/* ────────────────────────────── the ledgers ───────────────────────────────
 * Frozen 2026-08-30. All three may SHRINK freely — a stale entry is a failure,
 * so paginating one of these forces the line to be deleted. Growing one is a
 * decision somebody has to type out.
 * ─────────────────────────────────────────────────────────────────────────*/

/**
 * Documented GET routes that return an array and give the caller no bounded
 * page. Path form is exactly what the Hono route table prints.
 *
 * These were frozen, not triaged. A handful were read and are annotated in
 * `CAPPED_BELOW_THE_CONTRACT`; the rest are unexamined by design — inventing a
 * verdict for 75 handlers nobody opened would be worse documentation than
 * admitting the freeze. Before REMOVING one, read its handler; before adding a
 * new one, don't.
 */
const UNPAGED_LISTS: readonly string[] = [
  "/api/admin/adopt/tables",
  "/api/admin/advisor",
  "/api/admin/analytics/errors/:id",
  "/api/admin/analytics/event-names",
  "/api/admin/analytics/segments",
  "/api/admin/analytics/sites",
  "/api/admin/auth-hooks",
  "/api/admin/booking/resources",
  "/api/admin/cdc-sinks",
  "/api/admin/consent/policies",
  "/api/admin/consent/postures/suggested",
  "/api/admin/dashboards",
  "/api/admin/db/backups",
  "/api/admin/db/migrations",
  "/api/admin/documents/templates",
  "/api/admin/email-templates",
  "/api/admin/erasure",
  "/api/admin/erasure/surfaces",
  "/api/admin/forms",
  "/api/admin/forms/:id/invites",
  "/api/admin/forms/eligible-fields/:collection",
  "/api/admin/i18n",
  "/api/admin/integrations",
  "/api/admin/integrations/:id/listing/attributes",
  "/api/admin/integrations/:id/listing/categories",
  "/api/admin/integrations/:id/listing/lookup",
  "/api/admin/integrations/syncs",
  "/api/admin/integrations/syncs/:id/deliveries",
  "/api/admin/integrations/syncs/:id/listing/batches",
  "/api/admin/integrations/syncs/:id/listing/maps",
  "/api/admin/integrations/task-runs",
  "/api/admin/kpis",
  "/api/admin/oauth-clients",
  "/api/admin/oidc/providers",
  "/api/admin/panels",
  "/api/admin/payments/catalog",
  "/api/admin/payments/providers",
  "/api/admin/push-templates",
  "/api/admin/realtime-channels",
  "/api/admin/realtime/channels",
  "/api/admin/s3-credentials",
  "/api/admin/signing-keys",
  "/api/admin/sync-hooks",
  "/api/admin/tag-manager/sites/:siteId/compile",
  "/api/admin/tag-manager/sites/:siteId/tags",
  "/api/admin/tag-manager/sites/:siteId/triggers",
  "/api/admin/tag-manager/sites/:siteId/variables",
  "/api/admin/tag-manager/sites/:siteId/versions",
  "/api/admin/templates",
  "/api/admin/traces/:traceId",
  "/api/api-keys",
  "/api/api-keys/available-roles",
  "/api/app-orgs",
  "/api/app-orgs/:id/invites",
  "/api/app-orgs/:id/members",
  "/api/app-users/:id/sessions",
  "/api/collections",
  "/api/comments",
  "/api/device-tokens",
  "/api/extensions",
  "/api/extensions/enabled",
  "/api/flows",
  "/api/folders",
  "/api/functions",
  "/api/items/:slug/:id/transitions",
  "/api/phone-numbers",
  "/api/roles",
  "/api/roles/:id/permissions",
  "/api/shared-links",
  "/api/tenants",
  "/api/tenants/:id/members",
  "/api/uploads",
  "/api/users",
  "/api/users/:id/sessions",
  "/api/webhooks",
];

/**
 * A `limit` the caller controls with no ceiling on it is strictly worse than no
 * `limit` at all: the handler advertises the knob and then trusts whatever comes
 * through it. Exactly one route is on record here, and it does clamp — but in
 * the handler, where the published contract cannot say so
 * (`routes/db-admin.ts`: `Math.min(Math.max(Number(q.limit ?? 200), 1), 500)`,
 * declared as `limit: z.string().optional()`).
 *
 * This list is asserted by EQUALITY, not containment: a second one is a failure.
 */
const LIMIT_DECLARED_WITHOUT_CEILING: readonly string[] = ["/api/admin/db/tables"];

/**
 * GET routes that publish `schema: z.any()` (or no schema) for their 200, which
 * generates an empty `{}` in the document. The guard can read the path and the
 * parameters and then learns nothing at all about what comes back.
 *
 * This bucket is the reason the classifier was rewritten rather than shipped as
 * first drafted. The naive test — "does `\"type\":\"array\"` appear in the
 * response schema" — answered NO for every one of these and filed them under
 * "not a list", which is a guard passing because it matched nothing. At least
 * five are plainly list endpoints: `/api/admin/auth/sessions`, `/api/app-users`,
 * `/api/admin/saml/providers`, `/api/admin/platform-saml/providers` and
 * `/api/admin/third-party-auth/providers` all answer `{ data: [...] }` behind a
 * `z.any()`.
 *
 * No per-route verdict is claimed here, because none was checked for most of
 * them — the entry is the freeze, and the fix for all 25 is the same: give the
 * 200 response a real schema (`z.object({ data: z.array(Row) })`), at which
 * point this guard classifies it like everything else and the line comes out.
 */
const OPAQUE_RESPONSES: readonly string[] = [
  "/api/admin/ai-config",
  "/api/admin/auth/sessions",
  "/api/admin/db/backups/:id/download",
  "/api/admin/email-config",
  "/api/admin/feature-flags",
  "/api/admin/i18n/_matrix",
  "/api/admin/integrations/oauth/callback",
  "/api/admin/metrics/overview",
  "/api/admin/platform-ldap-config",
  "/api/admin/platform-saml/providers",
  "/api/admin/push-config",
  "/api/admin/saml/providers",
  "/api/admin/signatures/:id/document",
  "/api/admin/sms-config",
  "/api/admin/tag-manager/sites/:siteId/install",
  "/api/admin/tag-manager/vocabulary",
  "/api/admin/third-party-auth/providers",
  "/api/app-orgs/:id",
  "/api/app-users",
  "/api/items/:slug/:id/revisions",
  "/api/items/:slug/export",
  "/api/public/sign/:token/document",
  "/api/revisions/:collection/:itemId",
  "/api/storage/:key{.+}",
  "/api/workspace-config/asset/:kind",
];

/**
 * GET routes the OpenAPI document does not describe, because their sub-app is
 * not in `routes/openapi.ts`'s SUBAPPS list. The guard cannot read a response
 * shape it was never given, so each one is classified here by hand.
 *
 * The reasons are the point. "list, unpaged" ones are the same defect as
 * `UNPAGED_LISTS` — they are only in a separate ledger because the document
 * cannot see them, and registering the sub-app is the better fix.
 */
const UNDOCUMENTED_GETS: Record<string, string> = {
  "/.well-known/jwks.json":
    "JWKS document; the keys come from the instance's configured signing keys, never from tenant rows.",
  "/.well-known/oauth-authorization-server":
    "OAuth authorization-server metadata — one fixed object.",
  "/.well-known/oauth-authorization-server/api/auth":
    "The same metadata object under the issuer-path alias.",
  "/.well-known/oauth-protected-resource":
    "OAuth protected-resource metadata — one fixed object.",
  "/.well-known/oauth-protected-resource/mcp":
    "The same metadata object for the MCP resource.",
  "/.well-known/openid-configuration": "OIDC discovery metadata — one fixed object.",
  "/api/account/avatar/:userId": "One image body, for one user.",
  "/api/admin/mcp/count":
    "One integer: `allTools.length`, the size of the MCP catalog compiled into the bundle.",
  "/api/admin/migrate/runs": "List, unpaged — import runs. Same defect class as UNPAGED_LISTS.",
  "/api/admin/migrate/runs/:id": "One import run and its progress counters.",
  "/api/admin/migrate/sources":
    "List, unpaged — configured import sources. Same defect class as UNPAGED_LISTS.",
  "/api/admin/migrate/sources/:id/tables":
    "List, unpaged — the tables the external source exposes.",
  "/api/admin/schema/branches": "List, unpaged — schema branches.",
  "/api/admin/schema/branches/:id": "One schema branch and its diff.",
  "/api/admin/schema/snapshots": "List, unpaged — schema snapshots.",
  "/api/admin/schema/snapshots/:id": "One captured schema snapshot.",
  "/api/agents": "List, unpaged — configured agents.",
  "/api/agents/:id": "One agent definition and its config.",
  "/api/agents/:id/memory":
    "List, capped BELOW the route — see CAPPED_BELOW_THE_CONTRACT. `?limit` is read raw here and clamped in services/agents/memory.ts.",
  "/api/agents/:id/threads": "List, unpaged — one agent's threads.",
  "/api/agents/runs/:runId": "One agent run and its status.",
  "/api/agents/threads": "List, unpaged — threads in the workspace.",
  "/api/agents/threads/:threadId":
    "One thread — but its `messages` array is the whole transcript, unpaged.",
  "/api/analytics/script.js": "A static JavaScript asset.",
  "/api/analytics/tm/:file": "A static tag-manager asset.",
  "/api/auth/mcp/authorize": "OAuth authorize step — a redirect or a consent page.",
  "/api/auth/platform/sso/handoff": "A redirect into the platform SSO flow.",
  "/api/auth/saml/:slug/login": "A redirect to the configured IdP.",
  "/api/auth/saml/:slug/metadata": "One SAML metadata XML document.",
  "/api/consent/config": "One published consent-policy object.",
  "/api/extensions/:name/assets/*": "A static extension asset.",
  "/api/openapi.json": "The OpenAPI document itself.",
  "/api/openapi.yaml": "The same document as YAML.",
  "/api/payments/authorizenet/:id": "One hosted-payment bridge page.",
  "/api/payments/dummy/:token": "One stand-in checkout page.",
  "/api/realtime/:channel/subscribe":
    "An SSE stream, not a page; its replay window is bounded by /api/realtime/:channel/replay's own cap.",
  "/api/scim/v2/Groups":
    "SCIM list, paged by startIndex/count — capped BELOW the route, see CAPPED_BELOW_THE_CONTRACT.",
  "/api/scim/v2/Groups/:id": "One SCIM group resource.",
  "/api/scim/v2/ResourceTypes": "Fixed SCIM discovery document.",
  "/api/scim/v2/Schemas": "Fixed SCIM discovery document.",
  "/api/scim/v2/ServiceProviderConfig": "Fixed SCIM discovery document.",
  "/api/scim/v2/Users":
    "SCIM list, paged by startIndex/count — capped BELOW the route, see CAPPED_BELOW_THE_CONTRACT.",
  "/api/scim/v2/Users/:id": "One SCIM user resource, by id.",
  "/api/site/:file": "One static file from the bundled site.",
  "/api/t/:slug/agents": "List, unpaged — the app plane's view of the agents.",
  "/api/t/:slug/agents/threads": "List, unpaged — an end user's threads.",
  "/api/t/:slug/agents/threads/:threadId/messages": "List, unpaged — a whole transcript.",
  "/api/t/:slug/auth/invite/:token": "One workspace invite, by token.",
  "/api/t/:slug/auth/providers": "The auth providers configured for the workspace.",
  "/api/t/:slug/auth/saml/:providerSlug/login": "A redirect to the configured IdP.",
  "/api/t/:slug/auth/saml/:providerSlug/metadata": "One SAML metadata XML document.",
  "/api/t/:slug/orgs": "List, unpaged — the caller's organizations.",
  "/api/t/:slug/orgs/:orgId": "One organization the caller belongs to.",
  "/api/t/:slug/orgs/:orgId/invites": "List, unpaged — one org's open invites.",
  "/api/t/:slug/orgs/:orgId/members": "List, unpaged — one org's members.",
  "/api/t/:slug/orgs/invites/:token": "One organization invite, by token.",
  "/embed/form.js": "A static loader script for embedded forms.",
  "/health": "A liveness probe — one status object.",
  "/health/ready": "A readiness probe — one status object.",
};

/**
 * Routes whose ceiling exists but lives below the contract, so no amount of
 * reading the published spec can find it. Each names the file the clamp is in
 * and a fragment that must still be there.
 *
 * This half is a SOURCE SCAN — it reads the file as text and looks for the
 * clamp. It cannot tell whether the clamp is reached, only that it has not been
 * deleted. That is deliberately weaker than layers 2 and 3, and it is here
 * because the alternative (seeding 200+ rows through SCIM and the agent memory
 * pool per run) buys very little for what it costs.
 */
const CAPPED_BELOW_THE_CONTRACT: Record<string, { file: string; clamp: string }> = {
  "/api/admin/db/tables": {
    file: "apps/web/src/server/routes/db-admin.ts",
    clamp: "Math.min(Math.max(Number(q.limit ?? 200), 1), 500)",
  },
  "/api/agents/:id/memory": {
    file: "apps/web/src/server/services/agents/memory.ts",
    clamp: "Math.min(200, Math.max(1, opts.limit ?? 100))",
  },
  "/api/scim/v2/Users": {
    file: "apps/web/src/server/services/scim.ts",
    clamp: "Math.min(Math.max(opts.count ?? 100, 0), 200)",
  },
  "/api/scim/v2/Groups": {
    file: "apps/web/src/server/services/scim.ts",
    clamp: "Math.min(Math.max(opts.count ?? 100, 0), 200)",
  },
};

/* ─────────────────────────── inventory machinery ─────────────────────────── */

/** Repo root, from `apps/web/tests/` — four levels up. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");

/** A query parameter that decides how many rows come back. */
const PAGE_PARAM = /^(limit|count|page_?size|per_?page|take)$/i;

/**
 * One canonical spelling for a path, so the OpenAPI document and the Hono route
 * table can be compared. `{id}` and `:id` are the same route; `:key{.+}` (a Hono
 * regex param) is the same route as `{key}`; and the parameter's NAME is not
 * part of a route's identity, so every parameter collapses to `:p`.
 *
 * Order matters: the Hono modifier has to go first, or the `{…}` rule eats the
 * `{.+}` inside it and turns `/api/storage/:key{.+}` into a path that matches
 * nothing.
 */
const canon = (path: string): string =>
  path
    .replace(/:([A-Za-z0-9_]+)\{[^}]*\}/g, ":$1")
    .replace(/\{([^{}]+)\}/g, ":$1")
    .replace(/:[A-Za-z0-9_]+/g, ":p")
    .replace(/\/+$/, "");

interface OpenApiParam {
  in?: string;
  name?: string;
  schema?: { maximum?: unknown };
}
interface OpenApiOp {
  parameters?: OpenApiParam[];
  responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}
type SchemaNode = Record<string, unknown>;

/** How the guard sees one GET route. */
type Verdict =
  /** Declares a page parameter with a numeric ceiling — bounded by contract. */
  | { kind: "bounded"; max: number }
  /** Declares a page parameter with NO ceiling — the caller sets the row count. */
  | { kind: "uncapped-param" }
  /** Documented, and its 200 body is not an array — not a list endpoint. */
  | { kind: "not-a-list" }
  /** Documented, returns an array, offers no bounded page. */
  | { kind: "unpaged-list" }
  /** Documented, but the 200 schema is `z.any()` — the shape is unreadable. */
  | { kind: "opaque" }
  /** Not in the OpenAPI document at all — shape unknown to this guard. */
  | { kind: "undocumented" };

const pageParamOf = (op: OpenApiOp): OpenApiParam | undefined =>
  (op.parameters ?? []).find(
    (p) => p.in === "query" && typeof p.name === "string" && PAGE_PARAM.test(p.name),
  );

/**
 * Follow `$ref` into `components.schemas`.
 *
 * Needed because "is the body an array" cannot be answered from the path item
 * alone: the generator hoists named schemas, so `{ data: { $ref: FormResults } }`
 * is what a list endpoint often looks like on the wire. Depth-limited rather
 * than cycle-tracked — the schemas here are shallow, and a runaway ref should
 * fall out as "unreadable", not hang the suite.
 */
const deref = (
  node: unknown,
  schemas: Record<string, unknown>,
  depth = 0,
): SchemaNode | null => {
  if (!node || typeof node !== "object" || depth > 12) return null;
  const rec = node as SchemaNode;
  const ref = rec.$ref;
  if (typeof ref === "string") {
    const name = ref.split("/").pop() ?? "";
    return deref(schemas[name], schemas, depth + 1);
  }
  return rec;
};

/**
 * Does this 200 body hand back a collection?
 *
 * Two signals, OR-ed, because neither alone is right and the failure modes point
 * in opposite directions. (a) `"type":"array"` anywhere in the INLINE schema —
 * how the 75 known ones are written, and cheap. (b) the resolved `data` property
 * is an array — the same question asked through a `$ref`, which (a) cannot see.
 *
 * Deliberately NOT "an array anywhere in the RESOLVED schema": that reads
 * `/api/me`, `/api/admin/settings` and 32 others as list endpoints because an
 * object they return happens to carry a `roles: string[]` somewhere inside. A
 * ledger with 34 lies in it is a ledger nobody reads.
 */
const returnsCollection = (raw: unknown, schemas: Record<string, unknown>): boolean => {
  if (/"type":"array"/.test(JSON.stringify(raw ?? null))) return true;
  const root = deref(raw, schemas);
  if (!root) return false;
  if (root.type === "array") return true;
  const props = root.properties as SchemaNode | undefined;
  if (!props) return false;
  // SCIM answers `{ Resources: [...] }` rather than this API's `{ data }`.
  if ("Resources" in props) return true;
  return deref(props.data, schemas)?.type === "array";
};

/**
 * An empty schema object is what `z.any()` generates — no shape at all.
 *
 * Both places it can sit matter. `schema: z.any()` empties the whole body, and
 * `z.object({ data: z.any() })` empties only the envelope's payload — which is
 * the one that hides a list, e.g. `/api/items/{slug}/{id}/revisions` publishes
 * `{"type":"object","properties":{"data":{}}}` and returns every revision a row
 * has ever had.
 */
const isOpaque = (raw: unknown, schemas: Record<string, unknown>): boolean => {
  if (raw === undefined || raw === null) return true;
  const root = deref(raw, schemas);
  if (!root) return true;
  if (Object.keys(root).length === 0) return true;
  const props = root.properties as SchemaNode | undefined;
  if (!props || !("data" in props)) return false;
  const payload = deref(props.data, schemas);
  return !payload || Object.keys(payload).length === 0;
};

const classify = (op: OpenApiOp | undefined, schemas: Record<string, unknown>): Verdict => {
  if (!op) return { kind: "undocumented" };
  const page = pageParamOf(op);
  if (page) {
    const max = page.schema?.maximum;
    return typeof max === "number" ? { kind: "bounded", max } : { kind: "uncapped-param" };
  }
  const raw = op.responses?.["200"]?.content?.["application/json"]?.schema;
  if (returnsCollection(raw, schemas)) return { kind: "unpaged-list" };
  if (isOpaque(raw, schemas)) return { kind: "opaque" };
  return { kind: "not-a-list" };
};

interface Surface {
  /** Every distinct GET path the running app answers. */
  routes: string[];
  /** Canonical path → the documented GET operation. */
  doc: Map<string, OpenApiOp>;
  /** Route path → verdict. */
  verdicts: Map<string, Verdict>;
}

/**
 * Read the GET surface off the RUNNING app.
 *
 * `app.routes` is Hono's own registration table. It is not in Hono's public
 * types, hence the cast — but it is the only inventory that cannot be evaded by
 * forgetting to update a list, which is the whole point of using it.
 */
const readSurface = async (h: TestHarness): Promise<Surface> => {
  const res = await h.fetch("/api/openapi.json");
  if (res.status !== 200) {
    throw new Error(
      `GET /api/openapi.json answered ${res.status}. This guard reads the app's own ` +
        `document to learn each route's page contract; without it the inventory is blind, ` +
        `so this is a hard failure rather than a skip.`,
    );
  }
  const document = (await res.json()) as {
    paths?: Record<string, Record<string, OpenApiOp>>;
    components?: { schemas?: Record<string, unknown> };
  };
  const schemas = document.components?.schemas ?? {};

  const doc = new Map<string, OpenApiOp>();
  for (const [path, ops] of Object.entries(document.paths ?? {})) {
    const get = ops.get;
    if (get) doc.set(canon(path), get);
  }

  const table = (h.app as unknown as { routes?: { method: string; path: string }[] }).routes ?? [];
  const routes = [
    ...new Set(
      table.filter((r) => r.method.toUpperCase() === "GET").map((r) => r.path),
    ),
  ].sort();

  const verdicts = new Map<string, Verdict>();
  for (const path of routes) verdicts.set(path, classify(doc.get(canon(path)), schemas));

  return { routes, doc, verdicts };
};

/* ──────────────────────────────── the tests ──────────────────────────────── */

describe("list pagination — the inventory this guard runs on", () => {
  let h: TestHarness;
  let s: Surface;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // Deliberately a harness with NO collections: the OpenAPI document grows a
    // typed `/api/items/<slug>` path per collection, and those would read as
    // brand-new unledgered list endpoints. The data-driven describe below gets
    // its own harness for exactly this reason.
    s = await readSurface(h);
  });

  afterAll(() => h.cleanup());

  test("the GET surface is enumerable, and large enough to be the real one", () => {
    // Floors, not equalities — routes get added, and that must not fail here.
    // They exist so that an inventory which silently collapses to nothing (a
    // renamed `app.routes`, a broken document route) fails instead of passing
    // every later assertion vacuously.
    expect(s.routes.length).toBeGreaterThanOrEqual(200);
    expect(s.doc.size).toBeGreaterThanOrEqual(150);

    const counts = { bounded: 0, uncapped: 0, unpaged: 0, notList: 0, opaque: 0, undocumented: 0 };
    for (const v of s.verdicts.values()) {
      if (v.kind === "bounded") counts.bounded++;
      else if (v.kind === "uncapped-param") counts.uncapped++;
      else if (v.kind === "unpaged-list") counts.unpaged++;
      else if (v.kind === "not-a-list") counts.notList++;
      else if (v.kind === "opaque") counts.opaque++;
      else counts.undocumented++;
    }
    // Every route landed in exactly one bucket, and both buckets this file is
    // about are still reachable — if `classify` ever stopped recognising an
    // array response, every list would read as "not-a-list" and the ratchet
    // below would pass on an empty set.
    expect(
      counts.bounded +
        counts.uncapped +
        counts.unpaged +
        counts.notList +
        counts.opaque +
        counts.undocumented,
    ).toBe(s.routes.length);
    expect(counts.bounded).toBeGreaterThanOrEqual(15);
    // Deliberately 1 and not 75. Paginating these is the whole point, so a floor
    // that fails as they get fixed would be a guard punishing the work it exists
    // to prompt. Shrinkage is policed by the stale-ledger test instead, which
    // makes each fix delete its own line.
    expect(counts.unpaged).toBeGreaterThanOrEqual(1);
  });

  test("a list endpoint has a bounded page, or a line in the ledger", () => {
    const ledger = new Set(UNPAGED_LISTS);
    const uncapped = new Set(LIMIT_DECLARED_WITHOUT_CEILING);
    const opaque = new Set(OPAQUE_RESPONSES);
    const undocumented = new Set(Object.keys(UNDOCUMENTED_GETS));
    const offenders: string[] = [];

    for (const path of s.routes) {
      const v = s.verdicts.get(path);
      if (!v || v.kind === "bounded" || v.kind === "not-a-list") continue;
      if (v.kind === "unpaged-list" && !ledger.has(path)) {
        offenders.push(
          `GET ${path} returns an array and offers the caller no bounded page. ` +
            `Give it \`limit: z.coerce.number().int().min(1).max(N).optional()\` in ` +
            `request.query and clamp the handler with lib/pagination.ts's parsePagination — ` +
            `or, if its size is fixed by code rather than by tenant data, add it to ` +
            `UNPAGED_LISTS in this file and say which.`,
        );
      }
      if (v.kind === "uncapped-param" && !uncapped.has(path)) {
        offenders.push(
          `GET ${path} lets the caller choose the row count and puts no ceiling on it. ` +
            `Put \`.max(N)\` on the parameter's zod schema — a clamp inside the handler ` +
            `is invisible to every client and to this guard.`,
        );
      }
      if (v.kind === "opaque" && !opaque.has(path)) {
        offenders.push(
          `GET ${path} publishes \`z.any()\` (an empty schema) for its 200, so nothing can tell ` +
            `whether it hands back a collection — this guard included. Give the response a real ` +
            `schema, e.g. \`z.object({ data: z.array(Row) })\`, or add it to OPAQUE_RESPONSES.`,
        );
      }
      if (v.kind === "undocumented" && !undocumented.has(path)) {
        offenders.push(
          `GET ${path} is not in the OpenAPI document, so this guard cannot read what it ` +
            `returns. Three fixes, in order of preference: regenerate the committed spec ` +
            `(\`bun run --cwd apps/web gen:openapi-static\`) if the route is new; register its ` +
            `sub-app in routes/openapi.ts's SUBAPPS list if it was never described; or add it ` +
            `to UNDOCUMENTED_GETS here with a one-line reason it cannot return an unbounded ` +
            `collection.`,
        );
      }
    }

    expect(offenders).toEqual([]);
  });

  test("no ledger entry is stale — the ratchet only tightens", () => {
    const live = new Set(s.routes);
    const problems: string[] = [];

    for (const path of UNPAGED_LISTS) {
      const v = s.verdicts.get(path);
      if (!live.has(path)) {
        problems.push(`UNPAGED_LISTS names ${path}, which the app no longer serves — delete it.`);
      } else if (v && v.kind !== "unpaged-list") {
        problems.push(
          `UNPAGED_LISTS names ${path}, but it is now "${v.kind}". If it grew a bounded page ` +
            `that is the point of this file — delete the line.`,
        );
      }
    }
    for (const path of OPAQUE_RESPONSES) {
      const v = s.verdicts.get(path);
      if (!live.has(path)) {
        problems.push(
          `OPAQUE_RESPONSES names ${path}, which the app no longer serves — delete it.`,
        );
      } else if (v && v.kind !== "opaque") {
        problems.push(
          `OPAQUE_RESPONSES names ${path}, but its 200 now has a real schema and reads as ` +
            `"${v.kind}". Delete the line — it is classified properly now.`,
        );
      }
    }
    for (const path of Object.keys(UNDOCUMENTED_GETS)) {
      const v = s.verdicts.get(path);
      if (!live.has(path)) {
        problems.push(
          `UNDOCUMENTED_GETS names ${path}, which the app no longer serves — delete it.`,
        );
      } else if (v && v.kind !== "undocumented") {
        problems.push(
          `UNDOCUMENTED_GETS names ${path}, but the OpenAPI document now describes it as ` +
            `"${v.kind}". Delete the line; the document classifies it now.`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  test("the committed spec describes no GET route the app has stopped serving", () => {
    // The document is a build artifact, not a live read (see the header). A path
    // it still describes but the router no longer answers means the artifact has
    // fallen behind the code — at which point every classification above is
    // being made against yesterday's contract.
    const live = new Set(s.routes.map(canon));
    const orphans = [...s.doc.keys()].filter((p) => !live.has(p));
    expect(orphans).toEqual([]);
  });

  test("exactly one route declares a page size with no ceiling", () => {
    const found = s.routes.filter((p) => s.verdicts.get(p)?.kind === "uncapped-param").sort();
    // Equality, not containment. A `limit` the caller sets and nothing bounds is
    // the worst shape on this whole surface, so a second one is a failure even
    // though the ledger above would also have caught it.
    expect(found).toEqual([...LIMIT_DECLARED_WITHOUT_CEILING].sort());
  });

  test("every hand-classified route carries a reason somebody had to write", () => {
    const thin = Object.entries(UNDOCUMENTED_GETS)
      .filter(([, why]) => why.trim().length < 24)
      .map(([path]) => path);
    expect(thin).toEqual([]);
  });

  test("the ledgers do not overlap or repeat themselves", () => {
    expect(UNPAGED_LISTS.length).toBe(new Set(UNPAGED_LISTS).size);
    expect(OPAQUE_RESPONSES.length).toBe(new Set(OPAQUE_RESPONSES).size);
    const others = new Set([...Object.keys(UNDOCUMENTED_GETS), ...OPAQUE_RESPONSES]);
    expect(UNPAGED_LISTS.filter((p) => others.has(p))).toEqual([]);
    expect(OPAQUE_RESPONSES.filter((p) => p in UNDOCUMENTED_GETS)).toEqual([]);
  });

  test("the ceilings that live below the contract have not been deleted", () => {
    // SOURCE SCAN, and it is the weakest check in this file: it proves the clamp
    // is still written down, not that it runs. It earns its place because these
    // four are the only routes whose ceiling no contract can express, and a
    // silent deletion would otherwise leave the ledger describing a cap that is
    // gone.
    const missing: string[] = [];
    for (const [path, { file, clamp }] of Object.entries(CAPPED_BELOW_THE_CONTRACT)) {
      const abs = resolve(REPO_ROOT, file);
      if (!existsSync(abs)) {
        missing.push(`${path}: ${file} does not exist — the clamp moved, so update this entry.`);
        continue;
      }
      if (!readFileSync(abs, "utf8").includes(clamp)) {
        missing.push(
          `${path}: ${file} no longer contains \`${clamp}\`. Either the ceiling was removed — ` +
            `in which case this route now returns everything — or it moved and this entry needs ` +
            `to follow it.`,
        );
      }
      // A route can only be capped below the contract if the contract does not
      // cap it; if it grew a real one, this entry is dead weight.
      const v = s.verdicts.get(path);
      if (v?.kind === "bounded") {
        missing.push(`${path} now declares max=${v.max} in its contract — drop this entry.`);
      }
    }
    expect(missing).toEqual([]);
    expect(Object.keys(CAPPED_BELOW_THE_CONTRACT).length).toBeGreaterThan(0);
  });
});

describe("list pagination — a declared ceiling is enforced, not documentation", () => {
  let h: TestHarness;
  let s: Surface;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    s = await readSurface(h);
  });

  afterAll(() => h.cleanup());

  /** Bounded endpoints that can be driven as-is — no path parameter to invent. */
  const driveable = (surface: Surface): { path: string; max: number }[] =>
    surface.routes
      .filter((p) => !p.includes(":") && !p.includes("*"))
      .flatMap((path) => {
        const v = surface.verdicts.get(path);
        return v?.kind === "bounded" ? [{ path, max: v.max }] : [];
      });

  test("asking for one row past the declared maximum is refused", async () => {
    const targets = driveable(s);
    // Non-vacuous by construction: if the sweep ever finds nothing to drive —
    // a renamed parameter, a document that stopped publishing `maximum` — this
    // fails here rather than passing with an empty loop.
    expect(targets.length).toBeGreaterThanOrEqual(12);

    const bad: string[] = [];
    for (const { path, max } of targets) {
      const res = await h.fetch(`${path}?limit=${max + 1}`);
      if (res.status >= 400 && res.status < 500) continue;
      bad.push(
        `GET ${path}?limit=${max + 1} answered ${res.status}. Its contract publishes ` +
          `maximum ${max}, so the ceiling is documentation only — the parameter is not being ` +
          `validated against the schema that was published.`,
      );
    }
    expect(bad).toEqual([]);
  }, 60_000);

  test("asking for exactly the declared maximum is not refused for asking", async () => {
    // The mirror of the test above: a ceiling that rejects its own maximum is
    // off by one, and "everything 422s" would otherwise pass the first test.
    const bad: string[] = [];
    for (const { path, max } of driveable(s)) {
      const res = await h.fetch(`${path}?limit=${max}`);
      if (res.status !== 422) continue;
      const body = await res.text();
      if (!/"limit"/.test(body)) continue; // 422 for some other reason is fine here.
      bad.push(`GET ${path}?limit=${max} was rejected at its own maximum: ${body.slice(0, 160)}`);
    }
    expect(bad).toEqual([]);
  }, 60_000);
});

describe("list pagination — bounded, and unbounded, with real rows in the table", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });

  afterAll(() => h.cleanup());

  test("a page cap holds against more rows than the page", async () => {
    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: "pages", fields: [{ name: "title", type: "text" }] }),
    });
    expect(made.status).toBe(201);

    // 60 rows: more than the 50-row default page, so "no ?limit" cannot pass by
    // accident on a table that fits inside one page.
    for (let i = 0; i < 60; i++) {
      const row = await h.fetch("/api/items/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: `row ${i}` }),
      });
      expect(row.status).toBe(201);
    }

    const bare = await h.fetch("/api/items/pages");
    expect(bare.status).toBe(200);
    const bareBody = (await bare.json()) as { data: unknown[]; limit: number; has_more: boolean };
    // Omitting `?limit` must mean "one page", never "all of it".
    expect(bareBody.data.length).toBe(50);
    expect(bareBody.limit).toBe(50);
    expect(bareBody.has_more).toBe(true);

    const asked = await h.fetch("/api/items/pages?limit=10");
    const askedBody = (await asked.json()) as { data: unknown[]; limit: number };
    expect(askedBody.data.length).toBe(10);
    expect(askedBody.limit).toBe(10);

    // And the ceiling is the caller's hard stop, not a suggestion.
    const greedy = await h.fetch("/api/items/pages?limit=100000");
    expect(greedy.status).toBe(422);
  }, 120_000);

  test("an UNPAGED_LISTS entry really does hand back every row", async () => {
    // The ledger claims 75 endpoints ship whatever is in the table. That claim
    // is demonstrated here on one of them rather than only asserted, so the
    // ledger is a description of behaviour and not a list of names.
    const N = 55; // past any plausible default page size.
    for (let i = 0; i < N; i++) {
      const res = await h.fetch("/api/folders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: `folder ${i}` }),
      });
      expect(res.status).toBe(201);
    }

    const res = await h.fetch("/api/folders");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data.length).toBe(N);
    // If this ever returns fewer than N, /api/folders grew a page — which is the
    // outcome this whole file is asking for. Delete its UNPAGED_LISTS line and
    // rewrite this test against whatever bound it now has.
  }, 120_000);
});
