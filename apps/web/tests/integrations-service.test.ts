import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { FetchLike } from "@backlex/integrations";
import {
  connectIntegration,
  disconnectIntegration,
  dispatchIntegrations,
  listIntegrations,
} from "../src/server/services/integrations";
import { makeHarness, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
// dual-dialect db union; sqlite drizzle handle here.
let ctx: { db: any; dialect: "sqlite" };

function recorder() {
  const calls: { url: string; body: unknown }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(null, { status: 200 }) as unknown as Response;
  };
  return { fetch, calls };
}

beforeEach(() => {
  h = makeHarness();
  client = new Database(h.env.SQLITE_PATH as string);
  ctx = { db: drizzle({ client }), dialect: "sqlite" };
});
afterEach(() => h.cleanup());

/** A real item event as `publishEvent` produces it: `deserializeRow` emits only
 *  declared collection fields, so there is NO tenant marker in `data`. Tests
 *  that invented one here made the tenant scoping look correct while production
 *  fanned out unscoped. */
const created = (id: string) => ({ event: "created", data: { id } });

describe("admin integrations service", () => {
  test("connect encrypts secrets at rest; list masks them", async () => {
    await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://hooks.slack.com/services/SEKRET" } },
      h.env.AUTH_SECRET,
    );

    // raw row: the stored secret must NOT be the plaintext
    const raw = client.query("select config from integrations where tenant_id = 't1'").get() as { config: string };
    expect(raw.config).not.toContain("SEKRET");

    // list view: masked, never the full secret
    const list = await listIntegrations(ctx, "t1");
    expect(list).toHaveLength(1);
    expect(String(list[0]!.config.webhookUrl)).toContain("…");
    expect(String(list[0]!.config.webhookUrl)).not.toContain("SEKRET");
  });

  test("dispatch delivers a data event to a connected integration (decrypted)", async () => {
    await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://hooks.slack.com/services/X" } },
      h.env.AUTH_SECRET,
    );
    const rec = recorder();
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), rec.fetch);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toBe("https://hooks.slack.com/services/X");
    expect(rec.calls[0]!.body).toEqual({ text: "*posts: record created #r1*" });
  });

  test("dispatch respects the per-integration events[] filter", async () => {
    await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://hooks.slack.com/services/X" }, events: ["posts.created"] },
      h.env.AUTH_SECRET,
    );
    const rec = recorder();
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", { event: "updated", data: { id: "r1" } }, rec.fetch);
    expect(rec.calls).toHaveLength(0); // updated is not subscribed
    await dispatchIntegrations(h.env, ctx, "t1", "items:posts", created("r1"), rec.fetch);
    expect(rec.calls).toHaveLength(1); // created is
  });

  test("an event from another workspace never reaches this one's integrations", async () => {
    await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://hooks.slack.com/services/X" } },
      h.env.AUTH_SECRET,
    );
    const rec = recorder();
    // The payload carries no tenant marker — exactly as a real item event
    // doesn't. Scoping must come from the authoritative origin argument, so t1's
    // Slack must stay silent for a t2 event.
    await dispatchIntegrations(h.env, ctx, "t2", "items:posts", created("r9"), rec.fetch);
    expect(rec.calls).toHaveLength(0);
  });

  test("a payload-supplied tenant cannot widen the scope", async () => {
    await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://hooks.slack.com/services/X" } },
      h.env.AUTH_SECRET,
    );
    const rec = recorder();
    // A collection is free to declare its own `tenantId` field, so the payload
    // is attacker-influenced. It must not be consulted for scoping.
    await dispatchIntegrations(
      h.env,
      ctx,
      "t2",
      "items:posts",
      { event: "created", data: { id: "r9", tenantId: "t1" } },
      rec.fetch,
    );
    expect(rec.calls).toHaveLength(0);
  });

  test("with no origin tenant only globally-scoped integrations fire", async () => {
    await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://hooks.slack.com/services/TENANT" } },
      h.env.AUTH_SECRET,
    );
    await connectIntegration(
      ctx,
      { tenantId: null, kind: "discord", config: { webhookUrl: "https://discord.com/api/webhooks/GLOBAL" } },
      h.env.AUTH_SECRET,
    );
    const rec = recorder();
    await dispatchIntegrations(h.env, ctx, null, "items:posts", created("r1"), rec.fetch);
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]!.url).toContain("GLOBAL");
  });

  test("disconnect removes the integration", async () => {
    const conn = await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://hooks.slack.com/services/X" } },
      h.env.AUTH_SECRET,
    );
    await disconnectIntegration(ctx, "t1", conn.id);
    expect(await listIntegrations(ctx, "t1")).toHaveLength(0);
  });
});
