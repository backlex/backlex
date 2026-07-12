import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { createClient, BacklexError } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for the end-user invite flow. REST
 * (`POST /api/app-users/invite` → `POST /api/t/:slug/auth/invite/accept`) is
 * pinned by app-user-invites.test.ts; this pins the three surfaces added
 * alongside it — GraphQL (`inviteAppUser`), the SDK (`client.appUsers.invite`
 * + app-mode `auth.acceptInvite`), and MCP (`app_users.invite`) — to the same
 * semantics: pending row + one-shot token, role + person-link at invite time,
 * the accepted bearer sees only their own rows, and a duplicate email
 * surfaces as CONFLICT on every surface. Each surface gets a fresh workspace
 * (hr template) so the linked-row assertions stay deterministic.
 */
const JSON_HEADERS = { "content-type": "application/json" };

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

/** Apply hr and return the first two employee ids + the portal role id. */
const setupHr = async (
  h: TestHarness,
): Promise<{ mine: string; other: string; roleId: string }> => {
  await seedAdmin(h);
  const applied = await h.fetch("/api/admin/templates/apply", json({ templateId: "hr" }));
  expect(applied.status).toBe(201);
  const emps = (await (await h.fetch("/api/items/employees?fields=id")).json()) as {
    data: Array<{ id: string }>;
  };
  expect(emps.data.length).toBeGreaterThanOrEqual(2);
  const roles = (await (await h.fetch("/api/roles")).json()) as {
    data: Array<{ id: string; name: string }>;
  };
  const role = roles.data.find((r) => r.name === "Employee (self-service)");
  expect(role).toBeDefined();
  return { mine: emps.data[0]!.id, other: emps.data[1]!.id, roleId: role!.id };
};

/** REST accept (the app plane has a single accept endpoint every surface
 *  funnels into) — returns the bearer session token. */
const acceptInvite = async (h: TestHarness, token: string): Promise<string> => {
  const res = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json({ token, password: "invite-pass-123" }),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token: string };
  expect(body.token).toBeTruthy();
  return body.token;
};

/** Ids visible to the bearer on /api/items/employees. */
const bearerEmployeeIds = async (h: TestHarness, token: string): Promise<string[]> => {
  const res = await h.app.request("/api/items/employees", {
    headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data.map((r) => String(r.id));
};

describe("app-user invite — GraphQL surface", () => {
  let h: TestHarness;
  let hr: { mine: string; other: string; roleId: string };
  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json({ query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    hr = await setupHr(h);
  });
  afterAll(() => h.cleanup());

  test("inviteAppUser mints a token, binds the role and links the person row", async () => {
    const res = await gql(
      `mutation($email:String!,$roleIds:[String!],$link:InviteAppUserLinkInput){
        inviteAppUser(email:$email, name:"Jane", roleIds:$roleIds, link:$link){ id email token expiresAt }
      }`,
      {
        email: "Jane@GQL.Test", // mixed case → stored lowercased, REST parity
        roleIds: [hr.roleId],
        link: { collection: "employees", itemId: hr.mine },
      },
    );
    expect(res.errors).toBeUndefined();
    const invite = res.data?.inviteAppUser as {
      id: string;
      email: string;
      token: string;
      expiresAt: number;
    };
    expect(invite.email).toBe("jane@gql.test");
    expect(invite.token.length).toBeGreaterThanOrEqual(16);
    expect(invite.expiresAt).toBeGreaterThan(Date.now());

    // Pending row with the bound role; person row already linked.
    const users = (await (await h.fetch("/api/app-users")).json()) as {
      data: Array<{ id: string; email: string; status: string; roles: Array<{ name: string }> }>;
    };
    const jane = users.data.find((u) => u.email === "jane@gql.test");
    expect(jane?.status).toBe("invited");
    expect(jane?.roles.map((r) => r.name)).toContain("Employee (self-service)");
    const linked = (await (
      await h.fetch(`/api/items/employees/${hr.mine}?fields=id,app_user_id`)
    ).json()) as { data: { app_user_id: string | null } };
    expect(linked.data.app_user_id).toBe(invite.id);

    // REST accept → bearer sees exactly the linked row.
    const bearer = await acceptInvite(h, invite.token);
    expect(await bearerEmployeeIds(h, bearer)).toEqual([hr.mine]);
  });

  test("duplicate invite surfaces CONFLICT; admin role rejected as VALIDATION", async () => {
    const dupe = await gql(
      `mutation{ inviteAppUser(email:"jane@gql.test"){ id } }`,
    );
    expect(dupe.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    const roles = (await (await h.fetch("/api/roles")).json()) as {
      data: Array<{ id: string; name: string }>;
    };
    const adminRole = roles.data.find((r) => r.name === "admin")!;
    const escalate = await gql(
      `mutation($roleIds:[String!]){ inviteAppUser(email:"escalate@gql.test", roleIds:$roleIds){ id } }`,
      { roleIds: [adminRole.id] },
    );
    expect(escalate.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });
});

describe("app-user invite — SDK surface", () => {
  let h: TestHarness;
  let hr: { mine: string; other: string; roleId: string };
  let admin: ReturnType<typeof createClient>;

  beforeAll(async () => {
    h = makeHarness();
    hr = await setupHr(h);
    // Admin plane: cookie-authed control-plane client.
    admin = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("appUsers.invite → app-mode auth.acceptInvite → own rows only", async () => {
    const invited = await admin.appUsers.invite({
      email: "Jane@SDK.Test",
      name: "Jane",
      roleIds: [hr.roleId],
      link: { collection: "employees", itemId: hr.mine },
    });
    expect(invited.data.email).toBe("jane@sdk.test");
    expect(invited.data.token.length).toBeGreaterThanOrEqual(16);
    expect(invited.data.expiresAt).toBeGreaterThan(Date.now());

    // App plane: workspace-mode client, no admin cookies — accept signs in and
    // captures the bearer token for subsequent data calls.
    const app = createClient({
      url: "",
      workspace: "default",
      fetch: ((input: string, init?: RequestInit) =>
        h.app.request(input, init)) as unknown as typeof fetch,
    });
    const session = await app.auth.acceptInvite({
      token: invited.data.token,
      password: "invite-pass-123",
    });
    expect(session.user.email).toBe("jane@sdk.test");
    expect(app.auth.getToken()).toBeTruthy();

    const rows = await app.from<{ id: string }>("employees").list();
    expect(rows.data.map((r) => String(r.id))).toEqual([hr.mine]);

    // The invite token is one-shot.
    await expect(
      app.auth.acceptInvite({ token: invited.data.token, password: "invite-pass-123" }),
    ).rejects.toMatchObject({ status: 404 });
  });

  test("duplicate invite rejects with CONFLICT (409)", async () => {
    const err = await admin.appUsers
      .invite({ email: "jane@sdk.test" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BacklexError);
    expect((err as BacklexError).status).toBe(409);
    expect((err as BacklexError).code).toBe("CONFLICT");
  });
});

describe("app-user invite — MCP surface", () => {
  let h: TestHarness;
  let hr: { mine: string; other: string; roleId: string };
  let rpcId = 1;
  const callTool = async (name: string, args: unknown) => {
    const res = await h.fetch(
      "/mcp",
      json({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name, arguments: args } }),
    );
    return (await res.json()) as {
      result?: { structuredContent?: any; isError?: boolean };
      error?: { message: string };
    };
  };

  beforeAll(async () => {
    h = makeHarness();
    hr = await setupHr(h);
  });
  afterAll(() => h.cleanup());

  test("app_users.invite mints a token, binds the role and links the person row", async () => {
    const r = await callTool("app_users.invite", {
      email: "Jane@MCP.Test",
      name: "Jane",
      roleIds: [hr.roleId],
      link: { collection: "employees", itemId: hr.mine },
    });
    expect(r.error).toBeUndefined();
    expect(r.result?.isError).toBeFalsy();
    const invite = r.result?.structuredContent?.data as {
      id: string;
      email: string;
      token: string;
      expiresAt: number;
    };
    expect(invite.email).toBe("jane@mcp.test");
    expect(invite.token.length).toBeGreaterThanOrEqual(16);

    const linked = (await (
      await h.fetch(`/api/items/employees/${hr.mine}?fields=id,app_user_id`)
    ).json()) as { data: { app_user_id: string | null } };
    expect(linked.data.app_user_id).toBe(invite.id);

    // REST accept → bearer sees exactly the linked row.
    const bearer = await acceptInvite(h, invite.token);
    expect(await bearerEmployeeIds(h, bearer)).toEqual([hr.mine]);
  });

  test("duplicate invite surfaces as a tool error with the CONFLICT code", async () => {
    const r = await callTool("app_users.invite", { email: "jane@mcp.test" });
    expect(r.result?.isError).toBe(true);
    expect(r.result?.structuredContent?.error?.code).toBe("CONFLICT");
  });
});
