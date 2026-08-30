import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildTwoPlaneCast,
  json,
  type TwoPlaneCast,
} from "./fixtures/two-plane-cast";

/**
 * A share link belongs to the workspace it was minted in.
 *
 * Found by `scripts/scan-tenant-scope.ts` the day it was written, in code that
 * had shipped: `getSharedLinkById` and `revokeSharedLink` keyed on
 * `eq(t.id, id)` alone, and `DELETE /api/shared-links/:id` then authorised with
 *
 *     const isAdmin = auth.roles.includes(SYSTEM_ROLES.admin);
 *     if (!isAdmin && row.createdBy !== auth.userId) throw FORBIDDEN;
 *
 * `roles` are per-workspace (`roles.tenantId`), so being an admin ANYWHERE
 * satisfied that check against a row from ANYWHERE. The permission was asked
 * "may this person revoke a link" when the only safe question is "may this
 * person revoke a link HERE". Nothing about it looked wrong at the call site,
 * which is why 6,300 tests were green on it: every existing spec drove the
 * route as the workspace that owned the row.
 *
 * The tests below are a set on purpose. A refusal alone would also pass against
 * a handler that had simply stopped working, so the second one proves the owner
 * can still do exactly what the stranger could not — same route, same id, same
 * request, different workspace.
 */

let cast: TwoPlaneCast;

/**
 * Address one workspace explicitly.
 *
 * The active workspace is carried by a HEADER. An earlier draft of this file
 * passed `?tenant=<slug>`, which is silently ignored — so every request went to
 * whatever workspace the session happened to be in, and the spec failed in
 * three different ways that all looked like product bugs.
 */
const inTenant = (slug: string, init: RequestInit = {}): RequestInit => ({
  ...init,
  headers: { ...(init.headers ?? {}), "X-Backlex-Tenant": slug },
});

/** Mint a link in one workspace and hand back its id. */
const mintLink = async (
  who: TwoPlaneCast["ownerA"],
  slug: string,
  itemId: string,
): Promise<string> => {
  const res = await who.fetch(
    "/api/shared-links",
    inTenant(slug, json("POST", { collection: "posts", itemId })),
  );
  expect(res.status).toBe(201);
  const body = (await res.json()) as { data: { id: string } };
  expect(body.data.id).toBeTruthy();
  return body.data.id;
};

/** The ids the owner can see for a (collection, itemId) in one workspace. */
const listedIds = async (
  who: TwoPlaneCast["ownerA"],
  slug: string,
  itemId: string,
): Promise<string[]> => {
  const res = await who.fetch(
    `/api/shared-links?collection=posts&itemId=${itemId}`,
    inTenant(slug),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data.map((r) => r.id);
};

beforeAll(async () => {
  cast = await buildTwoPlaneCast();
});

afterAll(() => cast?.cleanup());

describe("share links are scoped to the workspace that minted them", () => {
  test("an admin of another workspace cannot revoke one", async () => {
    const id = await mintLink(cast.ownerA, cast.tenantA.slug, "item-cross-1");

    // ownerB is an owner — and therefore an admin — of workspace B, and holds
    // no membership in A. Under the old code this returned 200.
    const res = await cast.ownerB.fetch(
      `/api/shared-links/${id}`,
      inTenant(cast.tenantB.slug, { method: "DELETE" }),
    );

    // 404, not 403: a link owned elsewhere must be indistinguishable from one
    // that never existed, or the endpoint becomes a way to test whether an id
    // is live in some other workspace.
    expect(res.status).toBe(404);

    // The refusal is proven by state, not by the status code — a 404 from a
    // handler that revoked first and answered second would look identical here.
    // `listSharedLinks` filters out revoked rows, so the link still being
    // listed for its owner is the observable proof nothing was written.
    expect(await listedIds(cast.ownerA, cast.tenantA.slug, "item-cross-1")).toContain(id);
  });

  test("the owning workspace still can — so the refusal above is containment, not breakage", async () => {
    const id = await mintLink(cast.ownerA, cast.tenantA.slug, "item-cross-2");

    const res = await cast.ownerA.fetch(
      `/api/shared-links/${id}`,
      inTenant(cast.tenantA.slug, { method: "DELETE" }),
    );
    expect(res.status).toBe(200);
    expect(await listedIds(cast.ownerA, cast.tenantA.slug, "item-cross-2")).not.toContain(id);
  });

  test("the listing does not spill across workspaces on a shared (collection, itemId)", async () => {
    // `shared_links.collection` stores a SLUG, and slugs repeat across
    // workspaces — two tenants both having `posts` is the ordinary case, not a
    // contrived one. Before the fix the only thing keeping B's links out of A's
    // listing was `itemId` happening to differ.
    const itemId = "item-same-id-in-both";
    const idInA = await mintLink(cast.ownerA, cast.tenantA.slug, itemId);
    const idInB = await mintLink(cast.ownerB, cast.tenantB.slug, itemId);
    expect(idInB).not.toBe(idInA);

    // Asserted in both directions: A's own link is present (so the query did
    // not simply return nothing) and B's is absent.
    const seenByA = await listedIds(cast.ownerA, cast.tenantA.slug, itemId);
    expect(seenByA).toContain(idInA);
    expect(seenByA).not.toContain(idInB);
  });
});
