import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for backup / restore. Pins GraphQL + SDK + MCP to the
 * same `/api/admin/db/backups*` semantics the REST surface (covered in
 * backup.test.ts) established: manual run, list, additive confirm-gated
 * restore, and the schedule config round-trip. All surfaces funnel through
 * services/backup.ts helpers (GraphQL) or the REST routes themselves (MCP,
 * SDK), so scoping/validation can never diverge.
 */
const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("backups — GraphQL surface", () => {
  let h: TestHarness;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("runBackup → backups → restoreBackup(confirm) round-trips", async () => {
    const run = await gql(
      `mutation($l:String){ runBackup(label:$l){ id kind label status tableCount } }`,
      { l: "gql-backup" },
    );
    expect(run.errors).toBeUndefined();
    const backup = run.data?.runBackup;
    expect(backup.id).toBeTruthy();
    expect(backup.kind).toBe("manual");
    expect(backup.label).toBe("gql-backup");
    expect(backup.status).toBe("done");
    expect(backup.tableCount).toBeGreaterThan(0);

    const list = await gql(`{ backups { id status } }`);
    expect(list.errors).toBeUndefined();
    expect(list.data?.backups.some((b: any) => b.id === backup.id)).toBe(true);

    // confirm:false is rejected before any work happens.
    const denied = await gql(
      `mutation($id:ID!){ restoreBackup(id:$id, confirm:false){ rowCount } }`,
      { id: backup.id },
    );
    expect(denied.errors?.[0]?.extensions?.code).toBe("FORBIDDEN");

    const restored = await gql(
      `mutation($id:ID!){ restoreBackup(id:$id, confirm:true){ tableCount rowCount skipped } }`,
      { id: backup.id },
    );
    expect(restored.errors).toBeUndefined();
    expect(restored.data?.restoreBackup.tableCount).toBeGreaterThan(0);
    expect(restored.data?.restoreBackup.rowCount).toBeGreaterThan(0);
    // Every table in a fresh same-database dump exists — none get skipped.
    expect(restored.data?.restoreBackup.skipped).toBe(0);
  });

  test("restoreBackup on an unknown id surfaces NOT_FOUND", async () => {
    const res = await gql(
      `mutation{ restoreBackup(id:"nope", confirm:true){ rowCount } }`,
    );
    expect(res.errors?.[0]?.extensions?.code).toBe("NOT_FOUND");
  });

  test("backupConfig defaults and setBackupConfig validates + persists", async () => {
    const def = await gql(`{ backupConfig { schedule retain } }`);
    expect(def.data?.backupConfig).toEqual({ schedule: "off", retain: 7 });

    const bad = await gql(
      `mutation{ setBackupConfig(data:{ schedule:"hourly" }){ schedule } }`,
    );
    expect(bad.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const badRetain = await gql(
      `mutation{ setBackupConfig(data:{ retain: 0 }){ retain } }`,
    );
    expect(badRetain.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const set = await gql(
      `mutation{ setBackupConfig(data:{ schedule:"daily", retain: 3 }){ schedule retain } }`,
    );
    expect(set.errors).toBeUndefined();
    expect(set.data?.setBackupConfig).toEqual({ schedule: "daily", retain: 3 });

    const round = await gql(`{ backupConfig { schedule retain } }`);
    expect(round.data?.backupConfig).toEqual({ schedule: "daily", retain: 3 });

    // Age rule: set → read back → explicit null disables; 0 is rejected.
    const days = await gql(
      `mutation{ setBackupConfig(data:{ retainDays: 30 }){ retainDays } }`,
    );
    expect(days.data?.setBackupConfig.retainDays).toBe(30);
    const badDays = await gql(
      `mutation{ setBackupConfig(data:{ retainDays: 0 }){ retainDays } }`,
    );
    expect(badDays.errors?.[0]?.extensions?.code).toBe("VALIDATION");
    const cleared = await gql(
      `mutation{ setBackupConfig(data:{ retainDays: null }){ retainDays } }`,
    );
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data?.setBackupConfig.retainDays).toBeNull();
  });
});

describe("backups — SDK surface", () => {
  let h: TestHarness;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    client = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("run → list → restore → config round-trips", async () => {
    const run = await client.backups.run({ label: "sdk-backup" });
    expect(run.data.status).toBe("done");
    expect(run.data.label).toBe("sdk-backup");
    const id = run.data.id;

    const list = await client.backups.list();
    expect(list.data.some((b) => b.id === id)).toBe(true);

    // The SDK sends the confirm header itself.
    const restored = await client.backups.restore(id);
    expect(restored.data.tableCount).toBeGreaterThan(0);

    expect((await client.backups.getConfig()).data).toEqual({
      schedule: "off",
      retain: 7,
      retainDays: null,
    });
    const set = await client.backups.setConfig({ schedule: "weekly" });
    expect(set.data.schedule).toBe("weekly");
    expect(set.data.retain).toBe(7);
    const aged = await client.backups.setConfig({ retainDays: 30 });
    expect(aged.data.retainDays).toBe(30);
  });
});

describe("backups — MCP surface", () => {
  let h: TestHarness;

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as {
      result?: { structuredContent?: any; isError?: boolean };
      error?: { message: string };
    };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("backups.* tools are registered with sane kinds and round-trip", async () => {
    const listRes = await h.fetch("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }),
    });
    const tools = ((await listRes.json()) as {
      result: { tools: { name: string; kind?: string }[] };
    }).result.tools;
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("backups.list")?.kind).toBe("read");
    expect(byName.get("backups.run")?.kind).toBe("write");
    expect(byName.get("backups.restore")?.kind).toBe("write");
    expect(byName.get("backups.get_config")?.kind).toBe("read");
    expect(byName.get("backups.set_config")?.kind).toBe("write");

    const run = await callTool("backups.run", { label: "mcp-backup" });
    const backup = (run?.structuredContent as { data: { id: string; status: string } })
      .data;
    expect(backup.status).toBe("done");

    const list = await callTool("backups.list");
    const rows = (list?.structuredContent as { data: { id: string }[] }).data;
    expect(rows.some((r) => r.id === backup.id)).toBe(true);

    // Restore refuses to run without the explicit confirm arg — surfaces as a
    // JSON-RPC error or an isError result depending on the dispatch layer.
    const denied = await callTool("backups.restore", { id: backup.id }).catch(() => ({
      isError: true,
    }));
    expect(denied?.isError).toBe(true);
    const restored = await callTool("backups.restore", {
      id: backup.id,
      confirm: true,
    });
    expect(
      (restored?.structuredContent as { data: { tableCount: number } }).data.tableCount,
    ).toBeGreaterThan(0);

    const cfg = await callTool("backups.set_config", { schedule: "daily", retain: 2 });
    expect((cfg?.structuredContent as { data: { schedule: string } }).data.schedule).toBe(
      "daily",
    );
    const got = await callTool("backups.get_config");
    expect((got?.structuredContent as { data: { retain: number } }).data.retain).toBe(2);
  });
});
