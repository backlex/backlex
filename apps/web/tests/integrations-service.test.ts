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

const created = (id: string, tenantId: string) => ({ event: "created", data: { id, tenantId } });

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
    await dispatchIntegrations(h.env, ctx, "items:posts", created("r1", "t1"), rec.fetch);
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
    await dispatchIntegrations(h.env, ctx, "items:posts", { event: "updated", data: { id: "r1", tenantId: "t1" } }, rec.fetch);
    expect(rec.calls).toHaveLength(0); // updated is not subscribed
    await dispatchIntegrations(h.env, ctx, "items:posts", created("r1", "t1"), rec.fetch);
    expect(rec.calls).toHaveLength(1); // created is
  });

  test("dispatch only hits the originating tenant's integrations", async () => {
    await connectIntegration(
      ctx,
      { tenantId: "t1", kind: "slack", config: { webhookUrl: "https://hooks.slack.com/services/X" } },
      h.env.AUTH_SECRET,
    );
    const rec = recorder();
    await dispatchIntegrations(h.env, ctx, "items:posts", created("r9", "t2"), rec.fetch);
    expect(rec.calls).toHaveLength(0); // t2 has none; t1's must not fire
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
