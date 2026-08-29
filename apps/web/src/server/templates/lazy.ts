import type { SchemaTemplate } from "./types";

/**
 * The catalog, reached without paying for it at startup.
 *
 * `catalog.ts` pulls all 26 vertical definitions — roughly a megabyte of DSL
 * calls that build their object graphs at module scope. Anything that imports
 * it STATICALLY drags that megabyte into the worker's eager import graph, so
 * every cold isolate compiles and evaluates the whole catalog before it can
 * answer a request, no matter what that request is. The catalog is needed by
 * exactly four things — the picker, apply, the GraphQL twin, and first-user
 * seeding — and all four are already async.
 *
 * So the rule is: **outside `templates/`, import the catalog only through this
 * module.** Types are free (`import type` is erased and creates no edge); only
 * value imports cost anything. `apps/web/scripts/measure-startup.mjs` measures
 * what the graph costs, and `apps/web/tests/worker-startup-budget.test.ts`
 * fails when it grows past its recorded budget.
 *
 * The dynamic import is memoised by the module registry itself, so the second
 * caller in an isolate pays nothing.
 */
export const loadCatalog = () => import("./catalog");

/** Lazy {@link import("./catalog").getTemplate}. */
export const getTemplateLazy = async (id: string): Promise<SchemaTemplate | undefined> =>
  (await loadCatalog()).getTemplate(id);

/** Lazy {@link import("./catalog").templateSummaries}. */
export const templateSummariesLazy = async () => (await loadCatalog()).templateSummaries();
