/**
 * Playground (DEMO_MODE) — the no-signup demo instance behind the website's
 * "try it live" funnel (roadmap #16).
 *
 *  - `/api/auth/providers` publishes the demo credentials (demo mode only),
 *  - the write-guard 403s outbound/destructive endpoints,
 *  - `resetDemoWorkspace` wipes visitor state (collections, users, api keys)
 *    and converges on a seeded workspace whose demo admin can sign in with
 *    the published credentials — including bootstrapping a brand-new DB via
 *    `maybeResetDemo` without any manual sign-up.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";
import { buildContext } from "../../src/server/context";
import { getTemplateLazy } from "../../src/server/templates/lazy";
import {
  DEMO_RETRY_BACKOFF_MS,
  demoResetIntervalMs,
  isDemoBlockedRequest,
  maybeResetDemo,
  resetDemoWorkspace,
} from "../../src/server/services/demo";

const JSON_HEADERS = { "Content-Type": "application/json" };

let h: TestHarness;
afterEach(() => h?.cleanup());

describe("demo mode — auth surface", () => {
  test("publishes demo credentials only when DEMO_MODE is set", async () => {
    h = makeHarness({ DEMO_MODE: "1" });
    const res = await h.fetch("/api/auth/providers");
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.demo).toEqual({ email: "demo@backlex.com", password: "playground" });
    h.cleanup();

    h = makeHarness();
    const plain = await h.fetch("/api/auth/providers");
    const { data: plainData } = (await plain.json()) as any;
    expect(plainData.demo).toBeUndefined();
  });

  test("DEMO_EMAIL / DEMO_PASSWORD override the published credentials", async () => {
    h = makeHarness({
      DEMO_MODE: "true",
      DEMO_EMAIL: "try@backlex.com",
      DEMO_PASSWORD: "let-me-in",
    });
    const { data } = (await (await h.fetch("/api/auth/providers")).json()) as any;
    expect(data.demo).toEqual({ email: "try@backlex.com", password: "let-me-in" });
  });
});

describe("demo mode — write guard", () => {
  test("isDemoBlockedRequest blocks writes on the deny-list, never reads", () => {
    expect(isDemoBlockedRequest("POST", "/api/admin/email-config")).toBe(true);
    expect(isDemoBlockedRequest("PATCH", "/api/admin/auth/config")).toBe(true);
    expect(isDemoBlockedRequest("POST", "/api/messaging/send")).toBe(true);
    expect(isDemoBlockedRequest("POST", "/api/auth/change-password")).toBe(true);
    expect(isDemoBlockedRequest("POST", "/api/admin/db/query")).toBe(true);
    expect(isDemoBlockedRequest("GET", "/api/admin/email-config")).toBe(false);
    // Prefix must match on a path boundary, not raw startsWith.
    expect(isDemoBlockedRequest("POST", "/api/admin/dbx")).toBe(false);
    // The demo experience itself stays writable.
    expect(isDemoBlockedRequest("POST", "/api/collections")).toBe(false);
    expect(isDemoBlockedRequest("POST", "/api/auth/sign-in/email")).toBe(false);
  });

  test("blocked endpoints 403 in demo mode and stay open otherwise", async () => {
    h = makeHarness({ DEMO_MODE: "1" });
    await seedAdmin(h, undefined, undefined, { openSignup: false });
    const blocked = await h.fetch("/api/admin/email-config", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    expect(blocked.status).toBe(403);
    const body = (await blocked.json()) as any;
    expect(body.error?.message ?? body.message).toContain("playground");
    // Reads on the same prefix still work.
    const read = await h.fetch("/api/admin/email-config");
    expect(read.status).not.toBe(403);
  });

  // The prefix list above blocks email CONFIG, but a template's send-test is a
  // relay of its own: any subject and body, to any address, from the
  // workspace's sender — and on a playground every visitor is an admin. Editing
  // a template stays open (it sends nothing); both ways of sending one do not.
  test("an email template's send-test is refused in demo mode, and editing it is not", async () => {
    h = makeHarness({ DEMO_MODE: "1" });
    await seedAdmin(h, undefined, undefined, { openSignup: false });
    const created = await h.fetch("/api/admin/email-templates", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ key: "demo_probe", name: "Probe", subject: "Hi", bodyHtml: "<p>Hi</p>" }),
    });
    expect(created.status).toBe(201);
    const { data } = (await created.json()) as { data: { id: string } };

    const draft = await h.fetch("/api/admin/email-templates/send-test", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: "someone@example.com", subject: "Anything", bodyHtml: "<p>Anything</p>" }),
    });
    expect(draft.status).toBe(403);
    const stored = await h.fetch(`/api/admin/email-templates/${data.id}/send-test`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ to: "someone@example.com" }),
    });
    expect(stored.status).toBe(403);

    const edited = await h.fetch(`/api/admin/email-templates/${data.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ subject: "Hello" }),
    });
    expect(edited.status).toBe(200);
  });
});

describe("demo mode — reset", () => {
  test("resetDemoWorkspace wipes visitor state and reseeds the demo admin + template", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    // A visitor-ish admin signs up (first user) and leaves junk behind.
    await seedAdmin(h, "visitor@example.test", "correct-horse-battery", {
      openSignup: false,
    });
    const created = await h.fetch("/api/collections", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: "junk",
        name: "Junk",
        fields: [{ name: "title", type: "text" }],
      }),
    });
    expect(created.status).toBe(201);

    const ctx = await buildContext(h.env);
    const result = await resetDemoWorkspace(ctx, h.env);
    expect(result.templateApplied).toBe(true);
    expect(result.droppedCollections).toBeGreaterThanOrEqual(1);

    // The visitor's account died with the wipe. (Within better-auth's 60s
    // cookie-cache window the stale session may still "authenticate", but the
    // user row is gone → 404; past the window it's a plain 401.)
    const stale = await h.fetch("/api/me");
    expect([401, 404]).toContain(stale.status);

    // The published demo credentials sign straight in as admin…
    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "demo@backlex.com", password: "playground" }),
    });
    expect(signIn.status).toBe(200);

    // …and see the seeded template collections, not the visitor's junk.
    const list = await h.fetch("/api/collections");
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as any;
    const slugs = (data as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).not.toContain("junk");
    expect(slugs.length).toBeGreaterThan(0);

    // A reset that just ran parks the timer for the full interval.
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(false);
    const later = new Date(Date.now() + demoResetIntervalMs(h.env) + 1000);
    expect(await maybeResetDemo(ctx, h.env, later)).toBe(true);
  });

  test("a failed reset hands the claim back instead of parking for the interval", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    const ctx = await buildContext(h.env);

    // Reproduce what took the live playground down: the D1 drifted behind the
    // schema, so every reset wiped the workspace and then died seeding roles.
    // The claim is written *before* the wipe, so the old code left visitors an
    // empty workspace with a role-less demo admin until the next hour.
    await (ctx.db as any).run(sql`DROP TABLE roles`);
    const t0 = new Date();
    await expect(maybeResetDemo(ctx, h.env, t0)).rejects.toThrow();

    // Inside the backoff window the claim still holds — no per-minute retry storm.
    const soon = new Date(t0.getTime() + DEMO_RETRY_BACKOFF_MS - 1000);
    expect(await maybeResetDemo(ctx, h.env, soon)).toBe(false);

    // Past it the reset is attempted again (and throws again, because the
    // schema is still broken) rather than sitting on a wiped workspace.
    const after = new Date(t0.getTime() + DEMO_RETRY_BACKOFF_MS + 1000);
    await expect(maybeResetDemo(ctx, h.env, after)).rejects.toThrow();
  });

  test("maybeResetDemo bootstraps a brand-new instance without any sign-up", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    const ctx = await buildContext(h.env);
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(true);

    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "demo@backlex.com", password: "playground" }),
    });
    expect(signIn.status).toBe(200);
    const list = await h.fetch("/api/collections");
    expect(list.status).toBe(200);
    const { data } = (await list.json()) as any;
    expect((data as unknown[]).length).toBeGreaterThan(0);
  });
});

/**
 * The playground ran for a month without six ecommerce collections (#386).
 * Their physical tables had lost their `collections` rows in August, while
 * branch builds replayed migrations against the live D1. The wipe dropped only
 * the tables the metadata listed, so the orphans survived every reset; the
 * template apply then skipped those slugs because the table existed; and the
 * reset reported success. Each spec below re-creates one link of that chain.
 */
describe("demo mode — a reset converges on the whole template", () => {
  /** Managed base tables on disk vs the ones a `collections` row points at. */
  const tableCensus = (harness: TestHarness) => {
    const db = new Database(harness.env.SQLITE_PATH as string);
    try {
      const onDisk = (db.query("select name from sqlite_master where type = 'table'").all() as { name: string }[])
        .map((r) => r.name)
        .filter((n) => /^c_[0-9a-f]{12}_[a-z0-9_]+$/.test(n) && !/__(i18n|fts)/.test(n));
      const described = (db.query("select slug, physical_table as t from collections").all() as { slug: string; t: string }[]);
      return { onDisk: onDisk.sort(), described };
    } finally {
      db.close();
    }
  };

  const templateSlugs = async (id: string) =>
    ((await getTemplateLazy(id))?.collections ?? []).map((c) => c.slug).sort();

  test("a table no collection points at is dropped, and its collection comes back with its rows", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    const ctx = await buildContext(h.env);
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(true);

    // Lose `tags`' metadata row and keep its table — the August state.
    const db = new Database(h.env.SQLITE_PATH as string);
    try {
      db.query("delete from collections where slug = 'tags'").run();
    } finally {
      db.close();
    }

    const result = await resetDemoWorkspace(ctx, h.env);
    expect(result.droppedOrphanTables).toBe(1);
    expect(result.templateApplied).toBe(true);

    const { onDisk, described } = tableCensus(h);
    expect(described.map((c) => c.slug).sort()).toEqual(await templateSlugs("blog"));
    // No table on disk that nothing describes.
    expect(onDisk).toEqual(described.map((c) => c.t).sort());

    const check = new Database(h.env.SQLITE_PATH as string);
    try {
      const tags = described.find((c) => c.slug === "tags")!;
      const rows = check.query(`select count(*) as n from "${tags.t}"`).get() as { n: number };
      // Sample rows are seeded only into a collection the apply CREATED; a
      // skipped one came back empty, and so did everything that referenced it.
      expect(rows.n).toBeGreaterThan(0);
    } finally {
      check.close();
    }
  });

  test("a collection the template could not create fails the reset, instead of reporting success", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    const ctx = await buildContext(h.env);
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(true);
    const tags = tableCensus(h).described.find((c) => c.slug === "tags")!;

    // A table that will not drop — the one failure the sweep cannot repair —
    // must surface as a failed reset (which `maybeResetDemo` retries within
    // minutes), not as an hour of a playground missing a collection.
    const realRun = (ctx.db as any).run.bind(ctx.db);
    (ctx.db as any).run = (query: any) => {
      const text = String(query?.queryChunks?.map((c: any) => c?.value ?? c).join("") ?? "");
      if (text.includes(`DROP TABLE IF EXISTS "${tags.t}"`)) throw new Error("simulated: table will not drop");
      return realRun(query);
    };
    try {
      await expect(resetDemoWorkspace(ctx, h.env)).rejects.toThrow(/uncreated on a wiped workspace: tags/);
    } finally {
      (ctx.db as any).run = realRun;
    }
  });

  test("the scheduler's sweep watermarks survive a reset, and nothing else borrowing the prefix does", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    const ctx = await buildContext(h.env);
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(true);
    const db = new Database(h.env.SQLITE_PATH as string);
    try {
      const tenant = db.query("select id from tenants limit 1").get() as { id: string };
      const insert = db.query("insert into app_settings (id, tenant_id, key, value, updated_at) values (?, ?, ?, '1', ?)");
      insert.run("__sweep__schema_reapply", null, "__sweep__schema_reapply", Date.now());
      insert.run(crypto.randomUUID(), tenant.id, "__sweep__visitor", Date.now());
    } finally {
      db.close();
    }
    await resetDemoWorkspace(ctx, h.env);
    const after = new Database(h.env.SQLITE_PATH as string);
    try {
      const keys = (after.query("select key from app_settings where key >= '__sweep__' and key < '__sweep_~'").all() as { key: string }[]).map((r) => r.key);
      // Wiped hourly, the DAILY reapply ran every hour, into the reset's own
      // table creation (`schema-reapply-failed … CREATE TABLE …brands__i18n`).
      expect(keys).toContain("__sweep__schema_reapply");
      // Kept only as the scheduler writes them: instance-wide. A workspace row
      // under the same prefix is visitor state and goes with the rest.
      expect(keys).not.toContain("__sweep__visitor");
    } finally {
      after.close();
    }
  });
});

/**
 * The route, as opposed to the service the tests above call directly.
 *
 * `POST /api/admin/demo/reset` is a one-request destructor: it drops every
 * managed collection's physical table and reseeds. The service refuses to run
 * outside demo mode, but the service is not what an operator's browser reaches
 * — the route is, and the route carries its OWN `isDemoMode` check plus three
 * middlewares. Nothing asserted that stack, so a production instance's admin
 * being one POST away from a wiped workspace would have been a silent change.
 */
describe("demo mode — the reset endpoint", () => {
  const reset = () => h.fetch("/api/admin/demo/reset", { method: "POST" });

  test("a normal instance does not have this endpoint at all", async () => {
    h = makeHarness(); // no DEMO_MODE
    await seedAdmin(h);
    // Liveness: an admin session that can reach other admin routes, so the 404
    // below is the demo gate and not a failed sign-in.
    expect((await h.fetch("/api/collections")).status).toBe(200);

    const res = await reset();
    expect(res.status).toBe(404);
    // Still signed in and still holding a workspace — the refusal must not have
    // been a half-run reset.
    expect((await h.fetch("/api/collections")).status).toBe(200);
  });

  test("a playground instance resets, and says what it did", async () => {
    h = makeHarness({ DEMO_MODE: "1", SEED_TEMPLATE: "blog" });
    // `seedAdmin` cannot be used here: it enables open signup first, and the
    // playground refuses that (403 "disabled in the playground"). The demo
    // admin is bootstrapped by the reset path itself and signs in with the
    // credentials the instance publishes.
    const ctx = await buildContext(h.env);
    expect(await maybeResetDemo(ctx, h.env, new Date())).toBe(true);
    const signIn = await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: "demo@backlex.com", password: "playground" }),
    });
    expect(signIn.status).toBe(200);

    const res = await reset();
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    // The service's own tests pin the wipe; what the ROUTE owes is the report,
    // because the admin UI renders it as the confirmation that anything ran.
    expect(data).toBeTruthy();
    expect(typeof data).toBe("object");
  });

  test("a signed-out visitor cannot reset the playground", async () => {
    // The instance is public and the credentials are printed on its sign-in
    // screen, which makes it tempting to treat the reset as public too. It is
    // not: an anonymous POST would let a passer-by wipe a live demo mid-use.
    h = makeHarness({ DEMO_MODE: "1" });
    const res = await h.app.request(
      "/api/admin/demo/reset",
      { method: "POST", headers: { origin: h.env.APP_URL as string } },
      h.env,
    );
    expect(res.status).toBe(401);
  });
});
