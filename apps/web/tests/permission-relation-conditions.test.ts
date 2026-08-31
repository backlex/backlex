/**
 * Engine tests for DOTTED RELATION PATHS in permission-row conditions
 * (`assignee.app_user_id`), built by hand through the REST API (no templates).
 *
 * The compiler lowers these keys to correlated EXISTS subqueries, so the same
 * `whereSql` works in the list WHERE, the single-GET WHERE and the
 * UPDATE/DELETE row gates — no LEFT JOIN machinery required. Covered here:
 *   (a) 1-hop read condition filters the list; single GET of a foreign row 404s
 *   (b) UPDATE with a 1-hop condition: own row 200, foreign row 403/404
 *   (c) 2-hop condition (`task.assignee.app_user_id`) works
 *   (d) the permission stays correct when the request ALSO passes a user
 *       filter traversing the same relation (the join-recompile path)
 *   (e) a condition whose head is NOT a relation field fails closed (no rows)
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const JSON_HEADERS = { "content-type": "application/json" };

let h: TestHarness;
let bearer: (path: string, init?: RequestInit) => Promise<Response>;
let appUserId: string;

// Row ids seeded by the admin.
let staffMine: string;
let staffOther: string;
let taskMine: string;
let taskOther: string;
let logMine: string;
let logOther: string;

const adminPost = async (path: string, body: unknown): Promise<Response> =>
  h.fetch(path, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  });

const createItem = async (slug: string, body: unknown): Promise<string> => {
  const res = await adminPost(`/api/items/${slug}`, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
};

const listIds = async (res: Response): Promise<string[]> => {
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((r) => String(r.id));
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);

  // Schema: logs → tasks → staff (staff carries the app-user link).
  for (const c of [
    {
      slug: "staff",
      fields: [
        { name: "name", type: "text", required: true },
        { name: "app_user_id", type: "text" },
      ],
    },
    {
      slug: "tasks",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "assignee", type: "relation", to: "staff" },
      ],
    },
    {
      slug: "logs",
      fields: [
        { name: "note", type: "text", required: true },
        { name: "task", type: "relation", to: "tasks" },
      ],
    },
    {
      slug: "notes",
      fields: [{ name: "title", type: "text", required: true }],
    },
  ]) {
    const res = await adminPost("/api/collections", c);
    expect(res.status).toBe(201);
  }

  // Hand-built role: dotted 1-hop + 2-hop read/update conditions, plus an
  // intentionally broken condition on `notes` whose head ("title") is a text
  // field, not a relation — must fail closed.
  const roleRes = await adminPost("/api/roles", { name: "Portal" });
  expect(roleRes.status).toBe(201);
  const roleId = ((await roleRes.json()) as { data: { id: string } }).data.id;
  for (const p of [
    { collection: "staff", action: "read" },
    {
      collection: "tasks",
      action: "read",
      condition: { "assignee.app_user_id": { _eq: "$user.id" } },
    },
    {
      collection: "tasks",
      action: "update",
      condition: { "assignee.app_user_id": { _eq: "$user.id" } },
    },
    {
      collection: "logs",
      action: "read",
      condition: { "task.assignee.app_user_id": { _eq: "$user.id" } },
    },
    {
      collection: "notes",
      action: "read",
      condition: { "title.app_user_id": { _eq: "$user.id" } },
    },
  ]) {
    const res = await adminPost(`/api/roles/${roleId}/permissions`, p);
    expect(res.status).toBe(201);
  }

  // App-plane end-user + role binding.
  const signup = await h.fetch("/api/t/default/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      email: "portal.rel@example.com",
      password: "portal-pass-123",
      name: "Portal Rel",
    }),
  });
  expect(signup.status).toBe(200);
  const token = ((await signup.json()) as { token?: string }).token;
  expect(token).toBeTruthy();
  const users = (await (await h.fetch("/api/app-users")).json()) as {
    data: { id: string; email: string }[];
  };
  appUserId = users.data.find((u) => u.email === "portal.rel@example.com")!.id;
  const bind = await h.fetch(`/api/app-users/${appUserId}/roles`, {
    method: "PUT",
    headers: JSON_HEADERS,
    body: JSON.stringify({ roleIds: [roleId] }),
  });
  expect(bind.status).toBe(200);
  bearer = (path: string, init: RequestInit = {}) =>
    Promise.resolve(h.app.request(path, {
      ...init,
      headers: {
        ...JSON_HEADERS,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    }));

  // Data: one chain that resolves to the portal user, one that doesn't.
  staffMine = await createItem("staff", { name: "Mine", app_user_id: appUserId });
  staffOther = await createItem("staff", { name: "Other", app_user_id: "someone-else" });
  taskMine = await createItem("tasks", { title: "mine", assignee: staffMine });
  taskOther = await createItem("tasks", { title: "other", assignee: staffOther });
  logMine = await createItem("logs", { note: "mine", task: taskMine });
  logOther = await createItem("logs", { note: "other", task: taskOther });
  await createItem("notes", { title: "visible-to-nobody" });
});

afterAll(() => {
  h.cleanup();
});

describe("1-hop dotted read condition", () => {
  test("(a) list is filtered to rows whose relation chain matches", async () => {
    expect(await listIds(await bearer("/api/items/tasks"))).toEqual([taskMine]);
  });

  test("(a) single GET: own row 200, foreign row 404", async () => {
    expect((await bearer(`/api/items/tasks/${taskMine}`)).status).toBe(200);
    expect((await bearer(`/api/items/tasks/${taskOther}`)).status).toBe(404);
  });
});

describe("1-hop dotted update condition", () => {
  test("(b) own row updates; foreign row is 403/404", async () => {
    const own = await bearer(`/api/items/tasks/${taskMine}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "mine v2" }),
    });
    expect(own.status).toBe(200);
    const foreign = await bearer(`/api/items/tasks/${taskOther}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "hijacked" }),
    });
    expect([403, 404]).toContain(foreign.status);
    // The foreign row is untouched (checked as admin, who sees everything).
    const raw = (await (await h.fetch(`/api/items/tasks/${taskOther}`)).json()) as {
      data: { title: string };
    };
    expect(raw.data.title).toBe("other");
  });
});

describe("2-hop dotted read condition", () => {
  test("(c) list + single GET honour the two-hop chain", async () => {
    expect(await listIds(await bearer("/api/items/logs"))).toEqual([logMine]);
    expect((await bearer(`/api/items/logs/${logMine}`)).status).toBe(200);
    expect((await bearer(`/api/items/logs/${logOther}`)).status).toBe(404);
  });
});

describe("dotted permission + user filter on the same relation", () => {
  test("(d) join-recompile path keeps the EXISTS lowering", async () => {
    // The user filter traverses the SAME relation the permission does, which
    // wires a LEFT JOIN and forces the permission conditions to recompile.
    const same = await bearer(
      `/api/items/tasks?filter=${encodeURIComponent(
        JSON.stringify({ "assignee.app_user_id": { _eq: appUserId } }),
      )}`,
    );
    expect(await listIds(same)).toEqual([taskMine]);

    // Filtering FOR the other person's chain must not leak their row — the
    // permission condition still ANDs in.
    const foreign = await bearer(
      `/api/items/tasks?filter=${encodeURIComponent(
        JSON.stringify({ "assignee.app_user_id": { _eq: "someone-else" } }),
      )}`,
    );
    expect(await listIds(foreign)).toEqual([]);

    // A non-relation user filter alongside the dotted permission also works.
    const byTitle = await bearer(
      `/api/items/tasks?filter=${encodeURIComponent(
        JSON.stringify({ title: { _contains: "mine" } }),
      )}&sort=-assignee.name`,
    );
    expect(await listIds(byTitle)).toEqual([taskMine]);
  });
});

describe("fail closed", () => {
  test("(e) condition head that is not a relation grants no rows (no 500)", async () => {
    const res = await bearer("/api/items/notes");
    expect(await listIds(res)).toEqual([]);
  });
});
