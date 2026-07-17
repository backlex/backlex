import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Public webhook trigger — `POST /api/webhook/:flowId` (routes/
 * webhook-trigger.ts). The endpoint is deliberately unauthenticated: the
 * cryptographically-random flow id IS the secret (there is no additional
 * token/signature check today — the route comment defers that to a future
 * `webhook_token` column). Pins:
 *  - firing a `webhook`-triggered flow runs its operations (observable via
 *    an `item.create` op landing a row, and via the flow-run activity log),
 *  - unknown flow id → 404,
 *  - paused flow → 403,
 *  - non-webhook trigger → 400.
 */

const JSON_HEADERS = { "content-type": "application/json" } as const;

const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

describe("webhook trigger endpoint", () => {
  let h: TestHarness;
  const slug = `hooked_items_${Date.now()}`;
  let webhookFlowId: string;

  /** Cookie-free request — proves the trigger needs no session. */
  const anon = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers ?? {});
    if (!headers.has("Origin")) headers.set("Origin", "http://localhost:5173");
    return h.app.fetch(
      new Request(`http://localhost:5173${path}`, { ...init, headers }),
    );
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);

    // Target collection the flow writes into.
    const col = await h.fetch(
      "/api/collections",
      post({ slug, fields: [{ name: "title", type: "text" }] }),
    );
    if (col.status !== 201) {
      throw new Error(`collection create failed: ${col.status} ${await col.text()}`);
    }

    // Webhook-triggered flow: one item.create op with a static payload.
    const flow = await h.fetch(
      "/api/flows",
      post({
        name: "webhook-to-item",
        trigger: "webhook",
        operations: [
          { type: "item.create", collection: slug, data: { title: "from-webhook" } },
        ],
      }),
    );
    if (flow.status !== 201) {
      throw new Error(`flow create failed: ${flow.status} ${await flow.text()}`);
    }
    const body = (await flow.json()) as { data: { id: string; active: boolean } };
    webhookFlowId = body.data.id;
    expect(body.data.active).toBe(true);
  });
  afterAll(() => h.cleanup());

  test("anonymous POST fires the flow and its item.create lands a row", async () => {
    const res = await anon(`/api/webhook/${webhookFlowId}`, post({ ping: 1 }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    // Observable effect #1 — the flow's item.create wrote into the collection.
    const items = (await (await h.fetch(`/api/items/${slug}`)).json()) as {
      data: Array<{ id: string; title: string }>;
    };
    expect(items.data).toHaveLength(1);
    expect(items.data[0]?.title).toBe("from-webhook");

    // Observable effect #2 — runFlowById logged a `flow.run` activity row for
    // the flow (this is what the per-flow KPI cards read).
    const activity = (await (
      await h.fetch("/api/activity?limit=50")
    ).json()) as {
      data: Array<{ action: string; collection: string; itemId: string | null }>;
    };
    expect(
      activity.data.some(
        (a) =>
          a.action === "flow.run" &&
          a.collection === "system_flows" &&
          a.itemId === webhookFlowId,
      ),
    ).toBe(true);
  });

  test("a second POST fires again (one row per invocation)", async () => {
    const res = await anon(`/api/webhook/${webhookFlowId}`, post({}));
    expect(res.status).toBe(200);
    const items = (await (await h.fetch(`/api/items/${slug}`)).json()) as {
      data: unknown[];
    };
    expect(items.data).toHaveLength(2);
  });

  test("unknown flow id → 404 NOT_FOUND", async () => {
    const res = await anon(`/api/webhook/${crypto.randomUUID()}`, post({}));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("paused flow → 403 FORBIDDEN, and it does not run", async () => {
    const patch = await h.fetch(`/api/flows/${webhookFlowId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ active: false }),
    });
    expect(patch.status).toBe(200);

    const res = await anon(`/api/webhook/${webhookFlowId}`, post({}));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Flow is paused");

    // No third row appeared.
    const items = (await (await h.fetch(`/api/items/${slug}`)).json()) as {
      data: unknown[];
    };
    expect(items.data).toHaveLength(2);
  });

  test("non-webhook trigger → 400 BAD_REQUEST", async () => {
    const flow = await h.fetch(
      "/api/flows",
      post({
        name: "manual-only",
        trigger: "manual:",
        operations: [{ type: "log", message: "x" }],
      }),
    );
    expect(flow.status).toBe(201);
    const id = ((await flow.json()) as { data: { id: string } }).data.id;

    const res = await anon(`/api/webhook/${id}`, post({}));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  test("a non-JSON body is tolerated (defaults to {})", async () => {
    // Re-activate the webhook flow first.
    await h.fetch(`/api/flows/${webhookFlowId}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ active: true }),
    });
    const res = await anon(`/api/webhook/${webhookFlowId}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});
