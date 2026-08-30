/**
 * A workspace is an object with a lifecycle — and every step of that lifecycle
 * is a route somebody has to be allowed, or refused, to take.
 *
 * Until this phase `tenants.name` had no writer anywhere in the server: a typo
 * in a workspace name was permanent, there was no way to express an archived
 * workspace, and a managed-cloud operator's only lever against an abusive
 * tenant was tearing down the Worker. This spec pins the four routes that close
 * that — update, archive, restore, and the gate on creation — and it pairs
 * every refusal with the acceptance beside it, because a spec that only ever
 * asserts 403 passes just as happily against a route that refuses everybody.
 *
 * ── why one cast per describe ───────────────────────────────────────────────
 *
 * `buildTwoPlaneCast` owns ONE cookie jar, so switching platform identities
 * costs a `/sign-in`, and `auth-rate-limit.ts` allows ten of those per minute
 * per client IP — one IP per harness. The describes below are therefore split
 * by identity budget as well as by subject, and inside each one every action a
 * given identity performs is grouped into a single visit. A file that ignores
 * this fails on a 429 that has nothing to do with workspaces.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  buildTwoPlaneCast,
  json,
  type PlatformIdentity,
  type TwoPlaneCast,
} from "./fixtures/two-plane-cast";

interface Workspace {
  id: string;
  slug: string;
  name: string;
}

interface ListedWorkspace extends Workspace {
  mark: string | null;
  color: string | null;
  role: string;
  status: string;
  archivedAt: string | null;
}

/** The uniform error envelope, unwrapped. Assertions read the MESSAGE and not
 *  only the status, because "refused" and "refused for the reason the caller
 *  needs to read" are different outcomes — which of the two the `slug` case is
 *  happens to be the entire point of that route's design. */
const errorOf = async (res: Response): Promise<{ code: string; message: string }> => {
  const body = (await res.json()) as {
    error?: { code?: string; message?: string };
  };
  return { code: body.error?.code ?? "", message: body.error?.message ?? "" };
};

/** A throwaway workspace owned by `who`. Every test that moves a workspace
 *  through its lifecycle makes its own, so no test depends on the order the
 *  file happens to run in. */
const createWorkspace = async (
  who: PlatformIdentity,
  label: string,
): Promise<Workspace> => {
  const name = `${label} ${crypto.randomUUID().slice(0, 8)}`;
  const res = await who.fetch("/api/tenants", json("POST", { name }));
  expect(res.status, `create workspace "${name}"`).toBe(201);
  const { data } = (await res.json()) as { data: Workspace };
  return data;
};

/** Invite adminA into a workspace ownerA just made, returning the accept token
 *  rather than accepting it here — the accept has to happen in adminA's own
 *  visit, and batching those is what keeps the sign-in budget intact. */
const inviteAdminA = async (
  cast: TwoPlaneCast,
  tenantId: string,
  role: "admin" | "member",
): Promise<string> => {
  const res = await cast.ownerA.fetch(
    `/api/tenants/${tenantId}/members/invite`,
    json("POST", { email: cast.adminA.email, role }),
  );
  expect(res.status, `invite adminA as ${role}`).toBe(201);
  const { data } = (await res.json()) as { data: { token: string } };
  return data.token;
};

const acceptInvite = async (who: PlatformIdentity, token: string): Promise<void> => {
  const res = await who.fetch("/api/tenants/accept", json("POST", { token }));
  expect(res.status, "accept a workspace invite").toBe(200);
};

const listWorkspaces = async (
  who: PlatformIdentity,
  opts: { includeArchived?: boolean } = {},
): Promise<ListedWorkspace[]> => {
  const path = opts.includeArchived
    ? "/api/tenants?includeArchived=true"
    : "/api/tenants";
  const res = await who.fetch(path);
  expect(res.status, `list workspaces (${path})`).toBe(200);
  const { data } = (await res.json()) as { data: ListedWorkspace[] };
  return data;
};

const findListed = async (
  who: PlatformIdentity,
  id: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ListedWorkspace | undefined> =>
  (await listWorkspaces(who, opts)).find((w) => w.id === id);

describe("PATCH /api/tenants/{id} — the writer `tenants.name` never had", () => {
  let cast: TwoPlaneCast;
  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
  });
  afterAll(() => cast?.cleanup());

  test("renames a workspace, and the new name is what the next read returns", async () => {
    const ws = await createWorkspace(cast.ownerA, "Renamable");

    const res = await cast.ownerA.fetch(
      `/api/tenants/${ws.id}`,
      json("PATCH", { name: "Storefront EU", mark: "SE", color: "var(--chart-3)" }),
    );
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { name: string; mark: string | null; color: string | null };
    };
    expect(data.name).toBe("Storefront EU");
    expect(data.mark).toBe("SE");
    expect(data.color).toBe("var(--chart-3)");

    // The reply saying so is not the assertion — the next read is. A route that
    // echoes its input back and writes nothing is the exact shape this phase
    // exists to close.
    const listed = await findListed(cast.ownerA, ws.id);
    expect(listed?.name).toBe("Storefront EU");
    expect(listed?.mark).toBe("SE");
    expect(listed?.color).toBe("var(--chart-3)");
    // The slug is the workspace's address, and a rename must not move it.
    expect(listed?.slug).toBe(ws.slug);
  });

  test("refuses `slug` by name and says why, while the same request's `name` would have worked", async () => {
    const ws = await createWorkspace(cast.ownerA, "Slug Immutable");

    const refused = await cast.ownerA.fetch(
      `/api/tenants/${ws.id}`,
      json("PATCH", { name: "Renamed", slug: "somewhere-else" }),
    );
    expect(refused.status).toBe(422);
    const { code, message } = await errorOf(refused);
    expect(code).toBe("VALIDATION");
    // The reason, not just the refusal: a caller told only "invalid" tries
    // again with a different spelling.
    expect(message).toContain("slug");
    expect(message).toContain("c_<tenantPrefix12>_<slug>");
    expect(message).toContain("orphan every managed collection");

    // Refused as ONE request — the `name` in the same body must not have landed.
    const untouched = await findListed(cast.ownerA, ws.id);
    expect(untouched?.slug).toBe(ws.slug);
    expect(untouched?.name).toBe(ws.name);

    // The acceptance beside the refusal: without `slug`, the identical rename
    // goes through.
    const accepted = await cast.ownerA.fetch(
      `/api/tenants/${ws.id}`,
      json("PATCH", { name: "Renamed" }),
    );
    expect(accepted.status).toBe(200);
    expect((await findListed(cast.ownerA, ws.id))?.name).toBe("Renamed");
  });

  test("refuses a body that would change nothing rather than answering it 200", async () => {
    const ws = await createWorkspace(cast.ownerA, "Empty Patch");
    const res = await cast.ownerA.fetch(`/api/tenants/${ws.id}`, json("PATCH", {}));
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toContain("Nothing to change");
  });

  test("an archived workspace refuses edits until it is restored", async () => {
    const ws = await createWorkspace(cast.ownerA, "Frozen");
    const archived = await cast.ownerA.fetch(`/api/tenants/${ws.id}`, {
      method: "DELETE",
    });
    expect(archived.status).toBe(200);

    const whileArchived = await cast.ownerA.fetch(
      `/api/tenants/${ws.id}`,
      json("PATCH", { name: "Edited while archived" }),
    );
    expect(whileArchived.status).toBe(409);
    expect((await errorOf(whileArchived)).message).toContain("archived");

    const restored = await cast.ownerA.fetch(`/api/tenants/${ws.id}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    const afterRestore = await cast.ownerA.fetch(
      `/api/tenants/${ws.id}`,
      json("PATCH", { name: "Edited after restore" }),
    );
    expect(afterRestore.status).toBe(200);
    expect((await findListed(cast.ownerA, ws.id))?.name).toBe("Edited after restore");
  });

  test("a workspace's own end-user cannot rename the workspace they are a customer of", async () => {
    const res = await cast.endUserA.fetch(
      `/api/tenants/${cast.tenantA.id}`,
      json("PATCH", { name: "Owned by the customer now" }),
    );
    expect(res.status).toBe(403);
    expect((await findListed(cast.ownerA, cast.tenantA.id))?.name).not.toBe(
      "Owned by the customer now",
    );
  });

  test("an admin of the workspace may rename it; a plain member may not", async () => {
    // Both workspaces and both invites are issued in one ownerA visit, and
    // every adminA action below happens in one adminA visit — see the header.
    const asAdmin = await createWorkspace(cast.ownerA, "Admin Renames");
    const adminToken = await inviteAdminA(cast, asAdmin.id, "admin");
    const asMember = await createWorkspace(cast.ownerA, "Member Refused");
    const memberToken = await inviteAdminA(cast, asMember.id, "member");

    await acceptInvite(cast.adminA, adminToken);
    await acceptInvite(cast.adminA, memberToken);

    const adminRename = await cast.adminA.fetch(
      `/api/tenants/${asAdmin.id}`,
      json("PATCH", { name: "Renamed by admin" }),
    );
    expect(adminRename.status).toBe(200);

    const memberRename = await cast.adminA.fetch(
      `/api/tenants/${asMember.id}`,
      json("PATCH", { name: "Renamed by member" }),
    );
    expect(memberRename.status).toBe(403);
    expect((await errorOf(memberRename)).message).toContain("owners/admins");

    const listed = await listWorkspaces(cast.adminA);
    // The admin's rename landed; the member's did not. Refused and unwritten
    // are two different claims, and only the second one matters.
    expect(listed.find((w) => w.id === asAdmin.id)?.name).toBe("Renamed by admin");
    expect(listed.find((w) => w.id === asMember.id)?.name).toBe(asMember.name);
  });
});

describe("DELETE /api/tenants/{id} — archive, not delete", () => {
  let cast: TwoPlaneCast;
  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
  });
  afterAll(() => cast?.cleanup());

  test("only an owner may archive: the workspace's own admin is refused, its owner is not", async () => {
    const ws = await createWorkspace(cast.ownerA, "Owner Only");
    const token = await inviteAdminA(cast, ws.id, "admin");

    await acceptInvite(cast.adminA, token);
    const byAdmin = await cast.adminA.fetch(`/api/tenants/${ws.id}`, {
      method: "DELETE",
    });
    expect(byAdmin.status).toBe(403);
    // Still listed, and still active, because nothing was written.
    expect((await findListed(cast.adminA, ws.id))?.status).toBe("active");

    const byOwner = await cast.ownerA.fetch(`/api/tenants/${ws.id}`, {
      method: "DELETE",
    });
    expect(byOwner.status).toBe(200);
    const { data } = (await byOwner.json()) as {
      data: { status: string; archivedAt: string | null };
    };
    expect(data.status).toBe("archived");
    expect(data.archivedAt).toBeString();
  });

  test("archiving an already-archived workspace is refused, not answered ok", async () => {
    const ws = await createWorkspace(cast.ownerA, "Twice");
    const first = await cast.ownerA.fetch(`/api/tenants/${ws.id}`, { method: "DELETE" });
    expect(first.status).toBe(200);
    const again = await cast.ownerA.fetch(`/api/tenants/${ws.id}`, { method: "DELETE" });
    expect(again.status).toBe(409);
    expect((await errorOf(again)).message).toContain("already archived");
  });

  test("an archived workspace leaves its own members' list, and `includeArchived` is how they find it again", async () => {
    const ws = await createWorkspace(cast.ownerA, "Vanishing");
    expect((await findListed(cast.ownerA, ws.id))?.status).toBe("active");

    const archived = await cast.ownerA.fetch(`/api/tenants/${ws.id}`, {
      method: "DELETE",
    });
    expect(archived.status).toBe(200);
    expect(await findListed(cast.ownerA, ws.id)).toBeUndefined();

    const hidden = await findListed(cast.ownerA, ws.id, { includeArchived: true });
    expect(hidden?.status).toBe("archived");
    expect(hidden?.archivedAt).toBeString();
    // An ISO timestamp, not whatever shape the driver happened to hand back.
    expect(Number.isNaN(Date.parse(hidden!.archivedAt!))).toBe(false);

    // Nor can it be switched into, which would otherwise hand the caller a
    // cookie the very next request refuses. The refusal is deliberately the
    // same one an unknown slug gets — see the route.
    const switchIn = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: ws.slug }),
    );
    expect(switchIn.status).toBe(404);
    expect((await errorOf(switchIn)).message).toContain("is available to you");

    // The trapdoor has a way out, and the way out clears the stamp.
    const restored = await cast.ownerA.fetch(`/api/tenants/${ws.id}/restore`, {
      method: "POST",
    });
    expect(restored.status).toBe(200);
    const back = await findListed(cast.ownerA, ws.id);
    expect(back?.status).toBe("active");
    expect(back?.archivedAt).toBeNull();
    // And the acceptance beside that refusal: once restored, the same switch
    // that was refused a moment ago goes through.
    const switchAgain = await cast.ownerA.fetch(
      "/api/tenants/switch",
      json("POST", { tenant: ws.slug }),
    );
    expect(switchAgain.status).toBe(200);
  });

  test("restore refuses a workspace that was never archived", async () => {
    const ws = await createWorkspace(cast.ownerA, "Never Archived");
    const res = await cast.ownerA.fetch(`/api/tenants/${ws.id}/restore`, {
      method: "POST",
    });
    expect(res.status).toBe(422);
    expect((await errorOf(res)).message).toContain("not archived");
  });

  test("the `default` workspace can never be archived, though the operator may archive any other", async () => {
    // The operator is `owner` of `default` — the first sign-up is seeded that
    // way — so this refusal is the route's own rule firing, and not a rank
    // check turning them away before it is reached.
    const refused = await cast.operator.fetch(
      `/api/tenants/${cast.defaultTenant.id}`,
      { method: "DELETE" },
    );
    expect(refused.status).toBe(422);
    const { message } = await errorOf(refused);
    expect(message).toContain("default workspace cannot be archived");
    expect(message).toContain("operator");
    expect((await findListed(cast.operator, cast.defaultTenant.id))?.status).toBe(
      "active",
    );

    // The acceptance beside it: the operator reaching into a workspace they
    // hold no membership row in at all is precisely the managed-cloud lever
    // this route exists to give them.
    const archivedB = await cast.operator.fetch(`/api/tenants/${cast.tenantB.id}`, {
      method: "DELETE",
    });
    expect(archivedB.status).toBe(200);

    // And ownerB, who did not ask for any of this, can still see it and undo it
    // — the archive is not a one-way door held by whoever pulled it.
    expect(await findListed(cast.ownerB, cast.tenantB.id)).toBeUndefined();
    expect(
      (await findListed(cast.ownerB, cast.tenantB.id, { includeArchived: true }))?.status,
    ).toBe("archived");
    const restoredB = await cast.ownerB.fetch(
      `/api/tenants/${cast.tenantB.id}/restore`,
      { method: "POST" },
    );
    expect(restoredB.status).toBe(200);
    expect((await findListed(cast.ownerB, cast.tenantB.id))?.status).toBe("active");
  });
});

describe("WORKSPACE_CREATION — who may open a workspace at all", () => {
  let cast: TwoPlaneCast;
  beforeAll(async () => {
    cast = await buildTwoPlaneCast();
  });
  afterAll(() => cast?.cleanup());

  /** The env object the app was built with is the one `ctx.env` holds, so a
   *  policy change is one assignment away — no second harness, and no
   *  pretending the route reads something other than what it reads. */
  const withCreation = async (
    value: string | undefined,
    fn: () => Promise<void>,
  ): Promise<void> => {
    const before = cast.h.env.WORKSPACE_CREATION;
    cast.h.env.WORKSPACE_CREATION = value;
    try {
      await fn();
    } finally {
      cast.h.env.WORKSPACE_CREATION = before;
    }
  };

  const tryCreate = (who: PlatformIdentity): Promise<Response> =>
    who.fetch(
      "/api/tenants",
      json("POST", { name: `Gated ${crypto.randomUUID().slice(0, 8)}` }),
    );

  test("unset means open — an ordinary user may still create one, as they always could", async () => {
    expect(cast.h.env.WORKSPACE_CREATION).toBeUndefined();
    expect((await tryCreate(cast.ownerA)).status).toBe(201);
    // And `open` says the same thing explicitly, so an operator who wants
    // today's behaviour written down gets it.
    await withCreation("open", async () => {
      expect((await tryCreate(cast.ownerA)).status).toBe(201);
    });
  });

  test("`operator` admits the instance operator and nobody else", async () => {
    await withCreation("operator", async () => {
      const refused = await tryCreate(cast.ownerA);
      expect(refused.status).toBe(403);
      expect((await errorOf(refused)).message).toContain("instance operator");

      expect((await tryCreate(cast.operator)).status).toBe(201);
    });
  });

  test("`off` refuses everyone, the operator included, and lifting it restores the door", async () => {
    await withCreation("off", async () => {
      const asOperator = await tryCreate(cast.operator);
      expect(asOperator.status).toBe(403);
      expect((await errorOf(asOperator)).message).toContain(
        "does not allow new workspaces",
      );
    });
    // A gate, not a one-way door: the very next request after the variable is
    // lifted succeeds.
    expect((await tryCreate(cast.operator)).status).toBe(201);
  });

  test("a value nobody could have meant is refused loudly rather than read as `open`", async () => {
    await withCreation("operatr", async () => {
      const res = await tryCreate(cast.operator);
      expect(res.status).toBe(500);
      const { message } = await errorOf(res);
      expect(message).toContain("WORKSPACE_CREATION");
      expect(message).toContain("operatr");
    });
  });
});
