/**
 * `polymorphicRef` is a referential action over a target the schema cannot
 * name, so the only thing standing between a malformed declaration and a
 * `DELETE` statement built from it is `validateFields`.
 *
 * The failure it prevents is the worst-timed one there is: a pair naming a
 * column that does not exist produces SQL that is fine to store and fails when
 * somebody deletes a row — mid-cascade, on production data, in a code path
 * nobody exercises until then. So the shape is refused at write time, and the
 * engine ALSO skips a stored pair whose sibling has since gone (stored field
 * metadata is untrusted — a collection row can predate a rename, or be written
 * by hand).
 */
import { describe, expect, test } from "bun:test";
import { validateFields } from "@backlex/db";

const pair = (rowId: Record<string, unknown>, collectionField = "collection") => () =>
  validateFields([
    { name: collectionField, type: "text", required: true },
    { name: "row_id", type: "text", required: true, ...rowId },
  ] as never);

describe("validateFields — polymorphic references", () => {
  test("accepts the translations shape", () => {
    expect(
      pair({ polymorphicRef: { collectionField: "collection" }, onDelete: "cascade" }),
    ).not.toThrow();
  });

  test("accepts it without an action — declared, swept by nothing", () => {
    // `polymorphicRef` alone documents the pair; `onDelete: "cascade"` is what
    // arms the sweep. Both halves are needed, and neither is an error on its
    // own, so a collection can declare the shape before deciding the policy.
    expect(pair({ polymorphicRef: { collectionField: "collection" } })).not.toThrow();
  });

  test("refuses a sibling column that is not on the collection", () => {
    // The one that would otherwise fail mid-delete: `findPolymorphicRefs` skips
    // it at runtime, so without this the declaration would look accepted and
    // silently sweep nothing.
    expect(pair({ polymorphicRef: { collectionField: "nope" }, onDelete: "cascade" })).toThrow(
      /not a field on this collection/,
    );
  });

  test("refuses a pair that names its own column", () => {
    expect(pair({ polymorphicRef: { collectionField: "row_id" }, onDelete: "cascade" })).toThrow(
      /must name a DIFFERENT column/,
    );
  });

  test("refuses an empty sibling name", () => {
    expect(pair({ polymorphicRef: { collectionField: "" }, onDelete: "cascade" })).toThrow(
      /collectionField" is required/,
    );
  });

  test("refuses set_null — the row would describe nothing", () => {
    // And on the usual `required: true` shape it could not even be written, so
    // this is a statement that fails at delete time rather than a bad policy.
    expect(pair({ polymorphicRef: { collectionField: "collection" }, onDelete: "set_null" })).toThrow(
      /cascade" only/,
    );
  });

  test("refuses a non-string column", () => {
    expect(() =>
      validateFields([
        { name: "collection", type: "text" },
        {
          name: "row_id",
          type: "integer",
          polymorphicRef: { collectionField: "collection" },
          onDelete: "cascade",
        },
      ] as never),
    ).toThrow(/requires a text or uuid field/);
  });

  test("onDelete on a plain column is still refused, and now says why", () => {
    // The pre-existing rule. Relaxing it for `polymorphicRef` must not relax it
    // for everything — a `cascade` on an ordinary text column referenced
    // nothing before this change and still does not.
    expect(() =>
      validateFields([{ name: "note", type: "text", onDelete: "cascade" }] as never),
    ).toThrow(/only applies to a relation field or a polymorphicRef/);
  });
});
