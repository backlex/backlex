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
      "Every AI route is `requireAdmin` today, so there is no app-plane caller for an SDK method to serve. Wave 20 is the wave that decides which AI surfaces an end user may reach; shipping a client before that decision would fix the answer by accident.",
    until: "wave-20",
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
  channels: { client: "channels" },
  collections: { core: "from" },
  comments: {
    deferred:
      "Per-record discussion is exactly the boring collaboration CRUD an application draws itself, and the admin already proves the shape in `admin/api/content.ts`. This is a wave-19 target, not a decision to decline.",
    until: "wave-19-phase-2",
  },
  dashboards: { client: "dashboards" },
  db: {
    deferred:
      "`db.execute_sql` hands over arbitrary SQL against the workspace's own database. That is an operator capability reached from a trusted terminal, not something an application's front end should be able to call with a captured session token.",
    until: "wave-21",
  },
  documents: { client: "documents" },
  email: { core: "from" },
  embedding: {
    deferred:
      "Writing a raw embedding belongs with the vector client rather than on its own, so it lands in the same phase and shares its capability check.",
    until: "wave-19-phase-3",
  },
  extensions: { client: "extensions" },
  "feature-flags": { client: "flags" },
  flows: { client: "flows" },
  folders: {
    deferred:
      "File organisation is part of the storage story an application tells its users, and there is no client for it at all today. A wave-19 target.",
    until: "wave-19-phase-3",
  },
  forms: {
    client: "forms",
    // The client is 341 lines of AUTHORING and cannot fill in a form, which is
    // the entire point of a public form.
    missing: ["public"],
    until: "wave-19-phase-4",
    deferred: undefined,
  },
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
  notifications: {
    // The `messaging.*` half of this module IS covered, by `messaging`; the
    // `notifications.*` half — the bell an application draws — is not.
    deferred:
      "The push and SMS tools in this module reach the SDK through `messaging`; the notification list, send and mark-read tools have no client at all, and an in-app bell is something applications draw constantly.",
    until: "wave-19-phase-3",
  },
  oauth: { client: "oauth-clients" },
  order: { core: "from" },
  payments: { client: "payments" },
  permissions: { client: "permissions" },
  phone: { core: "from" },
  retirement: { core: "from" },
  revisions: {
    deferred:
      "Version history and revert are per-record collaboration an application shows its own users, and the envelope shapes are already settled in `admin/api/content.ts`. A wave-19 target.",
    until: "wave-19-phase-2",
  },
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
  "shared-links": {
    deferred:
      "Handing someone a read-only link to one record is a feature applications ship themselves, and the one-shot token semantics are already coded in the admin. A wave-19 target.",
    until: "wave-19-phase-2",
  },
  signatures: { client: "signatures" },
  "signing-keys": { client: "signing-keys" },
  slug: { core: "from" },
  storage: {
    client: "storage",
    // The two the ecommerce example works around with 40 lines of blob and
    // `createObjectURL`, with a comment saying a transform was what it wanted.
    missing: ["signUrl", "url"],
    until: "wave-19-phase-4",
  },
  support: { client: "support" },
  "sync-hooks": { client: "sync-hooks" },
  templates: { client: "templates" },
  tenants: { deferred: ADMIN_PLANE("Tenant listing and switching"), until: "wave-21" },
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
  vector: {
    deferred:
      "Semantic search is a headline capability an application cannot reach at all today. It ships with the caveat that `capabilities()` must degrade rather than throw where no vector store is configured. A wave-19 target.",
    until: "wave-19-phase-3",
  },
  webhooks: {
    deferred:
      "The cheapest four-of-five-to-five-of-five in the repository: REST, MCP and CLI all cover it and only the SDK does not. Sized at roughly seventy lines, and deferred only because wave 19's cut line put depth on the app-plane surfaces first.",
    until: "wave-19-phase-5",
  },
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
  "/.well-known": INTERNAL,
  "/api": { core: "request" },
  "/api/_internal/sandbox-rpc": INTERNAL,
  "/api/account": {
    deferred:
      "Account preferences are the admin console's own state — list columns, locale and timezone for the operator UI. An application keeps its users' preferences in its own collections.",
    until: "wave-21",
  },
  "/api/activity": MCP_SURFACES.activity!,
  "/api/agents": { client: "agents" },
  "/api/analytics": { client: "analytics" },
  "/api/api-keys": MCP_SURFACES["api-keys"]!,
  "/api/app-orgs": { client: "orgs" },
  "/api/app-users": { client: "app-users" },
  "/api/auth": { plane: "auth", client: "auth" },
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
  "/api/public/approve": {
    deferred:
      "The visitor half of approvals: someone who is not a user of the workspace acts on a token they were emailed. Same class as filling in a public form, and it should be designed alongside it rather than ahead of it.",
    until: "wave-21",
  },
  "/api/public/book": { client: "booking" },
  "/api/public/dashboards": {
    deferred:
      "A public dashboard embed is consumed as an iframe or an image, not as a typed method call, so the SDK is not the surface that makes it usable.",
    until: "wave-21",
  },
  "/api/public/forms": {
    deferred:
      "Filling in a public form from your own application is the entire purpose of the feature, and the client covers only authoring today. A wave-19 target.",
    until: "wave-19-phase-4",
  },
  "/api/public/sign": {
    deferred:
      "The signer's journey is a hosted page reached from an email link, and the token that authorises it is deliberately not something an application holds.",
    until: "wave-21",
  },
  "/api/realtime": { core: "subscribe" },
  "/api/revisions": MCP_SURFACES.revisions!,
  "/api/roles": MCP_SURFACES.roles!,
  "/api/scim/v2": INTERNAL,
  "/api/shared": MCP_SURFACES["shared-links"]!,
  "/api/shared-links": MCP_SURFACES["shared-links"]!,
  "/api/storage": MCP_SURFACES.storage!,
  "/api/t": { core: "request" },
  "/api/tenants": MCP_SURFACES.tenants!,
  "/api/uploads": MCP_SURFACES.uploads!,
  "/api/users": MCP_SURFACES.users!,
  "/api/vector": MCP_SURFACES.vector!,
  "/api/webhook": {
    serverOnly:
      "This is the INBOUND receiver third-party providers post to. Its callers are Stripe and Slack, not this SDK, and a client method pointed at it would have no meaning.",
  },
  "/api/webhooks": MCP_SURFACES.webhooks!,
  "/api/workspace-config": {
    deferred:
      "The public shape of a workspace's auth configuration is fetched by the sign-in flow itself rather than called directly, so it is served through `auth` rather than as a surface of its own.",
    until: "wave-21",
  },
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

const mountedFamilies = [
  ...new Set([...read(APP_TS).matchAll(/app\.route\("([^"]+)"/g)].map((m) => m[1]!)),
];

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
      // Search the INTERFACE the caller is handed, not the whole file — a
      // module-private helper or an unrelated option named `url` would
      // otherwise read as coverage that does not exist.
      const surface = cov.client
        ? interfaceBody(
            read(join(SDK_DIR, "clients", `${cov.client}.ts`)),
            `${factoryFor(cov.client).slice(4)}Client`,
          )
        : interfaceBody(coreSrc, "CollectionClient");
      for (const member of cov.missing) {
        // When the phase lands, this fails — and deleting the entry is how
        // the phase reports itself finished. An excuse cannot outlive the gap
        // it excuses.
        expect(`${key}.${member}: ${new RegExp(`^\\s{2}${member}[(<:?]`, "m").test(surface)}`).toBe(
          `${key}.${member}: false`,
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
