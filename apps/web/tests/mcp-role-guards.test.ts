import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import {
  checkToolCall,
  combineRoleGuards,
  filterByAllowlist,
  matchesPattern,
  mergeGuards,
} from "../src/server/mcp/guards";

/**
 * Role-scoped MCP guards (#23). The per-key allowlist already existed; this
 * pins the half that follows the *person* — so minting a fresh API key can't
 * shed a restriction — plus the composition rules between the two.
 */

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

const signUp = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });

const signIn = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD }),
  });

const rpc = (h: TestHarness, method: string, params?: unknown) =>
  h.fetch("/mcp", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

/** tools/list names, normalised back to the canonical dotted ids. */
const toolNames = async (h: TestHarness): Promise<string[]> => {
  const res = await rpc(h, "tools/list");
  const body = (await res.json()) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name.replaceAll("-", "."));
};

const callTool = async (h: TestHarness, name: string, args = {}) => {
  const res = await rpc(h, "tools/call", { name, arguments: args });
  const body = (await res.json()) as {
    result?: { content: { text: string }[]; isError?: boolean };
  };
  return {
    isError: Boolean(body.result?.isError),
    text: body.result?.content?.[0]?.text ?? "",
  };
};

describe("mcp guards — pattern matching (pure)", () => {
  test("an exact id matches only itself", () => {
    expect(matchesPattern("collections.read", "collections.read")).toBe(true);
    expect(matchesPattern("collections.read", "collections.list")).toBe(false);
  });

  test("a namespace glob stays inside its own namespace", () => {
    expect(matchesPattern("collections.*", "collections.read")).toBe(true);
    expect(matchesPattern("collections.*", "collections.bulk_insert")).toBe(true);
    // The trailing dot is the whole point: a sibling namespace sharing a prefix
    // must NOT be swept in by `collections.*`.
    expect(matchesPattern("collections.*", "collections_admin.read")).toBe(false);
    expect(matchesPattern("collections.*", "schema.read")).toBe(false);
  });

  test("a bare `*` matches everything", () => {
    expect(matchesPattern("*", "anything.at_all")).toBe(true);
  });
});

describe("mcp guards — composition (pure)", () => {
  const names = ["schema.list_collections", "collections.read", "collections.delete"];

  test("a policy-free role is ignored, not read as a blanket allow", () => {
    // This is the case that decides whether the feature works at all: every
    // signed-in user carries the policy-free `authenticated` role.
    const combined = combineRoleGuards([
      { allowlist: null, readOnly: false },
      { allowlist: ["schema.*"], readOnly: false },
    ]);
    expect(combined.allowlist).toEqual(["schema.*"]);
  });

  test("two restricted roles widen to their union", () => {
    expect(
      combineRoleGuards([
        { allowlist: ["a.*"], readOnly: false },
        { allowlist: ["b.*"], readOnly: false },
      ]).allowlist,
    ).toEqual(["a.*", "b.*"]);
  });

  test("no role sets a list → no allowlist at all", () => {
    expect(
      combineRoleGuards([
        { allowlist: null, readOnly: false },
        { allowlist: null, readOnly: true },
      ]).allowlist,
    ).toBeNull();
  });

  test("read-only is sticky — a second role cannot lift it", () => {
    expect(
      combineRoleGuards([
        { allowlist: null, readOnly: true },
        { allowlist: null, readOnly: false },
      ]).readOnly,
    ).toBe(true);
    expect(
      combineRoleGuards([
        { allowlist: ["a.*"], readOnly: false },
        { allowlist: ["b.*"], readOnly: false },
      ]).readOnly,
    ).toBe(false);
  });

  test("a caller with no roles contributes nothing rather than denying all", () => {
    expect(combineRoleGuards([])).toEqual({ allowlist: null, readOnly: false });
  });

  test("key and role allowlists intersect — neither can widen the other", () => {
    const guards = mergeGuards(
      { allowlist: ["collections.*"], readOnly: false },
      { allowlist: ["collections.read", "schema.list_collections"], readOnly: false },
    );
    // Only the id in BOTH lists survives.
    expect(filterByAllowlist(names, guards)).toEqual(["collections.read"]);
  });

  test("read-only ORs across the two sources", () => {
    expect(
      mergeGuards({ allowlist: null, readOnly: false }, { allowlist: null, readOnly: true })
        .readOnly,
    ).toBe(true);
    expect(
      mergeGuards({ allowlist: null, readOnly: true }, { allowlist: null, readOnly: false })
        .readOnly,
    ).toBe(true);
  });

  test("a refusal names which side refused, so the fix is findable", () => {
    const byKey = checkToolCall("collections.read", "read", {
      allowlist: ["schema.*"],
      readOnly: false,
      roleAllowlist: null,
    });
    expect(byKey.ok).toBe(false);
    if (!byKey.ok) expect(byKey.message).toContain("API key");

    const byRole = checkToolCall("collections.read", "read", {
      allowlist: null,
      readOnly: false,
      roleAllowlist: ["schema.*"],
    });
    expect(byRole.ok).toBe(false);
    if (!byRole.ok) expect(byRole.message).toContain("roles");
  });
});

describe("mcp guards — role restrictions through a real dispatch", () => {
  let h: TestHarness;
  const supportEmail = `support-${Date.now()}@example.test`;
  const writerEmail = `writer-${Date.now()}@example.test`;
  let adminEmail: string;

  /** Create a role, then attach it to a freshly signed-up user. Leaves the
   *  session signed in as the admin. */
  const roleFor = async (
    email: string,
    role: { name: string; mcpTools?: string[] | null; mcpReadOnly?: boolean },
  ) => {
    const created = await h.fetch("/api/roles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(role),
    });
    const roleId = ((await created.json()) as { data: { id: string } }).data.id;

    await signUp(h, email);
    await signIn(h, adminEmail);
    const users = (await (await h.fetch("/api/users")).json()) as {
      data: { id: string; email: string }[];
    };
    const userId = users.data.find((u) => u.email === email)?.id;
    expect(userId).toBeTruthy();
    await h.fetch(`/api/users/${userId}/roles`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ roleId }),
    });
    return roleId;
  };

  beforeAll(async () => {
    h = makeHarness();
    const seeded = await seedAdmin(h);
    adminEmail = seeded.email;
    await roleFor(supportEmail, {
      name: "support",
      mcpTools: ["schema.*", "collections.read"],
    });
    await roleFor(writerEmail, { name: "writer", mcpReadOnly: true });
  });
  afterAll(() => h.cleanup());

  test("the admin is unaffected — an admin role imposes no MCP restriction", async () => {
    await signIn(h, adminEmail);
    const names = await toolNames(h);
    expect(names).toContain("collections.delete");
    expect(names.length).toBeGreaterThan(50);
  });

  test("tools/list is narrowed to what the caller's role allows", async () => {
    await signIn(h, supportEmail);
    const names = await toolNames(h);
    expect(names).toContain("schema.list_collections");
    expect(names).toContain("collections.read");
    // Outside the allowlist — must not even be advertised.
    expect(names).not.toContain("collections.delete");
    expect(names).not.toContain("storage.upload");
    expect(names.every((n) => n.startsWith("schema.") || n === "collections.read")).toBe(
      true,
    );
  });

  test("a hidden tool is still refused when called directly", async () => {
    await signIn(h, supportEmail);
    const out = await callTool(h, "collections.delete", {
      collection: "posts",
      id: "1",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("FORBIDDEN");
    expect(out.text).toContain("roles");
  });

  test("the refusal lands in the audit log as mcp.denied", async () => {
    await signIn(h, adminEmail);
    const res = await h.fetch("/api/activity?action=mcp.denied&limit=50");
    const body = (await res.json()) as { data: { itemId: string | null }[] };
    expect(body.data.some((r) => r.itemId === "collections.delete")).toBe(true);
  });

  test("a read-only role blocks writes but leaves reads reachable", async () => {
    await signIn(h, writerEmail);
    // No allowlist on this role, so the catalog stays whole…
    const names = await toolNames(h);
    expect(names).toContain("collections.insert");
    // …but the write is refused at call time.
    const write = await callTool(h, "collections.insert", {
      collection: "posts",
      data: {},
    });
    expect(write.isError).toBe(true);
    expect(write.text).toContain("read-only");

    const read = await callTool(h, "schema.list_collections");
    expect(read.text).not.toContain("FORBIDDEN");
  });

  test("the role allowlist survives a key that has none of its own", async () => {
    // A key minted by the restricted user carries no `mcpTools`, so if the
    // restriction lived only on keys this call would succeed.
    await signIn(h, supportEmail);
    const keyRes = await h.fetch("/api/api-keys", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "unrestricted-key" }),
    });
    const token = ((await keyRes.json()) as { data?: { secret?: string } }).data?.secret;
    expect(token).toBeTruthy();

    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        Authorization: `Bearer ${token}`,
        // Drop the cookie session so the key is the only identity in play.
        Cookie: "",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "collections.delete", arguments: { collection: "p", id: "1" } },
      }),
    });
    const body = (await res.json()) as {
      result?: { content: { text: string }[]; isError?: boolean };
    };
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0]?.text).toContain("FORBIDDEN");
  });
});

describe("mcp guards — role fields round-trip over REST", () => {
  let h: TestHarness;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterAll(() => h.cleanup());

  test("create → list → patch keeps mcpTools and mcpReadOnly", async () => {
    const created = await h.fetch("/api/roles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "analyst",
        mcpTools: ["collections.*"],
        mcpReadOnly: true,
      }),
    });
    const id = ((await created.json()) as { data: { id: string } }).data.id;

    const list = (await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; mcpTools: string[] | null; mcpReadOnly: boolean }[];
    };
    const row = list.data.find((r) => r.id === id);
    expect(row?.mcpTools).toEqual(["collections.*"]);
    expect(Boolean(row?.mcpReadOnly)).toBe(true);

    await h.fetch(`/api/roles/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ mcpTools: null, mcpReadOnly: false }),
    });
    const after = (await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; mcpTools: string[] | null; mcpReadOnly: boolean }[];
    };
    const cleared = after.data.find((r) => r.id === id);
    expect(cleared?.mcpTools).toBeNull();
    expect(Boolean(cleared?.mcpReadOnly)).toBe(false);
  });

  test("a malformed pattern is rejected at the edge, not stored", async () => {
    const res = await h.fetch("/api/roles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "bad-patterns", mcpTools: ["collections read"] }),
    });
    expect(res.status).toBe(422);
  });

  test("a role with no MCP fields defaults to unrestricted", async () => {
    const created = await h.fetch("/api/roles", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "plain" }),
    });
    const body = (await created.json()) as {
      data: { mcpTools: string[] | null; mcpReadOnly: boolean };
    };
    expect(body.data.mcpTools).toBeNull();
    expect(body.data.mcpReadOnly).toBe(false);
  });
});
