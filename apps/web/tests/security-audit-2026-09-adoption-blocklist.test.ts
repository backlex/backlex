/**
 * Phase 2 of the 2026-09 pre-prod audit — adoption must not be able to name a
 * table backlex owns.
 *
 * The reproduction, before any of this was fixed: a workspace admin POSTed
 * `{adopted: true, physicalTable: "sessions", tenantScoped: false}` to
 * `/api/collections`, got a **201**, and `GET /api/items/<slug>` answered
 * **200** with `"token":"UqCGg3yKIN7YHggAoTTgFQm3VHgNYt1w"` — a live
 * better-auth session token, in plaintext, for every account on the
 * deployment. `POST /api/tenants` is open to any signed-in user and grants the
 * creator the workspace `admin` role, so "workspace admin" is self-serve; see
 * [[every-existing-test-drove-the-privileged-identity]].
 *
 * Two things were wrong, and only the first is what the audit filed:
 *
 *   1. The create endpoint never consulted `SYSTEM_TABLES` at all. That set
 *      filtered the adopt *picker* and nothing else.
 *   2. `SYSTEM_TABLES` was a hand-written literal of 46 names against a schema
 *      of 131 tables. **91 system tables were outside it**, the picker included
 *      — `signing_keys`, `oauth_access_tokens`, `ai_config`,
 *      `payment_providers`, `twoFactor`, `s3_credentials`. Fixing (1) against
 *      that list would have closed `sessions` and left the private keys open.
 *
 * So the set is now derived from the Drizzle schema (`services/system-tables.ts`)
 * and the guard runs on every door that can set `collections.physical_table`,
 * plus the read path — a guard on the writers is only as wide as the writers,
 * and rows written before it existed are still rows.
 *
 * Every block asserts both directions: the refusal AND that the legitimate
 * neighbouring case still works. Each guard was verified by breaking it — see
 * [[verify-a-guard-by-breaking-it]].
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  legacyTableNamesForTest,
  reservedNameReason,
  reservedTableReason,
  SYSTEM_TABLE_NAMES,
  unreadableTableReason,
} from "../src/server/services/system-tables";
import { buildContext } from "../src/server/context";
import { restoreBackup } from "../src/server/services/backup";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const J = { "Content-Type": "application/json" };
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: J,
  body: JSON.stringify(body),
});

/** A tenant id's 12-hex table prefix, computed the way `derivePhysicalTable`
 *  does — deliberately re-derived here rather than imported, so a change to
 *  the production helper has to agree with an independent statement of it. */
const prefixOf = (tenantId: string) => tenantId.replace(/-/g, "").slice(0, 12).toLowerCase();

// ─────────────────────────────────────────────────────────────────────────────
// 1. The derivation itself
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — the set is derived, not listed", () => {
  const schemaNames = (): Set<string> => {
    const out = new Set<string>();
    for (const v of Object.values(pg.schema)) if (is(v, PgTable)) out.add(getTableName(v));
    for (const v of Object.values(sqlite.schema)) if (is(v, SQLiteTable)) out.add(getTableName(v));
    return out;
  };

  /** Asserted through the public predicate rather than the raw set, because the
   *  set is stored case-folded (see `fold` in system-tables.ts) and a test that
   *  reached past the fold would be testing a different function than the
   *  guards call. */
  test("every table in either dialect's schema is covered", () => {
    const missing = [...schemaNames()].filter((n) => reservedNameReason(n) === null);
    expect(missing).toEqual([]);
  });

  /**
   * The load-bearing half. `SYSTEM_TABLE_NAMES` is built by iterating a module
   * namespace and asking `is(v, PgTable)`; if a drizzle upgrade moved that
   * check, the set would come back EMPTY and the assertion above would still
   * pass vacuously — `[].filter(...)` is `[]`. See
   * [[negative-assertions-need-the-loaded-state]].
   */
  test("...and there are actually tables in it (an empty set would pass the above)", () => {
    expect(SYSTEM_TABLE_NAMES.size).toBeGreaterThan(100);
    expect(SYSTEM_TABLE_NAMES.has("sessions")).toBe(true);
    expect(SYSTEM_TABLE_NAMES.has("signing_keys")).toBe(true);
  });

  test("the 91 tables the old hand-written list missed are covered now", () => {
    for (const t of [
      "signing_keys",
      "oauth_access_tokens",
      "oauth_applications",
      "ai_config",
      "payment_providers",
      "integrations",
      "s3_credentials",
      "twoFactor",
      "impersonations",
      "platform_saml_providers",
      "platform_ldap_config",
      "device_tokens",
      "shared_links",
      "form_invite_tokens",
      "scim_config",
    ]) {
      expect(reservedNameReason(t)).toBeTruthy();
    }
  });

  /** Keeps the legacy addendum from becoming a second, drifting copy of the
   *  schema: an entry that rejoins the schema must be deleted from it. */
  test("every legacy-name entry is genuinely absent from the schema", () => {
    const live = new Set([...schemaNames()].map((n) => n.toLowerCase()));
    for (const n of legacyTableNamesForTest()) {
      expect(live.has(n)).toBe(false);
    }
    // And the one entry that is there is there for a reason — the pre-per-model
    // vector store, which no migration drops and which holds vectorized text.
    expect(reservedNameReason("embeddings")).toBeTruthy();
  });

  test("engine and migration bookkeeping is refused by prefix", () => {
    for (const t of [
      "__drizzle_migrations",
      "__backlex_migrations",
      "_cf_KV",
      "_cf_METADATA",
      "d1_migrations",
      "sqlite_sequence",
    ]) {
      expect(reservedNameReason(t)).toBeTruthy();
    }
  });

  test("collection sidecars are refused by suffix", () => {
    expect(reservedNameReason("c_abc_notes__fts")).toBeTruthy();
    expect(reservedNameReason("c_abc_notes__i18n")).toBeTruthy();
  });

  /**
   * SQLite — so D1, so the Cloudflare deploy — resolves table identifiers
   * case-INSENSITIVELY: `SELECT * FROM "Sessions"` reads `sessions`. The first
   * version of this guard compared case-sensitively, so capitalising one letter
   * walked past all of it, and `POST /api/collections` was only incidentally
   * safe because `assertIdent` refuses anything outside `[a-z_][a-z0-9_]*`
   * BEFORE the guard runs. The snapshot, restore and `/inspect` doors never
   * called it. Caught in the security review of this very commit.
   */
  test("a capitalised system table is still a system table", () => {
    for (const t of ["Sessions", "SESSIONS", "Signing_Keys", "SQLITE_MASTER", "__Backlex_Migrations"]) {
      expect(reservedNameReason(t)).toBeTruthy();
    }
    expect(unreadableTableReason("Sessions", "aaaaaaaaaaaa000000000000000000000000")).toBeTruthy();
  });

  /** The fold applies to BOTH sides: the schema really does carry a camelCase
   *  SQL name (better-auth's), so folding only the input would stop matching
   *  it. */
  test("...and a camelCase schema name matches in either case", () => {
    expect(reservedNameReason("twoFactor")).toBeTruthy();
    expect(reservedNameReason("twofactor")).toBeTruthy();
    expect(reservedNameReason("TwoFactor")).toBeTruthy();
  });

  test("a capitalised foreign `c_` prefix is still foreign", () => {
    const mine = "aaaaaaaaaaaa000000000000000000000000";
    const theirs = "bbbbbbbbbbbb000000000000000000000000";
    expect(reservedTableReason(`C_${prefixOf(theirs).toUpperCase()}_notes`, mine)).toBeTruthy();
    expect(unreadableTableReason(`C_${prefixOf(theirs).toUpperCase()}_notes`, mine)).toBeTruthy();
  });

  test("an ordinary user table is not refused", () => {
    expect(reservedNameReason("legacy_products")).toBeNull();
    expect(reservedNameReason("orders_2019")).toBeNull();
    expect(reservedNameReason("crm_contacts")).toBeNull();
  });

  test("the `c_` rule is per workspace, not blanket", () => {
    const mine = "aaaaaaaaaaaa000000000000000000000000";
    const theirs = "bbbbbbbbbbbb000000000000000000000000";
    expect(reservedTableReason(`c_${prefixOf(mine)}_notes`, mine)).toBeNull();
    expect(reservedTableReason(`c_${prefixOf(theirs)}_notes`, mine)).toBeTruthy();
    // Choosing a NEW binding to pre-tenant naming is refused — it carries no
    // prefix to match and is already registered to whoever created it.
    expect(reservedTableReason("c_notes", mine)).toBeTruthy();
  });

  /**
   * The regression this nearly shipped, and the reason the read path has its
   * own predicate. `20260510120000_per_workspace_collections` ran
   * `UPDATE collections SET physical_table = 'c_' || slug` over every row that
   * predated per-workspace naming and never renamed the tables — so a
   * prefixless `c_<slug>` is ordinary live production state on any upgraded
   * deployment, and the strict rule would have 403'd every one of them.
   */
  test("the READ rule honours legacy prefixless `c_<slug>` but not a foreign prefix", () => {
    const mine = "aaaaaaaaaaaa000000000000000000000000";
    const theirs = "bbbbbbbbbbbb000000000000000000000000";
    expect(unreadableTableReason("c_notes", mine)).toBeNull();
    expect(unreadableTableReason(`c_${prefixOf(mine)}_notes`, mine)).toBeNull();
    expect(unreadableTableReason(`c_${prefixOf(theirs)}_notes`, mine)).toBeTruthy();
    // The tenant-independent half is identical on both rules.
    expect(unreadableTableReason("sessions", mine)).toBeTruthy();
    expect(unreadableTableReason("__backlex_migrations", mine)).toBeTruthy();
  });

  /** Neither predicate may throw: a guard that 500s on an unrecognised tenant
   *  id is worse than one that refuses. `derivePhysicalTable` keeps its error;
   *  judging a name is a total operation. */
  test("neither predicate throws on a tenant id that cannot carry a prefix", () => {
    for (const bad of ["", "not-a-uuid", "zzzz"]) {
      expect(() => reservedTableReason("c_abcdef012345_x", bad)).not.toThrow();
      expect(() => unreadableTableReason("c_abcdef012345_x", bad)).not.toThrow();
      // …and it fails CLOSED: an id we cannot place does not own that table.
      expect(unreadableTableReason("c_abcdef012345_x", bad)).toBeTruthy();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. POST /api/collections — the adopted branch
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — POST /api/collections {adopted:true}", () => {
  let h: TestHarness;
  let tenantId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const me = await h.fetch("/api/me");
    tenantId = ((await me.json()) as { tenantId?: string; data?: { tenantId?: string } })
      .tenantId ?? "";
    if (!tenantId) {
      const list = await h.fetch("/api/tenants");
      const body = (await list.json()) as { data: { id: string; slug: string }[] };
      tenantId = body.data.find((t) => t.slug === "default")?.id ?? body.data[0]!.id;
    }
    // A real legacy table for the positive cases.
    const raw = new Database(h.env.SQLITE_PATH!, { readwrite: true });
    raw.exec(`
      CREATE TABLE legacy_widgets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER,
        updated_at INTEGER
      );
      INSERT INTO legacy_widgets (id, name, created_at, updated_at)
        VALUES ('w1', 'Widget', 1700000000000, 1700000000000);
    `);
    raw.close();
  });
  afterAll(() => h.cleanup());

  const adopt = (slug: string, physicalTable: string, extra: object = {}) =>
    h.fetch(
      "/api/collections",
      json({
        slug,
        adopted: true,
        physicalTable,
        tenantScoped: false,
        fields: [{ name: "name", type: "text" }],
        ...extra,
      }),
    );

  test("`sessions` is refused — the reproduction that opened this phase", async () => {
    const res = await adopt("pwn_sessions", "sessions", {
      fields: [{ name: "token", type: "text" }],
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("sessions");
    // And nothing was registered — the refusal is before the write, not after.
    const items = await h.fetch("/api/items/pwn_sessions");
    expect(items.status).toBe(404);
  });

  test("`signing_keys` is refused — the case the old list would have missed", async () => {
    const res = await adopt("pwn_keys", "signing_keys", {
      fields: [{ name: "private_key", type: "text" }],
    });
    expect(res.status).toBe(403);
  });

  test("`accounts` (password + OAuth token columns) is refused", async () => {
    const res = await adopt("pwn_accounts", "accounts", {
      fields: [{ name: "password", type: "text" }],
    });
    expect(res.status).toBe(403);
  });

  test("the migration ledgers and the legacy vector store are refused", async () => {
    for (const t of ["__backlex_migrations", "__drizzle_migrations", "embeddings"]) {
      const res = await adopt(`pwn_${t.replace(/[^a-z0-9]/g, "")}`, t);
      expect(res.status).toBe(403);
    }
  });

  test("the refusal comes BEFORE the existence probe, so it is not an oracle", async () => {
    // `no_such_table_at_all` does not exist → NOT_FOUND. A system table that
    // DOES exist must not answer differently in a way that reveals presence:
    // both a present and an absent system table answer FORBIDDEN.
    const absent = await adopt("probe_absent", "no_such_table_at_all");
    expect(absent.status).toBe(404);
    // `saml_providers` is in the schema but this harness has no such table on
    // disk... it does, in fact, since migrations run — so use a schema table
    // and assert the answer is the guard's, not the probe's.
    const present = await adopt("probe_present", "sessions");
    expect(present.status).toBe(403);
  });

  test("a genuine legacy table still adopts, and reads", async () => {
    const res = await adopt("widgets", "legacy_widgets");
    expect(res.status).toBe(201);
    const items = await h.fetch("/api/items/widgets");
    expect(items.status).toBe(200);
    const body = (await items.json()) as { data: { name: string }[] };
    expect(body.data.map((r) => r.name)).toContain("Widget");
  });

  /**
   * The audit's roadmap asked whether `tenantScoped: false` should need an
   * operator. It should not: `client/admin/collections/adopt-wizard.tsx`
   * defaults it to FALSE, because the whole point of adopting a legacy table is
   * that it has no `tenant_id` column. Gating it would have taken the feature
   * away from the identity it was built for. The lever is WHICH table may be
   * named, which is what the guard above does.
   */
  test("`tenantScoped: false` stays available to a workspace admin", async () => {
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: "widgets_two",
        adopted: true,
        physicalTable: "legacy_widgets",
        tenantScoped: false,
        fields: [{ name: "name", type: "text" }],
      }),
    );
    // Refused for being a duplicate registration, NOT for being unscoped.
    expect(res.status).toBe(409);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. POST /api/collections — the managed branch's custom physicalTable
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — the managed path's custom physicalTable", () => {
  let h: TestHarness;
  let tenantId = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const list = await h.fetch("/api/tenants");
    const body = (await list.json()) as { data: { id: string; slug: string }[] };
    tenantId = body.data.find((t) => t.slug === "default")?.id ?? body.data[0]!.id;
  });
  afterAll(() => h.cleanup());

  test("a managed create cannot squat a system table name", async () => {
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: "squat",
        physicalTable: "signing_keys",
        fields: [{ name: "name", type: "text" }],
      }),
    );
    expect(res.status).toBe(403);
  });

  test("...nor a name a future migration would need", async () => {
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: "squat_ledger",
        physicalTable: "__backlex_migrations",
        fields: [{ name: "name", type: "text" }],
      }),
    );
    expect(res.status).toBe(403);
  });

  test("its own workspace's `c_` namespace is still its own", async () => {
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: "mine",
        physicalTable: `c_${prefixOf(tenantId)}_mine`,
        fields: [{ name: "name", type: "text" }],
      }),
    );
    expect(res.status).toBe(201);
  });

  test("another workspace's `c_` namespace is not", async () => {
    const foreign = "ffffffffffff00000000000000000000";
    const res = await h.fetch(
      "/api/collections",
      json({
        slug: "theirs",
        physicalTable: `c_${prefixOf(foreign)}_theirs`,
        fields: [{ name: "name", type: "text" }],
      }),
    );
    expect(res.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cross-workspace: B cannot adopt A's collection table
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — one workspace cannot adopt another's table", () => {
  let h: TestHarness;
  const suffix = `${Date.now()}`.slice(-6);
  const tenantBSlug = `tenant-${suffix}`;
  let tableA = "";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const create = await h.fetch("/api/tenants", json({ name: `Tenant ${suffix}` }));
    if (!create.ok) throw new Error(`tenant create failed: ${create.status}`);
    const mk = await h.fetch("/api/collections", {
      method: "POST",
      headers: { ...J, "X-Backlex-Tenant": "default" },
      body: JSON.stringify({
        slug: `secrets${suffix}`,
        fields: [{ name: "note", type: "text" }],
      }),
    });
    expect(mk.status).toBe(201);
    tableA = ((await mk.json()) as { data: { physicalTable: string } }).data.physicalTable;
    await h.fetch("/api/items/" + `secrets${suffix}`, {
      method: "POST",
      headers: { ...J, "X-Backlex-Tenant": "default" },
      body: JSON.stringify({ note: "workspace A only" }),
    });
  });
  afterAll(() => h.cleanup());

  test("B is refused workspace A's physical table", async () => {
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: { ...J, "X-Backlex-Tenant": tenantBSlug },
      body: JSON.stringify({
        slug: "stolen",
        adopted: true,
        physicalTable: tableA,
        tenantScoped: false,
        fields: [{ name: "note", type: "text" }],
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("another workspace");
  });

  test("...and A's rows stay unreachable from B", async () => {
    const items = await h.fetch("/api/items/stolen", {
      headers: { "X-Backlex-Tenant": tenantBSlug },
    });
    expect(items.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. The discovery surfaces
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — the picker and /inspect", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const raw = new Database(h.env.SQLITE_PATH!, { readwrite: true });
    raw.exec(`CREATE TABLE legacy_offers (id TEXT PRIMARY KEY, label TEXT)`);
    raw.close();
  });
  afterAll(() => h.cleanup());

  test("the picker offers the user table and no schema table at all", async () => {
    const res = await h.fetch("/api/admin/adopt/tables");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string }[] };
    const names = body.data.map((t) => t.name);
    expect(names).toContain("legacy_offers");
    // Before this phase this list held 91 system tables.
    const leaked = names.filter((n) => reservedNameReason(n) !== null);
    expect(leaked).toEqual([]);
    expect(names).not.toContain("__backlex_migrations");
    expect(names).not.toContain("embeddings");
  });

  test("/inspect refuses a system table — it answers with the column list", async () => {
    const res = await h.fetch("/api/admin/adopt/inspect", json({ table: "signing_keys" }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("signing_keys");
  });

  test("/inspect refuses it in any case — the route has no assertIdent", async () => {
    const res = await h.fetch("/api/admin/adopt/inspect", json({ table: "Signing_Keys" }));
    expect(res.status).toBe(403);
  });

  test("/inspect still introspects an ordinary table", async () => {
    const res = await h.fetch("/api/admin/adopt/inspect", json({ table: "legacy_offers" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { columns: { name: string }[] } };
    expect(body.data.columns.map((c) => c.name)).toContain("label");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. The second door: schema-version snapshot import + apply
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — the schema-versions door", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  /**
   * `POST /api/admin/schema/snapshots/import` parses collections with
   * `.passthrough()` on purpose — an export this service produced must import
   * back unchanged — so `adopted:true` + `physicalTable:"sessions"` survives
   * into `upsertMetadata`, which wrote it verbatim. Same hole, different
   * handle: closing only `/api/collections` would have left this open.
   */
  test("a snapshot naming a system table is refused when applied", async () => {
    const imported = await h.fetch(
      "/api/admin/schema/snapshots/import",
      json({
        name: "tampered",
        snapshot: [
          {
            slug: "pwn_via_snapshot",
            adopted: true,
            physicalTable: "sessions",
            tenantScoped: false,
            fields: [{ name: "token", type: "text" }],
          },
        ],
      }),
    );
    expect(imported.status).toBe(201);
    const snap = (await imported.json()) as { data: { id: string } };

    const applied = await h.fetch(
      "/api/admin/schema/apply",
      json({ target: { kind: "snapshot", id: snap.data.id }, confirmDestructive: true }),
    );
    expect(applied.status).toBe(403);

    const items = await h.fetch("/api/items/pwn_via_snapshot");
    expect(items.status).toBe(404);
  });

  /**
   * Pins the CHOSEN-name check specifically. `c_notes` is a legacy prefixless
   * name, which the read-shaped rule deliberately honours — so if the only
   * check here were on the resolved name, a document could still bind a
   * collection to another workspace's pre-tenant table. Only the write-shaped
   * check on `tc.physicalTable` refuses this.
   */
  test("a snapshot may not CHOOSE a legacy prefixless `c_<slug>` binding", async () => {
    const imported = await h.fetch(
      "/api/admin/schema/snapshots/import",
      json({
        name: "legacy-grab",
        snapshot: [
          {
            slug: "legacy_grab",
            adopted: true,
            physicalTable: "c_notes",
            tenantScoped: false,
            fields: [{ name: "title", type: "text" }],
          },
        ],
      }),
    );
    expect(imported.status).toBe(201);
    const snap = (await imported.json()) as { data: { id: string } };
    const applied = await h.fetch(
      "/api/admin/schema/apply",
      json({ target: { kind: "snapshot", id: snap.data.id }, confirmDestructive: true }),
    );
    expect(applied.status).toBe(403);
  });

  /**
   * Pins the RESOLVED-name check specifically. Here the document names no
   * table at all (`adopted: false` → the existing row's binding is kept), so
   * the chosen-name check is skipped entirely and only the resolved-name check
   * stands between an apply and a `sessions`-backed collection.
   */
  test("a managed target inherits a bad EXISTING binding, and is still refused", async () => {
    const list = await h.fetch("/api/tenants");
    const tenants = (await list.json()) as { data: { id: string; slug: string }[] };
    const tenantId = tenants.data.find((t) => t.slug === "default")?.id ?? tenants.data[0]!.id;
    const raw = new Database(h.env.SQLITE_PATH!, { readwrite: true });
    raw.run(
      `INSERT INTO collections
         (id, tenant_id, slug, physical_table, fields, owner_scoped, tenant_scoped,
          versioned, soft_delete, singleton, fts, adopted, audit_reads, vectorize,
          pk_column, pk_type, has_created_at, has_updated_at, status, created_at, updated_at)
       VALUES (?, ?, 'inherited', 'sessions', ?, 0, 0, 0, 0, 0, 0, 0, 0, 0,
               'id', 'text', 1, 1, 'active', ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        JSON.stringify([{ name: "token", type: "text" }]),
        Date.now(),
        Date.now(),
      ],
    );
    raw.close();

    const imported = await h.fetch(
      "/api/admin/schema/snapshots/import",
      json({
        name: "inherit",
        // No `physicalTable`, `adopted` false — the apply keeps what the row has.
        snapshot: [{ slug: "inherited", fields: [{ name: "token", type: "text" }] }],
      }),
    );
    expect(imported.status).toBe(201);
    const snap = (await imported.json()) as { data: { id: string } };
    const applied = await h.fetch(
      "/api/admin/schema/apply",
      json({ target: { kind: "snapshot", id: snap.data.id }, confirmDestructive: true }),
    );
    expect(applied.status).toBe(403);
  });

  /**
   * The end-to-end form of the case bypass, through the door that has no
   * `assertIdent` upstream of it. Before the fold this returned 201/200 and
   * `GET /api/items/pwn_case` served live session tokens on SQLite.
   */
  test("a snapshot naming a CAPITALISED system table is refused too", async () => {
    const imported = await h.fetch(
      "/api/admin/schema/snapshots/import",
      json({
        name: "case-tampered",
        snapshot: [
          {
            slug: "pwn_case",
            adopted: true,
            physicalTable: "Sessions",
            tenantScoped: false,
            fields: [{ name: "token", type: "text" }],
          },
        ],
      }),
    );
    expect(imported.status).toBe(201);
    const snap = (await imported.json()) as { data: { id: string } };
    const applied = await h.fetch(
      "/api/admin/schema/apply",
      json({ target: { kind: "snapshot", id: snap.data.id }, confirmDestructive: true }),
    );
    // Either arm is a correct refusal — `assertIdent` rejects the charset and
    // the fold rejects the name. Both are in the path on purpose.
    expect([403, 422]).toContain(applied.status);
    const items = await h.fetch("/api/items/pwn_case");
    expect(items.status).toBe(404);
  });

  /**
   * The charset half, which the case-fold cannot cover: `My Table` is not a
   * system table under any folding, but it is also not an identifier
   * `POST /api/collections` would ever accept. Four doors that disagree about
   * what a table name may contain is exactly the shape that produced the
   * capitalisation bypass, so this door now runs the same `assertIdent` the
   * create endpoint does.
   */
  test("a snapshot cannot register an identifier the create endpoint would refuse", async () => {
    const imported = await h.fetch(
      "/api/admin/schema/snapshots/import",
      json({
        name: "odd-ident",
        snapshot: [
          {
            slug: "odd_ident",
            adopted: true,
            physicalTable: "My Table",
            fields: [{ name: "title", type: "text" }],
          },
        ],
      }),
    );
    expect(imported.status).toBe(201);
    const snap = (await imported.json()) as { data: { id: string } };
    const applied = await h.fetch(
      "/api/admin/schema/apply",
      json({ target: { kind: "snapshot", id: snap.data.id }, confirmDestructive: true }),
    );
    expect(applied.status).toBe(422);
  });

  test("an ordinary snapshot still applies", async () => {
    const imported = await h.fetch(
      "/api/admin/schema/snapshots/import",
      json({
        name: "ordinary",
        snapshot: [{ slug: "from_snapshot", fields: [{ name: "title", type: "text" }] }],
      }),
    );
    expect(imported.status).toBe(201);
    const snap = (await imported.json()) as { data: { id: string } };
    const applied = await h.fetch(
      "/api/admin/schema/apply",
      json({ target: { kind: "snapshot", id: snap.data.id }, confirmDestructive: true }),
    );
    expect(applied.status).toBe(200);
    const items = await h.fetch("/api/items/from_snapshot");
    expect(items.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 6b. The third door: a hand-edited backup archive
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — the restore door", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  /**
   * A dump is a file of `{table, row}` lines, and `restoreBackup` writes
   * whatever `physical_table` it reads — then runs `applyCollection` against
   * it, i.e. ADDITIVE DDL on an auth table, before the metadata row even lands.
   * So the archive is a third way in, and it is the one that mutates rather
   * than merely registers.
   */
  const restoreDump = async (lines: string): Promise<{ ok: boolean; message: string }> => {
    const ctx = await buildContext(h.env);
    const key = `test-dumps/${crypto.randomUUID()}.ndjson`;
    await ctx.storage.put({ key, body: lines, contentType: "application/x-ndjson" });
    const list = await h.fetch("/api/tenants");
    const tenants = (await list.json()) as { data: { id: string; slug: string }[] };
    const tenantId = tenants.data.find((t) => t.slug === "default")?.id ?? tenants.data[0]!.id;
    try {
      await restoreBackup(ctx, { storageKey: key, tenantId });
      return { ok: true, message: "" };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  };

  const collectionRow = (slug: string, table: string) =>
    JSON.stringify({
      table: "collections",
      row: {
        id: crypto.randomUUID(),
        slug,
        physical_table: table,
        fields: JSON.stringify([{ name: "token", type: "text" }]),
        adopted: 1,
        tenant_scoped: 0,
        status: "active",
      },
    });

  test("an archive naming a system table is refused, not half-applied", async () => {
    const r = await restoreDump(collectionRow("from_archive", "sessions"));
    expect(r.ok).toBe(false);
    expect(r.message).toContain("sessions");
    const items = await h.fetch("/api/items/from_archive");
    expect(items.status).toBe(404);
  });

  /** Same door, capitalised. Nothing upstream of `restoreBackup` constrains
   *  the charset, so the fold is the only thing standing here. */
  test("...in any case", async () => {
    const r = await restoreDump(collectionRow("from_archive_case", "SESSIONS"));
    expect(r.ok).toBe(false);
    const items = await h.fetch("/api/items/from_archive_case");
    expect(items.status).toBe(404);
  });

  test("...and an ordinary collection row still restores", async () => {
    const mk = await h.fetch(
      "/api/collections",
      json({ slug: "restorable", fields: [{ name: "title", type: "text" }] }),
    );
    expect(mk.status).toBe(201);
    const table = ((await mk.json()) as { data: { physicalTable: string } }).data.physicalTable;
    const r = await restoreDump(collectionRow("restorable", table));
    expect(r.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. The read path — a row that already exists
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — a row written before the guard is still refused", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  /**
   * Every write door refuses now, but a deployment that ran the vulnerable
   * build already has the row — and a guard on the writers is only as wide as
   * the writers ([[a-guarantee-is-only-as-wide-as-its-callers]]). Written here
   * straight into `collections` through a second connection, which is exactly
   * the state such a deployment is in.
   */
  test("an already-registered `sessions` collection does not read", async () => {
    const list = await h.fetch("/api/tenants");
    const tenants = (await list.json()) as { data: { id: string; slug: string }[] };
    const tenantId = tenants.data.find((t) => t.slug === "default")?.id ?? tenants.data[0]!.id;

    const raw = new Database(h.env.SQLITE_PATH!, { readwrite: true });
    raw.run(
      `INSERT INTO collections
         (id, tenant_id, slug, physical_table, fields, owner_scoped, tenant_scoped,
          versioned, soft_delete, singleton, fts, adopted, audit_reads, vectorize,
          pk_column, pk_type, has_created_at, has_updated_at, status, created_at, updated_at)
       VALUES (?, ?, 'legacy_pwn', 'sessions', ?, 0, 0, 0, 0, 0, 0, 1, 0, 0,
               'id', 'text', 1, 1, 'active', ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        JSON.stringify([{ name: "token", type: "text" }]),
        Date.now(),
        Date.now(),
      ],
    );
    raw.close();

    const items = await h.fetch("/api/items/legacy_pwn");
    expect(items.status).toBe(403);
    const body = (await items.json()) as { error: { message: string } };
    expect(body.error.message).toContain("sessions");
    // The token is not in the response by any path.
    expect(JSON.stringify(body)).not.toContain("token\":\"");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7b. Legacy pre-tenant collections keep working, end to end
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — a pre-tenant `c_<slug>` collection is untouched", () => {
  let h: TestHarness;
  let tenantId = "";

  /**
   * Reproduces what an upgraded deployment actually looks like: a physical
   * table named `c_notes` (no workspace prefix) and a `collections` row
   * pointing at it, exactly as
   * `20260510120000_per_workspace_collections` left them. Every surface this
   * phase touched has to keep serving it.
   */
  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const list = await h.fetch("/api/tenants");
    const tenants = (await list.json()) as { data: { id: string; slug: string }[] };
    tenantId = tenants.data.find((t) => t.slug === "default")?.id ?? tenants.data[0]!.id;

    const raw = new Database(h.env.SQLITE_PATH!, { readwrite: true });
    raw.exec(`
      CREATE TABLE c_legacynotes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        title TEXT,
        -- Present because folded search postdates this naming scheme and the
        -- applier is additive, so a legacy collection acquires the companion
        -- the next time anything applies its schema. See the note below the
        -- fixture for what happens when it is absent.
        title__fold TEXT,
        created_at INTEGER,
        updated_at INTEGER
      );
    `);
    raw.run(`INSERT INTO c_legacynotes (id, tenant_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`, [
      "n1",
      tenantId,
      "from before per-workspace naming",
      Date.now(),
      Date.now(),
    ]);
    raw.run(
      `INSERT INTO collections
         (id, tenant_id, slug, physical_table, fields, owner_scoped, tenant_scoped,
          versioned, soft_delete, singleton, fts, adopted, audit_reads, vectorize,
          pk_column, pk_type, has_created_at, has_updated_at, status, created_at, updated_at)
       VALUES (?, ?, 'legacynotes', 'c_legacynotes', ?, 0, 1, 0, 0, 0, 0, 0, 0, 0,
               'id', 'text', 1, 1, 'active', ?, ?)`,
      [
        crypto.randomUUID(),
        tenantId,
        JSON.stringify([{ name: "title", type: "text" }]),
        Date.now(),
        Date.now(),
      ],
    );
    raw.close();
  });
  afterAll(() => h.cleanup());

  test("it still reads", async () => {
    const res = await h.fetch("/api/items/legacynotes");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { title: string }[] };
    expect(body.data.map((r) => r.title)).toContain("from before per-workspace naming");
  });

  /**
   * The fixture's `title__fold` companion is load-bearing, and NOT because of
   * anything this phase changed. `serialize.ts::serializeWithFold` emits the
   * companion from the field TYPE, unconditionally, while the read path
   * introspects `foldColumns` precisely because the column may be absent — so
   * a collection whose table predates folded search reads fine and 500s on
   * every write (`table c_… has no column named title__fold`). Found while
   * building this fixture; it is a folded-search defect, filed separately.
   */
  test("it still writes", async () => {
    const res = await h.fetch("/api/items/legacynotes", json({ title: "still writable" }));
    expect(res.status).toBe(201);
  });

  test("a schema apply over it still succeeds", async () => {
    const captured = await h.fetch(
      "/api/admin/schema/snapshots",
      json({ name: "legacy-capture" }),
    );
    expect(captured.status).toBe(201);
    const snap = (await captured.json()) as { data: { id: string } };
    const applied = await h.fetch(
      "/api/admin/schema/apply",
      json({ target: { kind: "snapshot", id: snap.data.id }, confirmDestructive: true }),
    );
    expect(applied.status).toBe(200);
  });

  test("a restore that reinstates it still succeeds", async () => {
    const ctx = await buildContext(h.env);
    const key = `test-dumps/${crypto.randomUUID()}.ndjson`;
    await ctx.storage.put({
      key,
      body: JSON.stringify({
        table: "collections",
        row: {
          id: crypto.randomUUID(),
          slug: "legacynotes",
          tenant_id: tenantId,
          physical_table: "c_legacynotes",
          fields: JSON.stringify([{ name: "title", type: "text" }]),
          adopted: 0,
          tenant_scoped: 1,
          status: "active",
        },
      }),
      contentType: "application/x-ndjson",
    });
    await expect(restoreBackup(ctx, { storageKey: key, tenantId })).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. The MCP twin
// ─────────────────────────────────────────────────────────────────────────────

describe("adoption blocklist — the MCP twin inherits the refusal", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  /**
   * `mcp/tools/schema-admin.ts::createCollection` proxies to
   * `POST /api/collections` through `fetchInternal`, so it inherits the route's
   * guard. Asserted rather than assumed — a twin that stopped proxying would be
   * a silent second hole ([[multi-surface-and-per-isolate-cache-pitfalls]]).
   */
  test("schema.create_collection cannot adopt `sessions` either", async () => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "schema-create_collection",
          arguments: {
            slug: "pwn_via_mcp",
            adopted: true,
            physicalTable: "sessions",
            tenantScoped: false,
            fields: [{ name: "token", type: "text" }],
          },
        },
      }),
    });
    const text = await res.text();
    expect(text).toContain("FORBIDDEN");
    const items = await h.fetch("/api/items/pwn_via_mcp");
    expect(items.status).toBe(404);
  });
});
