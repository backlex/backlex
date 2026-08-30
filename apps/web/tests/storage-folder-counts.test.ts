/**
 * `GET /api/storage/folder-counts` — the badge numbers on the storage
 * browser's folder tree.
 *
 * It had no spec. The route is not a listing, so it is easy to think of it as
 * cosmetic — but it is a COUNT over the same table the listing reads, behind
 * the same `requirePermission(files, "read")` and applying the same
 * `perm.whereSql`. A count that forgets the permission filter does not show
 * anyone a file they may not see; it tells them exactly how many exist, per
 * folder. That is the classic shape of a counting oracle, and it fails
 * completely silently: every number is plausible, nothing 500s, and the only
 * way to notice is to compare against what the listing returns.
 *
 * So the assertions here are relational rather than absolute — the counts must
 * agree with the listing THIS caller gets, at every level and in the total.
 * Hard-coding `total: 4` would pass just as well with the filter deleted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

type Counts = { root: number; byFolderId: Record<string, number>; total: number };

let h: TestHarness;

const put = async (key: string) => {
  const res = await h.fetch(`/api/storage/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: "x",
  });
  expect(`PUT ${key}: ${res.status}`).toBe(`PUT ${key}: 201`);
};

const counts = async (): Promise<Counts> => {
  const res = await h.fetch("/api/storage/folder-counts");
  expect(res.status).toBe(200);
  return (await res.json()) as Counts;
};

const listedKeys = async (): Promise<string[]> => {
  const res = await h.fetch("/api/storage");
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: { key: string }[] }).data.map((f) => f.key);
};

beforeAll(async () => {
  h = makeHarness();
  await seedAdmin(h);
  for (const key of ["a.txt", "b.txt", "invoices/2024/jan.pdf", "photos/beach.jpg"]) {
    await put(key);
  }
});
afterAll(() => h.cleanup());

describe("GET /api/storage/folder-counts", () => {
  test("the total equals what this caller can actually list", async () => {
    const listed = await listedKeys();
    // Liveness: an empty workspace makes every equality below hold at zero.
    expect(listed.length).toBeGreaterThanOrEqual(4);

    const c = await counts();
    expect(`total ${c.total} vs listed ${listed.length}`).toBe(
      `total ${listed.length} vs listed ${listed.length}`,
    );
  });

  test("the per-folder numbers sum to the total, with unfiled files under root", async () => {
    const c = await counts();
    const summed = c.root + Object.values(c.byFolderId).reduce((n, v) => n + v, 0);
    // A folder counted twice, or a NULL `folder_id` bucket dropped, shows up
    // here and nowhere else — `total` is computed in the same loop, so the two
    // disagreeing is the only observable symptom.
    expect(`sum ${summed} vs total ${c.total}`).toBe(`sum ${c.total} vs total ${c.total}`);
    // The uploads above go in through the key path without a folder row, so
    // root is where they land. Asserted as "not zero" rather than as a number,
    // so the folder-attaching migration route can change the split without
    // making this a chore.
    expect(`root has files: ${c.root > 0}`).toBe("root has files: true");
  });

  test("a new upload moves the number", async () => {
    // The cheapest guard against a cached or hard-coded answer: the repo has
    // shipped a 2xx that did nothing more than once.
    const before = await counts();
    await put("c.txt");
    const after = await counts();
    expect(`total ${after.total}`).toBe(`total ${before.total + 1}`);
    expect(`root ${after.root}`).toBe(`root ${before.root + 1}`);
  });

  test("a signed-out caller is refused", async () => {
    const res = await h.app.request(
      "/api/storage/folder-counts",
      { headers: { origin: h.env.APP_URL as string } },
      h.env,
    );
    expect(res.status).toBe(401);
  });
});

/**
 * The counting-oracle half, which the admin-session tests above structurally
 * cannot see.
 *
 * An admin's `perm.whereSql` is null, so deleting `if (perm.whereSql)
 * conds.push(perm.whereSql)` from the handler leaves every assertion in the
 * first describe green — verified 2026-08-30, it does. The filter is only
 * observable to a caller who carries a CONDITION on the files collection,
 * which the default `authenticated` role does: owner-scoped read. So the leak
 * is asserted from that seat or not at all.
 *
 * The viewer owns nothing, which is the sharpest version of the test rather
 * than a weaker one: four files exist, the viewer may list none of them, and
 * the only number that can betray them is this endpoint\'s.
 */
describe("folder-counts is filtered by permission, not just by tenant", () => {
  let hh: TestHarness;
  const ts = Date.now();
  const viewer = `folder-counts-viewer-${ts}@example.test`;
  const JSON_HEADERS = { "Content-Type": "application/json" };
  const ADMIN_FILES = ["adm-1.txt", "adm-2.txt", "adm-3.txt", "adm/nested.txt"];

  const countsOn = async (): Promise<Counts> => {
    const res = await hh.fetch("/api/storage/folder-counts");
    expect(res.status).toBe(200);
    return (await res.json()) as Counts;
  };

  beforeAll(async () => {
    hh = makeHarness();
    await seedAdmin(hh);
    for (const k of ADMIN_FILES) {
      const res = await hh.fetch(`/api/storage/${k}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: "x",
      });
      expect(`PUT ${k}: ${res.status}`).toBe(`PUT ${k}: 201`);
    }
  });
  afterAll(() => hh.cleanup());

  test("the viewer is counted only what the viewer can list", async () => {
    // Liveness: there is something to leak. Without this the viewer seeing
    // zero would be indistinguishable from an empty workspace, and the
    // assertion below would hold with the filter deleted.
    const asAdmin = await countsOn();
    expect(`admin total: ${asAdmin.total}`).toBe(`admin total: ${ADMIN_FILES.length}`);

    // Give the `authenticated` role an owner-scoped read on the files
    // collection. Without a grant the request is refused by
    // `requirePermission` before the handler runs, and the endpoint's own
    // filtering would never be exercised; without a CONDITION on the grant,
    // `perm.whereSql` is null and the filter is unobservable again — the same
    // blind spot as the admin seat.
    const roles = ((await (await hh.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data;
    const authRole = roles.find((r) => r.name === "authenticated");
    expect(`authenticated role exists: ${Boolean(authRole)}`).toBe("authenticated role exists: true");
    const grant = await hh.fetch(`/api/roles/${authRole!.id}/permissions`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        collection: "system_files",
        action: "read",
        condition: { owner_id: { _eq: "$user.id" } },
      }),
    });
    expect(`grant: ${grant.status < 300}`).toBe("grant: true");

    await hh.fetch("/api/auth/sign-out", { method: "POST" });
    const su = await hh.fetch("/api/auth/sign-up/email", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: viewer, password: "correct-horse-battery", name: "Viewer" }),
    });
    expect(su.status).toBe(200);

    // The seat exists and is allowed through `requirePermission` — a 403 here
    // would mean the endpoint was never reached and the count never computed.
    const listRes = await hh.fetch("/api/storage");
    expect(listRes.status).toBe(200);
    const mine = ((await listRes.json()) as { data: { key: string }[] }).data;
    expect(`viewer can list: ${mine.length}`).toBe("viewer can list: 0");

    const c = await countsOn();
    expect(`viewer total ${c.total} vs listable ${mine.length}`).toBe(
      `viewer total ${mine.length} vs listable ${mine.length}`,
    );
    expect(`viewer root: ${c.root}`).toBe("viewer root: 0");
  });
});
