/**
 * `VECTOR_STORES` is the single source of truth for which stores exist.
 *
 * It used to be restated in four places — the capability type, the vector
 * route's zod enum, the admin client's type, and an MCP tool description — and a
 * hand-maintained list restated N times is the shape of bug that has already
 * shipped twice in this repo: the next entry lands in three of them and is
 * silently missing from the fourth. These pin the two restatements that are
 * still text rather than types.
 */
import { describe, expect, test } from "bun:test";
import { VECTOR_STORES } from "@backlex/core";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) => readFileSync(join(import.meta.dir, "..", rel), "utf8");

describe("vector store list", () => {
  test("every store is described in the MCP capabilities tool", () => {
    // The tool text is what an agent reads to decide whether vector search can
    // work; a store missing from it is invisible to every MCP client.
    const src = read("src/server/mcp/tools/vector.ts");
    for (const store of VECTOR_STORES) {
      expect(src.includes(`\`${store}\``), `${store} missing from the MCP description`).toBe(true);
    }
  });

  test("every store is documented", () => {
    const doc = read("../../docs/vector-search.md");
    // `none` is an internal sentinel, not something an operator configures.
    for (const store of VECTOR_STORES.filter((s) => s !== "none")) {
      expect(doc.toLowerCase().includes(store), `${store} missing from docs/vector-search.md`).toBe(true);
    }
  });

  test("the list has no duplicates and keeps its sentinel", () => {
    expect(new Set(VECTOR_STORES).size).toBe(VECTOR_STORES.length);
    // `none` is a real member — the admin UI branches on it.
    expect(VECTOR_STORES).toContain("none");
  });
});
