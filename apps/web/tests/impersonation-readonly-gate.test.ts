/**
 * "Read-only" has to mean read-only on EVERY surface, not just on collections.
 *
 * Before `middleware/impersonation-readonly.ts` existed, the flag was checked in
 * exactly one place — `middleware/permission.ts`, which every collection action
 * passes through. So an item write was refused and `POST /api/t/{slug}/orgs`
 * was not: the same read-only token created an organization inside the
 * customer's account, attributed to the SUBJECT, in a table with no audit trail
 * of its own. That is the journey these tests cover, and the reason it stayed
 * invisible is that offboarding a customer is not something the admin UI does.
 *
 * Two things every assertion here is built to avoid:
 *
 *  - A refusal that proves nothing because the route was never going to work.
 *    Every "cannot" is paired with the SAME request succeeding — from the
 *    subject's own bearer, or from a `readOnly: false` impersonation — so a 403
 *    can only be the gate.
 *  - A gate that keys on impersonation rather than on the flag. The read-write
 *    case is what separates those two, and it is the last test here.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;

const JSON_HEADERS = { "content-type": "application/json" };

beforeEach(async () => {
  h = makeHarness();
  await seedAdmin(h);
  client = new Database(h.env.SQLITE_PATH as string);
});
afterEach(() => {
  h.cleanup();
});

/** Sign an end-user up on the app plane and hand back BOTH identities we need:
 *  the id the operator impersonates, and the bearer that user would send for
 *  themselves — the control every refusal below is measured against. */
const appUser = async (email: string): Promise<{ id: string; token: string }> => {
  const res = await h.fetch("/api/t/default/auth/sign-up/email", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ email, password: "correct-horse-battery", name: "Sub" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { token?: string };
  expect(typeof body.token).toBe("string");
  const row = client.query("select id from app_users where email = ?").get(email) as {
    id: string;
  };
  return { id: row.id, token: body.token as string };
};

/** A collection the bundled `authenticated` role may read AND create in, so a
 *  refused write below is the impersonation's refusal and not a missing grant. */
const notesCollection = async () => {
  const created = await h.fetch("/api/collections", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      name: "Notes",
      slug: "notes",
      fields: [{ name: "title", type: "text" }],
    }),
  });
  expect(created.status).toBeLessThan(400);
  const roles = (await (await h.fetch("/api/roles")).json()) as {
    data: Array<{ id: string; name: string }>;
  };
  const authenticated = roles.data.find((r) => r.name === "authenticated")!;
  for (const action of ["read", "create"]) {
    const granted = await h.fetch(`/api/roles/${authenticated.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ collection: "notes", action }),
    });
    expect(granted.status).toBeLessThan(400);
  }
};

/** Send a request as an app-plane bearer — an impersonation token or an
 *  end-user's own. `h.fetch` carries the operator's cookie, which is a
 *  different identity entirely and would answer none of these questions. */
const asBearer = (token: string, path: string, init: RequestInit = {}) =>
  h.app.request(
    path,
    {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${token}`,
        origin: "http://localhost:5173",
      },
    } as RequestInit,
    h.env,
  );

/** Start an impersonation of `subjectUserId`. Read-only unless told otherwise —
 *  the same default the API and the admin UI apply. */
const impersonate = async (
  subjectUserId: string,
  over: Record<string, unknown> = {},
): Promise<{ id: string; token: string; readOnly: boolean }> => {
  const res = await h.fetch("/api/admin/impersonation", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ subjectUserId, reason: "offboarding ticket #7", ...over }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    token: string;
    data: { id: string; readOnly: boolean };
  };
  return { id: body.data.id, token: body.token, readOnly: body.data.readOnly };
};

const orgCount = () =>
  (client.query("select count(*) as n from app_orgs").get() as { n: number }).n;

const createOrg = (token: string, name: string) =>
  asBearer(token, "/api/t/default/orgs", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ name }),
  });

const createNote = (token: string, title: string) =>
  asBearer(token, "/api/items/notes", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ title }),
  });

describe("read-only impersonation is read-only everywhere", () => {
  test("it still reads the app plane", async () => {
    await notesCollection();
    const subject = await appUser("reader@example.test");
    const imp = await impersonate(subject.id);
    // Read-only is the default; if it ever stopped being, every refusal below
    // would be measuring the wrong session.
    expect(imp.readOnly).toBe(true);

    const items = await asBearer(imp.token, "/api/items/notes");
    expect(items.status).toBe(200);
    // The org surface is the one that used to be writable — reading it has to
    // keep working, or the fix has broken the support session it protects.
    const orgs = await asBearer(imp.token, "/api/t/default/orgs");
    expect(orgs.status).toBe(200);
  });

  test("a read that needs a POST body still answers", async () => {
    await notesCollection();
    const subject = await appUser("aggregate@example.test");
    const imp = await impersonate(subject.id);

    // `/api/items/{slug}/aggregate` is a POST because the question does not fit
    // in a URL, not because it changes anything — it runs behind
    // `requirePermission(slug, "read")`. A blanket "no POST" would have taken
    // counting a customer's rows away from the operator looking at their
    // ticket, which is why the allowlist exists rather than a method check
    // alone. If this ever 403s, the allowlist stopped matching.
    const res = await asBearer(imp.token, "/api/items/notes/aggregate", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ agg: "count" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ value: number }> };
    expect(body.data[0]?.value).toBe(0);
  });

  test("it cannot create an organization, and the subject's own token can", async () => {
    const subject = await appUser("orgs@example.test");
    const imp = await impersonate(subject.id);

    const before = orgCount();
    const refused = await createOrg(imp.token, "Acme via impersonation");
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("read-only impersonation");
    // The refusal is a refusal, not a 403 written after the row landed.
    expect(orgCount()).toBe(before);

    // The control. Same route, same workspace, same person — only the identity
    // sending it differs. Without this a 403 above could be any of a dozen
    // unrelated failures on the org surface.
    const allowed = await createOrg(subject.token, "Acme by its owner");
    expect(allowed.status).toBe(201);
    expect(orgCount()).toBe(before + 1);
  });

  test("it cannot write an item either — the older gate still holds", async () => {
    await notesCollection();
    const subject = await appUser("items@example.test");
    const imp = await impersonate(subject.id);

    const refused = await createNote(imp.token, "written by an operator");
    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain("read-only impersonation");

    // Same control as above: the grant is real and the collection accepts writes
    // from this very user.
    expect((await createNote(subject.token, "written by its owner")).status).toBe(201);
  });

  test("the gate is not what stands between the operator and the exit", async () => {
    const subject = await appUser("exit@example.test");
    const imp = await impersonate(subject.id);

    // The operator ends the session from their OWN platform session, whose
    // `impersonationReadOnly` is false — so this POST never meets the gate, and
    // sealing someone into a read-only session is not a thing that can happen.
    const ended = await h.fetch(`/api/admin/impersonation/${imp.id}/end`, {
      method: "POST",
    });
    expect(ended.status).toBe(200);
    // Prove the end actually took: the token stops working on the next request,
    // which is also what makes "the operator is out" observable at all.
    expect((await asBearer(imp.token, "/api/items/notes")).status).toBeGreaterThanOrEqual(
      400,
    );

    // And the allowlist entry is real: the end path is exempt by construction,
    // so were that route ever opened to the impersonated session itself, this
    // middleware would not be the thing blocking it. Sent from the session, the
    // 403 that comes back is `requireAdminMiddleware`'s ("an impersonated
    // session cannot impersonate" family), never the read-only message.
    const fromInside = await asBearer(
      imp.token,
      `/api/admin/impersonation/${imp.id}/end`,
      { method: "POST" },
    );
    expect(await fromInside.text()).not.toContain("read-only impersonation");
  });

  test("a read-write impersonation may do all of it — the gate keys on the FLAG", async () => {
    await notesCollection();
    const subject = await appUser("readwrite@example.test");
    const imp = await impersonate(subject.id, { readOnly: false });
    expect(imp.readOnly).toBe(false);

    const before = orgCount();
    const org = await createOrg(imp.token, "Acme, deliberately");
    expect(org.status).toBe(201);
    expect(orgCount()).toBe(before + 1);

    expect((await createNote(imp.token, "written on the customer's behalf")).status).toBe(
      201,
    );

    // This is the assertion that says the middleware is not simply "no writes
    // while impersonating". Acting on a customer's behalf remains available to
    // an operator who declared it.
    expect((await asBearer(imp.token, "/api/items/notes")).status).toBe(200);
  });
});
