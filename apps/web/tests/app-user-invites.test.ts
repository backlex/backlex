import { describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * End-user provisioning + auto-linking (the phase after PR #265's
 * person↔app-user link):
 *
 *  1. Admin invite: `POST /api/app-users/invite` creates a pending
 *     (`status: "invited"`, credential-less) app_user, optionally binds roles
 *     and stamps `app_user_id` on a person row; the invitee accepts on the
 *     app plane (`POST /api/t/:slug/auth/invite/accept`) with a password and
 *     lands signed-in, seeing only their own rows.
 *  2. Auto-link on signup: templates seed `portalLinks` rules
 *     (collection + emailField + role) into app_settings; an app-plane
 *     self-signup whose email matches an unlinked person row gets linked and
 *     the self-service role auto-assigned — no admin step.
 */

const JSON_HEADERS = { "content-type": "application/json" };

const applyTemplate = async (h: TestHarness, templateId: string): Promise<void> => {
  const res = await h.fetch("/api/admin/templates/apply", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ templateId }),
  });
  expect(res.status).toBe(201);
};

type Bearer = (path: string, init?: RequestInit) => Promise<Response>;

const bearerFor = (h: TestHarness, token: string): Bearer =>
  (path, init = {}) =>
    Promise.resolve(h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    }));

interface AppUserRow {
  id: string;
  email: string;
  status: string;
  roles: Array<{ id: string; name: string }>;
}

const listAppUsers = async (h: TestHarness): Promise<AppUserRow[]> => {
  const res = await h.fetch("/api/app-users");
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: AppUserRow[] }).data;
};

const roleIdByName = async (h: TestHarness, name: string): Promise<string> => {
  const res = await h.fetch("/api/roles");
  expect(res.status).toBe(200);
  const roles = ((await res.json()) as { data: Array<{ id: string; name: string }> }).data;
  const role = roles.find((r) => r.name === name);
  expect(role, `role "${name}" should exist`).toBeDefined();
  return role!.id;
};

const listIds = async (res: Response): Promise<string[]> => {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  return body.data.map((r) => String(r.id));
};

describe("admin invite → accept (hr)", () => {
  test("invite with role + person link, accept with password, bearer sees only own rows", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      await applyTemplate(h, "hr");

      const emps = (await (await h.fetch("/api/items/employees?fields=id")).json()) as {
        data: Array<{ id: string }>;
      };
      expect(emps.data.length).toBeGreaterThanOrEqual(2);
      const [mine, other] = [emps.data[0]!.id, emps.data[1]!.id];
      const employeeRole = await roleIdByName(h, "Employee (self-service)");

      // Mixed-case input — stored + matched lowercased.
      const invited = await h.fetch("/api/app-users/invite", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          email: "Jane@X.Test",
          name: "Jane",
          roleIds: [employeeRole],
          link: { collection: "employees", itemId: mine },
        }),
      });
      expect(invited.status).toBe(201);
      const inviteBody = (await invited.json()) as {
        data: { id: string; email: string; token: string; expiresAt: number };
      };
      expect(inviteBody.data.email).toBe("jane@x.test");
      expect(inviteBody.data.token.length).toBeGreaterThanOrEqual(16);

      // Pending row is listed with the bound role and no session access.
      const jane = (await listAppUsers(h)).find((u) => u.email === "jane@x.test");
      expect(jane).toBeDefined();
      expect(jane!.status).toBe("invited");
      expect(jane!.roles.map((r) => r.name)).toContain("Employee (self-service)");

      // No credential yet — password sign-in must not work pre-accept.
      const preSignIn = await h.app.request("/api/t/default/auth/sign-in/email", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "jane@x.test", password: "invite-pass-123" }),
      });
      expect(preSignIn.status).not.toBe(200);

      // Person row got linked at invite time.
      const linked = (await (
        await h.fetch(`/api/items/employees/${mine}?fields=id,app_user_id`)
      ).json()) as { data: { app_user_id: string | null } };
      expect(linked.data.app_user_id).toBe(inviteBody.data.id);

      // Guard rails on accept.
      const badToken = await h.app.request("/api/t/default/auth/invite/accept", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: "not-a-real-token", password: "invite-pass-123" }),
      });
      expect(badToken.status).toBe(404);
      const shortPw = await h.app.request("/api/t/default/auth/invite/accept", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: inviteBody.data.token, password: "short" }),
      });
      expect(shortPw.status).toBe(422);

      // Accept → activated + signed in.
      const accepted = await h.app.request("/api/t/default/auth/invite/accept", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: inviteBody.data.token, password: "invite-pass-123" }),
      });
      expect(accepted.status).toBe(200);
      const session = (await accepted.json()) as {
        token: string;
        user: { id: string; email: string };
      };
      expect(session.token).toBeTruthy();
      expect(session.user.id).toBe(inviteBody.data.id);

      const after = (await listAppUsers(h)).find((u) => u.email === "jane@x.test");
      expect(after!.status).toBe("active");

      // The token is one-shot.
      const replay = await h.app.request("/api/t/default/auth/invite/accept", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ token: inviteBody.data.token, password: "invite-pass-123" }),
      });
      expect(replay.status).toBe(404);

      // Bearer sees exactly the linked employee row + only own leave requests.
      const bearer = bearerFor(h, session.token);
      expect(await listIds(await bearer("/api/items/employees"))).toEqual([mine]);
      const reqs = (await (
        await bearer("/api/items/leave_requests?fields=id,employee")
      ).json()) as { data: Array<{ employee: string | { id: string } }> };
      expect(reqs.data.length).toBeGreaterThanOrEqual(1);
      for (const r of reqs.data) {
        const empId = typeof r.employee === "string" ? r.employee : r.employee?.id;
        expect(empId).toBe(mine);
      }
      const touchOther = await bearer(`/api/items/employees/${other}`, {
        method: "PATCH",
        body: JSON.stringify({ job_title: "CEO" }),
      });
      expect([403, 404]).toContain(touchOther.status);

      // …and the fresh credential works for a normal email sign-in too.
      const signIn = await h.app.request("/api/t/default/auth/sign-in/email", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "jane@x.test", password: "invite-pass-123" }),
      });
      expect(signIn.status).toBe(200);
    } finally {
      h.cleanup();
    }
  });

  test("duplicate invite → 409; admin role rejected", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      await applyTemplate(h, "hr");

      const first = await h.fetch("/api/app-users/invite", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "dupe@x.test" }),
      });
      expect(first.status).toBe(201);

      // Same email again (any casing) → CONFLICT.
      const again = await h.fetch("/api/app-users/invite", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "Dupe@X.Test" }),
      });
      expect(again.status).toBe(409);

      // The admin role can never be bound to an end-user — and the failed
      // request must not leave a half-provisioned user behind.
      const adminRole = await roleIdByName(h, "admin");
      const withAdmin = await h.fetch("/api/app-users/invite", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "escalate@x.test", roleIds: [adminRole] }),
      });
      expect(withAdmin.status).toBe(422);
      expect(
        (await listAppUsers(h)).find((u) => u.email === "escalate@x.test"),
      ).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  test("a broken mail transport does not fail the invite", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      // Point the workspace's email at a dead SMTP endpoint — the send fails
      // (connection refused), the invite must still 201 with a usable token.
      const cfg = await h.fetch("/api/admin/email-config", {
        method: "PUT",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          provider: "smtp",
          fromAddress: "noreply@test.local",
          config: { host: "127.0.0.1", port: 1 },
        }),
      });
      expect(cfg.status).toBe(200);

      const invited = await h.fetch("/api/app-users/invite", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "unreachable@x.test" }),
      });
      expect(invited.status).toBe(201);
      const body = (await invited.json()) as { data: { token: string } };
      expect(body.data.token).toBeTruthy();
      // Let the fire-and-forget send fail inside the test's lifetime (its
      // rejection is swallowed by contract).
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      h.cleanup();
    }
  });
});

describe("auto-link on app-plane signup", () => {
  test("hr: signup matching a sample work_email links the row + assigns the role", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      await applyTemplate(h, "hr");

      // hr seeds employees:0 with work_email ada@company.example.
      const signup = await h.fetch("/api/t/default/auth/sign-up/email", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          email: "ada@company.example",
          password: "portal-pass-123",
          name: "Ada Lovelace",
        }),
      });
      expect(signup.status).toBe(200);
      const token = ((await signup.json()) as { token?: string }).token;
      expect(token).toBeTruthy();

      const ada = (await listAppUsers(h)).find((u) => u.email === "ada@company.example");
      expect(ada).toBeDefined();
      expect(ada!.roles.map((r) => r.name)).toContain("Employee (self-service)");

      const emps = (await (
        await h.fetch("/api/items/employees?fields=id,work_email,app_user_id")
      ).json()) as { data: Array<{ id: string; work_email: string; app_user_id: string | null }> };
      const adaRow = emps.data.find((e) => e.work_email === "ada@company.example");
      expect(adaRow).toBeDefined();
      expect(adaRow!.app_user_id).toBe(ada!.id);

      // Bearer sees exactly their own row.
      const bearer = bearerFor(h, token!);
      expect(await listIds(await bearer("/api/items/employees"))).toEqual([adaRow!.id]);

      // Inviting an email that already signed up → 409.
      const dupeInvite = await h.fetch("/api/app-users/invite", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email: "ada@company.example" }),
      });
      expect(dupeInvite.status).toBe(409);
    } finally {
      h.cleanup();
    }
  });

  test("hr: non-matching signup links nothing and assigns no role", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      await applyTemplate(h, "hr");

      const signup = await h.fetch("/api/t/default/auth/sign-up/email", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          email: "stranger@nowhere.test",
          password: "portal-pass-123",
          name: "Stranger",
        }),
      });
      expect(signup.status).toBe(200);

      const stranger = (await listAppUsers(h)).find(
        (u) => u.email === "stranger@nowhere.test",
      );
      expect(stranger).toBeDefined();
      expect(stranger!.roles.map((r) => r.name)).not.toContain("Employee (self-service)");

      const emps = (await (
        await h.fetch("/api/items/employees?fields=id,app_user_id")
      ).json()) as { data: Array<{ app_user_id: string | null }> };
      for (const e of emps.data) expect(e.app_user_id).not.toBe(stranger!.id);
    } finally {
      h.cleanup();
    }
  });

  test("fitness: signup matching a member email links + assigns Member (self-service)", async () => {
    const h = makeHarness();
    try {
      await seedAdmin(h);
      await applyTemplate(h, "fitness");

      // fitness seeds members:0 with email jamie@example.com.
      const signup = await h.fetch("/api/t/default/auth/sign-up/email", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          email: "jamie@example.com",
          password: "portal-pass-123",
          name: "Jamie Fox",
        }),
      });
      expect(signup.status).toBe(200);
      const token = ((await signup.json()) as { token?: string }).token;

      const jamie = (await listAppUsers(h)).find((u) => u.email === "jamie@example.com");
      expect(jamie).toBeDefined();
      expect(jamie!.roles.map((r) => r.name)).toContain("Member (self-service)");

      const members = (await (
        await h.fetch("/api/items/members?fields=id,email,app_user_id")
      ).json()) as { data: Array<{ id: string; email: string; app_user_id: string | null }> };
      const jamieRow = members.data.find((m) => m.email === "jamie@example.com");
      expect(jamieRow).toBeDefined();
      expect(jamieRow!.app_user_id).toBe(jamie!.id);

      const bearer = bearerFor(h, token!);
      expect(await listIds(await bearer("/api/items/members"))).toEqual([jamieRow!.id]);
    } finally {
      h.cleanup();
    }
  });
});
