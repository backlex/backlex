/**
 * Whether a subsystem reaches the SDK is a decision, and this is where it is
 * written down.
 *
 * The measurement that produced this file: the SDK covers 36 subsystems and
 * the MCP tool registry covers 66, so **an AI agent can do more with a
 * workspace than the customer's own application can**. Crossing the missing
 * subsystems against `*-surfaces.test.ts` explained why, and the correlation
 * was total — every subsystem with a surfaces test has an SDK client, and
 * every subsystem without one does not. The surfaces test is not a check on
 * SDK coverage; it is the mechanism that PRODUCES it, and it was never
 * applied backwards to the subsystems that predate the convention.
 *
 * So the convention becomes structural. Two registries, and a new surface
 * cannot appear in either without someone answering for it:
 *
 *   MCP_SURFACES    — one entry per `mcp/tools/*.ts`. A new tool module with
 *                     no entry fails here, naming the file.
 *   ROUTE_FAMILIES  — one entry per `app.route()` mount in `app.ts`. The
 *                     MCP-keyed table structurally cannot see a subsystem
 *                     that has no MCP tools at all — `i18n` and `erasure` are
 *                     both real, both mounted, and both invisible to it.
 *
 * A `deferred` entry is how you say no. It costs a sentence of reasoning and
 * a wave to revisit it in, so declining to ship a client is a decision on the
 * record rather than a silence — and a one-word excuse cannot be dropped in
 * to quiet a failure, because the length is asserted.
 *
 * The scan style (read the source, match with anchored regexes, assert both
 * directions) is lifted from `sdk-module-boundary.test.ts`, which polices the
 * neighbouring rule that each domain lives in its own module.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..", "..");
const MCP_DIR = join(REPO, "apps", "web", "src", "server", "mcp", "tools");
const SDK_DIR = join(REPO, "packages", "client", "src");
const APP_TS = join(REPO, "apps", "web", "src", "server", "app.ts");
const TESTS_DIR = import.meta.dir;

const read = (p: string) => readFileSync(p, "utf8");

/** The body of one `export interface X { … }`, so a member search sees the
 *  surface a caller is handed and not every identifier in the file. */
const interfaceBody = (src: string, name: string): string => {
  // `[^{]*` so a generic parameter list (`CollectionClient<T extends …>`) is
  // read the same as a plain one.
  const start = src.search(new RegExp(`^export interface ${name}\\b[^{]*\\{`, "m"));
  if (start === -1) throw new Error(`no \`export interface ${name}\` to read`);
  return src.slice(start, src.indexOf("\n}", start));
};

/**
 * Every member a caller can reach from `name`, as dotted paths.
 *
 * A domain client may hand out a SUB-client — `FormsClient.public:
 * PublicFormFillClient` — and a member one level down is just as shipped as one
 * at the top. Reading only the named interface is how `missing: ["submit"]` sat
 * green while `forms.public.submit` had existed since `f944f1b4`: the regex
 * searched `FormsClient`, `submit` was on the sub-client, and a tripwire aimed
 * at something that cannot happen never fires.
 *
 * `seen` is copied down each branch rather than shared across siblings: it is
 * there to stop a self-referencing interface from recursing forever, and a
 * shared set would silently drop the second use of a type — which loosens the
 * check in exactly the direction that produced the bug.
 */
const reachableMembers = (src: string, name: string, seen: Set<string> = new Set()): Set<string> => {
  const out = new Set<string>();
  if (seen.has(name)) return out;
  const here = new Set(seen).add(name);
  const body = interfaceBody(src, name);
  for (const m of body.matchAll(/^ {2}(\w+)\??[(<:]/gm)) out.add(m[1]!);
  for (const m of body.matchAll(/^ {2}(\w+)\??:\s*(\w+Client)\b/gm)) {
    const [, field, type] = m as unknown as [string, string, string];
    if (!new RegExp(`^export interface ${type}\\b`, "m").test(src)) continue;
    for (const sub of reachableMembers(src, type, here)) out.add(`${field}.${sub}`);
  }
  return out;
};

/**
 * How one surface is answered for. Exactly one of `client` / `core` /
 * `deferred` / `serverOnly` is set.
 *
 * `missing` is the honest middle: a client exists but does not yet cover the
 * whole surface. Each named member must still be ABSENT — when it lands, this
 * file fails and the entry has to be deleted, so a phase cannot quietly finish
 * without retiring its own excuse.
 */
type Coverage = {
  /** A `packages/client/src/clients/<name>.ts` domain module covers it. */
  client?: string;
  /** A member of the assembled `BacklexClient` covers it (`from`, `subscribe`…). */
  core?: string;
  /** Not covered, on purpose, until the named wave. Needs real reasoning. */
  deferred?: string;
  /** Not covered and never will be — there is no client-side counterpart. */
  serverOnly?: string;
  /** Members of `client` that do not exist yet, with `until` naming the phase. */
  missing?: string[];
  /** `wave-N` or `wave-N-phase-M`. Required by `deferred` and by `missing`. */
  until?: string;
  /**
   * The `clients/<name>.ts` module whose arrival retires this deferral, when
   * the entry's own key cannot name it.
   *
   * The tripwire below derives the module from the key by stripping an `mcp:`
   * prefix, which works for every MCP entry and for NONE of the route-literal
   * ones — `route:/api/i18n` never equals a filename, so those deferrals sat
   * green no matter what shipped. This is how such an entry says what would
   * satisfy it, and the retirability assertion refuses a new one without it.
   */
  retiredBy?: string;
};

/** Reasons repeated across many entries, written once so each stays specific. */
const ADMIN_PLANE = (what: string) =>
  `${what} is an administrator surface: an app-plane session is refused most of it by design, and an SDK method that reliably returns 403 is worse than no method at all. Revisit if the app plane ever needs a narrowed form.`;

// ---------------------------------------------------------------------------
// Registry 1 — every MCP tool module
// ---------------------------------------------------------------------------

const MCP_SURFACES: Record<string, Coverage> = {
  activity: {
    deferred: ADMIN_PLANE("The activity log is the workspace's audit trail, and"),
    until: "wave-21",
  },
  advisor: { client: "advisor" },
  agents: { client: "agents" },
  ai: {
    deferred:
      "Wave 20 asked which AI surfaces an end user may reach and ANSWERED: agent chat, not raw generation. That shipped as `clients/agent-chat.ts` against `/api/t/:slug/agents`, where the operator writes the prompt, picks the tools and opts each agent in — so the injection surface and the spend stay theirs. These three tools are the surfaces that decision went AGAINST: `ai.query`, `ai.suggest_schema` and `ai.import_csv` reshape a workspace's data and schema from a prompt, which is an operator capability and stays `requireAdmin`. So nothing here is waiting on a decision any more; the only open question is whether an operator-mode client is worth writing at all.",
    until: "wave-21",
  },
  analytics: { client: "analytics" },
  "api-keys": { deferred: ADMIN_PLANE("Key issuance and revocation"), until: "wave-21" },
  "app-orgs": { client: "orgs" },
  "app-users": { client: "app-users" },
  approvals: { client: "approvals" },
  "auth-hooks": { client: "auth-hooks" },
  backups: { client: "backups" },
  booking: { client: "booking" },
  bulk: { core: "from" },
  cdc: { client: "cdc" },
  consent: { client: "consent" },
  channels: { client: "channels" },
  collections: { core: "from" },
  comments: { client: "comments" },
  dashboards: { client: "dashboards" },
  db: {
    deferred:
      "`db.execute_sql` hands over arbitrary SQL against the workspace's own database. That is an operator capability reached from a trusted terminal, not something an application's front end should be able to call with a captured session token.",
    until: "wave-21",
  },
  documents: { client: "documents" },
  email: { core: "from" },
  embedding: { client: "vector" },
  extensions: { client: "extensions" },
  "feature-flags": { client: "flags" },
  flows: { client: "flows" },
  folders: { client: "folders" },
  forms: { client: "forms" },
  functions: {
    deferred:
      "Invoking a sandboxed function straight from a browser is a security design question — what the sandbox may reach on behalf of an unattended caller — and not one to settle as a side effect of adding a client method.",
    until: "wave-21",
  },
  geo: {
    core: "from",
    // `backfillGeo` is on `CollectionClient`; one-off geocoding is not.
    missing: ["geocode", "reverse"],
    until: "wave-21",
  },
  graphql: {
    deferred:
      "The SDK's typed data surface is `from()`, and a raw GraphQL document is reachable through `client.request`. A first-class typed method would be a second data API to keep in step with the first, which is a wave-21 question.",
    until: "wave-21",
  },
  integrations: { client: "integrations" },
  "items-publish": { core: "from" },
  jobs: { client: "jobs" },
  kpis: { client: "kpis" },
  migrate: { client: "migrate" },
  // Two clients: `messaging` owns the push/SMS tools here, `notifications` the
  // in-app bell. Named for the latter because that is this module's own verb.
  notifications: { client: "notifications" },
  oauth: { client: "oauth-clients" },
  order: { core: "from" },
  payments: { client: "payments" },
  permissions: { client: "permissions" },
  phone: { core: "from" },
  retirement: { core: "from" },
  revisions: { client: "revisions" },
  rls: { client: "rls" },
  roles: { deferred: ADMIN_PLANE("Role creation and assignment"), until: "wave-21" },
  s3: { client: "s3" },
  saml: { deferred: ADMIN_PLANE("SAML provider configuration"), until: "wave-21" },
  schema: {
    deferred:
      "Listing and describing collections is schema introspection. Generated types are the SDK's answer to the same need and are checked at build time rather than fetched, so a runtime introspection method would be a second, weaker answer.",
    until: "wave-21",
  },
  "schema-admin": {
    deferred:
      "This module is split down the middle: `rollups_refresh` and `sequences_sync` reach the SDK as `refreshRollups` / `syncSequences` on `CollectionClient`, while the DDL half — create, update, drop, reindex — has no client. Schema authoring from an application is a wave-21 decision.",
    until: "wave-21",
  },
  "schema-versions": { client: "schema" },
  settings: { deferred: ADMIN_PLANE("Workspace settings"), until: "wave-21" },
  "shared-links": { client: "shared-links" },
  signatures: { client: "signatures" },
  "signing-keys": { client: "signing-keys" },
  slug: { core: "from" },
  storage: { client: "storage" },
  support: { client: "support" },
  "sync-hooks": { client: "sync-hooks" },
  templates: { client: "templates" },
  // The module grew from "list + switch" to the whole membership lifecycle —
  // role changes, ownership transfer, invite resend/revoke, eviction. That
  // makes the deferral MORE argued, not less: deciding who administers a
  // workspace is the one surface an app-plane session must never reach, and a
  // client method for it would return 403 for every caller the SDK has.
  tenants: {
    deferred: ADMIN_PLANE("Workspace listing, switching and membership administration"),
    until: "wave-21",
  },
  "third-party-auth": {
    deferred: ADMIN_PLANE("Trusted-issuer configuration"),
    until: "wave-21",
  },
  uploads: {
    client: "storage",
    // `uploadResumable` / `resumeUpload` exist; inspecting and abandoning an
    // upload someone else started does not.
    missing: ["abortUpload"],
    until: "wave-21",
  },
  usage: { client: "usage" },
  users: { deferred: ADMIN_PLANE("Administrator user management"), until: "wave-21" },
  vector: { client: "vector" },
  webhooks: { client: "webhooks" },
};

// ---------------------------------------------------------------------------
// Registry 2 — every mounted route family
// ---------------------------------------------------------------------------

/** Planes that are not application surfaces, and so owe no SDK answer. */
type Plane = "admin" | "internal" | "auth";

type Family = Coverage & { plane?: Plane };

const ADMIN: Family = { plane: "admin" };
const INTERNAL: Family = { plane: "internal" };

const ROUTE_FAMILIES: Record<string, Family> = {
  // Two routers, two answers. JWKS is fetched by whoever is verifying one of
  // our tokens — a resource server, not this SDK — and the OAuth discovery
  // documents are read by an MCP client's own machinery.
  "/.well-known → jwksRoutes": INTERNAL,
  "/.well-known → mcpOAuthWellKnownRoutes": INTERNAL,
  "/api": { core: "request" },
  "/api/_internal/sandbox-rpc": INTERNAL,
  "/api/account": {
    serverOnly:
      "Account preferences are the admin console's own state — list columns, locale and timezone for the operator UI. An application keeps its users' preferences in its own collections, so there is nothing here for a client to wrap. Was marked deferred-until-wave-21, but its own reasoning describes a permanent exclusion: no wave was ever going to change the answer.",
  },
  "/api/activity": MCP_SURFACES.activity!,
  "/api/agents": { client: "agents" },
  // Two sub-apps share this prefix, so the registry has to speak about each —
  // "a shared prefix is not a shared decision", as the derivation below puts it.
  "/api/analytics → analyticsIngestRoutes": { client: "analytics" },
  "/api/analytics → analyticsCollectRoutes": {
    serverOnly:
      "The collect endpoint, the script it serves, and the per-site tag-manager container all exist for the drop-in `<script>` tag, which is deliberately NOT the SDK: they are hand-written plain JS that ships to a customer's own domain, authenticate with nothing but a public site id, and post a text/plain body so `sendBeacon` never triggers a preflight. An SDK method here would need credentials the tag must not carry, and would reach endpoints that can only append or read a document already published to anonymous visitors. The parts an application would automate — registering a site, editing and publishing a container — are covered by `analytics.sites` and the tag-manager admin surface.",
  },
  "/api/api-keys": MCP_SURFACES["api-keys"]!,
  "/api/app-orgs": { client: "orgs" },
  "/api/app-users": { client: "app-users" },
  // Four routers share this prefix because ordering matters in front of
  // better-auth's catch-all; three of them are the auth surface the `auth`
  // client already serves, and the other two are not app-facing at all.
  "/api/auth → authPublicRoutes": { plane: "auth", client: "auth" },
  "/api/auth → authRoutes": { plane: "auth", client: "auth" },
  "/api/auth → mcpAuthorizeConsentGate": INTERNAL,
  "/api/auth → platformAuthRoutes": ADMIN,
  "/api/collections": MCP_SURFACES.schema!,
  "/api/comments": MCP_SURFACES.comments!,
  "/api/device-tokens": { client: "messaging" },
  "/api/email": { core: "from" },
  "/api/extensions": { client: "extensions" },
  "/api/flags": { client: "flags" },
  "/api/flows": { client: "flows" },
  "/api/folders": MCP_SURFACES.folders!,
  "/api/functions": MCP_SURFACES.functions!,
  "/api/geo": MCP_SURFACES.geo!,
  // One of the two subsystems the MCP-keyed registry structurally cannot see.
  "/api/i18n": {
    deferred:
      "Translating a workspace's own content is reached through the `locale` option on ordinary reads and writes, which every application already uses. The i18n routes administer the locale set itself, which is an operator concern.",
    until: "wave-21",
    retiredBy: "i18n",
  },
  "/api/integrations": { client: "integrations" },
  "/api/items": { core: "from" },
  "/api/jobs": { client: "jobs" },
  "/api/me": { client: "auth" },
  "/api/messaging": { client: "messaging" },
  "/api/notifications": MCP_SURFACES.notifications!,
  "/api/payments": { client: "payments" },
  "/api/permissions": { client: "permissions" },
  "/api/phone": { core: "from" },
  "/api/phone-numbers": { client: "messaging" },
  // Was `client: "approvals", missing: ["actOnToken"]` — an entry that DEMANDED
  // the member `clients/approvals.ts` deliberately refuses: "deciding is the
  // approver's act, authenticated by their link token and nothing else." Two
  // statements, one of them had to go, and the client's is the reasoned one.
  // Same shape and same reason as `/api/public/sign`.
  "/api/public/approve": {
    serverOnly:
      "Deciding is the approver's act, authenticated by the link token mailed to them and nothing else — a token an application deliberately never holds. An admin-authenticated decision would also fire whatever the waiting flow does next, so the absent method is the design, not a gap.",
  },
  "/api/public/book": { client: "booking" },
  "/api/public/dashboards": {
    serverOnly:
      "A public dashboard embed is consumed as an iframe or an image, not as a typed method call, so the SDK is not the surface that makes it usable. Was deferred-until-wave-21 while saying, in the same sentence, that no client belongs here.",
  },
  // Covered outright: `forms.public.fill` / `.saveDraft` / `.submit` shipped in
  // `f944f1b4`. The entry briefly said `missing: ["submit"]`, which was not
  // merely stale — it could never have fired, because the member lives on
  // `FormsClient.public` and the check read only `FormsClient`. That is the
  // exact failure this file exists to prevent, so the reader now walks
  // sub-clients (see `reachableMembers`).
  "/api/public/forms": { client: "forms" },
  "/api/public/sign": {
    serverOnly:
      "The signer's journey is a hosted page reached from an email link, and the token that authorises it is deliberately not something an application holds. A client method would need the one credential the design refuses to hand out, so this is permanent rather than pending.",
  },
  "/api/realtime": { core: "subscribe" },
  "/api/revisions": MCP_SURFACES.revisions!,
  "/api/roles": MCP_SURFACES.roles!,
  "/api/scim/v2": INTERNAL,
  "/api/shared": MCP_SURFACES["shared-links"]!,
  "/api/shared-links": MCP_SURFACES["shared-links"]!,
  // The canonical per-site script. Same sub-app as the `/api/analytics/tm`
  // alias below it, mounted twice on purpose, so it needs its own sentence.
  "/api/site": {
    serverOnly:
      "One `<script>` a site owner pastes once. The server composes what it answers with — tracker, consent banner, tag container — from that site's own settings, so the page never chooses and never has to be re-pasted when a setting changes. It authenticates with nothing but a public site id and is cached at the edge for every anonymous visitor; an SDK method would need credentials this tag must not carry. What an application would automate — registering the site, editing and publishing its container — is `analytics.sites` and the tag-manager admin surface.",
  },
  "/api/storage": MCP_SURFACES.storage!,
  // The app plane, three routers deep. Each answers for itself now — the single
  // `core: "request"` these used to share is the blanket that hid the agent
  // chat surface below.
  "/api/t → appAgentsPublicRoutes": { client: "agent-chat" },
  "/api/t → appOrgsPublicRoutes": { client: "orgs" },
  "/api/t → tenantAuthRoutes": { plane: "auth", client: "auth" },
  "/api/tenants": MCP_SURFACES.tenants!,
  "/api/uploads": MCP_SURFACES.uploads!,
  "/api/users": MCP_SURFACES.users!,
  "/api/vector": MCP_SURFACES.vector!,
  "/api/webhook": {
    serverOnly:
      "This is the INBOUND receiver third-party providers post to. Its callers are Stripe and Slack, not this SDK, and a client method pointed at it would have no meaning.",
  },
  "/api/webhooks": MCP_SURFACES.webhooks!,
  // Not deferred — its own reasoning says the `auth` client already answers it,
  // which is `client`, not an excuse waiting on a wave.
  "/api/workspace-config": { client: "auth" },
  "/mcp": INTERNAL,
  "/s3": INTERNAL,
  // The whole `/api/admin/*` family. Listed one by one rather than matched by
  // prefix: a prefix rule would silently absorb a new mount, which is the
  // drift this file exists to catch.
  "/api/admin/adopt": ADMIN,
  "/api/admin/advisor": { client: "advisor" },
  "/api/admin/ai": MCP_SURFACES.ai!,
  "/api/admin/ai-config": MCP_SURFACES.ai!,
  "/api/admin/analytics": { client: "analytics" },
  "/api/admin/tag-manager": {
    deferred:
      "The tag manager's admin surface exists but has no SDK client yet: the browser runtime, the compile/publish service and this REST surface landed first because nothing downstream can be written against a container format that is still being proved end-to-end. An SDK client here would freeze the shape of a tag, a trigger and a compiled artifact before the admin has exercised any of them. It lands with the rest of the multi-surface pass, alongside the GraphQL fields, the MCP tools and the CLI verbs, so all four are written against one settled shape rather than four against a moving one.",
    until: "wave-2",
    // Names the module whose arrival retires this entry, so the tripwire can
    // actually fire. `clients/tag-manager.ts` does not exist yet; the day it
    // does, this deferral fails and has to be replaced by a real client entry.
    retiredBy: "tag-manager",
  },
  "/api/admin/consent": { client: "consent" },
  "/api/consent": {
    serverOnly:
      "The config document a cookie banner reads on the customer's own domain, addressed by a public site id and no credential at all. It is the same shape of exclusion as the collect route: hand-written plain JS on a foreign origin, an uncredentialed `ACAO: *` response, and a body that is only ever what the operator already published to their own anonymous visitors. An SDK method would have to carry credentials the banner must not hold, to fetch a document any visitor can already read. Everything an application would automate — writing the policy, reading its version history — is on `consent` against the admin surface.",
  },
  "/api/admin/approvals": { client: "approvals" },
  "/api/admin/auth": ADMIN,
  "/api/admin/auth-hooks": { client: "auth-hooks" },
  "/api/admin/booking": { client: "booking" },
  "/api/admin/captcha": { client: "support" },
  "/api/admin/cdc-sinks": { client: "cdc" },
  "/api/admin/dashboards": { client: "dashboards" },
  "/api/admin/db": { client: "backups" },
  "/api/admin/demo": ADMIN,
  "/api/admin/documents": { client: "documents" },
  "/api/admin/email-config": ADMIN,
  "/api/admin/email-templates": ADMIN,
  // The second subsystem the MCP-keyed registry cannot see.
  "/api/admin/erasure": {
    deferred:
      "Erasing a data subject is irreversible and wants its own confirmation gate before any client makes it one call away. It has no MCP tool either, so designing the surface is a piece of work rather than a port.",
    until: "wave-21",
    retiredBy: "erasure",
  },
  "/api/admin/feature-flags": { client: "flags" },
  "/api/admin/forms": { client: "forms" },
  "/api/admin/i18n": ADMIN,
  "/api/admin/impersonation": { client: "support" },
  "/api/admin/integrations": { client: "integrations" },
  "/api/admin/kpis": { client: "kpis" },
  "/api/admin/ldap-config": ADMIN,
  "/api/admin/mcp": INTERNAL,
  "/api/admin/metrics": ADMIN,
  "/api/admin/migrate": { client: "migrate" },
  "/api/admin/oauth-clients": { client: "oauth-clients" },
  "/api/admin/oidc": ADMIN,
  "/api/admin/panels": { client: "dashboards" },
  "/api/admin/payments": { client: "payments" },
  "/api/admin/platform-ldap-config": ADMIN,
  "/api/admin/platform-saml": ADMIN,
  "/api/admin/push-config": ADMIN,
  "/api/admin/push-templates": ADMIN,
  "/api/admin/realtime": ADMIN,
  "/api/admin/realtime-channels": { client: "channels" },
  "/api/admin/rls": { client: "rls" },
  "/api/admin/s3-credentials": { client: "s3" },
  "/api/admin/saml": ADMIN,
  "/api/admin/schema": { client: "schema" },
  "/api/admin/scim": ADMIN,
  "/api/admin/settings": ADMIN,
  "/api/admin/signatures": { client: "signatures" },
  "/api/admin/signing-keys": { client: "signing-keys" },
  "/api/admin/sms-config": ADMIN,
  "/api/admin/sync-hooks": { client: "sync-hooks" },
  "/api/admin/templates": { client: "templates" },
  "/api/admin/third-party-auth": MCP_SURFACES["third-party-auth"]!,
  "/api/admin/traces": ADMIN,
  "/api/admin/usage": { client: "usage" },
};

// ---------------------------------------------------------------------------
// Derived facts about the SDK, read from its source
// ---------------------------------------------------------------------------

const indexSrc = read(join(SDK_DIR, "index.ts"));
const coreSrc = read(join(SDK_DIR, "core.ts"));

const clientModules = readdirSync(join(SDK_DIR, "clients"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.slice(0, -3));

/** `oauth-clients` → `makeOAuthClients`, compared case-insensitively — the
 *  acronym is spelled the way the module spells it. Same rule as
 *  `sdk-module-boundary.test.ts`. */
const factoryFor = (module: string) =>
  `make${module.replace(/(^|-)(.)/g, (_, __, c: string) => c.toUpperCase())}`;

/** Module → the field it is assembled onto (`app-users` → `appUsers`), read
 *  from `index.ts` rather than guessed, so a rename cannot leave this stale. */
const fieldForModule = (() => {
  const byFactory = new Map<string, string>();
  for (const m of indexSrc.matchAll(/^\s+const (\w+) = (make\w+)\(core\);$/gm)) {
    byFactory.set(m[2]!.toLowerCase(), m[1]!);
  }
  const out = new Map<string, string>();
  for (const mod of clientModules) {
    const field = byFactory.get(factoryFor(mod).toLowerCase());
    if (field) out.set(mod, field);
  }
  return out;
})();

/** The members declared on `BacklexClient` — its own methods plus every
 *  assembled domain field. */
const backlexClientMembers = new Set(
  [...interfaceBody(indexSrc, "BacklexClient").matchAll(/^ {2}(\w+)[<(:]/gm)].map((m) => m[1]!),
);

/** Members of `CollectionClient` — what `core: "from"` actually buys. */
const collectionClientMembers = new Set(
  [...interfaceBody(coreSrc, "CollectionClient").matchAll(/^ {2}(\w+)[<(]/gm)].map((m) => m[1]!),
);

const surfacesTests = readdirSync(TESTS_DIR)
  .filter((f) => f.endsWith("-surfaces.test.ts"))
  .map((f) => ({ file: f, src: read(join(TESTS_DIR, f)) }));

const mcpModules = readdirSync(MCP_DIR)
  .filter((f) => f.endsWith(".ts") && f !== "index.ts")
  .map((f) => ({ name: f.slice(0, -3), src: read(join(MCP_DIR, f)) }))
  // `_links.ts` is a helper for attaching resource links and declares no
  // tools. Filtered by what it CONTAINS, not by its name, so a real tool
  // module can never be excluded by being named conveniently.
  .filter((m) => /^\s*name: "/m.test(m.src))
  .map((m) => m.name);

const routeMounts = [
  ...read(APP_TS).matchAll(/app\.route\("([^"]+)",\s*([A-Za-z_$][\w$]*)/g),
].map((m) => ({ path: m[1]!, router: m[2]! }));

/** Every `app.route(` in the file, however it is written — compared against
 *  `routeMounts` in the sanity test. A mount the stricter regex failed to parse
 *  would drop out of the registry entirely, so its surface would need no entry:
 *  a hole shaped exactly like coverage. */
const rawMountCount = [...read(APP_TS).matchAll(/app\.route\(/g)].length;

/**
 * Every mount, keyed by its path — or by `path → router` when the same path is
 * mounted by more than one router.
 *
 * That second case is the hole this closes. Three prefixes are shared
 * (`/api/auth` four ways, `/api/t` three, `/.well-known` two), and keying them
 * by path alone let ONE answer excuse every router behind it: the app-plane
 * agent chat shipped under `/api/t`, which had already been answered for by
 * the workspace auth surface mounted at the same prefix, so this file stayed
 * green over a brand-new app-facing surface with no client. A shared prefix is
 * not a shared decision.
 */
const mountedFamilies = (() => {
  const perPath = new Map<string, number>();
  for (const m of routeMounts) perPath.set(m.path, (perPath.get(m.path) ?? 0) + 1);
  return [
    ...new Set(
      routeMounts.map((m) =>
        (perPath.get(m.path) ?? 0) > 1 ? `${m.path} → ${m.router}` : m.path,
      ),
    ),
  ];
})();

const kindOf = (c: Coverage): string[] =>
  (["client", "core", "deferred", "serverOnly"] as const).filter((k) => c[k] !== undefined);

const UNTIL = /^wave-\d+(-phase-\d+)?$/;

// ---------------------------------------------------------------------------

describe("SDK parity — the registry covers every surface", () => {
  test("sanity: the scans found the surfaces they are meant to police", () => {
    // A regex that silently stopped matching would otherwise make every
    // assertion below pass over an empty list.
    expect(mcpModules.length).toBeGreaterThanOrEqual(60);
    expect(mountedFamilies.length).toBeGreaterThanOrEqual(100);
    // The router half of the mount scan is load-bearing — see `rawMountCount`.
    expect(routeMounts.length).toBe(rawMountCount);
    expect(clientModules.length).toBeGreaterThanOrEqual(30);
    expect(surfacesTests.length).toBeGreaterThanOrEqual(45);
    expect(fieldForModule.size).toBe(clientModules.length);
    expect(collectionClientMembers.size).toBeGreaterThanOrEqual(25);
  });

  test("every MCP tool module has an entry", () => {
    const missing = mcpModules.filter((m) => !MCP_SURFACES[m]);
    // The drift alarm: a new tool module means a new capability an agent has
    // and an application may not.
    expect(missing).toEqual([]);
  });

  test("no entry names an MCP module that no longer exists", () => {
    const stale = Object.keys(MCP_SURFACES).filter((k) => !mcpModules.includes(k));
    expect(stale).toEqual([]);
  });

  test("every mounted route family has an entry", () => {
    const missing = mountedFamilies.filter((f) => !ROUTE_FAMILIES[f]);
    // Catches the subsystems with no MCP tools at all — `i18n` and `erasure`
    // are both mounted and both invisible to the table above.
    expect(missing).toEqual([]);
  });

  test("no entry names a route family that is no longer mounted", () => {
    const stale = Object.keys(ROUTE_FAMILIES).filter((f) => !mountedFamilies.includes(f));
    expect(stale).toEqual([]);
  });
});

describe("SDK parity — every entry is well formed", () => {
  const allEntries: [string, Coverage][] = [
    ...Object.entries(MCP_SURFACES).map(([k, v]) => [`mcp:${k}`, v] as [string, Coverage]),
    ...Object.entries(ROUTE_FAMILIES)
      .filter(([, v]) => !(v as Family).plane)
      .map(([k, v]) => [`route:${k}`, v] as [string, Coverage]),
  ];

  test("each entry answers in exactly one way", () => {
    for (const [key, cov] of allEntries) {
      expect(`${key}: ${kindOf(cov).join("+") || "nothing"}`).toBe(`${key}: ${kindOf(cov)[0]}`);
    }
  });

  test("a deferral costs a real sentence and a wave to revisit it in", () => {
    for (const [key, cov] of allEntries) {
      if (cov.deferred === undefined) continue;
      // Sixty characters is roughly a clause. A `TODO` or a `later` cannot
      // reach it, so quieting this file takes a paragraph that a reviewer
      // reads as prose.
      expect(`${key}: ${cov.deferred.length}`).toBe(
        `${key}: ${Math.max(cov.deferred.length, 60)}`,
      );
      expect(`${key}: ${UNTIL.test(cov.until ?? "")}`).toBe(`${key}: true`);
    }
  });

  test("a deferral cannot outlive the gap it defers", () => {
    // The hole this closes: `missing` retires itself when the member lands,
    // but a whole-subsystem `deferred` did not — so a phase could ship its
    // client and leave the excuse for it sitting in the registry, which is
    // the exact drift this file exists to catch, wearing the file's own
    // uniform.
    // "The client that would satisfy this deferral does not exist yet" — which
    // is narrower than "a file of that name exists". `clients/schema.ts` is
    // real and is claimed by `schema-versions`; the `schema` module's own
    // tools (list and describe collections) are genuinely not in it, so that
    // deferral is honest and must not fail here.
    const claimed = new Set(
      [...Object.values(MCP_SURFACES), ...Object.values(ROUTE_FAMILIES)]
        .map((c) => c.client)
        .filter((c): c is string => Boolean(c)),
    );
    for (const [key, cov] of allEntries) {
      if (cov.deferred === undefined) continue;
      // `retiredBy` first: stripping an `mcp:` prefix leaves a `route:` key
      // intact, and `clientModules.includes("route:/api/i18n")` is false
      // forever — which is how seven route-literal deferrals sat here green
      // through every wave, wearing a tripwire that could not fire.
      const module = cov.retiredBy ?? key.replace(/^mcp:/, "");
      const stale = clientModules.includes(module) && !claimed.has(module);
      expect(`${key} is deferred but an unclaimed clients/${module}.ts exists: ${stale}`).toBe(
        `${key} is deferred but an unclaimed clients/${module}.ts exists: false`,
      );
    }
  });

  test("every deferral is one the tripwire above can actually fire on", () => {
    // The hole this closes is the file's own shape, not a typo: `deferred` was
    // accepted on any key, while the retirement check only ever understood
    // `mcp:`-prefixed ones. An entry could therefore promise "until wave 21"
    // and be incapable of noticing wave 21 — and eight of twenty-three were in
    // exactly that state, four of them describing permanent exclusions.
    //
    // So: a deferral either names a module the check can look for, or it is not
    // a deferral. If nothing would ever satisfy it, the honest field is
    // `serverOnly`; if a client already exists and only a member is absent, it
    // is `missing`, which retires itself.
    // A route family that answers by pointing at an MCP module's entry shares
    // the very same object (`"/api/activity": MCP_SURFACES.activity!`), so it
    // is already retirable under that module's own key — checking by identity
    // rather than by key is what stops twelve such aliases reading as holes.
    const mcpBacked = new Set(
      allEntries.filter(([k]) => k.startsWith("mcp:")).map(([, cov]) => cov),
    );
    for (const [key, cov] of allEntries) {
      if (cov.deferred === undefined) continue;
      const retirable =
        key.startsWith("mcp:") || typeof cov.retiredBy === "string" || mcpBacked.has(cov);
      expect(`${key} names what would retire it: ${retirable}`).toBe(
        `${key} names what would retire it: true`,
      );
    }
  });

  test("`retiredBy` names a module that does not exist yet", () => {
    // A `retiredBy` pointing at a module that is already there — or at one
    // another entry has claimed — is a tripwire aimed at the past. Either way
    // the deferral it guards can never fire, which is the state this whole
    // pair of tests exists to make impossible.
    for (const [key, cov] of allEntries) {
      if (!cov.retiredBy) continue;
      expect(
        `${key} -> clients/${cov.retiredBy}.ts exists: ${clientModules.includes(cov.retiredBy)}`,
      ).toBe(`${key} -> clients/${cov.retiredBy}.ts exists: false`);
    }
  });

  test("a permanent exclusion says why it is permanent", () => {
    for (const [key, cov] of allEntries) {
      if (cov.serverOnly === undefined) continue;
      expect(`${key}: ${cov.serverOnly.length}`).toBe(
        `${key}: ${Math.max(cov.serverOnly.length, 60)}`,
      );
      // It is not deferred to anything — that is the difference.
      expect(cov.until).toBeUndefined();
    }
  });

  test("a partial client names the phase that completes it", () => {
    for (const [key, cov] of allEntries) {
      if (!cov.missing) continue;
      expect(`${key}: ${cov.missing.length > 0}`).toBe(`${key}: true`);
      expect(`${key}: ${UNTIL.test(cov.until ?? "")}`).toBe(`${key}: true`);
    }
  });
});

describe("SDK parity — every claim of coverage is true", () => {
  const covered = [
    ...Object.entries(MCP_SURFACES),
    ...Object.entries(ROUTE_FAMILIES),
  ] as [string, Coverage][];

  test("every `client` names a module that exists and is assembled", () => {
    for (const [key, cov] of covered) {
      if (!cov.client) continue;
      expect(`${key}: ${clientModules.includes(cov.client)}`).toBe(`${key}: true`);

      const src = read(join(SDK_DIR, "clients", `${cov.client}.ts`));
      const factory = factoryFor(cov.client);
      expect(src).toMatch(new RegExp(`^export const ${factory} = \\(core: ClientCore\\)`, "mi"));
      expect(indexSrc).toMatch(
        new RegExp(`^import \\{ ${factory} \\} from "\\./clients/${cov.client}";$`, "mi"),
      );
      // Declared and imported is not shipped — it has to be on the client the
      // caller is handed.
      const field = fieldForModule.get(cov.client)!;
      expect(`${key}: ${backlexClientMembers.has(field)}`).toBe(`${key}: true`);
    }
  });

  test("every `core` names a member the assembled client really has", () => {
    for (const [key, cov] of covered) {
      if (!cov.core) continue;
      expect(`${key}: ${backlexClientMembers.has(cov.core)}`).toBe(`${key}: true`);
    }
  });

  test("a `missing` member is genuinely still missing", () => {
    for (const [key, cov] of covered) {
      if (!cov.missing) continue;
      // Search the INTERFACES the caller is handed — the named one and every
      // sub-client reachable from it — not the whole file, so a module-private
      // helper or an unrelated option named `url` does not read as coverage
      // that does not exist. A member one level down is spelled `public.submit`.
      const members = cov.client
        ? reachableMembers(
            read(join(SDK_DIR, "clients", `${cov.client}.ts`)),
            `${factoryFor(cov.client).slice(4)}Client`,
          )
        : reachableMembers(coreSrc, "CollectionClient");
      for (const member of cov.missing) {
        // When the phase lands, this fails — and deleting the entry is how
        // the phase reports itself finished. An excuse cannot outlive the gap
        // it excuses.
        expect(`${key}.${member}: ${members.has(member)}`).toBe(`${key}.${member}: false`);
        // And the failure that made the walk necessary: a bare name that IS
        // shipped one level down. The line above passes on it — `submit` is
        // genuinely not a member of `FormsClient` — while the member the entry
        // means has been callable for two waves. Naming the path is the fix.
        const deeper = [...members].filter((m) => m.endsWith(`.${member}`));
        expect(`${key}.${member} also shipped as: ${deeper.join(", ")}`).toBe(
          `${key}.${member} also shipped as: `,
        );
      }
    }
  });

  test("`core: \"from\"` buys what the entries assume it buys", () => {
    // The four field-level subsystems answered by `from` rather than a client
    // of their own. Named explicitly so a refactor that moves them off
    // `CollectionClient` fails here instead of leaving the registry lying.
    for (const member of ["backfillSlugs", "backfillGeo", "normalizePhones", "normalizeEmails"]) {
      expect(`${member}: ${collectionClientMembers.has(member)}`).toBe(`${member}: true`);
    }
  });
});

describe("SDK parity — the correlation is enforced, not observed", () => {
  /**
   * The finding that shaped this wave: SDK coverage and surfaces-test
   * coverage matched perfectly, because the surfaces test is what produces
   * the client. Asserting it turns a habit into a rule — a new client cannot
   * ship without the test that would have caught it pointing at a path
   * nobody registered.
   */
  test("every SDK client is exercised by a surfaces test", () => {
    const clients = new Set(
      [...Object.values(MCP_SURFACES), ...Object.values(ROUTE_FAMILIES)]
        .map((c) => c.client)
        .filter((c): c is string => Boolean(c)),
    );

    for (const mod of clients) {
      const field = fieldForModule.get(mod)!;
      // Either shape counts: importing the domain module directly (the
      // path-spy style) or driving it off an assembled client.
      const direct = new RegExp(`packages/client/src/clients/${mod}\\b`);
      const assembled = new RegExp(`\\.${field}\\.`);
      const hit = surfacesTests.some(
        (t) => direct.test(t.src) || (t.src.includes("packages/client/src") && assembled.test(t.src)),
      );
      expect(`${mod} (client.${field}) exercised by a surfaces test: ${hit}`).toBe(
        `${mod} (client.${field}) exercised by a surfaces test: true`,
      );
    }
  });
});
