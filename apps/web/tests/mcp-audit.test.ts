import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  shouldAudit,
  summariseArgs,
  resolveAuditLevel,
} from "../src/server/mcp/audit";
import type { Env } from "../src/server/env";

/**
 * Tool-level MCP auditing (#23). The underlying REST route logs its own row;
 * what these pin is the layer above it — WHICH tool an agent reached for,
 * whether a guard refused it, and that a refusal is recorded even when routine
 * reads are not.
 */

const rpc = (method: string, params?: unknown, id = 1): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
});

/** Activity rows whose action starts with `mcp.`, newest first. */
const mcpRows = async (h: TestHarness) => {
  const res = await h.fetch("/api/activity?action=mcp&limit=200");
  const body = (await res.json()) as {
    data: {
      action: string;
      itemId: string | null;
      collection: string | null;
      payload: any;
      response: any;
      durationMs: number | null;
    }[];
  };
  return body.data;
};

describe("mcp audit — level gating (pure)", () => {
  test("denials and errors are always recorded, at every level", () => {
    for (const level of ["all", "writes", "off"] as const) {
      expect(shouldAudit(level, "denied", "read")).toBe(true);
      expect(shouldAudit(level, "error", "read")).toBe(true);
    }
  });

  test("`writes` (the default) records mutations but not routine reads", () => {
    expect(shouldAudit("writes", "ok", "write")).toBe(true);
    expect(shouldAudit("writes", "ok", "destruct")).toBe(true);
    expect(shouldAudit("writes", "ok", "read")).toBe(false);
  });

  test("`all` records reads too; `off` records no successful call", () => {
    expect(shouldAudit("all", "ok", "read")).toBe(true);
    expect(shouldAudit("off", "ok", "read")).toBe(false);
    expect(shouldAudit("off", "ok", "write")).toBe(false);
  });

  test("an unset or nonsense MCP_AUDIT_LEVEL falls back to `writes`", () => {
    const env = (v?: string) => ({ MCP_AUDIT_LEVEL: v }) as unknown as Env;
    expect(resolveAuditLevel(env(undefined))).toBe("writes");
    expect(resolveAuditLevel(env(""))).toBe("writes");
    expect(resolveAuditLevel(env("verbose"))).toBe("writes");
    expect(resolveAuditLevel(env("ALL"))).toBe("all");
  });
});

describe("mcp audit — argument summarisation", () => {
  test("long strings are clipped with their true length", () => {
    const out = summariseArgs({ note: "x".repeat(2000) }) as { note: string };
    expect(out.note.length).toBeLessThan(600);
    expect(out.note).toContain("2000 chars");
  });

  test("long arrays keep a head plus a count of what was dropped", () => {
    const out = summariseArgs({ rows: Array.from({ length: 50 }, (_, i) => i) }) as {
      rows: unknown[];
    };
    expect(out.rows.length).toBe(21);
    expect(out.rows[20]).toBe("… 30 more");
  });

  test("a payload too large to summarise degrades to its key list", () => {
    const huge = Array.from({ length: 20 }, (_, i) => ({
      // 20 rows × ~600 chars survive clipping and still blow the 8 KB ceiling.
      [`field${i}`]: "y".repeat(400),
      [`other${i}`]: "z".repeat(400),
    }));
    const out = summariseArgs({ rows: huge, collection: "posts" }) as {
      _truncated?: boolean;
      keys?: string[];
    };
    expect(out._truncated).toBe(true);
    expect(out.keys).toEqual(["rows", "collection"]);
  });

  test("no arguments summarise to null rather than an empty object", () => {
    expect(summariseArgs(undefined)).toBeNull();
  });
});

describe("mcp audit — rows written by a real dispatch", () => {
  let h: TestHarness;

  beforeAll(async () => {
    // `all` so a read tool also earns a row — the default would skip it and
    // this suite wants to assert on the full shape.
    h = makeHarness({ MCP_AUDIT_LEVEL: "all" });
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a successful tools/call writes one mcp.call row naming the tool", async () => {
    await h.fetch(
      "/mcp",
      rpc("tools/call", { name: "schema-list_collections", arguments: {} }),
    );
    const rows = await mcpRows(h);
    const row = rows.find((r) => r.itemId === "schema.list_collections");
    expect(row).toBeTruthy();
    expect(row?.action).toBe("mcp.call");
    expect(row?.collection).toBe("system_mcp");
    expect(row?.payload?.kind).toBe("read");
    expect(row?.payload?.mount).toBe("tenant");
    expect(row?.response?.outcome).toBe("ok");
    expect(typeof row?.durationMs).toBe("number");
  });

  test("the calling key is attributed, not swallowed by the secret redactor", async () => {
    // Regression: naming the field `apiKeyId` made /api[-_]?key/i match it, so
    // every row recorded "[redacted]" where the attribution should be.
    const rows = await mcpRows(h);
    const row = rows.find((r) => r.itemId === "schema.list_collections");
    // Cookie session → no key, so null. The point is that it isn't "[redacted]".
    expect(row?.payload?.viaKeyId).toBeNull();
    expect(JSON.stringify(row?.payload)).not.toContain("[redacted]");
  });

  test("the row keys on the canonical dotted id, not the hyphenated wire name", async () => {
    const rows = await mcpRows(h);
    expect(rows.every((r) => !r.itemId?.includes("-"))).toBe(true);
  });

  test("a tool that reports an error is an mcp.error row carrying the reason", async () => {
    await h.fetch(
      "/mcp",
      rpc("tools/call", {
        name: "collections-read",
        arguments: { collection: "does_not_exist", id: "1" },
      }),
    );
    const rows = await mcpRows(h);
    const row = rows.find((r) => r.action === "mcp.error");
    expect(row).toBeTruthy();
    expect(row?.response?.outcome).toBe("error");
    expect(typeof row?.response?.error).toBe("string");
  });

  test("resources/read is audited under mcp.resource with the URI as the item", async () => {
    await h.fetch("/mcp", rpc("resources/read", { uri: "backlex://me" }));
    const rows = await mcpRows(h);
    const row = rows.find((r) => r.action === "mcp.resource");
    expect(row).toBeTruthy();
    expect(row?.itemId).toBe("backlex://me");
  });

  test("secret-looking arguments are redacted before they reach the log", async () => {
    // `apikeys.create` takes a name; the response is what carries a secret, but
    // the redactor runs over the payload too — prove a token-shaped key never
    // lands verbatim.
    await h.fetch(
      "/mcp",
      rpc("tools/call", {
        name: "apikeys-create",
        arguments: { name: "audited", apiKey: "sk-super-secret" },
      }),
    );
    const rows = await mcpRows(h);
    const row = rows.find((r) => r.itemId === "apikeys.create");
    expect(row).toBeTruthy();
    expect(JSON.stringify(row?.payload)).not.toContain("sk-super-secret");
    expect(row?.payload?.args?.apiKey).toBe("[redacted]");
  });
});

describe("mcp audit — off", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness({ MCP_AUDIT_LEVEL: "off" });
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("a successful call writes nothing", async () => {
    await h.fetch(
      "/mcp",
      rpc("tools/call", { name: "schema-list_collections", arguments: {} }),
    );
    expect((await mcpRows(h)).length).toBe(0);
  });
});
