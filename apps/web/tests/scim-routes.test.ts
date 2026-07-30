/**
 * SCIM over real HTTP.
 *
 * The service tests cover the data rules; these cover the thing only the route
 * layer can get wrong — `withScim`. It is the sole authorization for a route
 * group that the session and api-key middleware deliberately do not protect, so
 * "does an unauthenticated request actually get refused" has to be asserted
 * against the mounted app, not the service.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { issueScimToken } from "../src/server/services/scim";
import { makeHarness, type TestHarness } from "./setup";

let h: TestHarness;
let client: Database;
let token: string;

const BASE = "/api/scim/v2";

const scim = (path: string, init: RequestInit = {}, bearer = token) =>
  h.fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(init.body ? { "content-type": "application/scim+json" } : {}),
      ...(init.headers ?? {}),
    },
  });

const json = (body: unknown) => ({ body: JSON.stringify(body) });

beforeAll(async () => {
  h = makeHarness();
  client = new Database(h.env.SQLITE_PATH as string);
  const now = Date.now();
  client
    .query("insert into tenants (id, name, slug, created_at, updated_at) values (?,?,?,?,?)")
    .run("tw", "workspace", "workspace", now, now);
  client
    .query("insert into roles (id, tenant_id, name, created_at, updated_at) values (?,?,?,?,?)")
    .run("r-eng", "tw", "engineering", now, now);
  const issued = await issueScimToken({ db: drizzle({ client }), dialect: "sqlite" }, "tw");
  token = issued.token;
});
afterAll(() => h.cleanup());

describe("the bearer gate", () => {
  const PROTECTED: [string, string][] = [
    ["GET", "/ServiceProviderConfig"],
    ["GET", "/ResourceTypes"],
    ["GET", "/Schemas"],
    ["GET", "/Users"],
    ["GET", "/Users/anything"],
    ["POST", "/Users"],
    ["PUT", "/Users/anything"],
    ["PATCH", "/Users/anything"],
    ["DELETE", "/Users/anything"],
    ["GET", "/Groups"],
    ["GET", "/Groups/anything"],
    ["PATCH", "/Groups/anything"],
    ["POST", "/Groups"],
  ];

  test("every endpoint 401s with no credential", async () => {
    for (const [method, path] of PROTECTED) {
      const res = await scim(path, { method, ...(method === "GET" || method === "DELETE" ? {} : json({})) }, "");
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  test("every endpoint 401s with a wrong credential", async () => {
    for (const [method, path] of PROTECTED) {
      const res = await scim(
        path,
        { method, ...(method === "GET" || method === "DELETE" ? {} : json({})) },
        "scim_not-a-real-token",
      );
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  test("a 401 carries the SCIM error shape and tells the client which scheme to use", async () => {
    const res = await scim("/Users", {}, "");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Bearer");
    expect(res.headers.get("content-type")).toContain("application/scim+json");
    const body = (await res.json()) as { schemas: string[]; status: string };
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
    // SCIM `status` is a STRING, not a number — IdPs parse it strictly.
    expect(body.status).toBe("401");
  });
});

describe("discovery documents", () => {
  test("ServiceProviderConfig reports what is actually implemented", async () => {
    const res = await scim("/ServiceProviderConfig");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/scim+json");
    const body = (await res.json()) as any;
    expect(body.patch.supported).toBe(true);
    expect(body.bulk.supported).toBe(false);
    // Advertising sort or changePassword we do not have would make an IdP send
    // requests we then reject mid-sync.
    expect(body.sort.supported).toBe(false);
    expect(body.changePassword.supported).toBe(false);
    expect(body.authenticationSchemes[0].type).toBe("oauthbearertoken");
  });

  test("ResourceTypes and Schemas list both resources", async () => {
    for (const path of ["/ResourceTypes", "/Schemas"]) {
      const body = (await (await scim(path)).json()) as { totalResults: number; Resources: any[] };
      expect(body.totalResults).toBe(2);
      expect(body.Resources).toHaveLength(2);
    }
  });
});

describe("user lifecycle over HTTP", () => {
  let userId: string;

  test("POST creates and returns 201", async () => {
    const res = await scim("/Users", {
      method: "POST",
      ...json({ userName: "ada@example.com", name: { givenName: "Ada", familyName: "Lovelace" } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    userId = body.id;
    expect(body.userName).toBe("ada@example.com");
    expect(body.active).toBe(true);
    expect(body.meta.resourceType).toBe("User");
  });

  test("a duplicate POST is 409 with scimType uniqueness", async () => {
    const res = await scim("/Users", {
      method: "POST",
      ...json({ userName: "ada@example.com" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { status: string; scimType?: string };
    expect(body.status).toBe("409");
    expect(body.scimType).toBe("uniqueness");
  });

  test("GET by id round-trips", async () => {
    const body = (await (await scim(`/Users/${userId}`)).json()) as any;
    expect(body.id).toBe(userId);
  });

  test("an unknown id is 404, not 500", async () => {
    const res = await scim("/Users/does-not-exist");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { status: string }).status).toBe("404");
  });

  test("filter by userName returns a ListResponse", async () => {
    const body = (await (
      await scim(`/Users?filter=${encodeURIComponent('userName eq "ada@example.com"')}`)
    ).json()) as any;
    expect(body.schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:ListResponse"]);
    expect(body.totalResults).toBe(1);
    expect(body.startIndex).toBe(1);
  });

  test("an unsupported filter is 400 invalidFilter, not a full directory dump", async () => {
    const res = await scim(`/Users?filter=${encodeURIComponent('userName co "ada"')}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { status: string; scimType?: string };
    expect(body.scimType).toBe("invalidFilter");
  });

  test("PATCH deactivates", async () => {
    const res = await scim(`/Users/${userId}`, {
      method: "PATCH",
      ...json({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { active: boolean }).active).toBe(false);
  });

  test("PUT replaces and can re-activate", async () => {
    const res = await scim(`/Users/${userId}`, {
      method: "PUT",
      ...json({ userName: "ada@example.com", active: true, displayName: "Ada L" }),
    });
    const body = (await res.json()) as any;
    expect(body.active).toBe(true);
    expect(body.displayName).toBe("Ada L");
  });

  test("DELETE returns 204 and leaves the account suspended, not gone", async () => {
    const res = await scim(`/Users/${userId}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    const body = (await (await scim(`/Users/${userId}`)).json()) as { active: boolean };
    expect(body.active).toBe(false);
  });
});

describe("groups over HTTP", () => {
  test("GET lists roles as groups", async () => {
    const body = (await (await scim("/Groups")).json()) as any;
    const names = body.Resources.map((g: { displayName: string }) => g.displayName);
    expect(names).toContain("engineering");
  });

  test("POST /Groups is refused — SCIM must not mint permission targets", async () => {
    const res = await scim("/Groups", { method: "POST", ...json({ displayName: "invented" }) });
    expect(res.status).toBe(501);
  });

  test("PATCH on an unknown group is 404", async () => {
    const res = await scim("/Groups/nope", {
      method: "PATCH",
      ...json({ Operations: [{ op: "add", path: "members", value: [] }] }),
    });
    expect(res.status).toBe(404);
  });
});
