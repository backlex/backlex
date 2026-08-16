/**
 * The long-running admin operations, on the durable queue.
 *
 * Three properties this file exists to pin, in order of how much they would
 * cost to get wrong:
 *
 * 1. **The synchronous path did not move.** Every one of these routes has SDK,
 *    CLI, MCP and admin-SPA twins reading its response. `?async=1` is an opt-in
 *    door beside the old one, not a replacement for it, and the old one still
 *    answers the same status with the same keys.
 * 2. **A queued job carries an identity, never a permission.** The payload holds
 *    `{userId, tenantId}`; roles, workspace membership and the compiled row
 *    filter are resolved when the work runs. So a grant revoked while the job
 *    waited actually stops it — which is the whole reason the rule exists, and
 *    the assertion below removes the grant between enqueue and run to prove it.
 * 3. **Three kinds of caller are refused rather than queued.** An API key, a
 *    workspace end-user and an impersonation session each carry a narrowing that
 *    `{userId, tenantId}` cannot express, so re-resolving from the user id alone
 *    would hand the job MORE than the request had.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };
const GEOCODE_HOST = "http://nominatim.test";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

/** Nominatim stand-in: knows one place, answers everything else with the empty
 *  array a real one returns for an unknown address. */
const installGeocodeMock = (): { calls: string[]; restore: () => void } => {
  const real = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!href.startsWith(GEOCODE_HOST)) return real(input as never, init);
    const url = new URL(href);
    const q = url.searchParams.get("q") ?? "";
    calls.push(q);
    return Response.json(
      q.includes("Sultanahmet")
        ? [{ lat: "41.0082", lon: "28.9784", display_name: "Sultanahmet" }]
        : [],
    );
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = real; } };
};

interface JobShape {
  id: string;
  status: string;
  attempts: number;
  lastError: string | null;
  result: unknown;
  progress: { done: number; total: number | null; phase?: string; note?: string } | null;
}

/**
 * Wait for a queued job to reach a terminal status.
 *
 * The route starts the job inline (there is no ExecutionContext in the harness,
 * so the promise simply runs), which usually lands within a tick or two — but
 * "usually" is not a test, so this polls to a bound and fails loudly with the
 * job's own state rather than timing out anonymously.
 */
const waitForJob = async (h: TestHarness, id: string, tries = 200): Promise<JobShape> => {
  let last: JobShape | null = null;
  for (let i = 0; i < tries; i += 1) {
    const res = await h.fetch(`/api/jobs/${id}`);
    last = (await res.json()) as JobShape;
    if (["succeeded", "failed", "dead_letter", "cancelled"].includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${id} never finished; last seen ${JSON.stringify(last)}`);
};

describe("long-running ops — the durable queue", () => {
  let h: TestHarness;
  let mock: ReturnType<typeof installGeocodeMock>;

  const clinics = "jobs_clinics";

  beforeEach(async () => {
    h = makeHarness({ GEOCODE_PROVIDER: "nominatim", GEOCODE_URL: GEOCODE_HOST });
    await seedAdmin(h);
    mock = installGeocodeMock();
    const made = await h.fetch(
      "/api/collections",
      json({
        slug: clinics,
        fields: [
          { name: "name", type: "text", required: true, searchable: true },
          { name: "address", type: "text" },
          { name: "owner_tag", type: "text" },
          { name: "location", type: "geo", geo: { geocodeFrom: ["address"] } },
        ],
      }),
    );
    expect(made.status).toBe(201);
  });

  afterEach(() => {
    mock.restore();
    h.cleanup();
  });

  // ── the door beside the old one ────────────────────────────────────────

  describe("the synchronous path is untouched", () => {
    test("backup still answers 201 with the backup row", async () => {
      const res = await h.fetch("/api/admin/db/backups/now", json({ label: "sync" }));
      expect(res.status).toBe(201);
      const body = (await res.json()) as any;
      // The exact keys four other surfaces read off this response.
      expect(body.data).toMatchObject({ status: "done", kind: "manual", label: "sync" });
      expect(typeof body.data.storageKey).toBe("string");
      expect(body.data.jobId).toBeUndefined();
    });

    test("fts-reindex still answers 200 with {ok, processed, skipped, total}", async () => {
      await h.fetch(`/api/collections/${clinics}`, json({ fts: true }, "PATCH"));
      const res = await h.fetch(`/api/collections/${clinics}/fts-reindex`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Object.keys(body).sort()).toEqual(["ok", "processed", "skipped", "total"]);
    });

    test("geo backfill still answers 200 with one bounded batch", async () => {
      await h.fetch(`/api/items/${clinics}`, json({ name: "a", address: "Sultanahmet" }));
      await h.fetch(`/api/items/${clinics}`, json({ name: "b", address: "Nowhere At All" }));
      // Clear the points the write path filled in, so there is something to
      // backfill. (A create geocodes; only an import or an adopted table
      // arrives without one.)
      await h.fetch(
        "/api/admin/db/sql/run?writes=1",
        {
          ...json({ sql: `UPDATE c_%_${clinics} SET location = NULL` }),
          headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
        },
      ).catch(() => undefined);
      const res = await h.fetch(
        `/api/geo/backfill/${clinics}`,
        json({ field: "location", limit: 10 }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(Object.keys(body.data).sort()).toEqual([
        "located",
        "remaining",
        "skipped",
        "unresolved",
      ]);
    });
  });

  // ── the queued path ───────────────────────────────────────────────────

  describe("?async=1", () => {
    test("a backup runs on the queue, and the tracking row exists immediately", async () => {
      const res = await h.fetch("/api/admin/db/backups/now?async=1", json({ label: "queued" }));
      expect(res.status).toBe(202);
      const { data } = (await res.json()) as any;
      expect(typeof data.jobId).toBe("string");
      expect(typeof data.backupId).toBe("string");
      expect(data.status).toBe("queued");

      // The backup is listed before any worker has touched it — that is what
      // makes the 202 usable, rather than a job id pointing at nothing.
      const listed = (await (await h.fetch("/api/admin/db/backups")).json()) as any;
      expect(listed.data.some((b: any) => b.id === data.backupId)).toBe(true);

      const job = await waitForJob(h, data.jobId);
      expect(job.status).toBe("succeeded");
      expect((job.result as any).backupId).toBe(data.backupId);

      const after = (await (await h.fetch("/api/admin/db/backups")).json()) as any;
      const row = after.data.find((b: any) => b.id === data.backupId);
      expect(row.status).toBe("done");
      expect(row.tableCount).toBeGreaterThan(0);
    });

    test("a dump reports progress as it walks, and the reading is a real one", async () => {
      const res = await h.fetch("/api/admin/db/backups/now?async=1", json({}));
      const { data } = (await res.json()) as any;
      const job = await waitForJob(h, data.jobId);
      expect(job.status).toBe("succeeded");
      // Written once per table, so the last reading is the whole walk. A job
      // that never reported would leave this null — which the UI renders as
      // "—", NOT as 0%, and is the state this assertion distinguishes from.
      expect(job.progress).not.toBeNull();
      expect(job.progress!.done).toBeGreaterThan(0);
      expect(job.progress!.total).toBeGreaterThanOrEqual(job.progress!.done);
      expect(job.progress!.phase).toBe("dump");
    });

    test("a reindex runs on the queue and reports what it did", async () => {
      await h.fetch(`/api/collections/${clinics}`, json({ fts: true }, "PATCH"));
      await h.fetch(`/api/items/${clinics}`, json({ name: "searchable", address: "x" }));
      const res = await h.fetch(`/api/collections/${clinics}/fts-reindex?async=1`, {
        method: "POST",
      });
      expect(res.status).toBe(202);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.mode).toBe("fts");
      const job = await waitForJob(h, body.jobId);
      expect(job.status).toBe("succeeded");
      expect((job.result as any).fts).toBeDefined();
    });

    test("a queued job is enqueued as its own type, not as a client-enqueueable one", async () => {
      const res = await h.fetch("/api/admin/db/backups/now?async=1", json({}));
      const { data } = (await res.json()) as any;
      const job = (await (await h.fetch(`/api/jobs/${data.jobId}`)).json()) as any;
      expect(job.type).toBe("db.backup");
      // And the client allow-list still refuses to take one by hand — the six
      // internal types accept a `runAs` the caller must never be able to write.
      const forged = await h.fetch(
        "/api/jobs",
        json({ type: "db.backup", payload: { runAs: { userId: "x", tenantId: "y" } } }),
      );
      expect(forged.status).toBe(422);
      // Let the inline run finish before the harness tears its database down —
      // the job is detached by design, and a dangling one writes into a file
      // that no longer exists.
      await waitForJob(h, data.jobId);
    });
  });

  // ── who may queue ─────────────────────────────────────────────────────

  describe("callers that are refused rather than queued", () => {
    test("an API key cannot queue — it would run as its owner, which is wider", async () => {
      const key = await h.fetch("/api/api-keys", json({ name: "ops" }));
      const created = (await key.json()) as any;
      const secret = created.data.secret as string;
      expect(typeof secret).toBe("string");

      // Synchronous still works for the key: the refusal is about the queue,
      // not about the operation.
      const sync = await h.app.request("/api/admin/db/backups/now", {
        method: "POST",
        headers: { ...JSON_HEADERS, authorization: `Bearer ${secret}` },
        body: JSON.stringify({}),
      });
      expect(sync.status).toBe(201);

      const before = ((await (await h.fetch("/api/admin/db/backups")).json()) as any).data
        .length;
      const queued = await h.app.request("/api/admin/db/backups/now?async=1", {
        method: "POST",
        headers: { ...JSON_HEADERS, authorization: `Bearer ${secret}` },
        body: JSON.stringify({}),
      });
      expect(queued.status).toBe(422);
      expect(await queued.text()).toContain("API key");
      // And the refusal came BEFORE anything was written. Refusing after the
      // tracking row exists would leave a `queued` backup in the workspace's
      // list that no job will ever run — which reads as a dump in progress.
      const after = ((await (await h.fetch("/api/admin/db/backups")).json()) as any).data
        .length;
      expect(after).toBe(before);
    });

    test("a workspace end-user cannot queue a backfill", async () => {
      const roleRes = await h.fetch("/api/roles", json({ name: "Portal" }));
      const roleId = ((await roleRes.json()) as any).data.id;
      for (const action of ["read", "update"]) {
        await h.fetch(
          `/api/roles/${roleId}/permissions`,
          json({ collection: clinics, action }),
        );
      }
      const signup = await h.fetch(
        "/api/t/default/auth/sign-up/email",
        json({ email: "portal.jobs@example.com", password: "portal-pass-123", name: "P" }),
      );
      expect(signup.status).toBe(200);
      const token = ((await signup.json()) as any).token as string;
      const users = (await (await h.fetch("/api/app-users")).json()) as any;
      const appUserId = users.data.find((u: any) => u.email === "portal.jobs@example.com").id;
      await h.fetch(`/api/app-users/${appUserId}/roles`, {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({ roleIds: [roleId] }),
      });

      const queued = await h.app.request(`/api/geo/backfill/${clinics}?async=1`, {
        method: "POST",
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ field: "location" }),
      });
      expect(queued.status).toBe(422);
      expect(await queued.text()).toContain("end-users");

      // The synchronous door is still open to them, narrowed by their grant.
      const sync = await h.app.request(`/api/geo/backfill/${clinics}`, {
        method: "POST",
        headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
        body: JSON.stringify({ field: "location" }),
      });
      expect(sync.status).toBe(200);
    });
  });

  // ── identity is re-resolved, not remembered ───────────────────────────

  describe("a job re-resolves its permissions when it runs", () => {
    test("a backup queued by an admin who is then demoted does not run", async () => {
      // Queue one and let it succeed, so the assertion below is about the
      // membership check and not about a job that was broken all along.
      const first = await h.fetch("/api/admin/db/backups/now?async=1", json({}));
      expect(first.status).toBe(202);
      const okJob = await waitForJob(h, ((await first.json()) as any).data.jobId);
      expect(okJob.status).toBe("succeeded");

      const me = (await (await h.fetch("/api/me")).json()) as any;
      const userId = me.data?.id ?? me.id;
      const tenantId = me.data?.tenantId ?? me.tenantId;
      expect(typeof userId).toBe("string");

      // Queue a second one, THEN take the membership away before it runs. The
      // payload still names the same user; only the database's answer changed.
      const { buildContext } = await import("../src/server/context");
      const { enqueueJob, runJobInline, getJob } = await import("../src/server/services/jobs");
      const { createBackupRow } = await import("../src/server/services/backup");
      const ctx = await buildContext(h.env);
      const row = await createBackupRow(ctx, { tenantId, userId, label: "revoked" });
      const { id } = await enqueueJob(ctx, {
        type: "db.backup",
        queue: "ops",
        tenantId,
        payload: { backupId: row.id, runAs: { userId, tenantId } },
        maxAttempts: 3,
        runAt: new Date(Date.now() + 3_600_000),
      });

      // Both halves, and the second one is the point: dropping the membership
      // alone proves nothing about a global admin, because the request path
      // deliberately lets one act in a workspace it is not a member of (the
      // support shortcut) — and `resolveTenantAccess` is the SAME function, so
      // the job inherits that. Taking the admin role away too is what leaves
      // the user with no route into this workspace at all.
      const wiped = await h.fetch("/api/admin/db/sql/run?writes=1", {
        ...json({
          sql:
            `DELETE FROM tenant_members WHERE user_id = '${userId}';` +
            `DELETE FROM user_roles WHERE user_id = '${userId}'`,
        }),
        headers: { ...JSON_HEADERS, "x-backlex-confirm": "yes" },
      });
      expect(wiped.status).toBe(200);
      const { invalidateAllPermissions } = await import(
        "../src/server/services/permissions-cache"
      );
      invalidateAllPermissions();

      await runJobInline(ctx, id);
      const after = await getJob(ctx, id);
      // Refused, and dead-lettered on the FIRST hearing rather than retried —
      // a revoked grant will not come back on a sixty-second backoff.
      expect(after?.status).toBe("dead_letter");
      expect(String(after?.lastError)).toContain("can no longer act");
      // And the dump genuinely did not happen: the backup row is still queued.
      // Read through the service rather than the API — the user whose roles we
      // just removed can no longer list backups, which is itself the point.
      const { getBackupScoped } = await import("../src/server/services/backup");
      expect((await getBackupScoped(ctx, tenantId, row.id)).status).toBe("queued");
    });
  });

  // ── the row filter is the caller's, resolved when the work runs ───────

  describe("a queued backfill sees only the rows its grant matches", () => {
    /**
     * The escalation this rules out, spelled out because it is the reason the
     * payload rule exists at all: the bundled self-service roles grant `update`
     * conditioned on a column, so holding `update` on a collection is not
     * holding it on every ROW of it. A job that ran as the system — or that
     * carried a filter serialized an hour earlier — would geocode every other
     * customer's address and ship it to a third-party provider on the way.
     *
     * This runs as a non-admin CONTROL-PLANE user, because that is the only
     * identity that both survives `assertQueueable` and is genuinely narrowed
     * by a row condition (an admin has no filter to apply, and an app-plane
     * end-user is refused the queue outright).
     */
    test("a conditioned grant narrows the job, not just the request", async () => {
      const roleRes = await h.fetch("/api/roles", json({ name: "Field Staff" }));
      const roleId = ((await roleRes.json()) as any).data.id;
      for (const action of ["read", "update"]) {
        const p = await h.fetch(
          `/api/roles/${roleId}/permissions`,
          json({ collection: clinics, action, condition: { owner_tag: { _eq: "$user.id" } } }),
        );
        expect(p.status).toBe(201);
      }

      // Rows first, as the admin — one for the staffer, one for somebody else.
      // `location: null` because a create geocodes on the way in; a backfill
      // exists for rows that arrived without a point.
      const mk = async (name: string, owner: string) => {
        const r = await h.fetch(
          `/api/items/${clinics}`,
          json({ name, address: "Sultanahmet", owner_tag: owner, location: null }),
        );
        expect(r.status).toBe(201);
      };

      // A second control-plane user: signs up as `authenticated`, not admin.
      // Through `h.app.request`, NOT `h.fetch` — the harness tracks cookies, and
      // signing up through it would swap the admin session out from under the
      // rest of this test.
      const email = `staff-${Date.now()}@example.test`;
      const su = await h.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email, password: "correct-horse-battery", name: "Field Staff" }),
      });
      expect(su.status).toBe(200);
      const staffId = ((await su.json()) as any).user.id as string;
      const me = (await (await h.fetch("/api/me")).json()) as any;
      const tenantId = me.data?.tenantId ?? me.tenantId;

      const { buildContext } = await import("../src/server/context");
      const ctx = await buildContext(h.env);
      const { runJobInline, enqueueJob, getJob } = await import("../src/server/services/jobs");
      const grant = await h.fetch(`/api/users/${staffId}/roles`, json({ roleId }));
      expect(grant.status).toBe(200);
      const { invalidateAllPermissions } = await import(
        "../src/server/services/permissions-cache"
      );
      invalidateAllPermissions();

      await mk("mine", staffId);
      await mk("theirs", "someone-else");
      const callsBefore = mock.calls.length;

      const { id } = await enqueueJob(ctx, {
        type: "geo.backfill",
        queue: "ops",
        tenantId,
        payload: {
          slug: clinics,
          field: "location",
          batch: 50,
          runAs: { userId: staffId, tenantId },
        },
        maxAttempts: 2,
        runAt: new Date(Date.now() + 3_600_000),
      });
      await runJobInline(ctx, id);

      const job = await getJob(ctx, id);
      expect(job?.status).toBe("succeeded");
      expect((job?.result as any).located).toBe(1);
      // Exactly one provider call — the other customer's address never left the
      // building, which is the half a row count alone would not prove.
      expect(mock.calls.length - callsBefore).toBe(1);

      const rows = (await (await h.fetch(`/api/items/${clinics}?limit=100`)).json()) as any;
      const byName = Object.fromEntries(rows.data.map((r: any) => [r.name, r.location]));
      expect(byName.mine).toEqual({ lat: 41.0082, lng: 28.9784 });
      // The staffer can only READ their own row too, so `theirs` is absent
      // rather than present-and-unlocated. Either way it has no point.
      expect(byName.theirs ?? null).toBeNull();
    });
  });

  // ── the claim is atomic ───────────────────────────────────────────────

  test("a job can only be claimed once, so the inline start cannot double-run it", async () => {
    const { buildContext } = await import("../src/server/context");
    const { enqueueJob, claimJobById, getJob } = await import("../src/server/services/jobs");
    const me = (await (await h.fetch("/api/me")).json()) as any;
    const tenantId = me.data?.tenantId ?? me.tenantId;
    const ctx = await buildContext(h.env);
    const { id } = await enqueueJob(ctx, {
      type: "db.backup",
      tenantId,
      payload: {},
      // Far enough out that the tick cannot take it while this runs.
      runAt: new Date(Date.now() + 3_600_000),
    });
    const first = await claimJobById(ctx, id);
    const second = await claimJobById(ctx, id);
    expect(first?.id).toBe(id);
    // The one that lost gets null, and null means DO NOTHING — a second copy of
    // a restore or an import is exactly what this prevents.
    expect(second).toBeNull();
    // And the claim spent one attempt, not two.
    expect((await getJob(ctx, id))?.attempts).toBe(1);
    // The winner really did get the whole row, on both dialects: `progress` and
    // the timestamps are in the claim projection, not just the SQLite one.
    expect(Object.keys(first!)).toContain("progress");
    expect(Object.keys(first!)).toContain("createdAt");
  });
});
