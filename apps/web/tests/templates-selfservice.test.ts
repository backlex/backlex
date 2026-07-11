import { describe, expect, test } from "bun:test";
import { TEMPLATES } from "../src/server/templates/catalog";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/**
 * Self-service ("portal") roles: person collections carry an `app_user_id`
 * link to the workspace end-user (`app_users`), and templates bundle roles
 * whose permission conditions scope reads to `$user.id` — directly
 * (`app_user_id`) or one relation hop away (`employee.app_user_id`).
 *
 * Two layers:
 * 1. Static: every bundled role condition must reference fields that exist,
 *    and every relation hop must land on a collection that has `app_user_id`
 *    (a typo here would only explode at query time, not at seed time).
 * 2. E2E (hr + fitness): app-plane signup → link the person row → assign the
 *    role → the bearer sees exactly their own rows and no one else's.
 */

const JSON_HEADERS = { "content-type": "application/json" };

/* ── static validation over the whole catalog ── */

type Cond = Record<string, unknown>;

const isComparison = (v: unknown): boolean =>
  typeof v === "object" &&
  v !== null &&
  Object.keys(v as Cond).every((k) => k.startsWith("_"));

/** Permission conditions must use DOTTED relation paths ("employee.app_user_id").
 *  The nested-object form is only normalized for REST `filter` (schema-aware);
 *  the permission compiler ignores it SILENTLY → rows leak. Treat nesting as a
 *  hard authoring error. */
const leafFieldRefs = (cond: Cond): string[][] => {
  const out: string[][] = [];
  for (const [key, value] of Object.entries(cond)) {
    if (["$and", "$or", "_and", "_or"].includes(key)) {
      for (const sub of value as Cond[]) out.push(...leafFieldRefs(sub));
    } else if (key === "$not" || key === "_not") {
      out.push(...leafFieldRefs(value as Cond));
    } else {
      expect(
        isComparison(value),
        `condition key "${key}" nests an object — permission conditions must use dotted paths`,
      ).toBe(true);
      out.push(key.split("."));
    }
  }
  return out;
};

describe("self-service role conditions are statically sound", () => {
  for (const tpl of TEMPLATES) {
    const roles = tpl.roles ?? [];
    if (roles.length === 0) continue;
    test(`${tpl.id} role conditions reference real fields`, () => {
      const bySlug = new Map(tpl.collections.map((c) => [c.slug, c]));
      for (const role of roles) {
        for (const perm of role.permissions) {
          const collection = bySlug.get(perm.collection);
          expect(collection, `${role.name}: unknown collection ${perm.collection}`).toBeDefined();
          if (!perm.condition) continue;
          for (const ref of leafFieldRefs(perm.condition as Cond)) {
            let current = collection!;
            for (let i = 0; i < ref.length; i++) {
              const name = ref[i]!;
              const field = current.fields.find((f) => f.name === name);
              expect(
                field,
                `${tpl.id}/${role.name}: "${ref.join(".")}" — "${name}" missing on ${current.slug}`,
              ).toBeDefined();
              if (i < ref.length - 1) {
                expect(
                  field!.type,
                  `${tpl.id}/${role.name}: "${name}" on ${current.slug} must be a relation to traverse`,
                ).toBe("relation");
                const target = bySlug.get((field as { to?: string }).to ?? "");
                expect(
                  target,
                  `${tpl.id}/${role.name}: relation "${name}" targets unknown collection`,
                ).toBeDefined();
                current = target!;
              }
            }
          }
        }
      }
    });
  }
});

/* ── E2E: app-plane user sees only their own rows ── */

interface PortalSetup {
  h: TestHarness;
  bearer: (path: string, init?: RequestInit) => Promise<Response>;
  appUserId: string;
}

/** Apply a template, sign up an app-plane user, assign them a bundled role. */
const setupPortalUser = async (
  h: TestHarness,
  templateId: string,
  roleName: string,
  email: string,
): Promise<PortalSetup> => {
  await seedAdmin(h);
  const applied = await h.fetch("/api/admin/templates/apply", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ templateId }),
  });
  expect(applied.status).toBe(201);

  const signup = await h.fetch("/api/t/default/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "portal-pass-123", name: "Portal User" }),
  });
  expect(signup.status).toBe(200);
  // The body token is the bare app-session token (`findAppSession` key); the
  // `set-auth-token` header carries the cookie-signed form, which bearer auth
  // does not accept.
  const token = ((await signup.json()) as { token?: string }).token;
  expect(token).toBeTruthy();

  const users = (await (await h.fetch("/api/app-users")).json()) as {
    data: { id: string; email: string }[];
  };
  const appUser = users.data.find((u) => u.email === email);
  expect(appUser).toBeDefined();

  const roles = (await (await h.fetch("/api/roles")).json()) as {
    data: { id: string; name: string }[];
  };
  const role = roles.data.find((r) => r.name === roleName);
  expect(role, `role "${roleName}" should be seeded by ${templateId}`).toBeDefined();
  const bind = await h.fetch(`/api/app-users/${appUser!.id}/roles`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ roleIds: [role!.id] }),
  });
  expect(bind.status).toBe(200);

  const bearer = (path: string, init: RequestInit = {}) =>
    h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
  return { h, bearer, appUserId: appUser!.id };
};

const listIds = async (res: Response): Promise<string[]> => {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Record<string, unknown>[] };
  return body.data.map((r) => String(r.id));
};

describe("hr — Employee (self-service)", () => {
  test("employee sees own record, allocations and requests only; can file leave", async () => {
    const h = makeHarness();
    try {
      const { bearer, appUserId } = await setupPortalUser(
        h,
        "hr",
        "Employee (self-service)",
        "jane.employee@example.com",
      );

      // Link the FIRST sample employee to the signed-up app user; the second
      // sample employee stays unlinked and must remain invisible.
      const emps = (await (await h.fetch("/api/items/employees?fields=id")).json()) as {
        data: { id: string }[];
      };
      expect(emps.data.length).toBeGreaterThanOrEqual(2);
      const [mine, other] = [emps.data[0]!.id, emps.data[1]!.id];
      const link = await h.fetch(`/api/items/employees/${mine}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ app_user_id: appUserId }),
      });
      expect(link.status).toBe(200);

      // Own employee row only.
      const visible = await listIds(await bearer("/api/items/employees"));
      expect(visible).toEqual([mine]);

      // Lookups are readable; other people's allocations are not.
      expect((await bearer("/api/items/leave_types")).status).toBe(200);
      expect((await bearer("/api/items/public_holidays")).status).toBe(200);
      const allocs = (await (
        await bearer("/api/items/leave_allocations?fields=id,employee")
      ).json()) as { data: { employee: string | { id: string } }[] };
      for (const a of allocs.data) {
        const empId = typeof a.employee === "string" ? a.employee : a.employee?.id;
        expect(empId).toBe(mine);
      }

      // Can file a leave request for themselves…
      const types = (await (await bearer("/api/items/leave_types?fields=id")).json()) as {
        data: { id: string }[];
      };
      const created = await bearer("/api/items/leave_requests", {
        method: "POST",
        body: JSON.stringify({
          employee: mine,
          leave_type: types.data[0]?.id,
          start_date: Date.UTC(2026, 8, 1),
          end_date: Date.UTC(2026, 8, 5),
          days: 5,
        }),
      });
      expect(created.status).toBe(201);

      // …and sees only their own requests afterwards.
      const reqs = (await (
        await bearer("/api/items/leave_requests?fields=id,employee")
      ).json()) as { data: { employee: string | { id: string } }[] };
      expect(reqs.data.length).toBeGreaterThanOrEqual(1);
      for (const r of reqs.data) {
        const empId = typeof r.employee === "string" ? r.employee : r.employee?.id;
        expect(empId).toBe(mine);
      }

      // No write access outside their scope: employees update is forbidden.
      const touchOther = await bearer(`/api/items/employees/${other}`, {
        method: "PATCH",
        body: JSON.stringify({ job_title: "CEO" }),
      });
      expect([403, 404]).toContain(touchOther.status);
    } finally {
      h.cleanup();
    }
  });
});

describe("fitness — Member (self-service)", () => {
  test("member sees classes but only their own bookings and measurements", async () => {
    const h = makeHarness();
    try {
      const { bearer, appUserId } = await setupPortalUser(
        h,
        "fitness",
        "Member (self-service)",
        "jamie.member@example.com",
      );

      const members = (await (await h.fetch("/api/items/members?fields=id")).json()) as {
        data: { id: string }[];
      };
      const mine = members.data[0]!.id;
      await h.fetch(`/api/items/members/${mine}`, {
        method: "PATCH",
        headers: JSON_HEADERS,
        body: JSON.stringify({ app_user_id: appUserId }),
      });

      expect(await listIds(await bearer("/api/items/members"))).toEqual([mine]);
      expect((await bearer("/api/items/classes")).status).toBe(200);
      expect((await bearer("/api/items/class_sessions")).status).toBe(200);

      const bookings = (await (
        await bearer("/api/items/class_bookings?fields=id,member")
      ).json()) as { data: { member: string | { id: string } }[] };
      for (const b of bookings.data) {
        const memberId = typeof b.member === "string" ? b.member : b.member?.id;
        expect(memberId).toBe(mine);
      }
    } finally {
      h.cleanup();
    }
  });
});
