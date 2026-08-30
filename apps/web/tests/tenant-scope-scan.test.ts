/**
 * Tenant isolation, checked mechanically instead of remembered.
 *
 * WHY THIS FILE EXISTS
 *
 * The 2026-08 identity audit confirmed three isolation breaks in this codebase.
 * All three were ONE missing `WHERE` clause. All three shipped past a green
 * 6,300-test suite, and none of them was a subtle bug — they were the most
 * ordinary mistake there is. The reason the suite did not see them is
 * structural, not accidental: every isolation test we own drives a route that
 * REMEMBERED to scope, and a route that forgot returns a perfectly valid 200
 * carrying somebody else's rows. There is no assertion to fail.
 *
 * So this file does not test a route. It runs
 * `scripts/scan-tenant-scope.ts` over all ~600 files of
 * `apps/web/src/server/` and asserts a property of the SOURCE: every Drizzle
 * query against a table that carries `tenant_id` names a tenant predicate, or
 * is one of the entries in that script's `ALLOWLIST` — each of which says, in a
 * sentence, what provides containment instead.
 *
 * WHAT MAKES THIS A GUARD AND NOT A DECORATION
 *
 * A source scan that stops matching reports "0 violations", which is
 * indistinguishable from a clean codebase. That failure mode is the whole risk
 * with this kind of test, so four things are asserted BESIDES the violation
 * count:
 *
 *   1. the scan resolved at least `MIN_QUERIES` queries — if a refactor changes
 *      the table-binding idiom and the resolver goes blind, this trips;
 *   2. at most `MAX_UNRESOLVED` queries name a table it could not resolve —
 *      those are UNCHECKED, and the ceiling stops the number creeping;
 *   3. the tenant-scoped table set derived from the schema is non-trivial and
 *      contains the tables we know carry a tenant;
 *   4. the matcher itself is exercised against synthetic sources with KNOWN
 *      answers — scoped shapes it must accept and unscoped shapes it must
 *      reject. Those cases fail even when the real tree is spotless, which is
 *      what keeps this file honest between audits.
 *
 * AND THE ALLOWLIST IS PART OF THE TEST
 *
 * An entry that matches nothing is a failure, not a pass. A stale exemption is
 * how a rule quietly stops meaning anything: the code it excused is gone, the
 * sentence stays, and the next query in that file inherits an exemption nobody
 * wrote for it.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ALLOWLIST,
  collectHelpers,
  deriveScopedTables,
  MAX_UNRESOLVED,
  maskSource,
  MIN_QUERIES,
  predicateVerdictsFor,
  resolveArg,
  scanTenantScope,
} from "../../../scripts/scan-tenant-scope";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const scan = await scanTenantScope();

describe("tenant-scope scanner: the codebase", () => {
  test("every query against a tenant-scoped table carries a tenant predicate", () => {
    const lines = scan.violations.map(
      (v) =>
        `\n  ${v.file}:${v.line}  ${v.symbol}  ${v.op}(${v.table})\n      ${v.snippet}`,
    );
    expect(
      lines.length === 0
        ? ""
        : `${lines.length} unscoped quer${lines.length === 1 ? "y" : "ies"} against a tenant-scoped table.` +
          `\nEither add the missing tenant predicate, or — if something else provides` +
          `\ncontainment — add an entry to ALLOWLIST in scripts/scan-tenant-scope.ts` +
          `\nsaying what that something is.${lines.join("")}\n`,
    ).toBe("");
  });

  test("the scan did not fail open", () => {
    // `errors` carries the "this scan saw too little to mean anything" cases:
    // no tenant-scoped tables derived, too few queries resolved, too many
    // unresolved. Any of them makes a green violation count worthless.
    expect(scan.errors.join("\n")).toBe("");
  });

  test("it actually read the codebase", () => {
    expect(scan.filesScanned).toBeGreaterThan(400);
    expect(scan.scopedTableCount).toBeGreaterThan(50);
    expect(scan.queriesChecked).toBeGreaterThanOrEqual(MIN_QUERIES);
  });

  test("unresolved table expressions stay under the ceiling", () => {
    const listed = scan.unresolved
      .map((u) => `  ${u.file}:${u.line}  ${u.symbol}  ${u.op}(${u.arg})`)
      .join("\n");
    expect(
      scan.unresolved.length <= MAX_UNRESOLVED
        ? ""
        : `${scan.unresolved.length} queries name a table the scan could not resolve ` +
          `(ceiling ${MAX_UNRESOLVED}). Each one is UNCHECKED:\n${listed}\n`,
    ).toBe("");
  });
});

describe("tenant-scope scanner: the allowlist is a ledger, not a mute button", () => {
  test("no entry is stale", () => {
    const stale = scan.staleAllowlist.map(
      (e) => `  ${e.file}  ${e.symbol}${e.table ? ` [${e.table}]` : ""}`,
    );
    expect(
      stale.length === 0
        ? ""
        : `${stale.length} allowlist entr${stale.length === 1 ? "y" : "ies"} match nothing any more.` +
          `\nThe code they excused is gone or now scopes properly — delete them, or the` +
          `\nnext query in that file inherits an exemption nobody wrote for it:\n${stale.join("\n")}\n`,
    ).toBe("");
  });

  test("every entry names a file that exists", () => {
    const missing = ALLOWLIST.filter((e) => !existsSync(`${REPO_ROOT}${e.file}`)).map(
      (e) => e.file,
    );
    expect(missing).toEqual([]);
  });

  test("every entry gives a reason worth reading", () => {
    // A one-word reason ("legacy", "ok") is how this list turns into a mute
    // button. The bar is deliberately a sentence.
    const thin = ALLOWLIST.filter((e) => e.reason.trim().length < 40).map(
      (e) => `${e.file} ${e.symbol}: ${JSON.stringify(e.reason)}`,
    );
    expect(thin).toEqual([]);
  });

  test("no two entries claim the same site", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const e of ALLOWLIST) {
      const k = `${e.file}|${e.symbol}|${e.table ?? "*"}`;
      if (seen.has(k)) dupes.push(k);
      seen.add(k);
    }
    expect(dupes).toEqual([]);
  });

  test("the ledger stays small enough to read", () => {
    // Not a style rule. Every entry is a place this codebase reaches a row
    // without naming a workspace, and the list growing without bound means the
    // rule has stopped being a rule. 200 leaves headroom over the 140 that
    // existed when this landed (covering 173 query sites), and trips long
    // before the list becomes something nobody reviews.
    expect(ALLOWLIST.length).toBeLessThan(200);
  });
});

describe("tenant-scope scanner: the matcher itself", () => {
  // These run against synthetic sources with known answers, so they fail even
  // when the real tree is clean. Without them, a matcher that silently stopped
  // matching would leave every test above green.

  /**
   * The verdict for the LAST query site in a synthetic module, computed through
   * the scanner's own entry point rather than by rebuilding its windows here.
   * Building them locally is how the "does not borrow from the function next
   * door" case below first passed for the wrong reason: the handmade block was
   * the whole file, so it proved nothing about the real boundary.
   */
  const verdictFor = (src: string): { scoped: boolean; via?: string } => {
    const sites = predicateVerdictsFor(src);
    expect(sites.length).toBeGreaterThan(0);
    return sites[sites.length - 1] as { scoped: boolean; via?: string };
  };

  const HELPER = `const tableFor = (d: "pg" | "sqlite") =>\n  d === "pg" ? pg.schema.flows : sqlite.schema.flows;\n`;

  test("resolves the dominant table-binding idiom", () => {
    const src = `${HELPER}
export const listFlows = async (ctx: Ctx, tenantId: string) => {
  const t = tableFor(ctx.dialect);
  const rows = await (ctx.db as any).select().from(t).where(eq(t.tenantId, tenantId));
  return rows;
};
`;
    const masked = maskSource(src);
    const helpers = collectHelpers(masked);
    const at = masked.indexOf(".from(");
    expect(resolveArg("t", masked, at, helpers)).toEqual(["flows"]);
  });

  test("resolves the tablesFor object-map idiom", () => {
    const src = `const tablesFor = (d: "pg" | "sqlite") =>
  d === "pg"
    ? { members: pg.schema.tenantMembers, roles: pg.schema.roles }
    : { members: sqlite.schema.tenantMembers, roles: sqlite.schema.roles };
const run = async (ctx: Ctx) => {
  const t = tablesFor(ctx.dialect);
  await (ctx.db as any).select().from(t.members);
};
`;
    const masked = maskSource(src);
    const helpers = collectHelpers(masked);
    const at = masked.indexOf(".from(");
    expect(resolveArg("t.members", masked, at, helpers)).toEqual(["tenantMembers"]);
  });

  test("a ternary is not an object literal", () => {
    // `d === "pg" ? pg.schema.flows : sqlite.schema.flows` reads to a naive
    // `key: value` regex as the KEY `flows` mapping to `sqlite.schema.flows`.
    // That one mistake made every single-table helper resolve as a table MAP
    // and left 666 of ~730 queries unresolvable while the scan still printed a
    // violation count.
    const masked = maskSource(HELPER);
    const helpers = collectHelpers(masked);
    expect(helpers.get("tableFor")).toEqual({ kind: "table", tables: ["flows"] });
  });

  test("accepts an inline tenant predicate", () => {
    expect(
      verdictFor(`const f = async (ctx: Ctx, tenantId: string) => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).select().from(t).where(eq(t.tenantId, tenantId));
};`).scoped,
    ).toBe(true);
  });

  test("accepts a conditions array built a few lines up", () => {
    expect(
      verdictFor(`const f = async (ctx: Ctx, tenantId: string) => {
  const t = tableFor(ctx.dialect);
  const conds: SQL[] = [eq(t.tenantId, tenantId)];
  if (q) conds.push(eq(t.name, q));
  await (ctx.db as any).select().from(t).where(and(...conds));
};`).scoped,
    ).toBe(true);
  });

  test("accepts a two-hop predicate chain", () => {
    expect(
      verdictFor(`const f = async (ctx: Ctx, tenantId: string | null) => {
  const t = tableFor(ctx.dialect);
  const scope = tenantId == null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);
  const where = status ? and(scope, eq(t.status, status)) : scope;
  await (ctx.db as any).select().from(t).where(where);
};`).scoped,
    ).toBe(true);
  });

  test("accepts an insert whose values object carries the tenant", () => {
    expect(
      verdictFor(`const f = async (ctx: Ctx, tenantId: string) => {
  const t = tableFor(ctx.dialect);
  const row = {
    id: crypto.randomUUID(),
    tenantId,
    name: "x",
  };
  await (ctx.db as any).insert(t).values(row);
};`).scoped,
    ).toBe(true);
  });

  test("REJECTS a query keyed on an id alone", () => {
    expect(
      verdictFor(`const f = async (ctx: Ctx, tenantId: string, id: string) => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).update(t).set({ name: "x" }).where(eq(t.id, id));
};`).scoped,
    ).toBe(false);
  });

  test("REJECTS a query whose only mention of the tenant is in a string", () => {
    // Route summaries and error messages say "tenantId" all the time. Masking
    // string CONTENTS is what stops them vouching for a query that scopes
    // nothing.
    expect(
      verdictFor(`const f = async (ctx: Ctx, id: string) => {
  const t = tableFor(ctx.dialect);
  if (!id) throw new AppError("VALIDATION", "tenantId is required");
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};`).scoped,
    ).toBe(false);
  });

  test("REJECTS a query whose only mention of the tenant is in a comment", () => {
    expect(
      verdictFor(`const f = async (ctx: Ctx, id: string) => {
  const t = tableFor(ctx.dialect);
  // TODO: scope this by t.tenantId
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};`).scoped,
    ).toBe(false);
  });

  test("does NOT borrow a tenant predicate from the function next door", () => {
    // The window the carrier walk searches is bounded to the enclosing
    // FUNCTION. With a plain character budget instead, the scoped query in
    // `a()` cleared the unscoped one in `b()` — 77 queries across the tree were
    // being excused that way.
    expect(
      verdictFor(`const a = async (ctx: Ctx, tenantId: string) => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).select().from(t).where(eq(t.tenantId, tenantId));
};
const b = async (ctx: Ctx, id: string) => {
  const t = tableFor(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.id, id));
};`).scoped,
    ).toBe(false);
  });

  test("a route handler's queries are judged one at a time", () => {
    // Every route here is `.openapi(createRoute({…}), async (c) => { … })`, so
    // a handler body sits at parenthesis depth ≥ 1 for its whole length. A
    // statement splitter that only cuts at depth zero never cuts INSIDE a
    // handler — the entire registration is one "statement" and the
    // `const tenantId = …` at the top vouches for every query below it.
    //
    // This is not hypothetical. Deleting a real `eq(t.tenantId, tenantId)` from
    // `routes/folders.ts` produced NO finding at all until the splitter learned
    // the difference between a block and an object literal.
    const src = `export const routes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({ method: "get", path: "/", summary: "List folders" }),
    async (c) => {
      const ctx = c.get("ctx");
      const auth = c.get("auth");
      const tenantId = requireTenantId(auth);
      const t = tableFor(ctx.dialect);
      const rows = await (ctx.db as any).select().from(t).where(eq(t.id, auth.id));
      return c.json({ data: rows });
    },
  );`;
    expect(verdictFor(src).scoped).toBe(false);
  });

  test("a type that names tenantId is not a tenant predicate", () => {
    // `as Array<{ … tenantId: string | null … }>` is the ROW TYPE. Left alone
    // it cleared seven cross-workspace reads here, `flow-schedules
    // .listScheduleFlows` among them.
    expect(
      verdictFor(`const f = async (ctx: Ctx) => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.active, true))) as Array<{
    id: string;
    tenantId: string | null;
  }>;
  return rows;
};`).scoped,
    ).toBe(false);
  });

  test("a declared return type does not swallow the function body", () => {
    // `): Promise<void> {` ends in `>`, not `)`, so the body brace has to be
    // recognised through the annotation. When it was not, the whole function
    // collapsed into one statement and its first `tenantId` cleared everything
    // after it.
    expect(
      verdictFor(`export async function deleteThing(ctx: Ctx, tenantId: string | null, key: string): Promise<void> {
  const t = tableFor(ctx.dialect);
  const where = tenantId == null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);
  const [own] = await (ctx.db as any).select().from(t).where(where);
  await (ctx.db as any).delete(t).where(eq(t.key, key));
}`).scoped,
    ).toBe(false);
  });

  test("a JavaScript .filter() is not a tenant predicate", () => {
    // Filtering rows in memory after reading every workspace's is a real
    // pattern here (backup.runBackup) and it must still be REPORTED, because
    // the SQL reads across workspaces whatever the array does afterwards.
    expect(
      verdictFor(`const f = async (ctx: Ctx, tenantId: string) => {
  const t = tableFor(ctx.dialect);
  const rows = await (ctx.db as any).select().from(t);
  return rows.filter((r) => r.tenantId === tenantId);
};`).scoped,
    ).toBe(false);
  });

  test("derives tenant-scoped tables from the schema rather than a hard-coded list", async () => {
    const scoped = await deriveScopedTables();
    // Tables that unambiguously carry a workspace. If the schema ever drops
    // `tenantId` from one of these, that is a finding in itself.
    for (const name of ["appUsers", "collections", "flows", "apiKeys", "tenantMembers"]) {
      expect(scoped.has(name)).toBe(true);
    }
    // And tables that unambiguously do not, so "everything is scoped" —
    // another way for this to pass vacuously — is caught too.
    for (const name of ["users", "sessions", "tenants", "permissions"]) {
      expect(scoped.has(name)).toBe(false);
    }
  });
});
