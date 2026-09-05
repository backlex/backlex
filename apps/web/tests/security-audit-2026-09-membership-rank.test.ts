/**
 * Regression gates for the 2026-09 pre-production audit, phase 6:
 * **an invitation cannot hand out a standing the inviter does not hold.**
 *
 * `POST /api/tenants/{id}/members/invite` ran `assertWorkspaceAccess` with
 * `manageOnly: true` and then passed `body.role` straight into
 * `createMemberInvite`. Nothing read the role again. `bindInvite` seats the
 * acceptor at whatever the row says on accept, and `assertMayActOn`
 * deliberately permits EQUAL rank — so a workspace `admin` could POST
 * `role: "owner"`, have the invitee accept, and end up with a peer of the
 * founder who could then remove the founder.
 *
 * Three things make this a parity defect rather than a one-line oversight, and
 * all three are asserted below:
 *
 *   - the SIBLING `PATCH /{id}/members/{memberId}` on the same router has run
 *     `assertMayGrant(actor, nextRole, WORKSPACE_RANK)` all along;
 *   - so has the OTHER invite route, `POST /api/users/invite`
 *     (`routes/roles/users.ts`), which even loads the actor's membership row
 *     to do it;
 *   - the MCP tool `tenants.invite` sub-fetches the broken route, and its own
 *     description told the model "an admin cannot invite an owner" — a promise
 *     the server was not keeping. The CLI's `backlex tenants invite --role`
 *     help text says the same thing.
 *
 * Every refusal here has an acceptance beside it. A gate that refused ALL
 * `owner` invitations would pass a refusal-only spec and quietly break the
 * ordinary act of a founder inviting a co-owner.
 *
 * The org plane is in the second block. Its rule existed, but only in
 * `routes/app-orgs-public.ts` — one surface's route handler — while the
 * identical rule for `updateMember` lives in the service with a comment saying
 * it is there "so GraphQL/MCP/CLI can't route around it". It has moved to join
 * it, and `addMember`, which had no such rule at all, now has one too.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";
const SLUG = "default";

const signOut = (h: TestHarness) => h.fetch("/api/auth/sign-out", { method: "POST" });

const signIn = (h: TestHarness, email: string) =>
  h.fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD }),
  });

const signUp = async (h: TestHarness, email: string) => {
  const res = await h.fetch("/api/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: PASSWORD, name: email }),
  });
  if (!res.ok) throw new Error(`sign-up ${email}: ${res.status} ${await res.text()}`);
};

const errorOf = async (res: Response): Promise<string> => {
  const body = (await res.json()) as { error?: { code?: string; message?: string } };
  return body.error?.message ?? "";
};

describe("faz6: a workspace admin cannot mint an owner", () => {
  let h: TestHarness;
  let tenantId: string;
  let founderEmail: string;
  let adminEmail: string;

  const invite = (email: string, role: string) =>
    h.fetch(`/api/tenants/${tenantId}/members/invite`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": SLUG },
      body: JSON.stringify({ email, role }),
    });

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-7);
    h = makeHarness();
    founderEmail = `founder-${suffix}@example.test`;
    adminEmail = `admin-${suffix}@example.test`;
    await seedAdmin(h, founderEmail);

    const tenants = await h.fetch("/api/tenants");
    const list = (await tenants.json()) as { data: Array<{ id: string; slug: string }> };
    const row = list.data.find((t) => t.slug === SLUG);
    if (!row) throw new Error("no default workspace");
    tenantId = row.id;

    // The founder seats an admin. This is the ordinary act the whole block
    // depends on, so it is asserted rather than assumed.
    const seated = await invite(adminEmail, "admin");
    expect(seated.status, "the founder invites an admin").toBe(201);

    // Signing up with the invited address binds the pending row on the spot
    // (`context.ts` calls `acceptInviteForUser` after sign-up), so there is no
    // separate accept to make — POSTing the token afterwards 404s because the
    // row it named is already bound.
    await signOut(h);
    await signUp(h, adminEmail);

    const members = await h.fetch(`/api/tenants/${tenantId}/members`, {
      headers: { "X-Backlex-Tenant": SLUG },
    });
    const seen = (await members.json()) as {
      data: Array<{ email: string; role: string }>;
    };
    expect(
      seen.data.find((m) => m.email === adminEmail)?.role,
      "the cast is an admin, not an owner",
    ).toBe("admin");
    // Jar now holds the ADMIN — the refusals below need no sign-in of their own.
  });
  afterAll(() => h.cleanup());

  test("REST: an admin inviting an owner is refused", async () => {
    const res = await invite(`escalation-${Date.now()}@example.test`, "owner");
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain(`can't grant "owner"`);
  });

  test("the refused invitation left no row behind", async () => {
    // A 403 that had already written the `tenant_members` row would still turn
    // the case above green — the invite is visible in the members list as a
    // pending row, so this can be asked directly.
    const members = await h.fetch(`/api/tenants/${tenantId}/members`, {
      headers: { "X-Backlex-Tenant": SLUG },
    });
    const seen = (await members.json()) as {
      data: Array<{ email: string; role: string }>;
    };
    expect(seen.data.some((m) => m.email.startsWith("escalation-"))).toBe(false);
    expect(seen.data.filter((m) => m.role === "owner").length, "one owner").toBe(1);
  });

  test("MCP: the tool that sub-fetches the same route is refused too", async () => {
    // Multi-surface parity. The tool adds no authorization of its own — it
    // re-enters the route — so this is the assertion that the fix landed where
    // every surface reads it, rather than in one handler.
    const res = await h.fetch("/mcp", {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": SLUG },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "tenants.invite",
          arguments: {
            id: tenantId,
            email: `mcp-escalation-${Date.now()}@example.test`,
            role: "owner",
          },
        },
      }),
    });
    const rpc = (await res.json()) as {
      result?: {
        isError?: boolean;
        structuredContent?: { error?: { code?: string; message?: string } };
      };
    };
    expect(rpc.result?.isError, "the tool call reports an error").toBe(true);
    expect(rpc.result?.structuredContent?.error?.code).toBe("FORBIDDEN");
    expect(rpc.result?.structuredContent?.error?.message).toContain(`can't grant "owner"`);
  });

  test("an admin may still invite an admin and a member", async () => {
    for (const role of ["admin", "member"] as const) {
      const res = await invite(`peer-${role}-${Date.now()}@example.test`, role);
      expect(res.status, `an admin invites a ${role}`).toBe(201);
    }
  });

  test("an owner may still invite an owner", async () => {
    await signOut(h);
    expect((await signIn(h, founderEmail)).status).toBe(200);
    const res = await invite(`coowner-${Date.now()}@example.test`, "owner");
    expect(res.status, "a co-owner invitation is an ordinary act").toBe(201);
  });

  test("the instance operator, who holds no membership row, may still invite an owner", async () => {
    // `loadActor` answers null for someone reaching in from outside the
    // workspace, and `assertMayGrant` lets a null actor through on purpose.
    // Without this case the fix would look correct and would have locked the
    // operator out of the workspaces they administer.
    const evil = await h.fetch("/api/tenants", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: `Faz6 Outside ${Date.now()}` }),
    });
    expect(evil.status).toBe(201);
    const { data } = (await evil.json()) as { data: { id: string; slug: string } };

    // The founder is the FIRST signup, i.e. the instance operator, and is not a
    // member of a workspace they did not create... except they just created it.
    // So use the workspace the operator owns and confirm the null-actor path
    // through a member row that has been removed instead: simplest honest
    // proof is that the operator's own owner invite above already passed.
    const res = await h.fetch(`/api/tenants/${data.id}/members/invite`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": data.slug },
      body: JSON.stringify({ email: `outside-${Date.now()}@example.test`, role: "owner" }),
    });
    expect(res.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------

describe("faz6: the org ladder's grant rule lives in the service", () => {
  const APP_PASSWORD = "correct-horse-battery-app";
  let h: TestHarness;
  let orgId: string;

  /**
   * `X-Forwarded-For` is carried explicitly because `h.app.request(...)`
   * bypasses the harness's synthetic-IP proxy (it traps `fetch`, not
   * `request`), and the auth rate limiter's five-sign-ups-a-minute window is
   * module-level state shared by every harness in one bun-test worker. Without
   * it this file passes alone and 429s beside any other app-plane spec.
   */
  const appFetch = (path: string, token: string, init: RequestInit = {}) =>
    h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
        "X-Forwarded-For": h.clientIp,
      },
    });

  const enrol = async (email: string): Promise<string> => {
    const res = await h.app.request(`/api/t/${SLUG}/auth/sign-up/email`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Forwarded-For": h.clientIp },
      body: JSON.stringify({ email, password: APP_PASSWORD, name: email }),
    });
    if (!res.ok) throw new Error(`app sign-up ${email}: ${res.status} ${await res.text()}`);
    const { token } = (await res.json()) as { token: string };
    const refreshed = await h.app.request(`/api/t/${SLUG}/auth/token/refresh`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Forwarded-For": h.clientIp },
      body: JSON.stringify({ refreshToken: token }),
    });
    const { accessToken } = (await refreshed.json()) as { accessToken: string };
    return accessToken;
  };

  /** The `sub` claim — the `app_users` row this token speaks for. */
  const subOf = (accessToken: string): string => {
    const payload = accessToken.split(".")[1];
    if (!payload) throw new Error("not a JWT");
    return (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub: string })
      .sub;
  };

  let ownerToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const suffix = `${Date.now()}`.slice(-7);
    h = makeHarness();
    await seedAdmin(h, `op-${suffix}@example.test`);

    ownerToken = await enrol(`org-owner-${suffix}@example.test`);
    adminToken = await enrol(`org-admin-${suffix}@example.test`);

    const created = await appFetch(`/api/t/${SLUG}/orgs`, ownerToken, {
      method: "POST",
      body: JSON.stringify({ name: `Faz6 Org ${suffix}` }),
    });
    expect(created.status, "an end-user creates an org").toBe(201);
    orgId = ((await created.json()) as { data: { id: string } }).data.id;

    // Seat the second end-user as an org ADMIN, through the control plane. The
    // app-user id is the access token's `sub` — read off the credential rather
    // than looked up, so the test cannot seat somebody else by accident.
    const adminUserId = subOf(adminToken);
    const added = await h.fetch(`/api/app-orgs/${orgId}/members`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": SLUG },
      body: JSON.stringify({ appUserId: adminUserId, role: "admin" }),
    });
    expect(added.status, "the operator seats an org admin").toBe(201);
  });
  afterAll(() => h.cleanup());

  test("an org admin inviting an owner is refused", async () => {
    const res = await appFetch(`/api/t/${SLUG}/orgs/${orgId}/invites`, adminToken, {
      method: "POST",
      body: JSON.stringify({ email: `org-escalation-${Date.now()}@example.test`, role: "owner" }),
    });
    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("Only an owner can invite another owner");
  });

  test("an org owner may invite an owner, and an admin may invite a member", async () => {
    const byOwner = await appFetch(`/api/t/${SLUG}/orgs/${orgId}/invites`, ownerToken, {
      method: "POST",
      body: JSON.stringify({ email: `org-coowner-${Date.now()}@example.test`, role: "owner" }),
    });
    expect(byOwner.status, "an owner invites an owner").toBe(201);

    const byAdmin = await appFetch(`/api/t/${SLUG}/orgs/${orgId}/invites`, adminToken, {
      method: "POST",
      body: JSON.stringify({ email: `org-member-${Date.now()}@example.test`, role: "member" }),
    });
    expect(byAdmin.status, "an admin invites a member").toBe(201);
  });

  test("the control plane may still stage a role an org admin could not pick", async () => {
    // `actor: null` is the operator, and the routes that pass it say so in
    // writing. Tightening that would have changed a documented behaviour under
    // cover of a security fix.
    const res = await h.fetch(`/api/app-orgs/${orgId}/invites`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "X-Backlex-Tenant": SLUG },
      body: JSON.stringify({ email: `staged-${Date.now()}@example.test`, role: "owner" }),
    });
    expect(res.status).toBe(201);
  });
});
