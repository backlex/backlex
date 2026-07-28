/**
 * Regression gates for the 2026-07 security audit.
 *
 * Every test here pins a fix for a confirmed cross-tenant / stored-XSS /
 * traversal finding. The shared premise of most of them: `POST /api/tenants` is
 * open to any authenticated user and grants the creator `admin` **in the
 * workspace they just created**. That makes "workspace admin" a self-serve,
 * low-trust principal, so it must never authorize anything that spans another
 * workspace or the instance.
 *
 * Cast of characters, reused by every block:
 *   - **operator** — the first signup. Auto-promoted to `admin` in the default
 *     workspace, which is what `isInstanceOperator` recognises.
 *   - **attacker** — a later signup. Lands in `default` as `authenticated`,
 *     then creates workspace `evil` and is `admin` there and only there.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { processJobsWithEnv } from "../src/server/services/jobs";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

const signIn = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD }),
  });

const signOut = (h: TestHarness) =>
  h.fetch("/api/auth/sign-out", { method: "POST" });

const signUp = async (h: TestHarness, email: string) => {
  const res = await h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
  if (!res.ok) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
};

interface Cast {
  h: TestHarness;
  operatorEmail: string;
  attackerEmail: string;
  defaultTenantId: string;
  /** Workspace owned by the operator alone. Note we can NOT use `default` as
   *  the victim: `onUserCreated` lands every signup in it as a member, so the
   *  attacker legitimately belongs there. */
  victimTenantId: string;
  evilTenantId: string;
  evilSlug: string;
}

/** operator → default workspace; attacker → self-created `evil` workspace. */
const buildCast = async (): Promise<Cast> => {
  const h = makeHarness();
  const suffix = `${Date.now()}`.slice(-7);

  const operator = await seedAdmin(h, `operator-${suffix}@example.test`);
  const tenantList = await h.fetch("/api/tenants");
  const listed = (await tenantList.json()) as { data: { id: string; slug: string }[] };
  const defaultTenantId = listed.data.find((t) => t.slug === "default")!.id;

  const victim = await h.fetch("/api/tenants", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: `Victim ${suffix}` }),
  });
  expect(victim.status).toBe(201);
  const victimTenantId = ((await victim.json()) as { data: { id: string } }).data.id;

  await signOut(h);
  const attackerEmail = `attacker-${suffix}@example.test`;
  await signUp(h, attackerEmail);

  const created = await h.fetch("/api/tenants", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name: `Evil ${suffix}` }),
  });
  expect(created.status).toBe(201);
  const evil = (await created.json()) as { data: { id: string; slug: string } };

  return {
    h,
    operatorEmail: operator.email,
    attackerEmail,
    defaultTenantId,
    victimTenantId,
    evilTenantId: evil.data.id,
    evilSlug: evil.data.slug,
  };
};

// ---------------------------------------------------------------------------
// Finding 2 — /api/tenants/{id}/* authorized against the ACTIVE workspace
// ---------------------------------------------------------------------------

describe("finding 2: workspace routes authorize against the path workspace", () => {
  let cast: Cast;
  /** Header pins the attacker's ACTIVE workspace to the one they own — the
   *  exact shape of the original bypass: admin *there*, acting on `default`. */
  const asAttacker = () => ({ "X-Backlex-Tenant": cast.evilSlug });

  beforeAll(async () => {
    cast = await buildCast();
    // The cast leaves us signed in as the attacker.
  });
  afterAll(() => cast.h.cleanup());

  test("cannot invite themselves into a workspace they do not belong to", async () => {
    const res = await cast.h.fetch(
      `/api/tenants/${cast.victimTenantId}/members/invite`,
      {
        method: "POST",
        headers: { ...JSON_HEADERS, ...asAttacker() },
        body: JSON.stringify({ email: cast.attackerEmail, role: "owner" }),
      },
    );
    expect(res.status).toBe(403);
  });

  test("cannot list another workspace's members", async () => {
    const res = await cast.h.fetch(
      `/api/tenants/${cast.victimTenantId}/members`,
      { headers: asAttacker() },
    );
    expect(res.status).toBe(403);
  });

  test("cannot remove a member of another workspace", async () => {
    const res = await cast.h.fetch(
      `/api/tenants/${cast.victimTenantId}/members/some-member-id`,
      { method: "DELETE", headers: asAttacker() },
    );
    expect(res.status).toBe(403);
  });

  test("the member list never returns live invite tokens", async () => {
    // Read the attacker's OWN workspace — allowed — after creating a pending
    // invite there. `select()` used to hand back `invite_token`, i.e. a
    // credential that accepts the invite, to every member of the workspace.
    const invite = await cast.h.fetch(
      `/api/tenants/${cast.evilTenantId}/members/invite`,
      {
        method: "POST",
        headers: { ...JSON_HEADERS, ...asAttacker() },
        body: JSON.stringify({ email: `guest-${Date.now()}@example.test`, role: "member" }),
      },
    );
    expect(invite.status).toBe(201);

    const res = await cast.h.fetch(`/api/tenants/${cast.evilTenantId}/members`, {
      headers: asAttacker(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(row).not.toHaveProperty("inviteToken");
      expect(row).not.toHaveProperty("invite_token");
    }
  });

  test("owner/admin of the path workspace is still allowed", async () => {
    // The fix must not break the legitimate case it replaced.
    const res = await cast.h.fetch(`/api/tenants/${cast.evilTenantId}/members`, {
      headers: asAttacker(),
    });
    expect(res.status).toBe(200);
  });

  test("the instance operator keeps the cross-workspace escape hatch", async () => {
    await signOut(cast.h);
    expect((await signIn(cast.h, cast.operatorEmail)).ok).toBe(true);
    const res = await cast.h.fetch(`/api/tenants/${cast.evilTenantId}/members`, {
      headers: { "X-Backlex-Tenant": "default" },
    });
    expect(res.status).toBe(200);
    // Restore the attacker session for any later block sharing this harness.
    await signOut(cast.h);
    await signIn(cast.h, cast.attackerEmail);
  });
});

// ---------------------------------------------------------------------------
// Finding 3 — instance-wide SQL gated on the self-serve `admin` role
// ---------------------------------------------------------------------------

describe("finding 3: raw SQL requires the instance operator", () => {
  let cast: Cast;

  beforeAll(async () => {
    cast = await buildCast();
  });
  afterAll(() => cast.h.cleanup());

  test("a self-created workspace admin cannot run SQL", async () => {
    const res = await cast.h.fetch("/api/admin/db/sql/run", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": cast.evilSlug },
      body: JSON.stringify({ sql: "SELECT id, email FROM users" }),
    });
    expect(res.status).toBe(403);
  });

  test("nor reach the instance-wide table inventory", async () => {
    const res = await cast.h.fetch("/api/admin/db/tables", {
      headers: { "X-Backlex-Tenant": cast.evilSlug },
    });
    expect(res.status).toBe(403);
  });

  test("the instance operator still can", async () => {
    await signOut(cast.h);
    expect((await signIn(cast.h, cast.operatorEmail)).ok).toBe(true);
    const res = await cast.h.fetch("/api/admin/db/sql/run", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": "default" },
      body: JSON.stringify({ sql: "SELECT 1 AS one" }),
    });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Finding 8 — global session admin
// ---------------------------------------------------------------------------

describe("finding 8: admin session routes are workspace-scoped", () => {
  let cast: Cast;

  beforeAll(async () => {
    cast = await buildCast();
  });
  afterAll(() => cast.h.cleanup());

  test("the session list never leaks non-members' email or IP", async () => {
    const res = await cast.h.fetch("/api/admin/auth/sessions", {
      headers: { "X-Backlex-Tenant": cast.evilSlug },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { userEmail: string }[] };
    // Only the attacker belongs to `evil`; the operator's session must not show.
    for (const row of body.data) {
      expect(row.userEmail).not.toBe(cast.operatorEmail);
    }
  });

  test("revoking a non-member's session is refused", async () => {
    // Grab a real session id from the operator's own (correctly scoped) view.
    await signOut(cast.h);
    await signIn(cast.h, cast.operatorEmail);
    const listed = await cast.h.fetch("/api/admin/auth/sessions", {
      headers: { "X-Backlex-Tenant": "default" },
    });
    expect(listed.status).toBe(200);
    const rows = (await listed.json()) as { data: { id: string; userEmail: string }[] };
    const operatorSession = rows.data.find((r) => r.userEmail === cast.operatorEmail);
    expect(operatorSession).toBeTruthy();

    // Sign in as the attacker WITHOUT signing out — sign-out would delete the
    // very session row this test targets, turning the check into a no-op 200.
    await signIn(cast.h, cast.attackerEmail);
    const res = await cast.h.fetch(
      `/api/admin/auth/sessions/${operatorSession!.id}`,
      { method: "DELETE", headers: { "X-Backlex-Tenant": cast.evilSlug } },
    );
    // 404 from assertTenantMember ("User not in this workspace").
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Findings 1 + 4 — event fan-out crossing workspace boundaries
// ---------------------------------------------------------------------------

describe("findings 1+4: flows and webhooks never fan out across workspaces", () => {
  let cast: Cast;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let baseUrl = "";
  const captured: string[] = [];
  const victimSlug = `victim_${Date.now()}`.slice(0, 24);
  const attackerSlug = `owned_${Date.now()}`.slice(0, 24);

  const createCollection = (h: TestHarness, slug: string, headers: HeadersInit = {}) =>
    h.fetch("/api/collections", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...headers },
      body: JSON.stringify({
        slug,
        fields: [{ name: "title", type: "text" }],
      }),
    });

  /** Pump the durable queue a few times — webhook delivery is enqueued as a
   *  `webhook.deliver` job, so nothing reaches the receiver without this. */
  const drain = async () => {
    for (let i = 0; i < 4; i++) {
      await processJobsWithEnv(cast.h.env);
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        captured.push(new URL(req.url).pathname);
        return new Response("ok");
      },
    });
    baseUrl = `http://localhost:${server.port}`;

    cast = await buildCast();
    const asAttacker = { "X-Backlex-Tenant": cast.evilSlug };

    // Attacker arms both fan-out paths inside their OWN workspace.
    const hook = await cast.h.fetch("/api/webhooks", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...asAttacker },
      body: JSON.stringify({
        name: "exfil",
        url: `${baseUrl}/webhook-leak`,
        events: ["items"],
        secret: "s",
        active: true,
      }),
    });
    expect(hook.status).toBeLessThan(300);

    const flow = await cast.h.fetch("/api/flows", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...asAttacker },
      body: JSON.stringify({
        name: "exfil-flow",
        trigger: "event:items:*",
        active: true,
        operations: [{ type: "webhook", url: `${baseUrl}/flow-leak` }],
      }),
    });
    expect(flow.status).toBeLessThan(300);

    // …and a collection to prove the arming actually works (positive control).
    expect((await createCollection(cast.h, attackerSlug, asAttacker)).status).toBeLessThan(300);

    // The victim (operator, default workspace) writes an item.
    await signOut(cast.h);
    await signIn(cast.h, cast.operatorEmail);
    const asVictim = { "X-Backlex-Tenant": "default" };
    expect(
      (await createCollection(cast.h, victimSlug, asVictim)).status,
    ).toBeLessThan(300);
    const write = await cast.h.fetch(`/api/items/${victimSlug}`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...asVictim },
      body: JSON.stringify({ title: "tenant-A-confidential" }),
    });
    expect(write.status).toBe(201);
    await drain();
  });

  afterAll(() => {
    server?.stop(true);
    cast.h.cleanup();
  });

  test("another workspace's item write reaches neither the hook nor the flow", () => {
    expect(captured).not.toContain("/webhook-leak");
    expect(captured).not.toContain("/flow-leak");
  });

  test("positive control: the same hook + flow DO fire inside their own workspace", async () => {
    await signOut(cast.h);
    await signIn(cast.h, cast.attackerEmail);
    const write = await cast.h.fetch(`/api/items/${attackerSlug}`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": cast.evilSlug },
      body: JSON.stringify({ title: "my-own-row" }),
    });
    expect(write.status).toBe(201);
    await drain();
    // Proves the assertion above is not passing simply because nothing fires.
    expect(captured).toContain("/webhook-leak");
    expect(captured).toContain("/flow-leak");
  });
});

// ---------------------------------------------------------------------------
// Finding 5 — stored XSS via an attacker-chosen content type
// ---------------------------------------------------------------------------

describe("finding 5: uploaded objects are served inert", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("an uploaded text/html object cannot execute on the app origin", async () => {
    const put = await h.fetch("/api/storage/evil.html", {
      method: "PUT",
      headers: { "Content-Type": "text/html" },
      body: "<script>alert(document.cookie)</script>",
    });
    expect(put.status).toBeLessThan(300);

    const get = await h.fetch("/api/storage/evil.html");
    expect(get.status).toBe(200);
    // `sandbox` with no allow-scripts → opaque origin, scripting disabled.
    expect(get.headers.get("content-security-policy")).toContain("sandbox");
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
    expect(get.headers.get("content-disposition")).toBe("attachment");
  });

  test("a benign image is still served inline", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const put = await h.fetch("/api/storage/logo.png", {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: png,
    });
    expect(put.status).toBeLessThan(300);

    const get = await h.fetch("/api/storage/logo.png");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    // No forced download for renderable types — the admin previews these.
    expect(get.headers.get("content-disposition")).toBeNull();
    expect(get.headers.get("content-security-policy")).toContain("sandbox");
  });

  test("content-type parameters cannot smuggle an executable type past the guard", async () => {
    const put = await h.fetch("/api/storage/smuggled.html", {
      method: "PUT",
      headers: { "Content-Type": "TEXT/HTML ;charset=utf-8" },
      body: "<script>1</script>",
    });
    expect(put.status).toBeLessThan(300);
    const get = await h.fetch("/api/storage/smuggled.html");
    expect(get.headers.get("content-disposition")).toBe("attachment");
  });
});

// ---------------------------------------------------------------------------
// Finding 6 — path traversal through the public branding asset
// ---------------------------------------------------------------------------

describe("finding 6: branding file keys cannot traverse", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  const put = (logoFileKey: string) =>
    h.fetch("/api/workspace-config", {
      method: "PUT",
      headers: JSON_HEADERS,
      body: JSON.stringify({ logoFileKey }),
    });

  test("a traversal key is rejected at write time", async () => {
    const res = await put("../../../backlex.sqlite");
    expect(res.status).toBe(422);
  });

  test("percent-encoded traversal is rejected too", async () => {
    const res = await put("%2e%2e/%2e%2e/backlex.sqlite");
    expect(res.status).toBe(422);
  });

  test("an absolute key is rejected", async () => {
    const res = await put("/etc/passwd");
    expect(res.status).toBe(422);
  });

  test("an ordinary key is still accepted", async () => {
    const res = await put("branding/logo.png");
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Finding 7 — flow `function` op resolving names across workspaces
// ---------------------------------------------------------------------------

describe("finding 7: the flow function op stays inside its workspace", () => {
  let cast: Cast;
  const victimFn = `victim_fn_${Date.now()}`.slice(0, 30);

  beforeAll(async () => {
    cast = await buildCast();

    // Victim (operator, default workspace) owns a function.
    await signOut(cast.h);
    await signIn(cast.h, cast.operatorEmail);
    const fn = await cast.h.fetch("/api/functions", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": "default" },
      body: JSON.stringify({
        name: victimFn,
        trigger: "http",
        timeoutMs: 3000,
        code: "return { secret: 'TENANT-A-SECRET' };",
        active: true,
      }),
    });
    expect(fn.status).toBeLessThan(300);

    await signOut(cast.h);
    await signIn(cast.h, cast.attackerEmail);
  });
  afterAll(() => cast.h.cleanup());

  test("a flow cannot call another workspace's function by name", async () => {
    const asAttacker = { "X-Backlex-Tenant": cast.evilSlug };
    const flow = await cast.h.fetch("/api/flows", {
      method: "POST",
      headers: { ...JSON_HEADERS, ...asAttacker },
      body: JSON.stringify({
        name: "steal",
        trigger: "manual:steal",
        active: true,
        operations: [{ type: "function", name: victimFn }],
      }),
    });
    expect(flow.status).toBeLessThan(300);
    const created = (await flow.json()) as { data: { id: string } };

    const run = await cast.h.fetch(`/api/flows/${created.data.id}/run`, {
      method: "POST",
      headers: { ...JSON_HEADERS, ...asAttacker },
      body: JSON.stringify({}),
    });
    expect(run.status).toBe(200);
    const result = (await run.json()) as { ok: boolean; error?: string };
    // The run must fail on a not-found lookup, never execute the victim's code.
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("not found");
  });
});
