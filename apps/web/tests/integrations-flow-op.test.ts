/**
 * The `integration` flow operation — every connected provider as a flow step.
 *
 * Two layers: the service call a flow op compiles down to, and a real flow run
 * driven through the HTTP app so interpolation and the delivery log are proven
 * end to end.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { FetchLike } from "@backlex/integrations";
import {
  connectIntegration,
  deliverIntegrationByKind,
  listIntegrationDeliveries,
} from "../src/server/services/integrations";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const SLACK = { webhookUrl: "https://hooks.slack.com/services/X" };

function responder(status = 200) {
  const calls: { url: string; body: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(null, { status }) as unknown as Response;
  };
  return { fetch, calls };
}

describe("deliverIntegrationByKind", () => {
  let h: TestHarness;
  let client: Database;
  let ctx: { db: any; dialect: "sqlite" };

  beforeEach(() => {
    h = makeHarness();
    client = new Database(h.env.SQLITE_PATH as string);
    ctx = { db: drizzle({ client }), dialect: "sqlite" };
  });
  afterEach(() => h.cleanup());

  const msg = { event: "flow.run", text: "hello", payload: { a: 1 } };

  test("addresses the workspace's row by provider kind", async () => {
    await connectIntegration(ctx, { tenantId: "t1", kind: "slack", config: SLACK }, h.env.AUTH_SECRET);
    const rec = responder();
    const out = await deliverIntegrationByKind(h.env, ctx, "t1", "slack", msg, rec.fetch);
    expect(out.ok).toBe(true);
    expect(rec.calls[0]!.body).toEqual({ text: "*hello*" });
  });

  test("a kind the workspace hasn't connected is skipped, not failed", async () => {
    const rec = responder();
    const out = await deliverIntegrationByKind(h.env, ctx, "t1", "slack", msg, rec.fetch);
    expect(out.skipped).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  test("an unknown provider name is skipped rather than throwing", async () => {
    const rec = responder();
    const out = await deliverIntegrationByKind(h.env, ctx, "t1", "not-a-provider", msg, rec.fetch);
    expect(out.skipped).toBe(true);
  });

  test("a paused integration is skipped", async () => {
    await connectIntegration(ctx, { tenantId: "t1", kind: "slack", config: SLACK }, h.env.AUTH_SECRET);
    client.query("update integrations set status = 'disabled'").run();
    const rec = responder();
    const out = await deliverIntegrationByKind(h.env, ctx, "t1", "slack", msg, rec.fetch);
    expect(out.skipped).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  test("another workspace's integration is never reachable by kind", async () => {
    await connectIntegration(ctx, { tenantId: "t1", kind: "slack", config: SLACK }, h.env.AUTH_SECRET);
    const rec = responder();
    const out = await deliverIntegrationByKind(h.env, ctx, "t2", "slack", msg, rec.fetch);
    expect(out.skipped).toBe(true);
    expect(rec.calls).toHaveLength(0);
  });

  test("the delivery is logged under the flow's event label", async () => {
    const conn = await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: SLACK },
      h.env.AUTH_SECRET,
    );
    const rec = responder();
    await deliverIntegrationByKind(h.env, ctx, "t1", "slack", { ...msg, event: "order.shipped" }, rec.fetch);
    const log = await listIntegrationDeliveries(ctx, "t1", conn.id);
    expect(log).toHaveLength(1);
    expect(log[0]!.event).toBe("order.shipped");
  });
});

describe("integration step in a real flow run", () => {
  let h: TestHarness;
  let client: Database;
  const realFetch = globalThis.fetch;
  let outbound: { url: string; body: any }[] = [];

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = new Database(h.env.SQLITE_PATH as string);
    // The flow runtime delivers through the ambient fetch, so intercept it
    // here rather than reaching for a seam the op doesn't expose.
    globalThis.fetch = (async (url: any, init: any) => {
      const u = String(url);
      if (u.startsWith("https://hooks.slack.com/")) {
        outbound.push({ url: u, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return new Response(null, { status: 200 });
      }
      return realFetch(url, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    h.cleanup();
  });
  beforeEach(() => {
    outbound = [];
  });

  const post = (path: string, body: unknown) =>
    h.fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  test("a manual flow sends through the connected provider with interpolation", async () => {
    const conn = await post("/api/admin/integrations", { kind: "slack", config: SLACK });
    expect(conn.status).toBe(201);

    const made = await post("/api/flows", {
      name: "notify-slack",
      trigger: "manual:",
      operations: [
        {
          type: "integration",
          kind: "slack",
          text: "Order {{ data.id }} shipped",
          event: "order.shipped",
          payload: { id: "{{ data.id }}" },
        },
      ],
    });
    expect(made.status).toBe(201);
    const flowId = ((await made.json()) as any).data.id as string;

    // The whole request body IS the template payload — `data` in a template
    // refers to it directly, not to a nested `data` key.
    const run = await post(`/api/flows/${flowId}/run`, { id: "A-42" });
    expect(run.status).toBe(200);
    expect(((await run.json()) as any).ok).toBe(true);

    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.body).toEqual({ text: "*Order A-42 shipped*" });

    const log = client
      .query("select event, status from integration_deliveries order by delivered_at desc")
      .all() as { event: string; status: number }[];
    expect(log[0]).toMatchObject({ event: "order.shipped", status: 200 });
  });

  test("a provider the workspace hasn't connected leaves the flow green", async () => {
    const made = await post("/api/flows", {
      name: "notify-jira",
      trigger: "manual:",
      operations: [{ type: "integration", kind: "jira", text: "x" }],
    });
    const flowId = ((await made.json()) as any).data.id as string;
    const run = await post(`/api/flows/${flowId}/run`, {});
    // Skipped, not failed — a provider nobody connected must not break the
    // automation that mentions it. The run reports ok and nothing left the box.
    expect(run.status).toBe(200);
    const body = (await run.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.error).toBeUndefined();
    expect(outbound).toHaveLength(0);
  });
});
