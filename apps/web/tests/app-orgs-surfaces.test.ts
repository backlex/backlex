import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, BacklexError } from "../../../packages/client/src/index";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Multi-surface parity for app-plane organizations. REST is pinned by
 * app-orgs.test.ts; this pins the three surfaces built alongside it — GraphQL
 * (`appOrgs` / `createAppOrg` / …), the SDK (`client.orgs.*` on both planes)
 * and MCP (`app_orgs.*`) — to the same semantics:
 *
 *   - create → add member → invite, with the org-scoped role binding;
 *   - the last-owner guard fires identically everywhere (VALIDATION);
 *   - the workspace admin role is unassignable as an in-org role everywhere;
 *   - a duplicate pending invitation is a CONFLICT everywhere.
 *
 * Each surface gets its own workspace so the assertions stay deterministic.
 */

const JSON_HEADERS = { "content-type": "application/json" };

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: JSON_HEADERS,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

/** Admin-invite an end-user and accept it — the only way to get an
 *  `app_users` row a membership can point at. */
const makeEndUser = async (
  h: TestHarness,
  email: string,
): Promise<{ id: string; email: string; token: string }> => {
  const invited = await h.fetch("/api/app-users/invite", json("POST", { email }));
  expect(invited.status).toBe(201);
  const { data } = (await invited.json()) as {
    data: { id: string; email: string; token: string };
  };
  const accepted = await h.app.request(
    "/api/t/default/auth/invite/accept",
    json("POST", { token: data.token, password: "surface-pass-123" }),
  );
  expect(accepted.status).toBe(200);
  return {
    id: data.id,
    email: data.email,
    token: ((await accepted.json()) as { token: string }).token,
  };
};

const roleIdByName = async (h: TestHarness, name: string): Promise<string> => {
  const res = await h.fetch("/api/roles");
  const roles = ((await res.json()) as { data: { id: string; name: string }[] }).data;
  const role = roles.find((r) => r.name === name);
  expect(role, `role "${name}" should exist`).toBeDefined();
  return role!.id;
};

describe("app-orgs — GraphQL surface", () => {
  let h: TestHarness;
  let alice: { id: string; email: string; token: string };
  let bob: { id: string; email: string; token: string };
  let orgId: string;

  const gql = async (query: string, variables?: unknown) =>
    (await (await h.fetch("/api/graphql", json("POST", { query, variables }))).json()) as {
      data?: Record<string, any>;
      errors?: { message: string; extensions?: { code?: string } }[];
    };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alice = await makeEndUser(h, "alice@gql.test");
    bob = await makeEndUser(h, "bob@gql.test");
  });
  afterAll(() => h.cleanup());

  test("createAppOrg seeds the owner and appOrgs lists it", async () => {
    const created = await gql(
      `mutation($owner:String){ createAppOrg(name:"Acme GQL", ownerAppUserId:$owner){ id slug name } }`,
      { owner: alice.id },
    );
    expect(created.errors).toBeUndefined();
    const org = created.data?.createAppOrg as { id: string; slug: string };
    expect(org.slug).toBe("acme-gql");
    orgId = org.id;

    const listed = await gql(`query{ appOrgs{ id slug memberCount } }`);
    expect(listed.data?.appOrgs).toEqual([
      { id: orgId, slug: "acme-gql", memberCount: 1 },
    ]);

    const members = await gql(`query($o:String!){ appOrgMembers(orgId:$o){ appUserId role } }`, {
      o: orgId,
    });
    expect(members.data?.appOrgMembers).toEqual([{ appUserId: alice.id, role: "owner" }]);
  });

  test("addAppOrgMember binds an org-scoped role; the admin role is rejected", async () => {
    const roleRes = await h.fetch("/api/roles", json("POST", { name: "Analyst" }));
    const analystId = ((await roleRes.json()) as { data: { id: string } }).data.id;

    const added = await gql(
      `mutation($o:String!,$u:String!,$r:[String!]){
        addAppOrgMember(orgId:$o, appUserId:$u, role:"member", roleIds:$r){ appUserId role roles{ name } }
      }`,
      { o: orgId, u: bob.id, r: [analystId] },
    );
    expect(added.errors).toBeUndefined();
    expect(added.data?.addAppOrgMember).toMatchObject({
      appUserId: bob.id,
      role: "member",
      roles: [{ name: "Analyst" }],
    });

    const adminRoleId = await roleIdByName(h, "admin");
    const escalate = await gql(
      `mutation($o:String!,$u:String!,$r:[String!]){
        updateAppOrgMember(orgId:$o, appUserId:$u, roleIds:$r){ appUserId }
      }`,
      { o: orgId, u: bob.id, r: [adminRoleId] },
    );
    expect(escalate.errors?.[0]?.extensions?.code).toBe("VALIDATION");
  });

  test("the last-owner guard and duplicate invitations surface with their codes", async () => {
    const demote = await gql(
      `mutation($o:String!,$u:String!){ updateAppOrgMember(orgId:$o, appUserId:$u, role:"member"){ role } }`,
      { o: orgId, u: alice.id },
    );
    expect(demote.errors?.[0]?.extensions?.code).toBe("VALIDATION");

    const invited = await gql(
      `mutation($o:String!){ inviteToAppOrg(orgId:$o, email:"NEW@GQL.Test"){ email role token expiresAt } }`,
      { o: orgId },
    );
    expect(invited.errors).toBeUndefined();
    const invite = invited.data?.inviteToAppOrg as { email: string; token: string };
    expect(invite.email).toBe("new@gql.test"); // lowercased, REST parity
    expect(invite.token.length).toBeGreaterThanOrEqual(32);

    const dupe = await gql(
      `mutation($o:String!){ inviteToAppOrg(orgId:$o, email:"new@gql.test"){ email } }`,
      { o: orgId },
    );
    expect(dupe.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    // Already a member → also a CONFLICT, not a second pending row.
    const member = await gql(
      `mutation($o:String!,$e:String!){ inviteToAppOrg(orgId:$o, email:$e){ email } }`,
      { o: orgId, e: bob.email },
    );
    expect(member.errors?.[0]?.extensions?.code).toBe("CONFLICT");

    const invites = await gql(
      `query($o:String!){ appOrgInvites(orgId:$o, pending:true){ email pending } }`,
      { o: orgId },
    );
    expect(invites.data?.appOrgInvites).toEqual([{ email: "new@gql.test", pending: true }]);
  });
});

describe("app-orgs — SDK surface", () => {
  let h: TestHarness;
  let admin: ReturnType<typeof createClient>;
  let alice: { id: string; email: string; token: string };
  let bob: { id: string; email: string; token: string };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alice = await makeEndUser(h, "alice@sdk.test");
    bob = await makeEndUser(h, "bob@sdk.test");
    admin = createClient({ url: "", fetch: h.fetch as unknown as typeof fetch });
  });
  afterAll(() => h.cleanup());

  test("admin mode drives the control-plane routes", async () => {
    const created = await admin.orgs.create({
      name: "Acme SDK",
      ownerAppUserId: alice.id,
    });
    expect(created.data.slug).toBe("acme-sdk");

    const listed = await admin.orgs.list();
    expect(listed.data.map((o) => o.slug)).toEqual(["acme-sdk"]);

    const added = await admin.orgs.addMember(created.data.id, { appUserId: bob.id });
    expect(added.data).toMatchObject({ appUserId: bob.id, role: "member" });

    // The last-owner guard reaches the SDK as a typed 422.
    const err = await admin.orgs
      .updateMember(created.data.id, alice.id, { role: "member" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BacklexError);
    expect((err as BacklexError).status).toBe(422);
  });

  test("app mode is scoped to the signed-in end-user, and `use()` sets the active org", async () => {
    // App-plane client authenticated as Alice.
    const app = createClient({
      url: "",
      workspace: "default",
      token: alice.token,
      fetch: ((input: string, init?: RequestInit) =>
        h.app.request(input, init)) as unknown as typeof fetch,
    });

    const mine = await app.orgs.list();
    expect(mine.data.map((o) => o.slug)).toEqual(["acme-sdk"]);
    expect(mine.data[0]!.role).toBe("owner");

    // A second org she owns, created from the app plane.
    const second = await app.orgs.create({ name: "Beta SDK" });
    expect(second.data.slug).toBe("beta-sdk");

    // With two memberships nothing is active until she picks one.
    expect((await app.orgs.list()).active?.orgId).toBeNull();
    app.orgs.use(second.data.slug);
    expect(app.orgs.active()).toBe("beta-sdk");
    expect((await app.orgs.list()).active?.orgId).toBe(second.data.id);

    // Naming an org she doesn't belong to is refused rather than ignored.
    app.orgs.use("acme-sdk-nope");
    await expect(app.orgs.list()).rejects.toMatchObject({ status: 403 });
    app.orgs.use(null);

    // Invite → accept on Bob's own app-mode client.
    const invite = await app.orgs.invite(second.data.id, { email: bob.email });
    expect(invite.data.email).toBe(bob.email);
    const bobApp = createClient({
      url: "",
      workspace: "default",
      token: bob.token,
      fetch: ((input: string, init?: RequestInit) =>
        h.app.request(input, init)) as unknown as typeof fetch,
    });
    const accepted = await bobApp.orgs.acceptInvite(invite.data.token);
    expect(accepted.data.org.slug).toBe("beta-sdk");
    expect(accepted.data.role).toBe("member");

    // setActive pins the session — visible on the next list without a header.
    await bobApp.orgs.setActive(second.data.slug);
    expect((await bobApp.orgs.list()).active?.orgId).toBe(second.data.id);
  });
});

describe("app-orgs — MCP surface", () => {
  let h: TestHarness;
  let alice: { id: string; email: string; token: string };
  let bob: { id: string; email: string; token: string };
  let orgId: string;
  let rpcId = 1;

  const callTool = async (name: string, args: unknown) => {
    const res = await h.fetch(
      "/mcp",
      json("POST", {
        jsonrpc: "2.0",
        id: rpcId++,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
    return (await res.json()) as {
      result?: { structuredContent?: any; isError?: boolean };
      error?: { message: string };
    };
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    alice = await makeEndUser(h, "alice@mcp.test");
    bob = await makeEndUser(h, "bob@mcp.test");
  });
  afterAll(() => h.cleanup());

  test("create → members → invite round-trips through the tools", async () => {
    const created = await callTool("app_orgs.create", {
      name: "Acme MCP",
      ownerAppUserId: alice.id,
    });
    expect(created.result?.isError).toBeFalsy();
    const org = created.result?.structuredContent?.data as { id: string; slug: string };
    expect(org.slug).toBe("acme-mcp");
    orgId = org.id;

    const listed = await callTool("app_orgs.list", {});
    expect(
      (listed.result?.structuredContent?.data as { slug: string }[]).map((o) => o.slug),
    ).toEqual(["acme-mcp"]);

    const added = await callTool("app_orgs.add_member", { id: orgId, appUserId: bob.id });
    expect(added.result?.structuredContent?.data).toMatchObject({
      appUserId: bob.id,
      role: "member",
    });

    const members = await callTool("app_orgs.members", { id: "acme-mcp" });
    expect((members.result?.structuredContent?.data as unknown[]).length).toBe(2);

    const invited = await callTool("app_orgs.invite", { id: orgId, email: "New@MCP.Test" });
    expect(invited.result?.structuredContent?.data?.email).toBe("new@mcp.test");
  });

  test("service guards surface as tool errors carrying their codes", async () => {
    const dupe = await callTool("app_orgs.invite", { id: orgId, email: "new@mcp.test" });
    expect(dupe.result?.isError).toBe(true);
    expect(dupe.result?.structuredContent?.error?.code).toBe("CONFLICT");

    const demote = await callTool("app_orgs.update_member", {
      id: orgId,
      appUserId: alice.id,
      role: "member",
    });
    expect(demote.result?.isError).toBe(true);
    expect(demote.result?.structuredContent?.error?.code).toBe("VALIDATION");

    const adminRoleId = await roleIdByName(h, "admin");
    const escalate = await callTool("app_orgs.update_member", {
      id: orgId,
      appUserId: bob.id,
      roleIds: [adminRoleId],
    });
    expect(escalate.result?.isError).toBe(true);
    expect(escalate.result?.structuredContent?.error?.code).toBe("VALIDATION");
  });

  test("the read tools are classified as reads so read-only keys keep them", async () => {
    const res = await h.fetch(
      "/mcp",
      json("POST", { jsonrpc: "2.0", id: rpcId++, method: "tools/list", params: {} }),
    );
    const body = (await res.json()) as {
      result: { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] };
    };
    // The tenant mount publishes wire names (dots → hyphens) so strict clients
    // accept them; `tools/call` translates back, which is why the calls above
    // could use the dotted ids.
    const byName = new Map(body.result.tools.map((t) => [t.name, t]));
    // The name heuristic would have called these writes ("members"/"invites"
    // aren't read verbs), which would have hidden them from read-only keys.
    for (const name of ["app_orgs-list", "app_orgs-get", "app_orgs-members", "app_orgs-invites"]) {
      expect(byName.get(name)?.annotations?.readOnlyHint, name).toBe(true);
    }
    expect(byName.get("app_orgs-create")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("app_orgs-remove_member")?.annotations?.destructiveHint).toBe(true);
  });
});
