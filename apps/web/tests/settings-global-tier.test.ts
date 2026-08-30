/**
 * PHASE 6 — the instance-global settings tier stops being NULL.
 *
 * `app_settings` used to say "this row belongs to the whole instance" by
 * leaving `tenant_id` NULL, which is the same value a bug produces: a row whose
 * tenant column was never filled in is indistinguishable from a deliberate
 * instance-wide setting. Every other layered config table here already answers
 * that with a `'_global'` sentinel, and this tier now joins them.
 *
 * Three things have to hold at once for that move to be safe, and this file
 * pins all three:
 *
 *   1. the sentinel row is what gets written and what gets read, for both the
 *      global-only readers (`loadSignInBranding`, `loadPasswordLoginMode`) and
 *      the workspace reader asked for the global tier (`loadAppSettings(…,
 *      null)`);
 *   2. a workspace's own value still cannot be seen by another workspace, and
 *      does not fall into the global tier — the sentinel must not have turned
 *      "no active workspace" into "everyone's workspace";
 *   3. the pre-sentinel `tenant_id IS NULL` row is STILL readable for one
 *      release, and every key served from it announces itself, so an operator
 *      can tell whether anything still depends on the shim before it is
 *      deleted. A compatibility shim nobody can tell is unused is a shim that
 *      never gets removed.
 *
 * Two smaller defects ride along and are pinned here too: `GET /api/admin/
 * settings` used to spread the instance-wide branding flat over the workspace's
 * own settings, so every workspace read the operator's copy back as if it had
 * chosen it and no caller could tell the two apart; and `defaultCurrency` was
 * in the `.strict()` PATCH whitelist with no reader at all — accepted, stored,
 * and dropped on every read, which is a green toast for work that did not
 * happen.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { buildTwoPlaneCast, json, type TwoPlaneCast } from "./fixtures/two-plane-cast";
import {
  GLOBAL_SETTINGS_TENANT_ID,
  legacyGlobalSettingsKeysSeen,
  loadAppSettings,
  loadPasswordLoginMode,
  loadSignInBranding,
  resetLegacyGlobalSettingsLog,
} from "../src/server/services/settings";

let cast: TwoPlaneCast;
/** A second connection to the harness's own SQLite file, so a test can plant a
 *  row the HTTP surface has no way to write — the pre-sentinel NULL row is by
 *  definition something no current code path produces any more. */
let raw: Database;
/** The same file through drizzle, so the service functions can be called
 *  directly. The route layer only ever reaches the global tier through them,
 *  so this is the reader under test, not a stand-in for it. */
let db: any;

/** Unique per run so a row left behind by another spec sharing this process
 *  cannot satisfy an assertion here by coincidence. */
const suffix = `${Date.now()}`.slice(-7);
const GLOBAL_TAGLINE = `Instance tagline ${suffix}`;
const LEGACY_TAGLINE = `Legacy tagline ${suffix}`;
const SENTINEL_TAGLINE = `Sentinel tagline ${suffix}`;
const OPERATOR_HEADLINE = `Operated instance ${suffix}`;
/** A time zone parked on the GLOBAL tier — no workspace ever writes this one,
 *  so seeing it through a workspace's reader would be a leak. */
const GLOBAL_TZ = "Pacific/Chatham";
const A_TZ = "Asia/Kolkata";
const B_TZ = "America/Argentina/Ushuaia";

/** Acting-as-workspace request. The settings routes read `auth.tenantId`, and
 *  `X-Backlex-Tenant` is what sets it; the cast shares one cookie jar, so every
 *  call here names its workspace rather than inheriting whoever called last. */
const inTenant = (slug: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Backlex-Tenant": slug },
});

interface SettingsBody {
  data: Record<string, unknown> & {
    workspace: Record<string, unknown>;
    global: Record<string, unknown>;
  };
}

const getSettings = async (
  who: TwoPlaneCast["ownerA"],
  slug: string,
): Promise<SettingsBody["data"]> => {
  const res = await who.fetch("/api/admin/settings", inTenant(slug));
  expect(res.status, "an admin reads their own workspace's settings").toBe(200);
  return ((await res.json()) as SettingsBody).data;
};

/** Plant a row directly. `tenantId: null` writes the pre-sentinel shape that no
 *  current writer produces — which is exactly why the shim needs a test. */
const putRow = (tenantId: string | null, key: string, value: unknown): void => {
  raw
    .query(
      "insert into app_settings (id, tenant_id, key, value, updated_at) values (?, ?, ?, ?, ?)",
    )
    .run(crypto.randomUUID(), tenantId, key, JSON.stringify(value), Date.now());
};

const dropRows = (key: string): void => {
  raw.query("delete from app_settings where key = ?").run(key);
};

/** Which `tenant_id`s hold a row for this key, sorted. `null` reads back as the
 *  string "null" so a missing sentinel is visible rather than falsy. */
const tenantsHolding = (key: string): string[] =>
  (
    raw.query("select tenant_id as t from app_settings where key = ?").all(key) as {
      t: string | null;
    }[]
  )
    .map((r) => r.t ?? "null")
    .sort();

beforeAll(async () => {
  cast = await buildTwoPlaneCast();
  raw = new Database(cast.h.env.SQLITE_PATH as string);
  db = drizzle({ client: raw });
});

afterAll(() => {
  raw?.close();
  cast?.cleanup();
});

describe("the global tier is addressed by a sentinel, and both readers find it", () => {
  test("a '_global' row answers the branding reader AND the workspace-less settings reader", async () => {
    // Assert the pre-state, or "the tagline is what I planted" could pass on a
    // reader that returns its argument no matter what the table holds.
    const before = await loadSignInBranding(db, "sqlite");
    expect(before.signInTagline, "a fresh instance ships no custom tagline").toBe("");
    const tzBefore = await loadAppSettings(db, "sqlite", null);
    expect(tzBefore.timezone, "…nor a global time zone").not.toBe(GLOBAL_TZ);

    putRow(GLOBAL_SETTINGS_TENANT_ID, "signInTagline", GLOBAL_TAGLINE);
    putRow(GLOBAL_SETTINGS_TENANT_ID, "timezone", GLOBAL_TZ);

    // The two readers reach the same tier by different routes: one always reads
    // global (there is one sign-in screen), the other reads whichever tier its
    // caller names and was handed the global one.
    expect((await loadSignInBranding(db, "sqlite")).signInTagline).toBe(GLOBAL_TAGLINE);
    expect((await loadAppSettings(db, "sqlite", null)).timezone).toBe(GLOBAL_TZ);

    // Naming the sentinel explicitly must mean the same thing as passing null —
    // otherwise callers would have two different ways to ask for one tier and
    // only one of them would work.
    expect(
      (await loadAppSettings(db, "sqlite", GLOBAL_SETTINGS_TENANT_ID)).timezone,
      "the sentinel and `null` name the same tier",
    ).toBe(GLOBAL_TZ);

    dropRows("signInTagline");
    dropRows("timezone");
  });

  test("the operator's PATCH lands on the sentinel row, and leaves no NULL row behind", async () => {
    expect(tenantsHolding("signInHeadline"), "nothing has written it yet").toEqual([]);

    const patched = await cast.operator.fetch(
      "/api/admin/settings",
      inTenant(cast.defaultTenant.slug, json("PATCH", { signInHeadline: OPERATOR_HEADLINE })),
    );
    expect(patched.status, "the instance operator writes the instance's copy").toBe(200);

    // The point of the phase: the row now SAYS which tier it is on. A NULL here
    // would read as "someone forgot to set tenant_id", which is precisely the
    // ambiguity being removed.
    expect(tenantsHolding("signInHeadline")).toEqual([GLOBAL_SETTINGS_TENANT_ID]);
    expect((await loadSignInBranding(db, "sqlite")).signInHeadline).toBe(OPERATOR_HEADLINE);

    // And the unauthenticated sign-in screen — the surface this key exists for
    // — serves it, so the move did not quietly strand the value in a row only
    // this test can see.
    const surface = (await (await cast.anon("/api/auth/providers")).json()) as {
      data: { branding: { signInHeadline: string } };
    };
    expect(surface.data.branding.signInHeadline).toBe(OPERATOR_HEADLINE);
  });

  test("the password-login mode reads the sentinel row too", async () => {
    expect(
      await loadPasswordLoginMode(db, "sqlite"),
      "a fresh instance accepts passwords on both planes",
    ).toBe("enabled");

    putRow(GLOBAL_SETTINGS_TENANT_ID, "passwordLogin", "app-only");
    expect(await loadPasswordLoginMode(db, "sqlite")).toBe("app-only");
    dropRows("passwordLogin");
    expect(await loadPasswordLoginMode(db, "sqlite")).toBe("enabled");
  });
});

describe("a workspace's own value stays in its workspace", () => {
  test("two workspaces keep their own time zone, and neither reaches the global tier", async () => {
    // Both writes happen before either read, so neither can pass by being taken
    // before the other workspace had a chance to clobber it.
    for (const [who, slug, tz] of [
      [cast.ownerA, cast.tenantA.slug, A_TZ],
      [cast.ownerB, cast.tenantB.slug, B_TZ],
    ] as const) {
      const res = await who.fetch("/api/admin/settings", inTenant(slug, json("PATCH", { timezone: tz })));
      expect(res.status, "a workspace admin sets their own workspace's time zone").toBe(200);
    }

    const a = await getSettings(cast.ownerA, cast.tenantA.slug);
    const b = await getSettings(cast.ownerB, cast.tenantB.slug);
    expect(a.workspace.timezone).toBe(A_TZ);
    expect(b.workspace.timezone).toBe(B_TZ);

    // The rows say so as well: one per real tenant id, and nothing on the
    // global tier. The sentinel makes "instance-wide" a value you can look for,
    // which is what lets this assertion exist at all.
    expect(tenantsHolding("timezone")).toEqual([cast.tenantA.id, cast.tenantB.id].sort());
    expect(
      (await loadAppSettings(db, "sqlite", null)).timezone,
      "a workspace write must not become the instance default",
    ).not.toBe(A_TZ);
  });
});

describe("the response tells the caller which tier a value came from", () => {
  test("branding is reported as instance-wide; the workspace block holds only the workspace's own", async () => {
    const data = await getSettings(cast.ownerB, cast.tenantB.slug);

    // The defect: workspace B never chose this headline — the operator did, for
    // the whole deployment — and the old response handed it back mixed in with
    // B's own settings, with nothing to tell them apart.
    expect(data.global.signInHeadline, "the operator's copy is reported as the INSTANCE's").toBe(
      OPERATOR_HEADLINE,
    );
    expect(
      "signInHeadline" in data.workspace,
      "…and is NOT reported as something workspace B chose",
    ).toBe(false);
    expect(
      "passwordLogin" in data.workspace,
      "the password-login mode is instance-wide as well",
    ).toBe(false);
    expect(data.global.passwordLogin, "…and it is in the global block").toBe("enabled");

    // The other half of the contrast, without which "the workspace block has no
    // branding" would also pass on an empty block.
    expect(data.workspace.timezone, "the workspace block holds B's OWN time zone").toBe(B_TZ);

    // The flat mirror is deliberate and documented: the admin SPA, the CLI and
    // the MCP settings tool all still read these keys at the top level, and
    // none of those files moves in this phase. Pin it so the removal is a
    // deliberate act rather than a surprise.
    expect(data.signInHeadline, "compat mirror — remove with the last flat reader").toBe(
      OPERATOR_HEADLINE,
    );
    expect(data.timezone).toBe(B_TZ);
  });
});

describe("defaultCurrency is read back, not just accepted", () => {
  test("it round-trips per workspace, upper-cased, and defaults to USD elsewhere", async () => {
    const before = await getSettings(cast.ownerA, cast.tenantA.slug);
    // It was `undefined` here for three releases — the key was in the strict
    // write whitelist with no read branch, so the money-field editor asked for
    // it, got nothing, and fell back to USD forever. USD is still the default;
    // what changed is that it is now an ANSWER rather than the absence of one.
    expect(before.defaultCurrency, "the default is stated, not missing").toBe("USD");

    // Lower case on the way in, because that is what a hand-typed code looks
    // like and the write schema accepts it.
    const patched = await cast.ownerA.fetch(
      "/api/admin/settings",
      inTenant(cast.tenantA.slug, json("PATCH", { defaultCurrency: "try" })),
    );
    expect(patched.status).toBe(200);

    const a = await getSettings(cast.ownerA, cast.tenantA.slug);
    expect(a.workspace.defaultCurrency, "stored lower-case, served canonical").toBe("TRY");
    expect(a.defaultCurrency, "…and through the flat mirror the field editor reads").toBe("TRY");

    // Per workspace, not per instance: a currency is an authoring default for
    // the money fields of ONE workspace's collections.
    const b = await getSettings(cast.ownerB, cast.tenantB.slug);
    expect(b.workspace.defaultCurrency, "workspace B is unaffected").toBe("USD");
  });
});

describe("the pre-sentinel NULL row still answers, and says that it did", () => {
  test("a legacy row is served, and reported once per key", async () => {
    dropRows("signInTagline");
    resetLegacyGlobalSettingsLog();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      // The shape no current writer produces: the value only exists on the old
      // NULL row. Without the fallback this reads back as the empty default,
      // and an instance that upgraded would silently lose its sign-in copy.
      putRow(null, "signInTagline", LEGACY_TAGLINE);

      expect((await loadSignInBranding(db, "sqlite")).signInTagline).toBe(LEGACY_TAGLINE);
      expect(
        legacyGlobalSettingsKeysSeen(),
        "the fallback reports which key still depends on it",
      ).toContain("signInTagline");

      // Once per key per isolate, not once per request: this sits on the
      // sign-in path, and a per-request line would be a flood on the busiest
      // endpoint the instance has.
      expect((await loadSignInBranding(db, "sqlite")).signInTagline).toBe(LEGACY_TAGLINE);
      expect(warn.mock.calls.length, "the second read is silent").toBe(1);
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message, "the warning names the key").toContain("signInTagline");
      expect(message, "…and the row it should have been on").toContain(
        GLOBAL_SETTINGS_TENANT_ID,
      );
    } finally {
      warn.mockRestore();
      dropRows("signInTagline");
    }
  });

  test("a sentinel row shadows the legacy one, and the fallback goes quiet", async () => {
    dropRows("signInTagline");
    // Both rows exist — the state an instance is in between the migration and
    // the day the NULL row is deleted. The newer tier has to win, or the
    // migration would look like a rollback.
    putRow(null, "signInTagline", LEGACY_TAGLINE);
    putRow(GLOBAL_SETTINGS_TENANT_ID, "signInTagline", SENTINEL_TAGLINE);
    resetLegacyGlobalSettingsLog();

    expect((await loadSignInBranding(db, "sqlite")).signInTagline).toBe(SENTINEL_TAGLINE);
    // This is the assertion that makes the report actionable: silence has to
    // mean "nothing depends on the shim", so a key that is fully migrated must
    // not be listed. Without it the previous test's `toContain` would pass on a
    // reporter that names every key it ever reads.
    expect(
      legacyGlobalSettingsKeysSeen(),
      "a migrated key does not count as a legacy dependency",
    ).not.toContain("signInTagline");

    dropRows("signInTagline");
  });

  test("a NULL row that is not a setting is not reported as one", async () => {
    // `PUT /api/account/list-columns` still parks a per-user
    // `listColumns:<userId>` row on a NULL tenant_id for a user with no active
    // workspace. Those rows share the old tier without belonging to it, nothing
    // reads them here, and reporting them would make every isolate announce a
    // legacy dependency that does not exist — a warning that always fires is a
    // warning nobody acts on.
    const perUserKey = `listColumns:not-a-user-${suffix}`;
    resetLegacyGlobalSettingsLog();
    putRow(null, perUserKey, { widgets: ["id"] });
    try {
      await loadSignInBranding(db, "sqlite");
      expect(legacyGlobalSettingsKeysSeen()).not.toContain(perUserKey);
      expect(
        legacyGlobalSettingsKeysSeen(),
        "nothing else was dragged in either",
      ).toEqual([]);
    } finally {
      dropRows(perUserKey);
    }
  });
});
