/**
 * Two silent-success shapes, pinned so they cannot come back.
 *
 * 1. THE MCP SETTINGS TOOL ADVERTISED KEYS THE ROUTE DOES NOT HAVE.
 *    `settings.update` declared `brandName` and `flags`; `SettingsInput` is
 *    `.strict()`, so both came back as `VALIDATION: Unrecognized key` — an
 *    advertised input that could only ever fail — while eleven keys the route
 *    DOES accept were advertised nowhere and an agent had to guess them. This
 *    is the third instance of the shape on this branch (`users.invite` declared
 *    a `roleName` that never existed, `tenants.switch` posted a body key the
 *    route did not accept), and all three were invisible because every existing
 *    test drove the ROUTE. These drive the TOOL, which is the only thing that
 *    reads `inputSchema`.
 *
 * 2. NUMERIC USAGE CAPS APPLIED TO NOTHING. `USAGE_LIMIT_MODE` was
 *    independently optional, so a provisioner that injected a plan's caps but
 *    not the mode fell through to the workspace's own `usageLimits.mode` —
 *    default `off` — and every enforcement site returned on its first line. The
 *    containment half is worse than the inert half: with no env mode, the
 *    workspace's OWN admin could set `off` and walk out of a plan the platform
 *    had pinned.
 *
 * The parity test reads the route's own OpenAPI component rather than a copy of
 * the key list, so a rename on EITHER side fails here instead of at an agent's
 * tool call.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { buildContext } from "../src/server/context";
import { patchSettings } from "../src/server/mcp/tools/settings";
import {
  assertAiQuota,
  envUsageMode,
  resetUsageState,
  resolveUsageLimits,
  utcDay,
} from "../src/server/services/usage";
import { USAGE_LIMITS_DEFAULTS } from "../src/server/services/settings";
import type { Env } from "../src/server/env";
import * as sqlite from "@backlex/db/sqlite";

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/* ── MCP plumbing ──────────────────────────────────────────────────────── */

interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let rpcId = 0;

/** Call one tool on the admin mount and return the tool RESULT — including a
 *  failed one, because "did this advertised key fail?" is the question. */
const callTool = async (
  h: TestHarness,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => {
  const res = await h.fetch(
    "/api/admin/mcp",
    json("POST", {
      jsonrpc: "2.0",
      id: ++rpcId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
  expect(res.status, `tools/call ${name} transport status`).toBe(200);
  const body = (await res.json()) as
    | { result: ToolResult }
    | { error: { message: string } };
  if ("error" in body) throw new Error(`${name}: JSON-RPC error ${body.error.message}`);
  return body.result;
};

const resultText = (r: ToolResult): string =>
  r.content.map((c) => c.text ?? "").join("\n");

/**
 * Every property `settings.update` advertises, with a value the route accepts.
 *
 * Kept as a table rather than inline so the suite can assert it covers the
 * advertised set exactly: adding a property to the tool without adding a probe
 * here fails the coverage test below, which is what stops this file from
 * quietly testing a subset of a surface that grew.
 */
const PROBES: Record<string, unknown> = {
  i18nLocales: ["en", "tr"],
  i18nDefaultLocale: "tr",
  timezone: "Europe/Istanbul",
  defaultCurrency: "EUR",
  signInHeadline: "Sign in to the surfaces test",
  signInTagline: "One tagline, one deployment",
  termsUrl: "https://example.com/terms",
  privacyUrl: "https://example.com/privacy",
  // "enabled" rather than a lock-down value: turning the password off is
  // refused unless another way in exists, and that guard has its own tests.
  passwordLogin: "enabled",
  erdLayout: { posts: { x: 12, y: 34 } },
  listColumns: { posts: ["id", "title"] },
  collectionGroups: ["Content", "Operations"],
  schemaSnapshotSchedule: "weekly",
  schemaSnapshotKeepLast: 12,
};

const advertised = Object.keys(patchSettings.inputSchema.properties ?? {});

/** `GET /api/admin/settings` answers in two tiers plus a flat mirror. Look
 *  through all three so this spec asserts that the value LANDED, not which
 *  block this week's response shape files it under. */
const readBack = (data: Record<string, unknown>, key: string): unknown => {
  const workspace = (data.workspace ?? {}) as Record<string, unknown>;
  const global = (data.global ?? {}) as Record<string, unknown>;
  if (key in workspace) return workspace[key];
  if (key in global) return global[key];
  return data[key];
};

describe("MCP settings.update — advertised inputs are the accepted inputs", () => {
  let h: TestHarness;
  beforeAll(async () => {
    h = makeHarness();
    // seedAdmin's account is the first signup, so it is admin of the default
    // workspace — which is what `isInstanceOperator` recognises. The five
    // instance-global keys are unreachable without that standing.
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("the advertised set equals the route's own accepted set", async () => {
    const spec = (await (await h.fetch("/api/openapi.json")).json()) as {
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    };
    const routeSchema = spec.components.schemas.SettingsInput;
    expect(routeSchema, "SettingsInput component is published").toBeDefined();
    const accepted = Object.keys(routeSchema!.properties ?? {}).sort();
    expect(advertised.slice().sort()).toEqual(accepted);
  });

  test("the tool tells callers unknown keys are rejected, not ignored", () => {
    // `additionalProperties: true` was the other half of the lie: the schema
    // said "send what you like" while the route refused everything unlisted.
    expect(patchSettings.inputSchema.additionalProperties).toBe(false);
  });

  test("every advertised property has a probe below", () => {
    expect(Object.keys(PROBES).sort()).toEqual(advertised.slice().sort());
  });

  test("every advertised property is accepted and lands", async () => {
    // One call per property, so a failure names the offender instead of
    // condemning the whole body — which is exactly how `brandName` would have
    // been caught the day it was written.
    for (const [key, value] of Object.entries(PROBES)) {
      const r = await callTool(h, "settings.update", { [key]: value });
      expect(r.isError ?? false, `settings.update {${key}}: ${resultText(r)}`).toBe(
        false,
      );
    }

    const got = await callTool(h, "settings.get", {});
    expect(got.isError ?? false, resultText(got)).toBe(false);
    const data = (got.structuredContent as { data: Record<string, unknown> }).data;
    for (const [key, value] of Object.entries(PROBES)) {
      expect(readBack(data, key), `settings.get did not report ${key}`).toEqual(value);
    }
  });

  test("an unadvertised property is refused, not silently dropped", async () => {
    // The two the tool used to advertise. Each must come back as an error the
    // caller can act on — and must not have written anything.
    for (const bad of [{ brandName: "Acme" }, { flags: { beta: true } }]) {
      const r = await callTool(h, "settings.update", bad);
      expect(r.isError, `settings.update ${JSON.stringify(bad)} should fail`).toBe(true);
      expect(resultText(r)).toContain("Unrecognized key");
    }

    // Positive control, so the assertion above cannot pass because the tool is
    // broken for everything: the same call shape with an advertised key wins.
    const ok = await callTool(h, "settings.update", { timezone: "Europe/Berlin" });
    expect(ok.isError ?? false, resultText(ok)).toBe(false);

    const got = await callTool(h, "settings.get", {});
    const data = (got.structuredContent as { data: Record<string, unknown> }).data;
    expect(readBack(data, "timezone")).toBe("Europe/Berlin");
    expect(readBack(data, "brandName")).toBeUndefined();
    expect(readBack(data, "flags")).toBeUndefined();
  });
});

/* ── Usage limits: a cap with no mode ──────────────────────────────────── */

const envWith = (over: Partial<Env>): Env => ({ ...(over as Env) });

describe("usage limits — a pinned cap implies an enforcing mode", () => {
  const off = { ...USAGE_LIMITS_DEFAULTS, mode: "off" as const };

  test("caps with no USAGE_LIMIT_MODE resolve to hard", () => {
    expect(envUsageMode(envWith({ USAGE_LIMIT_REQUESTS_MONTH: "1000" }))).toBe("hard");
    expect(envUsageMode(envWith({ USAGE_LIMIT_STORAGE_BYTES: "1000" }))).toBe("hard");
    expect(envUsageMode(envWith({ USAGE_LIMIT_DB_ROWS: "1000" }))).toBe("hard");
    expect(envUsageMode(envWith({ USAGE_LIMIT_AI_CALLS: "1000" }))).toBe("hard");
  });

  test("a workspace cannot set itself out of a cap the platform pinned", () => {
    // The containment half. `off` is the workspace's own saved setting, and it
    // used to win outright whenever the provisioner had left the mode unset.
    const limits = resolveUsageLimits(
      envWith({ USAGE_LIMIT_AI_CALLS: "5" }),
      off,
    );
    expect(limits.mode).toBe("hard");
    expect(limits.maxAiCallsPerMonth).toBe(5);
  });

  test("an EXPLICIT mode still wins over the implication, both ways", () => {
    expect(
      resolveUsageLimits(
        envWith({ USAGE_LIMIT_MODE: "soft", USAGE_LIMIT_AI_CALLS: "5" }),
        off,
      ).mode,
    ).toBe("soft");
    expect(
      resolveUsageLimits(
        envWith({ USAGE_LIMIT_MODE: "off", USAGE_LIMIT_AI_CALLS: "5" }),
        off,
      ).mode,
    ).toBe("off");
  });

  test("no caps means no implication — the workspace's own mode decides", () => {
    // The narrowness matters: a self-hosted deployment with no USAGE_LIMIT_*
    // at all must keep answering to its admin, not be dragged into `hard`.
    expect(envUsageMode(envWith({}))).toBeNull();
    expect(
      resolveUsageLimits(envWith({}), { ...USAGE_LIMITS_DEFAULTS, mode: "soft" }).mode,
    ).toBe("soft");
    expect(resolveUsageLimits(envWith({}), off).mode).toBe("off");
  });

  test("a malformed cap is not a cap", () => {
    // `envPosInt` refuses these, so they set no ceiling — and something that
    // sets no ceiling must not flip an entire deployment into hard mode.
    for (const v of ["", "0", "-5", "abc"]) {
      expect(envUsageMode(envWith({ USAGE_LIMIT_DB_ROWS: v })), `cap ${v || "(empty)"}`)
        .toBeNull();
    }
  });
});

describe("usage limits — the implied mode actually bites", () => {
  let h: TestHarness;
  let tenantId: string;

  beforeAll(async () => {
    resetUsageState();
    // A cap and NOTHING else: exactly the provisioner shape that used to be
    // inert.
    h = makeHarness({ USAGE_LIMIT_AI_CALLS: "1" });
    await seedAdmin(h);
    const tenants = (await (await h.fetch("/api/tenants")).json()) as {
      data: { id: string }[];
    };
    tenantId = tenants.data[0]!.id;
    // And the workspace explicitly opting out, which is the lever a tenant
    // admin actually has in the Usage page.
    const saved = await h.fetch(
      "/api/admin/usage/limits",
      json("PUT", {
        mode: "off",
        maxRequestsPerMonth: null,
        maxStorageBytes: null,
        maxDbRows: null,
        maxAiCallsPerMonth: null,
      }),
    );
    expect(saved.status).toBe(200);
    const ctx = await buildContext(h.env);
    await (ctx.db as any).insert(sqlite.schema.usageCounters).values({
      tenantId,
      apiKeyId: "",
      day: utcDay(),
      requests: 0,
      errors: 0,
      aiCalls: 1,
      updatedAt: new Date(),
    });
    resetUsageState();
  });
  afterAll(() => h.cleanup());

  test("assertAiQuota refuses the over-budget workspace", async () => {
    const ctx = await buildContext(h.env);
    await expect(assertAiQuota(ctx, h.env, tenantId)).rejects.toThrow(
      /AI limit reached/i,
    );
  });

  test("the overview reports the mode as env-pinned", async () => {
    const res = await h.fetch("/api/admin/usage/overview");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { limits: { mode: string }; settingsLimits: { mode: string }; envPinned: string[] };
    };
    expect(body.data.limits.mode).toBe("hard");
    // The workspace's own choice is still reported verbatim — the admin UI has
    // to be able to show BOTH "what you set" and "what applies", or the pinned
    // control looks editable and a save that changes nothing looks successful.
    expect(body.data.settingsLimits.mode).toBe("off");
    expect(body.data.envPinned).toContain("mode");
    expect(body.data.envPinned).toContain("maxAiCallsPerMonth");
  });
});

describe("usage limits — the positive control", () => {
  let h: TestHarness;
  let tenantId: string;

  beforeAll(async () => {
    resetUsageState();
    // Same cap, same ledger, but the provisioner said `off` OUT LOUD. If this
    // one also refused, the test above would be proving nothing about the
    // implication — only that a cap exists.
    h = makeHarness({ USAGE_LIMIT_AI_CALLS: "1", USAGE_LIMIT_MODE: "off" });
    await seedAdmin(h);
    const tenants = (await (await h.fetch("/api/tenants")).json()) as {
      data: { id: string }[];
    };
    tenantId = tenants.data[0]!.id;
    const ctx = await buildContext(h.env);
    await (ctx.db as any).insert(sqlite.schema.usageCounters).values({
      tenantId,
      apiKeyId: "",
      day: utcDay(),
      requests: 0,
      errors: 0,
      aiCalls: 5,
      updatedAt: new Date(),
    });
    resetUsageState();
  });
  afterAll(() => h.cleanup());

  test("an explicit off leaves an over-budget workspace generating", async () => {
    const ctx = await buildContext(h.env);
    await expect(assertAiQuota(ctx, h.env, tenantId)).resolves.toBeUndefined();
  });
});
