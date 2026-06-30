/**
 * Unit tests for `diffSchema` (@backlex/db) — the pure schema-diff engine that
 * powers migration diffing / schema branching (#9). No harness, no DB: it
 * compares two snapshots and categorizes every change additive / destructive /
 * metadata with the DDL it would emit.
 */
import { describe, expect, test } from "bun:test";
import {
  canonicalizeSnapshot,
  diffSchema,
  type SchemaCollection,
  type SchemaSnapshot,
} from "@backlex/db";

const coll = (over: Partial<SchemaCollection> & { slug: string }): SchemaCollection => ({
  fields: [],
  physicalTable: `c_${over.slug}`,
  ...over,
});

describe("diffSchema — collection-level", () => {
  test("added managed collection is additive", () => {
    const d = diffSchema([], [coll({ slug: "posts", fields: [{ name: "title", type: "text" }] })]);
    expect(d.counts.additive).toBe(1);
    expect(d.hasDestructive).toBe(false);
    expect(d.changes[0]?.kind).toBe("collection.add");
  });

  test("dropped managed collection is destructive with DROP TABLE ddl", () => {
    const d = diffSchema([coll({ slug: "posts" })], []);
    expect(d.hasDestructive).toBe(true);
    const c = d.changes[0];
    expect(c?.kind).toBe("collection.drop");
    expect(c?.severity).toBe("destructive");
    expect(c?.ddl?.pg[0]).toContain("DROP TABLE");
  });

  test("dropped adopted collection is metadata-only (table left intact)", () => {
    const d = diffSchema([coll({ slug: "legacy", adopted: true })], []);
    expect(d.hasDestructive).toBe(false);
    expect(d.changes[0]?.severity).toBe("metadata");
    expect(d.changes[0]?.ddl?.pg).toEqual([]);
  });
});

describe("diffSchema — field-level", () => {
  const base = coll({ slug: "posts", fields: [{ name: "title", type: "text" }] });

  test("added nullable field is additive ADD COLUMN", () => {
    const next = coll({
      slug: "posts",
      fields: [{ name: "title", type: "text" }, { name: "views", type: "integer" }],
    });
    const d = diffSchema([base], [next]);
    const c = d.changes.find((x) => x.field === "views");
    expect(c?.kind).toBe("field.add");
    expect(c?.severity).toBe("additive");
    expect(c?.ddl?.sqlite[0]).toContain("ADD COLUMN");
  });

  test("added required field with no default is destructive (fails on existing rows)", () => {
    const next = coll({
      slug: "posts",
      fields: [{ name: "title", type: "text" }, { name: "slug", type: "text", required: true }],
    });
    const d = diffSchema([base], [next]);
    const c = d.changes.find((x) => x.field === "slug");
    expect(c?.severity).toBe("destructive");
  });

  test("added required field WITH default is additive", () => {
    const next = coll({
      slug: "posts",
      fields: [{ name: "title", type: "text" }, { name: "state", type: "text", required: true, default: "draft" }],
    });
    const d = diffSchema([base], [next]);
    expect(d.changes.find((x) => x.field === "state")?.severity).toBe("additive");
  });

  test("dropped field is destructive DROP COLUMN", () => {
    const d = diffSchema([base], [coll({ slug: "posts", fields: [] })]);
    const c = d.changes.find((x) => x.kind === "field.drop");
    expect(c?.severity).toBe("destructive");
    expect(c?.ddl?.pg[0]).toContain("DROP COLUMN");
  });

  test("type change is destructive drop+re-add", () => {
    const next = coll({ slug: "posts", fields: [{ name: "title", type: "integer" }] });
    const d = diffSchema([base], [next]);
    const c = d.changes.find((x) => x.kind === "field.type");
    expect(c?.severity).toBe("destructive");
    expect(c?.ddl?.pg).toHaveLength(2);
    expect(c?.ddl?.pg[0]).toContain("DROP COLUMN");
    expect(c?.ddl?.pg[1]).toContain("ADD COLUMN");
  });

  test("adding an index is additive; removing one is metadata", () => {
    const indexed = coll({ slug: "posts", fields: [{ name: "title", type: "text", indexed: true }] });
    expect(diffSchema([base], [indexed]).counts.additive).toBe(1);
    expect(diffSchema([indexed], [base]).counts.metadata).toBe(1);
  });

  test("tightening a constraint is destructive; loosening is metadata", () => {
    const required = coll({ slug: "posts", fields: [{ name: "title", type: "text", required: true }] });
    expect(diffSchema([base], [required]).hasDestructive).toBe(true);
    expect(diffSchema([required], [base]).counts.metadata).toBe(1);
  });

  test("pure label/interface change is metadata", () => {
    const labeled = coll({ slug: "posts", fields: [{ name: "title", type: "text", label: "Headline" }] });
    const d = diffSchema([base], [labeled]);
    expect(d.changes.find((x) => x.kind === "field.metadata")?.severity).toBe("metadata");
    expect(d.hasDestructive).toBe(false);
  });

  test("adopted-collection field changes carry no DDL", () => {
    const a = coll({ slug: "legacy", adopted: true, fields: [{ name: "x", type: "text" }] });
    const b = coll({ slug: "legacy", adopted: true, fields: [{ name: "x", type: "text" }, { name: "y", type: "text" }] });
    const c = diffSchema([a], [b]).changes.find((ch) => ch.field === "y");
    expect(c?.ddl?.pg).toEqual([]);
  });
});

describe("diffSchema — flags", () => {
  test("enabling versioned is additive, disabling is metadata", () => {
    const off = coll({ slug: "posts" });
    const on = coll({ slug: "posts", versioned: true });
    expect(diffSchema([off], [on]).counts.additive).toBe(1);
    expect(diffSchema([on], [off]).counts.metadata).toBe(1);
  });

  test("toggling ownerScoped (UI-only) is metadata either way", () => {
    const off = coll({ slug: "posts" });
    const on = coll({ slug: "posts", ownerScoped: true });
    expect(diffSchema([off], [on]).counts.metadata).toBe(1);
  });
});

describe("diffSchema — identity", () => {
  test("identical snapshots produce no changes", () => {
    const snap: SchemaSnapshot = [coll({ slug: "posts", fields: [{ name: "title", type: "text" }] })];
    expect(diffSchema(snap, snap).counts.total).toBe(0);
  });

  test("canonicalize is order-independent", () => {
    const a: SchemaSnapshot = [
      coll({ slug: "b", fields: [{ name: "y", type: "text" }, { name: "x", type: "text" }] }),
      coll({ slug: "a" }),
    ];
    const b: SchemaSnapshot = [
      coll({ slug: "a" }),
      coll({ slug: "b", fields: [{ name: "x", type: "text" }, { name: "y", type: "text" }] }),
    ];
    expect(canonicalizeSnapshot(a)).toBe(canonicalizeSnapshot(b));
  });
});
