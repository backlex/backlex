/**
 * Config as code, end to end.
 *
 * `templates extract`/`apply` moves config between workspaces, but it is a
 * SEEDER: additive, skip-by-natural-key, and it never says what would change or
 * removes what should not be there. This is the other half — reconciliation —
 * built on the frame `schema-versions` already had: snapshot, ref, diff,
 * severity, confirm gate.
 *
 * What these tests are really pinning is the asymmetry that makes a reconciler
 * different from a seeder: applying a snapshot in which a role is ABSENT must
 * remove it, and that removal must be gated, because a deleted role cascades
 * into `user_roles` and people lose access.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

interface Snapshot {
  id: string;
  hash: string;
  snapshot: { collections: unknown[]; config?: Record<string, { key: string }[]> };
}

describe("config reconciler", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = makeHarness();
    await seedAdmin(h);
  });
  afterEach(() => h.cleanup());

  const ok = async (res: Response, what: string) => {
    if (res.status >= 300) throw new Error(`${what}: ${res.status} ${await res.text()}`);
    return res;
  };

  const capture = async (name: string): Promise<Snapshot> =>
    ((await (
      await ok(await h.fetch("/api/admin/schema/snapshots", json({ name })), "capture")
    ).json()) as { data: Snapshot }).data;

  const diffAgainst = async (snapshotId: string) =>
    ((await (
      await ok(
        await h.fetch(
          "/api/admin/schema/diff",
          json({ from: { kind: "live" }, to: { kind: "snapshot", id: snapshotId } }),
        ),
        "diff",
      )
    ).json()) as {
      data: { diff: { changes: { kind: string; severity: string; field?: string }[]; hasDestructive: boolean } };
    }).data.diff;

  const apply = async (snapshotId: string, confirmDestructive = false) =>
    h.fetch(
      "/api/admin/schema/apply",
      json({ target: { kind: "snapshot", id: snapshotId }, confirmDestructive }),
    );

  const roleNames = async () =>
    ((await (await h.fetch("/api/roles")).json()) as { data: { name: string }[] }).data.map(
      (r) => r.name,
    );

  const flagKeys = async () =>
    ((await (await h.fetch("/api/admin/feature-flags")).json()) as {
      data: { key: string }[];
    }).data.map((f) => f.key);

  test("a snapshot carries the workspace's config, not just its collections", async () => {
    await ok(await h.fetch("/api/roles", json({ name: "support" })), "role");
    await ok(
      await h.fetch("/api/admin/feature-flags/beta", json({ enabled: true }, "PUT")),
      "flag",
    );
    const snap = await capture("with-config");
    expect(snap.snapshot.config?.roles?.map((r) => r.key)).toEqual(["support"]);
    expect(snap.snapshot.config?.flags?.map((f) => f.key)).toEqual(["beta"]);
  });

  test("the three system roles are never captured", async () => {
    // They exist in every workspace before anything is applied, so carrying
    // them would be rows the apply must recognise as no-ops — and one that
    // could DELETE `admin` if a target had drifted.
    const snap = await capture("system-roles");
    const names = snap.snapshot.config?.roles?.map((r) => r.key) ?? [];
    expect(names).not.toContain("admin");
    expect(names).not.toContain("authenticated");
    expect(names).not.toContain("public");
  });

  test("adding config after a capture shows up as a drop against it", async () => {
    const before = await capture("before");
    await ok(await h.fetch("/api/roles", json({ name: "support" })), "role");
    // live has `support`; the snapshot does not — reconciling TO the snapshot
    // would remove it.
    const d = await diffAgainst(before.id);
    const drops = d.changes.filter((c) => c.kind === "config.drop");
    expect(drops.map((c) => c.field)).toEqual(["support"]);
    expect(d.hasDestructive).toBe(true);
  });

  test("removing a role is refused without the confirm, and happens with it", async () => {
    const empty = await capture("empty");
    await ok(await h.fetch("/api/roles", json({ name: "support" })), "role");
    expect(await roleNames()).toContain("support");

    const refused = await apply(empty.id);
    expect(refused.status).toBe(422);
    expect(await roleNames()).toContain("support");

    await ok(await apply(empty.id, true), "confirmed apply");
    expect(await roleNames()).not.toContain("support");
    // The system roles survive an apply that removes every captured role.
    expect(await roleNames()).toContain("admin");
  });

  test("a flag the snapshot has and live does not is created, with no confirm", async () => {
    await ok(
      await h.fetch("/api/admin/feature-flags/beta", json({ enabled: true }, "PUT")),
      "flag",
    );
    const withFlag = await capture("with-flag");
    await ok(await h.fetch("/api/admin/feature-flags/beta", { method: "DELETE" }), "delete flag");
    expect(await flagKeys()).not.toContain("beta");

    const d = await diffAgainst(withFlag.id);
    expect(d.changes.filter((c) => c.kind === "config.add").map((c) => c.field)).toEqual(["beta"]);
    expect(d.hasDestructive).toBe(false);

    await ok(await apply(withFlag.id), "additive apply needs no confirm");
    expect(await flagKeys()).toContain("beta");
  });

  test("a role's grants are REPLACED, not merged", async () => {
    // The one direction that widens access silently: merging would leave a
    // grant the document removed in place.
    await ok(await h.fetch("/api/collections", json({ slug: "notes", fields: [{ name: "body", type: "text" }] })), "collection");
    await ok(await h.fetch("/api/roles", json({ name: "support" })), "role");
    const roleId = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data.find((r) => r.name === "support")!.id;
    await ok(
      await h.fetch(`/api/roles/${roleId}/permissions`, json({ collection: "notes", action: "read" })),
      "grant read",
    );
    const oneGrant = await capture("one-grant");

    await ok(
      await h.fetch(`/api/roles/${roleId}/permissions`, json({ collection: "notes", action: "delete" })),
      "grant delete",
    );
    const grantsNow = async () =>
      ((await (await h.fetch(`/api/roles/${roleId}/permissions`)).json()) as {
        data: { action: string }[];
      }).data.map((g) => g.action).sort();
    expect(await grantsNow()).toEqual(["delete", "read"]);

    // Reconciling back to the snapshot must take `delete` away again.
    await ok(await apply(oneGrant.id, true), "apply");
    const after = ((await (await h.fetch("/api/roles")).json()) as {
      data: { id: string; name: string }[];
    }).data.find((r) => r.name === "support")!.id;
    const finalGrants = ((await (await h.fetch(`/api/roles/${after}/permissions`)).json()) as {
      data: { action: string }[];
    }).data.map((g) => g.action);
    expect(finalGrants).toEqual(["read"]);
  });

  describe("the GitOps loop closes", () => {
    // Export the document, edit it the way a human would in git, import it
    // back, apply. A document this service can produce but not re-import would
    // break the only loop the import endpoint exists for — and that is exactly
    // what happened when the envelope arrived: the endpoint still demanded a
    // bare array.
    const importDoc = async (name: string, snapshot: unknown): Promise<Snapshot> =>
      ((await (
        await ok(
          await h.fetch("/api/admin/schema/snapshots/import", json({ name, snapshot })),
          "import",
        )
      ).json()) as { data: Snapshot }).data;

    test("a captured document can be edited and imported back", async () => {
      await ok(await h.fetch("/api/roles", json({ name: "support" })), "role");
      const exported = await capture("exported");

      // The edit a human makes in git: add a flag the workspace does not have.
      const edited = {
        ...exported.snapshot,
        config: { ...(exported.snapshot.config ?? {}), flags: [{ key: "from_git", enabled: true }] },
      };
      const imported = await importDoc("from-git", edited);

      const d = await diffAgainst(imported.id);
      expect(d.changes.filter((c) => c.kind === "config.add").map((c) => c.field)).toEqual([
        "from_git",
      ]);
      await ok(await apply(imported.id), "apply the edited document");
      expect(await flagKeys()).toContain("from_git");
    });

    test("a bare collections array still imports — the shape every older caller sends", async () => {
      const snap = await importDoc("legacy-shape", [
        { slug: "legacy", fields: [{ name: "title", type: "text" }] },
      ]);
      expect(snap.snapshot.collections.length).toBe(1);
    });

    test("an unknown config resource is refused by name", async () => {
      // Silently dropping it would let a typo in a hand-edited document read as
      // "this resource has no rows" — which an apply would then act on.
      const res = await h.fetch(
        "/api/admin/schema/snapshots/import",
        json({ name: "bad", snapshot: { collections: [], config: { nonsense: [{ key: "x" }] } } }),
      );
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("nonsense");
    });

    test("a config entry with no natural key is refused", async () => {
      const res = await h.fetch(
        "/api/admin/schema/snapshots/import",
        json({ name: "bad", snapshot: { collections: [], config: { flags: [{ enabled: true }] } } }),
      );
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("key");
    });
  });

  test("capturing an unchanged workspace twice gives the same hash", async () => {
    // The content hash is what tells an operator "nothing drifted". If the
    // config half were serialised non-deterministically, every capture would
    // look like a change.
    await ok(await h.fetch("/api/roles", json({ name: "support" })), "role");
    const a = await capture("a");
    const b = await capture("b");
    expect(b.hash).toBe(a.hash);
  });

  test("applying a snapshot of the workspace as it stands is a no-op", async () => {
    await ok(await h.fetch("/api/roles", json({ name: "support" })), "role");
    const snap = await capture("now");
    const res = await ok(await apply(snap.id), "apply");
    const body = (await res.json()) as { data: { noop: boolean } };
    expect(body.data.noop).toBe(true);
  });
});
