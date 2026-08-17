/**
 * The snapshot envelope, and the one property it had to preserve.
 *
 * Snapshots began as a bare `SchemaCollection[]`, and `schema_snapshots.hash` is
 * a sha256 of that array's canonical JSON. Adding config to a snapshot meant
 * changing the stored shape, and the naive envelope would have changed the
 * canonical bytes of every existing row — silently invalidating every hash in
 * the table and making a collections-only capture look different from the one
 * the same workspace produced the day before.
 *
 * So a CONFIGLESS document canonicalizes to exactly what the bare array did.
 * That is the assertion this file exists for; the rest covers the reading of
 * both stored shapes and the config diff's severity mapping.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalizeDocument,
  canonicalizeSnapshot,
  diffDocument,
  readDocument,
  type SchemaCollection,
  type SchemaDocument,
} from "@backlex/db";

const collection = (slug: string): SchemaCollection => ({
  slug,
  fields: [
    { name: "b_second", type: "text" },
    { name: "a_first", type: "text" },
  ] as SchemaCollection["fields"],
});

const legacy: SchemaCollection[] = [collection("zebra"), collection("apple")];

describe("snapshot envelope", () => {
  test("a stored bare array reads as a document with no config", () => {
    const doc = readDocument(legacy);
    expect(doc.collections.map((c) => c.slug)).toEqual(["zebra", "apple"]);
    expect(doc.config).toBeUndefined();
  });

  test("a stored envelope reads back whole", () => {
    const doc = readDocument({ collections: legacy, config: { flags: [{ key: "beta" }] } });
    expect(doc.collections.length).toBe(2);
    expect(doc.config?.flags).toEqual([{ key: "beta" }]);
  });

  test("null and junk read as an empty document rather than throwing", () => {
    // A snapshot column can be null on a row written by a path that failed
    // halfway; a reconciler that throws on read cannot even show the diff that
    // would explain it.
    expect(readDocument(null).collections).toEqual([]);
    expect(readDocument(undefined).collections).toEqual([]);
    expect(readDocument({}).collections).toEqual([]);
  });

  test("HASH CONTINUITY — a configless document canonicalizes byte-identically to the bare array", () => {
    // The property every hash already in `schema_snapshots` depends on.
    expect(canonicalizeDocument({ collections: legacy })).toBe(canonicalizeSnapshot(legacy));
    // And an envelope whose config is present but empty is still configless —
    // `loadLiveConfig` returns a key per resource, so a workspace with no roles
    // and no flags produces `{roles: [], flags: [], …}`, which must not change
    // the hash of a schema that did not change.
    expect(
      canonicalizeDocument({ collections: legacy, config: { roles: [], flags: [] } }),
    ).toBe(canonicalizeSnapshot(legacy));
  });

  test("config changes the hash, and does so stably", () => {
    const a = canonicalizeDocument({ collections: legacy, config: { flags: [{ key: "beta" }] } });
    expect(a).not.toBe(canonicalizeSnapshot(legacy));
    // Order of resources and of rows within one must not matter — two
    // environments that hold the same config must hash the same.
    const b = canonicalizeDocument({
      collections: [...legacy].reverse(),
      config: { flags: [{ key: "beta" }] },
    });
    expect(b).toBe(a);
    const c = canonicalizeDocument({
      collections: legacy,
      config: { flags: [{ key: "b" }, { key: "a" }] },
    });
    const d = canonicalizeDocument({
      collections: legacy,
      config: { flags: [{ key: "a" }, { key: "b" }] },
    });
    expect(c).toBe(d);
  });
});

describe("config diff", () => {
  const doc = (config: SchemaDocument["config"]): SchemaDocument => ({ collections: [], config });

  test("a new row is additive", () => {
    const d = diffDocument(doc({ flags: [] }), doc({ flags: [{ key: "beta" }] }));
    expect(d.changes.map((c) => [c.kind, c.severity, c.field])).toEqual([
      ["config.add", "additive", "beta"],
    ]);
    expect(d.hasDestructive).toBe(false);
  });

  test("a changed row is additive, not metadata", () => {
    // `metadata` means "free to apply", which would be the wrong thing to say
    // about a role grant or a flag rule. It loses no data, so not destructive.
    const d = diffDocument(
      doc({ flags: [{ key: "beta", enabled: true }] }),
      doc({ flags: [{ key: "beta", enabled: false }] }),
    );
    expect(d.changes.map((c) => [c.kind, c.severity])).toEqual([["config.update", "additive"]]);
  });

  test("a removed row is DESTRUCTIVE and gates the apply", () => {
    // The row disappears, and for a role that cascades into `user_roles` —
    // people lose access. Same gate a dropped column gets.
    const d = diffDocument(doc({ roles: [{ key: "support" }] }), doc({ roles: [] }));
    expect(d.changes.map((c) => [c.kind, c.severity])).toEqual([["config.drop", "destructive"]]);
    expect(d.hasDestructive).toBe(true);
  });

  test("key order inside a stored row is not a change", () => {
    // Stored JSON key order is an artefact of whatever wrote it; treating it as
    // a diff would make every apply report changes that are not there.
    const d = diffDocument(
      doc({ flags: [{ key: "beta", enabled: true, description: "x" }] }),
      doc({ flags: [{ key: "beta", description: "x", enabled: true }] }),
    );
    expect(d.changes).toEqual([]);
  });

  test("a resource dropped from the document still reconciles its rows", () => {
    // `to` naming no `flags` key at all is "there are no flags", not "leave
    // flags alone" — a reconciler that read it as the latter could never
    // remove the last row of a resource.
    const d = diffDocument(doc({ flags: [{ key: "beta" }] }), doc({}));
    expect(d.changes.map((c) => c.kind)).toEqual(["config.drop"]);
  });

  test("collections and config are diffed together, in one verdict", () => {
    const d = diffDocument(
      { collections: legacy, config: { flags: [{ key: "beta" }] } },
      { collections: [collection("apple")], config: {} },
    );
    // Dropping the `zebra` collection and the `beta` flag are both destructive
    // and both land in one counts object, so one confirm covers the apply.
    expect(d.counts.destructive).toBe(2);
    expect(d.hasDestructive).toBe(true);
  });
});
