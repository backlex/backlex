/**
 * SCIM 2.0 provisioning.
 *
 * This endpoint is the app's only unauthenticated-by-default route group: the
 * bearer token IS the authorization, and it also decides which workspace gets
 * written to. So the tests that matter most are the auth edges and the
 * cross-workspace boundary — a fallthrough in `resolveScimTenant` is a
 * cross-workspace write primitive, not a 500.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
  createScimUser,
  getScimGroup,
  deactivateScimUser,
  getScimConfig,
  getScimUser,
  issueScimToken,
  listScimGroups,
  listScimUsers,
  parseEqFilter,
  patchScimGroup,
  patchScimUser,
  replaceScimUser,
  resolveScimTenant,
  updateScimConfig,
} from "../src/server/services/scim";
import { makeHarness, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
let ctx: { db: any; dialect: "sqlite" };

const seedTenant = (id: string, slug: string) =>
  client
    .query("insert into tenants (id, name, slug, created_at, updated_at) values (?,?,?,?,?)")
    .run(id, slug, slug, Date.now(), Date.now());

const seedRole = (id: string, tenantId: string | null, name: string) =>
  client
    .query("insert into roles (id, tenant_id, name, created_at, updated_at) values (?,?,?,?,?)")
    .run(id, tenantId, name, Date.now(), Date.now());

const statusOf = (id: string) =>
  (client.query("select status from app_users where id = ?").get(id) as { status: string } | null)
    ?.status ?? null;

beforeEach(() => {
  h = makeHarness();
  client = new Database(h.env.SQLITE_PATH as string);
  ctx = { db: drizzle({ client }), dialect: "sqlite" };
  seedTenant("t1", "one");
  seedTenant("t2", "two");
  seedRole("r-eng", "t1", "engineering");
  seedRole("r-other", "t2", "other-tenant-role");
});
afterEach(() => h.cleanup());

describe("token auth fails closed", () => {
  test("a valid token resolves to its workspace", async () => {
    const { token } = await issueScimToken(ctx, "t1");
    const resolved = await resolveScimTenant(ctx, `Bearer ${token}`);
    expect(resolved?.tenantId).toBe("t1");
  });

  test("every malformed or unknown credential is refused", async () => {
    const { token } = await issueScimToken(ctx, "t1");
    for (const header of [
      undefined,
      null,
      "",
      "   ",
      token, // no scheme
      `Basic ${token}`,
      "Bearer",
      "Bearer ",
      "Bearer wrong-token",
      `Bearer ${token}x`,
      `Bearer ${token.slice(0, -1)}`,
    ]) {
      expect(await resolveScimTenant(ctx, header as string | null | undefined)).toBeNull();
    }
  });

  test("the scheme is case-insensitive, as RFC 7235 requires", async () => {
    const { token } = await issueScimToken(ctx, "t1");
    expect((await resolveScimTenant(ctx, `bearer ${token}`))?.tenantId).toBe("t1");
    expect((await resolveScimTenant(ctx, `BEARER ${token}`))?.tenantId).toBe("t1");
  });

  test("a disabled config refuses its own still-valid token", async () => {
    const { token } = await issueScimToken(ctx, "t1");
    await updateScimConfig(ctx, "t1", { enabled: false });
    expect(await resolveScimTenant(ctx, `Bearer ${token}`)).toBeNull();
  });

  test("rotating invalidates the previous token immediately", async () => {
    const first = await issueScimToken(ctx, "t1");
    const second = await issueScimToken(ctx, "t1");
    expect(second.token).not.toBe(first.token);
    expect(await resolveScimTenant(ctx, `Bearer ${first.token}`)).toBeNull();
    expect((await resolveScimTenant(ctx, `Bearer ${second.token}`))?.tenantId).toBe("t1");
  });

  test("one workspace's token never resolves to another", async () => {
    const a = await issueScimToken(ctx, "t1");
    const b = await issueScimToken(ctx, "t2");
    expect((await resolveScimTenant(ctx, `Bearer ${a.token}`))?.tenantId).toBe("t1");
    expect((await resolveScimTenant(ctx, `Bearer ${b.token}`))?.tenantId).toBe("t2");
  });
});

describe("token storage", () => {
  test("the token is stored hashed and never returned by the read path", async () => {
    const { token } = await issueScimToken(ctx, "t1");
    const raw = client.query("select token_hash, token_prefix from scim_config").get() as {
      token_hash: string;
      token_prefix: string;
    };
    expect(raw.token_hash).not.toBe(token);
    expect(raw.token_hash).not.toContain(token.slice(8));
    // The prefix is a display aid; it must not be enough to reconstruct the key.
    expect(token.startsWith(raw.token_prefix)).toBe(true);
    expect(raw.token_prefix.length).toBeLessThan(token.length / 2);

    const cfg = await getScimConfig(ctx, "t1");
    expect(JSON.stringify(cfg)).not.toContain(token);
    expect(JSON.stringify(cfg)).not.toContain(raw.token_hash);
  });
});

describe("users", () => {
  const body = { userName: "Ada@Example.com", name: { givenName: "Ada", familyName: "Lovelace" } };

  test("create normalizes the address and defaults to active", async () => {
    const user = await createScimUser(ctx, "t1", null, body);
    expect(user.userName).toBe("ada@example.com");
    expect(user.active).toBe(true);
    expect(user.displayName).toBe("Ada Lovelace");
    expect(user.schemas).toEqual(["urn:ietf:params:scim:schemas:core:2.0:User"]);
  });

  test("a duplicate userName is a CONFLICT so the IdP switches to update", async () => {
    await createScimUser(ctx, "t1", null, body);
    // Different casing must still collide — otherwise Okta creates a second
    // account for the same person.
    await expect(
      createScimUser(ctx, "t1", null, { userName: "ADA@example.com" }),
    ).rejects.toThrow(/already exists/);
  });

  test("the same address in another workspace is not a conflict", async () => {
    await createScimUser(ctx, "t1", null, body);
    const other = await createScimUser(ctx, "t2", null, body);
    expect(other.userName).toBe("ada@example.com");
  });

  test("the default role is granted on create", async () => {
    const user = await createScimUser(ctx, "t1", "r-eng", body);
    expect(user.groups).toEqual([{ value: "r-eng", display: "engineering" }]);
  });

  test("a stale default role does not fail provisioning", async () => {
    const user = await createScimUser(ctx, "t1", "role-that-was-deleted", body);
    expect(user.userName).toBe("ada@example.com");
    expect(user.groups).toBeUndefined();
  });

  test("list is workspace-scoped", async () => {
    await createScimUser(ctx, "t1", null, body);
    expect((await listScimUsers(ctx, "t1", {})).totalResults).toBe(1);
    expect((await listScimUsers(ctx, "t2", {})).totalResults).toBe(0);
  });

  test("get and update refuse another workspace's user", async () => {
    const user = await createScimUser(ctx, "t1", null, body);
    expect(await getScimUser(ctx, "t2", user.id)).toBeNull();
    expect(await replaceScimUser(ctx, "t2", user.id, { active: false })).toBeNull();
    expect(await patchScimUser(ctx, "t2", user.id, [{ op: "replace", path: "active", value: false }])).toBeNull();
    expect(await deactivateScimUser(ctx, "t2", user.id)).toBe(false);
    // …and the victim row is untouched.
    expect(statusOf(user.id)).toBe("active");
  });

  test("pagination is 1-based, as SCIM specifies", async () => {
    for (const n of [1, 2, 3]) await createScimUser(ctx, "t1", null, { userName: `u${n}@x.test` });
    const page = await listScimUsers(ctx, "t1", { startIndex: 2, count: 2 });
    expect(page.startIndex).toBe(2);
    expect(page.totalResults).toBe(3);
    expect(page.Resources).toHaveLength(2);
    // startIndex 1 must return the first record, not skip it.
    const first = await listScimUsers(ctx, "t1", { startIndex: 1, count: 1 });
    expect((first.Resources[0] as { userName: string }).userName).toBe("u1@x.test");
  });

  test("a userName filter selects one user", async () => {
    await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    await createScimUser(ctx, "t1", null, { userName: "b@x.test" });
    const found = await listScimUsers(ctx, "t1", { filter: 'userName eq "b@x.test"' });
    expect(found.totalResults).toBe(1);
    expect((found.Resources[0] as { userName: string }).userName).toBe("b@x.test");
  });
});

describe("deactivation", () => {
  test("PATCH active=false suspends without deleting the row", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    const patched = await patchScimUser(ctx, "t1", user.id, [
      { op: "replace", path: "active", value: false },
    ]);
    expect(patched?.active).toBe(false);
    expect(statusOf(user.id)).toBe("suspended");
  });

  test("Okta's path-less replace form works too", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    // Okta sends the attribute bag with no `path`.
    const patched = await patchScimUser(ctx, "t1", user.id, [
      { op: "replace", value: { active: false } },
    ]);
    expect(patched?.active).toBe(false);
  });

  test("a string \"false\" is honoured — some IdPs send it unquoted-typed", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    const patched = await patchScimUser(ctx, "t1", user.id, [
      { op: "replace", path: "active", value: "false" },
    ]);
    expect(patched?.active).toBe(false);
  });

  test("DELETE deactivates rather than destroying the account", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    expect(await deactivateScimUser(ctx, "t1", user.id)).toBe(true);
    // The row must survive: re-assigning in the IdP would otherwise orphan
    // everything keyed to the old id.
    expect(statusOf(user.id)).toBe("suspended");
    expect(await getScimUser(ctx, "t1", user.id)).not.toBeNull();
  });

  test("re-activating clears the suspension", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    await deactivateScimUser(ctx, "t1", user.id);
    const back = await patchScimUser(ctx, "t1", user.id, [
      { op: "replace", path: "active", value: true },
    ]);
    expect(back?.active).toBe(true);
    expect(statusOf(user.id)).toBe("active");
  });

  test("a PATCH touching only attributes we do not store is a no-op, not an error", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    const same = await patchScimUser(ctx, "t1", user.id, [
      { op: "replace", path: "timezone", value: "Europe/Istanbul" },
    ]);
    expect(same?.active).toBe(true);
    expect(same?.userName).toBe("a@x.test");
  });
});

describe("groups map onto roles", () => {
  test("list exposes workspace roles and global system roles", async () => {
    const groups = await listScimGroups(ctx, "t1", {});
    const names = (groups.Resources as { displayName: string }[]).map((g) => g.displayName);
    expect(names).toContain("engineering");
    // Another workspace's role must not be visible.
    expect(names).not.toContain("other-tenant-role");
  });

  test("adding a member binds the role", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    const group = await patchScimGroup(ctx, "t1", "r-eng", [
      { op: "add", path: "members", value: [{ value: user.id }] },
    ]);
    expect(group?.members).toEqual([{ value: user.id, display: "a@x.test" }]);
    expect((await getScimUser(ctx, "t1", user.id))?.groups).toEqual([
      { value: "r-eng", display: "engineering" },
    ]);
  });

  test("adding the same member twice is idempotent", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    const op = [{ op: "add", path: "members", value: [{ value: user.id }] }];
    await patchScimGroup(ctx, "t1", "r-eng", op);
    const again = await patchScimGroup(ctx, "t1", "r-eng", op);
    expect(again?.members).toHaveLength(1);
  });

  test("removing a member unbinds the role", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    await patchScimGroup(ctx, "t1", "r-eng", [
      { op: "add", path: "members", value: [{ value: user.id }] },
    ]);
    const after = await patchScimGroup(ctx, "t1", "r-eng", [
      { op: "remove", path: "members", value: [{ value: user.id }] },
    ]);
    expect(after?.members).toEqual([]);
  });

  test("replace sets the membership to exactly the given set", async () => {
    const a = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    const b = await createScimUser(ctx, "t1", null, { userName: "b@x.test" });
    await patchScimGroup(ctx, "t1", "r-eng", [
      { op: "add", path: "members", value: [{ value: a.id }] },
    ]);
    const after = await patchScimGroup(ctx, "t1", "r-eng", [
      { op: "replace", path: "members", value: [{ value: b.id }] },
    ]);
    expect(after?.members).toEqual([{ value: b.id, display: "b@x.test" }]);
  });

  test("a member from another workspace is silently dropped, never bound", async () => {
    const foreign = await createScimUser(ctx, "t2", null, { userName: "spy@x.test" });
    const group = await patchScimGroup(ctx, "t1", "r-eng", [
      { op: "add", path: "members", value: [{ value: foreign.id }] },
    ]);
    // Binding a foreign user to this workspace's role would grant them its
    // permissions.
    expect(group?.members).toEqual([]);
  });

  test("a shared global role never leaks another workspace's members", async () => {
    // Global system roles (roles.tenant_id IS NULL) are visible to every
    // workspace by design, and users in every workspace hold them. Listing that
    // group's members by role_id alone would hand this workspace another's user
    // ids and email addresses.
    seedRole("r-global", null, "viewer");
    const mine = await createScimUser(ctx, "t1", null, { userName: "mine@x.test" });
    const theirs = await createScimUser(ctx, "t2", null, { userName: "theirs@x.test" });
    client
      .query("insert into app_user_roles (app_user_id, role_id, created_at) values (?,?,?)")
      .run(mine.id, "r-global", Date.now());
    client
      .query("insert into app_user_roles (app_user_id, role_id, created_at) values (?,?,?)")
      .run(theirs.id, "r-global", Date.now());

    const group = await getScimGroup(ctx, "t1", "r-global");
    expect(group?.members).toEqual([{ value: mine.id, display: "mine@x.test" }]);
    expect(JSON.stringify(group)).not.toContain("theirs@x.test");

    // …and from the other side, symmetrically.
    const other = await getScimGroup(ctx, "t2", "r-global");
    expect(other?.members).toEqual([{ value: theirs.id, display: "theirs@x.test" }]);
  });

  test("another workspace's role is not patchable", async () => {
    const user = await createScimUser(ctx, "t1", null, { userName: "a@x.test" });
    expect(
      await patchScimGroup(ctx, "t1", "r-other", [
        { op: "add", path: "members", value: [{ value: user.id }] },
      ]),
    ).toBeNull();
  });
});

describe("filter parsing", () => {
  test("accepts the eq form real IdPs send", () => {
    expect(parseEqFilter('userName eq "a@x.test"', ["userName"])).toEqual({
      attribute: "userName",
      value: "a@x.test",
    });
    expect(parseEqFilter('  displayName eq "Eng Team"  ', ["displayName"])).toEqual({
      attribute: "displayName",
      value: "Eng Team",
    });
  });

  test("an absent filter is null, not an error", () => {
    expect(parseEqFilter(undefined, ["userName"])).toBeNull();
    expect(parseEqFilter("   ", ["userName"])).toBeNull();
  });

  test("an unsupported filter is REFUSED, never silently ignored", () => {
    // Dropping the filter would return the whole directory to a caller asking
    // for one user — Okta would read that as "everyone is a duplicate".
    expect(() => parseEqFilter('userName co "x"', ["userName"])).toThrow(/Unsupported/);
    expect(() => parseEqFilter('active eq true', ["userName"])).toThrow(/Unsupported/);
    expect(() => parseEqFilter('emails[type eq "work"]', ["userName"])).toThrow(/Unsupported/);
  });

  test("an attribute outside the allow-list is refused", () => {
    expect(() => parseEqFilter('password eq "x"', ["userName"])).toThrow(/not supported/);
  });
});
