/**
 * Whether a subsystem reaches GraphQL is a decision, and this is where it is
 * written down — plus the half the older ledgers leave out.
 *
 * `sdk-surfaces.test.ts` answers the same question for the SDK, keyed by MCP
 * tool module, and the sixty-six `*-surfaces.test.ts` files answer it per
 * feature. Between them the repository has a thorough NAME-level ledger and no
 * mechanical statement that any of those names DO anything. That gap is not
 * theoretical: on this branch alone four surfaces returned 2xx and did nothing
 * — MCP `users.invite` accepted a `roleName` it never read, MCP
 * `tenants.switch` accepted `{tenantId}` when the handler wanted `{tenant}`,
 * MCP settings accepted `brandName`/`flags` it dropped, and an admin menu item
 * called `pushToast` and issued no request. A ledger that compares one surface
 * to another passes on every one of them.
 *
 * So this file is three checks stacked, weakest first, and it says out loud
 * which is which:
 *
 *   1. NAME parity   — `GRAPHQL_SURFACES` answers for every MCP tool module,
 *                      both directions, the way `MCP_SURFACES` does.
 *   2. MOUNTING      — every field record a module exports is spread into BOTH
 *                      schema branches AND is present in the schema a live
 *                      request introspects. A module that exists, compiles and
 *                      is never assembled is exactly the shape of a surface
 *                      that "exists" and cannot be called.
 *   3. ARGUMENTS ARE READ — for every field the live schema declares, each
 *                      argument name must be referenced by that field's
 *                      resolver, or the resolver must hand `args` on whole.
 *                      This is the check that fails on `roleName`.
 *
 * The third one has a known blind spot and it is stated rather than hidden: a
 * resolver that forwards `args` wholesale is opaque to a source scan, so the
 * scan cannot tell whether the callee reads a field or drops it. The fourth
 * section closes it for a sample — three mutations whose arguments are ALL in
 * that blind spot are executed for real and the values are read back through
 * REST, a different surface, so a 2xx that stored nothing fails.
 *
 * The scans are source scans (Bun's regexes over the file text, plus a small
 * brace matcher), not compiler-API parses: `typescript` here is 7.0's Go port
 * and ships no compiler API. Every scan is bounded below by the sanity test —
 * a regex that silently stops matching empties the list it feeds, and an
 * assertion over an empty list is a green tick for work nobody did.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { OPEN_WAVE } from "./surfaces-wave";

const REPO = join(import.meta.dir, "..", "..", "..");
const GQL_DIR = join(REPO, "apps", "web", "src", "server", "services", "graphql");
const MCP_DIR = join(REPO, "apps", "web", "src", "server", "mcp", "tools");

const read = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// A small source scanner — enough to walk object literals without a parser
// ---------------------------------------------------------------------------

/**
 * If a string, template literal or comment starts at `i`, the index just past
 * it; otherwise -1.
 *
 * Brace counting without this is wrong in this codebase specifically: field
 * descriptions carry `{slug}` and `{id}` inside quotes, and several resolvers
 * build template literals. A naive counter closes the object early and the
 * scan then reports fewer fields than exist — which reads as "nothing to
 * check" rather than as a failure.
 */
const skipAt = (src: string, i: number): number => {
  const c = src[i];
  const n = src[i + 1];
  if (c === "/" && n === "/") {
    const e = src.indexOf("\n", i);
    return e === -1 ? src.length : e;
  }
  if (c === "/" && n === "*") {
    const e = src.indexOf("*/", i + 2);
    return e === -1 ? src.length : e + 2;
  }
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  if (c === "`") {
    let j = i + 1;
    let depth = 0;
    while (j < src.length) {
      const t = src[j];
      if (t === "\\") {
        j += 2;
        continue;
      }
      if (t === "$" && src[j + 1] === "{") {
        depth += 1;
        j += 2;
        continue;
      }
      if (t === "}" && depth > 0) {
        depth -= 1;
        j += 1;
        continue;
      }
      if (t === "`" && depth === 0) break;
      j += 1;
    }
    return j + 1;
  }
  return -1;
};

/** The `key: value` entries one level inside the object literal whose `{` is
 *  at `open`. `start`/`end` bound the value text. */
const objectEntries = (
  src: string,
  open: number,
): { key: string; start: number; end: number }[] => {
  const out: { key: string; start: number; end: number }[] = [];
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const skipped = skipAt(src, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const c = src[i] as string;
    if (c === "{" || c === "[" || c === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === "}" || c === "]" || c === ")") {
      depth -= 1;
      if (depth === 0) return out;
      i += 1;
      continue;
    }
    if (depth === 1) {
      const m = /^(\w+)\s*:/.exec(src.slice(i, i + 80));
      // `!/[\w$.]/` so `foo.bar:` and the tail of a longer identifier are not
      // read as a fresh key.
      if (m && !/[\w$.]/.test(src[i - 1] ?? "")) {
        let j = i + (m[0] as string).length;
        while (j < src.length && /\s/.test(src[j] ?? "")) j += 1;
        const vstart = j;
        let vdepth = 0;
        while (j < src.length) {
          const sk = skipAt(src, j);
          if (sk !== -1) {
            j = sk;
            continue;
          }
          const ch = src[j] as string;
          if (ch === "{" || ch === "[" || ch === "(") vdepth += 1;
          else if (ch === "}" || ch === "]" || ch === ")") {
            if (vdepth === 0) break;
            vdepth -= 1;
          } else if (ch === "," && vdepth === 0) break;
          j += 1;
        }
        out.push({ key: m[1] as string, start: vstart, end: j });
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out;
};

// ---------------------------------------------------------------------------
// What the source says GraphQL offers
// ---------------------------------------------------------------------------

type SourceField = {
  /** `services/graphql/<module>.ts` */
  module: string;
  /** `advisorQueryFields` etc. */
  record: string;
  /** The schema field name, e.g. `createWebhook`. */
  name: string;
  /** The text of the `resolve:` value. */
  resolver: string;
};

const gqlModules = readdirSync(GQL_DIR)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.slice(0, -3));

const sourceFields: SourceField[] = [];
/** Module → the field-record names it exports. Modules with none (`core`,
 *  `index`, `cost`) are helpers and are excluded by what they CONTAIN, never
 *  by name — a real surface must not be able to hide behind a filename. */
const recordsOf = new Map<string, string[]>();

for (const mod of gqlModules) {
  const src = read(join(GQL_DIR, `${mod}.ts`));
  for (const m of src.matchAll(/^export const (\w+(?:Query|Mutation)Fields)[^=]*=\s*\{/gm)) {
    const record = m[1] as string;
    recordsOf.set(mod, [...(recordsOf.get(mod) ?? []), record]);
    const open = (m.index ?? 0) + (m[0] as string).length - 1;
    for (const field of objectEntries(src, open)) {
      const body = src.slice(field.start, field.end);
      const parts = objectEntries(body, body.indexOf("{"));
      const resolvePart = parts.find((p) => p.key === "resolve");
      sourceFields.push({
        module: mod,
        record,
        name: field.key,
        resolver: resolvePart ? body.slice(resolvePart.start, resolvePart.end) : "",
      });
    }
  }
}

const fieldModules = [...recordsOf.keys()].sort();
const byFieldName = new Map(sourceFields.map((f) => [f.name, f]));

const mcpModules = readdirSync(MCP_DIR)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .map((f) => ({ name: f.slice(0, -3), src: read(join(MCP_DIR, f)) }))
  .filter((m) => /^\s*name: "/m.test(m.src))
  .map((m) => m.name);

// ---------------------------------------------------------------------------
// Registry — how GraphQL answers for every MCP tool module
// ---------------------------------------------------------------------------

/**
 * Exactly one of `fields` / `generated` / `deferred` / `serverOnly`.
 *
 * `retiredBy` is what makes a deferral falsifiable, and it is REQUIRED on
 * every one. `sdk-surfaces.test.ts` learned this the expensive way: eight of
 * its twenty-three deferrals were written against a retirement check that
 * structurally could not fire on them, so they were promises no test could
 * ever call in. Here it is one of two forms, and both are checked against
 * reality rather than against this file:
 *
 *   `module:<name>`  — `services/graphql/<name>.ts` must not exist yet.
 *   `field:<name>`   — the LIVE schema must not offer a field of that name.
 *
 * The `field:` form has a limit worth stating: it fires only if whoever ships
 * the surface picks the name written here. `module:` has no such weakness and
 * is preferred wherever a whole module would be the answer; `field:` is used
 * only where the gap is a field on a module that already exists.
 */
type Coverage = {
  /** A `services/graphql/<name>.ts` module covers it. */
  fields?: string;
  /** The per-collection schema `index.ts` generates from `core.ts` covers it. */
  generated?: string;
  /** Not covered, on purpose, until the named wave. Needs real reasoning. */
  deferred?: string;
  /** Not covered and never will be — GraphQL is the wrong shape for it. */
  serverOnly?: string;
  /** Field names the covering module does NOT offer yet. Each must still be
   *  absent from the live schema, so an entry cannot outlive its own gap. */
  missing?: string[];
  /** `wave-N` or `wave-N-phase-M`. Required by `deferred` and by `missing`. */
  until?: string;
  /** What would retire a deferral. See above. Required by `deferred`. */
  retiredBy?: string;
};

/**
 * The reason repeated most often, written once so the specific half of each
 * entry stays specific.
 *
 * It is a real argument rather than a placeholder: GraphQL's whole value is
 * selecting fields across related rows in one document. A subsystem whose
 * tools are single imperative acts with a one-shot result gains nothing from
 * being expressible in a query language, and costs a second schema surface to
 * keep in step with REST forever.
 */
const NOT_A_GRAPH = (what: string) =>
  `${what} is a single imperative act with a one-shot result, not a graph to traverse. GraphQL earns its keep when a caller selects fields across related rows in one document, and nothing here is ever selected alongside data — REST, MCP and the CLI all state it more plainly. Revisit if a caller ever wants it in the same document as the rows it affects.`;

const GRAPHQL_SURFACES: Record<string, Coverage> = {
  activity: {
    deferred:
      "The activity log is read by time window and actor, and its only consumer is the admin console's own timeline. Nothing selects an audit row alongside the data it describes, so a GraphQL field would be a second pagination surface over a table REST already pages.",
    until: "wave-21",
    retiredBy: "field:activityLog",
  },
  advisor: { fields: "advisor" },
  agents: { fields: "agents" },
  ai: {
    deferred:
      "`ai.query`, `ai.suggest_schema` and `ai.import_csv` reshape a workspace's data and schema from a prompt. That is an operator capability behind `requireAdmin`, and it is also non-deterministic and long-running — the two properties a query document, which clients cache and re-issue freely, is worst at carrying.",
    until: "wave-21",
    retiredBy: "field:aiQuery",
  },
  analytics: { fields: "analytics" },
  "api-keys": {
    deferred:
      "Key issuance returns the secret exactly once and never again. GraphQL responses are the ones clients log, cache and replay by construction, so minting a credential through this surface would spread it further than the REST route already does. The revocation half is cheap but is not worth a surface of its own.",
    until: "wave-21",
    retiredBy: "field:createApiKey",
  },
  "app-orgs": { fields: "app-orgs" },
  "app-users": {
    fields: "app-users",
    // Only `inviteAppUser` shipped. Listing end-users and editing their roles
    // are the admin half and have not been written.
    missing: ["appUsers", "setAppUserRoles", "updateAppUser"],
    until: "wave-21",
  },
  approvals: { fields: "approvals" },
  "auth-hooks": { fields: "auth-hooks" },
  backups: { fields: "backups" },
  booking: { fields: "booking" },
  bulk: { generated: "batch<Pascal> / bulkUpdate<Pascal>" },
  cdc: {
    deferred:
      "Change-data-capture sinks are configured once and then run themselves; the interesting surface is the delivery log, which is a time series rather than a graph. It lands with the rest of the multi-surface pass rather than on its own.",
    until: "wave-21",
    retiredBy: "module:cdc",
  },
  channels: { fields: "channels" },
  collections: { generated: "<slug> / <slug>Page / create<Pascal> / update<Pascal>" },
  comments: {
    deferred:
      "Comments hang off an item, which is the one thing GraphQL would genuinely improve — reading a row and its thread in one document. That makes it a schema-design question (a comments field on every generated collection type) rather than a module to port, and it is deferred as design work, not as typing.",
    until: "wave-21",
    retiredBy: "module:comments",
  },
  consent: { fields: "consent" },
  dashboards: { fields: "dashboards" },
  db: {
    deferred:
      "`db.execute_sql` hands over arbitrary SQL against the workspace's own database. It is an operator capability reached from a trusted terminal; putting it behind a query language a browser can post to widens who can reach it for no gain the CLI does not already give.",
    until: "wave-21",
    retiredBy: "field:executeSql",
  },
  documents: { fields: "documents" },
  email: {
    deferred:
      "`email.normalize` answers what one address canonicalises to. The collection write path already normalises on the way in, so the tool exists for a human checking a value by hand — which is what the CLI and MCP are for.",
    until: "wave-21",
    retiredBy: "field:normalizeEmails",
  },
  embedding: {
    deferred:
      "Writing an embedding is a bulk maintenance act against a vector index, measured in thousands of rows and minutes. A GraphQL mutation would have to either block a request for the duration or invent a job handle, and the jobs surface is itself not on the schema yet.",
    until: "wave-21",
    retiredBy: "field:upsertEmbedding",
  },
  extensions: { fields: "extensions" },
  "feature-flags": {
    deferred:
      "Flags are read on nearly every request by the runtime itself, through a cache rather than a query. A GraphQL field would be a third read path for a value whose whole design is to be resolved without a round trip.",
    until: "wave-21",
    retiredBy: "module:flags",
  },
  flows: { fields: "flows" },
  folders: {
    deferred:
      "Folders are the storage plane's tree, and the storage module reached the schema as a flat file list first because that is what the admin file browser asks for. Nesting is the natural second half and is genuinely just not written yet.",
    until: "wave-21",
    retiredBy: "module:folders",
  },
  forms: { fields: "forms" },
  functions: {
    deferred:
      "Invoking a sandboxed function from a browser-reachable surface is a security design question — what the sandbox may reach on behalf of an unattended caller — and not one to settle as a side effect of adding a schema field.",
    until: "wave-21",
    retiredBy: "module:functions",
  },
  geo: {
    deferred:
      "One-off geocoding is a call to a third-party provider with its own quota and latency. Putting it behind a field that a client may request once per row in a list is how a page of fifty rows becomes fifty upstream calls; the backfill verb exists precisely so it happens in bulk, off the read path.",
    until: "wave-21",
    retiredBy: "field:geocode",
  },
  graphql: {
    serverOnly:
      "`graphql.execute` is the MCP tool that FORWARDS a document to this endpoint. A GraphQL field for executing GraphQL is the transport describing itself, and would be one more layer for a caller who is already holding the thing it wraps.",
  },
  integrations: { fields: "integrations" },
  "items-publish": {
    deferred:
      "Draft/publish is half-generated already: `verify<Pascal>` and `<slug>Transitions` are built per collection from `core.ts`, while publish, unpublish, archive and the two scheduling verbs are not. Finishing it means deciding whether they are generated per collection like the rest of the item surface or a collection-generic mutation like `retireItem` — a shape question, and the wrong one to answer twice.",
    until: "wave-21",
    retiredBy: "field:publishItem",
  },
  jobs: {
    deferred:
      "The durable queue's surface is enqueue plus a status poll. Polling is what the realtime channel exists to replace, and a GraphQL field that a client re-issues on a timer is the shape this repo already decided against for job status.",
    until: "wave-21",
    retiredBy: "module:jobs",
  },
  kpis: { fields: "kpis" },
  migrate: { fields: "migrate" },
  notifications: {
    // `messaging.ts` covers the push/SMS dispatch half of this module. The
    // in-app bell — list, send, mark read — has no fields.
    fields: "messaging",
    missing: ["notifications", "sendNotification", "markNotificationsRead"],
    until: "wave-21",
  },
  oauth: {
    deferred:
      "The OAuth client registry is read by the authorization endpoint itself, not by an application: a client that could query its own registration is one that already holds its credentials. Registration is a one-time operator act at a terminal.",
    until: "wave-21",
    retiredBy: "module:oauth",
  },
  order: { fields: "order" },
  payments: { fields: "payments" },
  permissions: {
    // `permission-sim.ts` ships `permissionSimulation`. Granting and revoking
    // are the write half and have no fields.
    fields: "permission-sim",
    missing: ["grantPermission", "revokePermission", "rolePermissions"],
    until: "wave-21",
  },
  phone: {
    deferred:
      "`phone.normalize` answers what one number canonicalises to in E.164. The collection write path already normalises on the way in, so the tool exists for a human checking a value by hand, which is what the CLI and MCP are for.",
    until: "wave-21",
    retiredBy: "field:normalizePhones",
  },
  retirement: { fields: "retirement" },
  revisions: {
    deferred:
      "Revisions are the other half of the comments question: a row's history read alongside the row is the document GraphQL would genuinely improve, and bolting it on as a flat list keyed by item id would freeze the weaker shape. Deferred as design, not as typing.",
    until: "wave-21",
    retiredBy: "module:revisions",
  },
  rls: { fields: "rls" },
  roles: {
    deferred:
      NOT_A_GRAPH("Creating a role and binding it to a user"),
    until: "wave-21",
    retiredBy: "module:roles",
  },
  s3: {
    deferred:
      "S3 credentials exist so that rclone, aws-cli and mc can reach a workspace. Their consumers are those binaries, and none of them speaks GraphQL; the credential is minted once at a terminal and pasted into a config file.",
    until: "wave-21",
    retiredBy: "module:s3",
  },
  saml: {
    deferred:
      "SAML provider configuration is XML metadata and certificates pasted once per identity provider. It is read by the SSO handshake, never by an application, and the admin console is its only editor.",
    until: "wave-21",
    retiredBy: "module:saml",
  },
  "schema-admin": {
    deferred:
      "DDL over GraphQL is partly here already and by accident: `schemaApply` in `schema-versions.ts` applies a diff, which creates and drops columns. Adding create/update/drop-collection fields beside it would make two ways to reach the same applier, and the one that exists is the one with a plan to review first.",
    until: "wave-21",
    retiredBy: "field:createCollection",
  },
  "schema-versions": { fields: "schema-versions" },
  schema: {
    serverOnly:
      "`schema.list_collections` and `schema.describe_collection` are introspection, and GraphQL answers introspection natively: `__schema` and `__type` are generated from the same collection metadata these tools read. A hand-written second introspection surface would be a shape to keep in step with the generated one forever, and it would be the stale one.",
  },
  settings: {
    deferred:
      "Workspace settings are a whitelisted key-value document read once at boot by the admin console. There is no graph in it, and the surface that edits it is the one screen that already does.",
    until: "wave-21",
    retiredBy: "field:workspaceSettings",
  },
  "shared-links": {
    deferred:
      "A shared link is minted so that someone WITHOUT a session can read one thing. Its consumer is a browser following a URL, not a client composing a query, and the token is deliberately printed once rather than made queryable.",
    until: "wave-21",
    retiredBy: "module:shared-links",
  },
  signatures: { fields: "signatures" },
  "signing-keys": {
    deferred:
      "The signing-key lifecycle — standby, in use, revoked — is operated deliberately, one key at a time, and its public half is already served at `/.well-known/jwks.json` for the resource servers that verify tokens. Neither audience wants a query language.",
    until: "wave-21",
    retiredBy: "module:signing-keys",
  },
  slug: { fields: "slug" },
  storage: {
    fields: "storage",
    // The metadata plane (list, rename, delete) shipped. Upload is multipart
    // and signing is a redirect; neither fits a JSON POST body.
    missing: ["uploadFile", "signFileUrl"],
    until: "wave-21",
  },
  support: {
    deferred:
      "Impersonation is the most audited act in the product and captcha configuration guards the front door. Both are reached from the admin console with a confirmation gate in front, and a field that makes either one call away is a step in the wrong direction.",
    until: "wave-21",
    retiredBy: "module:support",
  },
  "sync-hooks": { fields: "sync-hooks" },
  templates: { fields: "templates" },
  tenants: {
    deferred:
      "Who administers a workspace is the one surface an application-plane session must never reach. The REST routes are behind membership-rank checks that only make sense with a control-plane session, and a schema field for them would answer 403 for every caller that has a reason to hold a GraphQL client.",
    until: "wave-21",
    retiredBy: "module:tenants",
  },
  "third-party-auth": {
    deferred:
      "Trusting an external JWT issuer is a one-time operator decision with a JWKS URL and an audience. It is read by the token verifier on every request through a cache, never by an application, and there is no graph in three fields.",
    until: "wave-21",
    retiredBy: "module:third-party-auth",
  },
  uploads: {
    deferred:
      "Resumable uploads are TUS: a protocol of `HEAD`/`PATCH` with byte offsets in headers. Listing and abandoning a session is the small half of a surface whose main verb cannot be a JSON POST at all, so it stays where the protocol lives.",
    until: "wave-21",
    retiredBy: "module:uploads",
  },
  usage: { fields: "usage" },
  users: {
    deferred:
      "Administrator user management — invite, suspend, activate — is the control plane's own roster, and the same argument as `tenants` applies: every caller a GraphQL client is issued to would be refused it.",
    until: "wave-21",
    retiredBy: "module:users",
  },
  vector: {
    deferred:
      "Vector search takes an embedding or the text to embed, and returns rows by distance. It belongs on the generated per-collection surface next to `<slug>Search` rather than as a module of its own, and putting it anywhere else first would be the shape to undo later.",
    until: "wave-21",
    retiredBy: "field:vectorSearch",
  },
  webhooks: { fields: "webhooks" },
};

/**
 * Modules that answer for a subsystem with no MCP tools at all.
 *
 * `sdk-surfaces.test.ts` keeps a full `ROUTE_FAMILIES` table for this and it
 * is not duplicated here — one copy of a hundred-entry route ledger is enough,
 * and a second would drift. What this file needs is only the reverse
 * direction: every `services/graphql/*.ts` module that exports fields must be
 * claimed by SOME entry, or a brand-new module could ship unregistered.
 */
const NON_MCP_SURFACES: Record<string, Coverage> = {
  "route:/api/i18n": { fields: "i18n" },
};

const ALL_ENTRIES: [string, Coverage][] = [
  ...Object.entries(GRAPHQL_SURFACES).map(([k, v]) => [`mcp:${k}`, v] as [string, Coverage]),
  ...Object.entries(NON_MCP_SURFACES),
];

const UNTIL = /^wave-\d+(-phase-\d+)?$/;
const kindOf = (c: Coverage): string[] =>
  (["fields", "generated", "deferred", "serverOnly"] as const).filter((k) => c[k] !== undefined);

// ---------------------------------------------------------------------------
// How `index.ts` assembles the schema — read, not assumed
// ---------------------------------------------------------------------------

const indexSrc = read(join(GQL_DIR, "index.ts"));

/**
 * The two spread lists, one per branch.
 *
 * `buildSchema` returns EARLY when a workspace has no collections yet, and
 * that branch repeats the whole spread list. Two copies of a list is a drift
 * generator: a module added to one and not the other gives a workspace a
 * different schema depending on whether it has any collections, which is
 * invisible to every test that seeds one first.
 */
const spreadRegions = (() => {
  const emptyAt = indexSrc.indexOf("if (collections.length === 0)");
  const generatedAt = indexSrc.indexOf("const queryFields");
  const endAt = indexSrc.indexOf("const pageTypes");
  const empty = emptyAt === -1 || generatedAt === -1 ? "" : indexSrc.slice(emptyAt, generatedAt);
  const generated =
    generatedAt === -1 || endAt === -1 ? "" : indexSrc.slice(generatedAt, endAt);
  const spreads = (region: string, suffix: "QueryFields" | "MutationFields") =>
    new Set([...region.matchAll(new RegExp(`\\.\\.\\.(\\w+${suffix})`, "g"))].map((m) => m[1] as string));
  return {
    emptyQuery: spreads(empty, "QueryFields"),
    emptyMutation: spreads(empty, "MutationFields"),
    fullQuery: spreads(generated, "QueryFields"),
    fullMutation: spreads(generated, "MutationFields"),
  };
})();

// ---------------------------------------------------------------------------
// The live schema
// ---------------------------------------------------------------------------

let h: TestHarness;
/** Live field name → its declared argument names, from introspection. */
let liveFields = new Map<string, string[]>();
/** The slug seeded so the per-collection half of the schema is built too. */
const SLUG = "gqlsurf_widgets";
const GENERATED_TOKEN = "gqlsurfwidget";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const gql = async (query: string, variables?: unknown) =>
  (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
    data?: Record<string, any>;
    errors?: { message: string }[];
  };

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  // One collection, so `buildSchema` takes the branch that also generates the
  // per-collection fields. Introspecting the empty branch would leave every
  // `generated:` claim unproven.
  const created = await h.fetch(
    "/api/collections",
    json({ slug: SLUG, fields: [{ name: "title", type: "text" }] }),
  );
  expect(created.status).toBeLessThan(300);

  const res = await gql(
    `{ __schema {
        queryType { fields { name args { name } } }
        mutationType { fields { name args { name } } }
     } }`,
  );
  expect(res.errors).toBeUndefined();
  const shape = res.data?.__schema as {
    queryType: { fields: { name: string; args: { name: string }[] }[] };
    mutationType: { fields: { name: string; args: { name: string }[] }[] };
  };
  liveFields = new Map(
    [...shape.queryType.fields, ...shape.mutationType.fields].map((f) => [
      f.name,
      f.args.map((a) => a.name),
    ]),
  );
});

afterAll(() => h?.cleanup());

// ---------------------------------------------------------------------------

describe("GraphQL parity — the scans found the surfaces they police", () => {
  test("sanity: every list this file asserts over is non-trivially full", () => {
    // Without these, a regex that stopped matching would empty a list and turn
    // every assertion below into a green tick over nothing.
    expect(mcpModules.length).toBeGreaterThanOrEqual(60);
    expect(fieldModules.length).toBeGreaterThanOrEqual(30);
    expect(sourceFields.length).toBeGreaterThanOrEqual(200);
    expect(liveFields.size).toBeGreaterThanOrEqual(200);
    expect(spreadRegions.emptyQuery.size).toBeGreaterThanOrEqual(25);
    expect(spreadRegions.fullQuery.size).toBeGreaterThanOrEqual(25);
    expect(spreadRegions.emptyMutation.size).toBeGreaterThanOrEqual(30);
    expect(spreadRegions.fullMutation.size).toBeGreaterThanOrEqual(30);
    // Every scanned field must have a resolver; a field config without one is
    // a name in a schema that answers null.
    expect(sourceFields.filter((f) => f.resolver === "").map((f) => f.name)).toEqual([]);
  });

  test("every MCP tool module has an entry", () => {
    expect(mcpModules.filter((m) => !GRAPHQL_SURFACES[m])).toEqual([]);
  });

  test("no entry names an MCP module that no longer exists", () => {
    expect(Object.keys(GRAPHQL_SURFACES).filter((k) => !mcpModules.includes(k))).toEqual([]);
  });

  test("every GraphQL module that exports fields is claimed by an entry", () => {
    const claimed = new Set(ALL_ENTRIES.map(([, c]) => c.fields).filter(Boolean));
    expect(fieldModules.filter((m) => !claimed.has(m))).toEqual([]);
  });

  test("no entry claims a GraphQL module that exports nothing", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (!cov.fields) continue;
      expect(`${key} -> ${cov.fields} exports field records: ${recordsOf.has(cov.fields)}`).toBe(
        `${key} -> ${cov.fields} exports field records: true`,
      );
    }
  });
});

describe("GraphQL parity — every entry is well formed", () => {
  test("each entry answers in exactly one way", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      expect(`${key}: ${kindOf(cov).join("+") || "nothing"}`).toBe(`${key}: ${kindOf(cov)[0]}`);
    }
  });

  test("a deferral costs a real sentence, a wave, and something that retires it", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (cov.deferred === undefined) continue;
      // Sixty characters is roughly a clause; `TODO` and `later` cannot reach
      // it, so quieting this file takes prose a reviewer reads as an argument.
      expect(`${key}: ${cov.deferred.length}`).toBe(`${key}: ${Math.max(cov.deferred.length, 60)}`);
      expect(`${key}: ${UNTIL.test(cov.until ?? "")}`).toBe(`${key}: true`);
      // Shape is not enough: a wave that has already shipped reads exactly like
      // one that has not. See `surfaces-wave.ts` for the drift this caught.
      expect(`${key} defers to the open wave: ${cov.until}`).toBe(
        `${key} defers to the open wave: ${OPEN_WAVE}`,
      );
      expect(`${key} retiredBy: ${/^(module|field):[\w-]+$/.test(cov.retiredBy ?? "")}`).toBe(
        `${key} retiredBy: true`,
      );
    }
  });

  test("a permanent exclusion says why it is permanent and defers to nothing", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (cov.serverOnly === undefined) continue;
      expect(`${key}: ${cov.serverOnly.length}`).toBe(
        `${key}: ${Math.max(cov.serverOnly.length, 60)}`,
      );
      expect(cov.until).toBeUndefined();
      expect(cov.retiredBy).toBeUndefined();
    }
  });

  test("every `retiredBy` is a tripwire that can still fire", () => {
    // The failure this closes is the one `sdk-surfaces.test.ts` found in
    // itself: a deferral whose retirement condition was already true, or could
    // never become true, is a promise no test will ever call in.
    for (const [key, cov] of ALL_ENTRIES) {
      if (!cov.retiredBy) continue;
      const [kind, name] = cov.retiredBy.split(":") as [string, string];
      if (kind === "module") {
        expect(`${key} -> services/graphql/${name}.ts exists: ${gqlModules.includes(name)}`).toBe(
          `${key} -> services/graphql/${name}.ts exists: false`,
        );
      } else {
        expect(`${key} -> live schema offers ${name}: ${liveFields.has(name)}`).toBe(
          `${key} -> live schema offers ${name}: false`,
        );
      }
    }
  });

  test("a `missing` field is genuinely still missing", () => {
    for (const [key, cov] of ALL_ENTRIES) {
      if (!cov.missing) continue;
      expect(`${key}: ${cov.missing.length > 0}`).toBe(`${key}: true`);
      expect(`${key}: ${UNTIL.test(cov.until ?? "")}`).toBe(`${key}: true`);
      // Shape is not enough: a wave that has already shipped reads exactly like
      // one that has not. See `surfaces-wave.ts` for the drift this caught.
      expect(`${key} defers to the open wave: ${cov.until}`).toBe(
        `${key} defers to the open wave: ${OPEN_WAVE}`,
      );
      for (const name of cov.missing) {
        // When it lands this fails, and deleting the entry is how the phase
        // reports itself finished.
        expect(`${key}.${name} shipped: ${liveFields.has(name)}`).toBe(`${key}.${name} shipped: false`);
      }
    }
  });
});

describe("GraphQL parity — a claimed module is actually mounted", () => {
  test("both schema branches spread the same field records", () => {
    // Two copies of one list; a module added to one and not the other gives a
    // fresh workspace a different schema from a populated one.
    expect([...spreadRegions.emptyQuery].sort()).toEqual([...spreadRegions.fullQuery].sort());
    expect([...spreadRegions.emptyMutation].sort()).toEqual([...spreadRegions.fullMutation].sort());
  });

  test("every exported field record is spread into the schema", () => {
    for (const [mod, records] of recordsOf) {
      for (const record of records) {
        const where = record.endsWith("QueryFields")
          ? spreadRegions.fullQuery
          : spreadRegions.fullMutation;
        // Exported, imported and never spread is a module that compiles,
        // type-checks, is covered by its own unit test — and cannot be called.
        expect(`${mod}: ${record} is spread into the schema: ${where.has(record)}`).toBe(
          `${mod}: ${record} is spread into the schema: true`,
        );
      }
    }
  });

  test("every field the source declares is offered by a live schema", () => {
    // The behavioural half of the same statement: introspection is what a
    // caller sees, and it is built by running the real assembly path.
    const absent = sourceFields.filter((f) => !liveFields.has(f.name)).map((f) => `${f.module}.${f.name}`);
    expect(absent).toEqual([]);
  });

  test("every live field is either scanned or generated per collection", () => {
    // The other direction: a field the scan cannot see is a field the argument
    // check below silently skips, which is how a guard hollows out.
    const unknown = [...liveFields.keys()].filter(
      (name) =>
        !byFieldName.has(name) &&
        name !== "_empty" &&
        !name.toLowerCase().includes(GENERATED_TOKEN),
    );
    expect(unknown).toEqual([]);
  });
});

describe("GraphQL parity — a declared argument is an argument that is read", () => {
  /**
   * Arguments come from INTROSPECTION, not from the source.
   *
   * Several modules build their `args` by spreading a shared object
   * (`...resourceArgs`, `...siteArgs`), which a source scan of the args block
   * cannot see — and an argument the scan cannot see is one it cannot report
   * as dropped. The live schema has them all, already resolved.
   */
  const classify = () => {
    const named: string[] = [];
    const forwarded: { field: string; args: string[] }[] = [];
    const unread: string[] = [];
    for (const [name, args] of liveFields) {
      const field = byFieldName.get(name);
      if (!field || args.length === 0) continue;
      const body = field.resolver;
      const missing = args.filter((a) => !new RegExp(`\\b${a}\\b`).test(body));
      if (missing.length === 0) {
        named.push(name);
        continue;
      }
      // `args` handed on whole — `svc(ctx, args)`, `args as never`. The callee
      // may still drop a field, which a source scan cannot see; that blind
      // spot is what the round-trip section below exists to sample.
      const forwardsWhole = /\bargs\b(?!\s*\.)/.test(body.slice(body.indexOf("=>")));
      if (forwardsWhole) forwarded.push({ field: name, args: missing });
      else unread.push(`${field.module}.${name}: declares ${missing.join(", ")} and reads neither`);
    }
    return { named, forwarded, unread };
  };

  test("no field declares an argument its resolver neither reads nor forwards", () => {
    // This is the check that fails on the shape that shipped four times on
    // this branch: a surface that accepts a name and does nothing with it.
    expect(classify().unread).toEqual([]);
  });

  test("the check is not hollow: most fields are checked argument by argument", () => {
    const { named, forwarded } = classify();
    // A floor, so the guard cannot be defeated by refactoring resolvers into
    // wholesale forwarding — which would be legal, invisible, and would turn
    // every assertion above into a tautology.
    expect(named.length).toBeGreaterThanOrEqual(140);
    // And a ceiling on the blind spot, so it cannot grow quietly.
    expect(forwarded.length).toBeLessThanOrEqual(60);
  });

  test("every forwarding resolver really does forward", () => {
    for (const { field, args } of classify().forwarded) {
      const body = byFieldName.get(field)!.resolver;
      expect(`${field} (${args.join(",")}) hands args on: ${/\bargs\b/.test(body)}`).toBe(
        `${field} (${args.join(",")}) hands args on: true`,
      );
    }
  });
});

describe("GraphQL parity — the blind spot, closed by execution", () => {
  /**
   * Three mutations whose arguments are ALL invisible to the scan above:
   * each hands `args` to a service wholesale. They are run for real and the
   * values are read back through REST — a different surface, a different code
   * path — so "returned a row" is not mistaken for "stored what it was given".
   */

  test("createAnalyticsSite stores every argument it accepted", async () => {
    const res = await gql(
      `mutation($n:String!,$d:String!,$tz:String,$fb:Boolean){
         createAnalyticsSite(name:$n, domain:$d, tz:$tz, filterBots:$fb){ id name domain }
       }`,
      { n: "surfaces-site", d: "surfaces.example", tz: "Europe/Istanbul", fb: false },
    );
    expect(res.errors).toBeUndefined();
    const id = res.data?.createAnalyticsSite?.id as string;
    expect(id).toBeTruthy();

    const rest = (await (await h.fetch("/api/admin/analytics/sites")).json()) as {
      data: Record<string, any>[];
    };
    const row = rest.data.find((s) => s.id === id);
    expect(row, "the site GraphQL created is not readable over REST").toBeTruthy();
    expect(row!.name).toBe("surfaces-site");
    expect(row!.domain).toBe("surfaces.example");
    // The two that a `2xx` would happily lie about: both are optional, both
    // are spread in from `siteArgs`, and dropping either is invisible from the
    // mutation's own response.
    expect(row!.tz).toBe("Europe/Istanbul");
    expect(row!.filterBots).toBe(false);
  });

  test("createBookingResource stores every argument it accepted", async () => {
    const res = await gql(
      `mutation($k:String!,$n:String!,$d:String,$s:Int){
         createBookingResource(key:$k, name:$n, description:$d, slotMinutes:$s){
           resource { id key name }
         }
       }`,
      { k: "surfaces-room", n: "Surfaces Room", d: "written by a ledger", s: 45 },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.createBookingResource?.resource?.key).toBe("surfaces-room");

    const rest = (await (await h.fetch("/api/admin/booking/resources")).json()) as {
      data: Record<string, any>[];
    };
    const row = rest.data.find((r) => r.key === "surfaces-room");
    expect(row, "the resource GraphQL created is not readable over REST").toBeTruthy();
    expect(row!.name).toBe("Surfaces Room");
    // `description` and `slotMinutes` arrive through `...resourceArgs`, which
    // the source scan cannot even enumerate.
    expect(row!.description).toBe("written by a ledger");
    expect(row!.slotMinutes).toBe(45);
  });

  test("createAnalyticsSegment stores the definition it was given", async () => {
    const definition = { all: [{ prop: "path", op: "eq", value: "/pricing" }] };
    const res = await gql(
      `mutation($n:String!,$d:JSON!){ createAnalyticsSegment(name:$n, definition:$d){ id name } }`,
      { n: "surfaces-segment", d: definition },
    );
    expect(res.errors).toBeUndefined();
    const id = res.data?.createAnalyticsSegment?.id as string;
    expect(id).toBeTruthy();

    const rest = (await (await h.fetch("/api/admin/analytics/segments")).json()) as {
      data: Record<string, any>[];
    };
    const row = rest.data.find((s) => s.id === id);
    expect(row, "the segment GraphQL created is not readable over REST").toBeTruthy();
    expect(row!.name).toBe("surfaces-segment");
    // The whole point of a segment. A mutation that returned `{id, name}` and
    // stored `{}` would pass every name-level check in this repository.
    expect(row!.definition).toEqual(definition);
  });
});
