/**
 * Durable integration delivery: the log, the circuit breaker, the queue hop,
 * and the tenant guards around them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { FetchLike } from "@backlex/integrations";
import {
  INTEGRATION_AUTODISABLE_THRESHOLD,
  connectIntegration,
  deliverIntegrationById,
  disconnectIntegration,
  dispatchIntegrations,
  listIntegrationDeliveries,
  listIntegrations,
  resumeIntegration,
} from "../src/server/services/integrations";
import { makeHarness, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
let ctx: { db: any; dialect: "sqlite" };

/** A fetch seam that answers with a fixed status and counts calls. */
function responder(status: number) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(String(url));
    return new Response(null, { status }) as unknown as Response;
  };
  return { fetch, calls };
}

const SLACK = { webhookUrl: "https://hooks.slack.com/services/X" };
const created = (id: string) => ({ event: "created", data: { id } });

const connectSlack = () =>
  connectIntegration(ctx, { tenantId: "t1", kind: "slack", config: SLACK }, h.env.AUTH_SECRET);

const statusOf = (id: string) =>
  (client.query("select status, consecutive_failures as f, disabled_reason as r from integrations where id = ?").get(id) ??
    null) as { status: string; f: number; r: string | null } | null;

beforeEach(() => {
  h = makeHarness();
  client = new Database(h.env.SQLITE_PATH as string);
  ctx = { db: drizzle({ client }), dialect: "sqlite" };
});
afterEach(() => h.cleanup());

describe("integration delivery log", () => {
  test("a successful delivery is recorded", async () => {
    const conn = await connectSlack();
    const rec = responder(200);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), rec.fetch);

    const log = await listIntegrationDeliveries(ctx, "t1", conn.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe(200);
    expect(log[0]!.event).toBe("posts.created");
    expect(log[0]!.error).toBeNull();
    expect(log[0]!.attempts).toBe(1);
  });

  test("a failed delivery is recorded with the reason", async () => {
    const conn = await connectSlack();
    const rec = responder(500);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), rec.fetch);

    const log = await listIntegrationDeliveries(ctx, "t1", conn.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe(500);
    expect(log[0]!.error).toBe("HTTP 500");
  });

  test("a misconfigured provider is logged as unreachable, not as HTTP 0", async () => {
    const conn = await connectIntegration(
      ctx,
      // Not a hooks.slack.com URL — the adapter refuses it before any request.
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://evil.example.com/x" } },
      h.env.AUTH_SECRET,
    );
    const rec = responder(200);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), rec.fetch);

    expect(rec.calls).toHaveLength(0); // never left the process
    const log = await listIntegrationDeliveries(ctx, "t1", conn.id);
    expect(log[0]!.status).toBe(0);
    expect(log[0]!.error).toBe("provider misconfigured or unreachable");
  });

  test("the log is tenant-guarded", async () => {
    const conn = await connectSlack();
    const rec = responder(200);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), rec.fetch);

    expect(await listIntegrationDeliveries(ctx, "t1", conn.id)).toHaveLength(1);
    // Same integration id, wrong workspace — must read as empty, not as t1's log.
    expect(await listIntegrationDeliveries(ctx, "t2", conn.id)).toHaveLength(0);
  });

  test("disconnecting drops the log with the integration", async () => {
    const conn = await connectSlack();
    const rec = responder(200);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), rec.fetch);
    await disconnectIntegration(ctx, "t1", conn.id);

    const rows = client.query("select count(*) as n from integration_deliveries").get() as { n: number };
    expect(rows.n).toBe(0);
  });

  test("a foreign disconnect erases neither the integration nor its log", async () => {
    const conn = await connectSlack();
    const rec = responder(200);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), rec.fetch);

    // The integration delete is tenant-scoped and matches nothing here; the
    // delivery cleanup keys off the id alone, so it must be gated on ownership
    // or this call would wipe t1's log from t2.
    await disconnectIntegration(ctx, "t2", conn.id);

    expect(await listIntegrations(ctx, "t1")).toHaveLength(1);
    expect(await listIntegrationDeliveries(ctx, "t1", conn.id)).toHaveLength(1);
  });
});

describe("integration circuit breaker", () => {
  test("failures accumulate and a success clears them", async () => {
    const conn = await connectSlack();
    const bad = responder(500);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), bad.fetch);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r2"), bad.fetch);
    expect(statusOf(conn.id)!.f).toBe(2);

    const good = responder(200);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r3"), good.fetch);
    const after = statusOf(conn.id)!;
    expect(after.f).toBe(0);
    expect(after.status).toBe("connected");
  });

  test("crossing the threshold disables the integration and stops delivery", async () => {
    const conn = await connectSlack();
    const bad = responder(500);
    for (let i = 0; i < INTEGRATION_AUTODISABLE_THRESHOLD; i++) {
      await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created(`r${i}`), bad.fetch);
    }
    const row = statusOf(conn.id)!;
    expect(row.status).toBe("disabled");
    expect(row.f).toBe(INTEGRATION_AUTODISABLE_THRESHOLD);
    expect(row.r).toContain("Auto-disabled");

    // A disabled integration is no longer a dispatch target.
    const after = responder(200);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("later"), after.fetch);
    expect(after.calls).toHaveLength(0);
  });

  test("resume re-enables and clears the failure state", async () => {
    const conn = await connectSlack();
    const bad = responder(500);
    for (let i = 0; i < INTEGRATION_AUTODISABLE_THRESHOLD; i++) {
      await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created(`r${i}`), bad.fetch);
    }
    const resumed = await resumeIntegration(ctx, "t1", conn.id);
    expect(resumed!.status).toBe("connected");
    expect(resumed!.consecutiveFailures).toBe(0);
    expect(resumed!.disabledReason).toBeNull();

    const good = responder(200);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("again"), good.fetch);
    expect(good.calls).toHaveLength(1);
  });

  test("resume is tenant-guarded", async () => {
    const conn = await connectSlack();
    expect(await resumeIntegration(ctx, "t2", conn.id)).toBeNull();
    // …and the row was not touched by the failed attempt.
    expect(statusOf(conn.id)!.status).toBe("connected");
  });

  test("the health fields are exposed on the list view", async () => {
    await connectSlack();
    const bad = responder(500);
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), bad.fetch);
    const [row] = await listIntegrations(ctx, "t1");
    expect(row!.consecutiveFailures).toBe(1);
    expect(row!.lastFailureAt).not.toBeNull();
  });
});

describe("deliverIntegrationById (the queue handler's runtime)", () => {
  test("an integration deleted between enqueue and run is a terminal no-op", async () => {
    const conn = await connectSlack();
    await disconnectIntegration(ctx, "t1", conn.id);
    const out = await deliverIntegrationById(h.env, ctx, {
      integrationId: conn.id,
      tenantId: "t1",
      message: { event: "posts.created", text: "x", payload: {} },
    });
    // ok:true so the queue stops retrying, but flagged as skipped.
    expect(out).toEqual({ ok: true, status: 200, skipped: true });
  });

  test("a disabled integration is skipped rather than retried", async () => {
    const conn = await connectSlack();
    const bad = responder(500);
    for (let i = 0; i < INTEGRATION_AUTODISABLE_THRESHOLD; i++) {
      await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created(`r${i}`), bad.fetch);
    }
    const out = await deliverIntegrationById(h.env, ctx, {
      integrationId: conn.id,
      tenantId: "t1",
      message: { event: "posts.created", text: "x", payload: {} },
    });
    expect(out.skipped).toBe(true);
  });

  test("a foreign workspace cannot drive another's integration", async () => {
    const conn = await connectSlack();
    const out = await deliverIntegrationById(h.env, ctx, {
      integrationId: conn.id,
      tenantId: "t2",
      message: { event: "posts.created", text: "x", payload: {} },
    });
    expect(out.skipped).toBe(true);
    // Nothing was logged against t1's integration.
    expect(await listIntegrationDeliveries(ctx, "t1", conn.id)).toHaveLength(0);
  });

  test("the queue's attempt counter reaches the log", async () => {
    const conn = await connectSlack();
    await deliverIntegrationById(h.env, ctx, {
      integrationId: conn.id,
      tenantId: "t1",
      message: { event: "posts.created", text: "x", payload: {} },
      attempt: 4,
    });
    const log = await listIntegrationDeliveries(ctx, "t1", conn.id);
    expect(log[0]!.attempts).toBe(4);
  });
});

describe("dispatch enqueues instead of blocking the write path", () => {
  test("with a full ctx the fan-out becomes integration.deliver jobs", async () => {
    const { buildContext } = await import("../src/server/context");
    const full = await buildContext(h.env);
    await connectIntegration(full, { tenantId: "t1", kind: "slack", config: SLACK }, h.env.AUTH_SECRET);

    // No fetch seam → the durable path. Nothing is delivered inline.
    await dispatchIntegrations(h.env, full, "t1", "items:posts", created("r1"));

    const jobs = client
      .query("select type, tenant_id as tenantId, payload from jobs where type = 'integration.deliver'")
      .all() as { type: string; tenantId: string; payload: string }[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.tenantId).toBe("t1");
    const payload = JSON.parse(jobs[0]!.payload);
    expect(payload.message.event).toBe("posts.created");
    expect(payload.message.text).toBe("posts: record created #r1");

    // The write path did not wait on a provider, so nothing is logged yet.
    const log = client.query("select count(*) as n from integration_deliveries").get() as { n: number };
    expect(log.n).toBe(0);
  });

  test("an unsubscribed event enqueues nothing", async () => {
    const { buildContext } = await import("../src/server/context");
    const full = await buildContext(h.env);
    await connectIntegration(
      full,
      { tenantId: "t1", kind: "slack", config: SLACK, events: ["posts.created"] },
      h.env.AUTH_SECRET,
    );
    await dispatchIntegrations(h.env, full, "t1", "items:posts", { event: "updated", data: { id: "r1" } });

    const n = client.query("select count(*) as n from jobs where type = 'integration.deliver'").get() as { n: number };
    expect(n.n).toBe(0);
  });
});
