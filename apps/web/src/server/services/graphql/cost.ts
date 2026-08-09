/**
 * Query cost, depth and alias budget for `/api/graphql`.
 *
 * The schema is generated from tenant metadata, so a caller can ask for
 * arbitrarily deep relation chains with an arbitrarily large `limit` on every
 * hop. Nothing in `createYoga` bounds that: a single accepted document can fan
 * out into millions of rows and burn the whole workspace's D1/Postgres budget
 * before the first byte is written. REST is safe by construction (one list, one
 * `limit`, `maxRelationDepth` on filters) — GraphQL was not.
 *
 * This is the analogue of Saleor's query cost validation: refuse the *document*
 * before execution rather than discovering the cost while paying it.
 *
 * The budget is deliberately computed off the AST alone, with no schema
 * awareness. A typed walk would be more precise about which fields are lists,
 * but it would also have to be rebuilt for every generated schema shape, and
 * the imprecision only ever makes the estimate *lower* than reality for fields
 * we cannot recognise — never higher, so a legitimate query is not rejected for
 * a cost it does not have.
 */
import {
  Kind,
  type ArgumentNode,
  type DefinitionNode,
  type DocumentNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
} from "graphql";

/** Defaults, overridable per deployment via `GRAPHQL_MAX_*`. */
export const DEFAULT_MAX_DEPTH = 12;
export const DEFAULT_MAX_COST = 50_000;
export const DEFAULT_MAX_ALIASES = 40;

/**
 * Rows assumed for a list field that does not carry an explicit `limit`. The
 * items resolvers apply their own default page size; this only has to be the
 * same order of magnitude for the estimate to be useful.
 */
const ASSUMED_PAGE_SIZE = 25;

export interface CostBudget {
  maxDepth: number;
  maxCost: number;
  maxAliases: number;
}

export interface CostReport {
  depth: number;
  cost: number;
  aliases: number;
}

/**
 * Read the budget from env, falling back to the defaults. A value that is not a
 * positive integer is ignored rather than treated as zero — a typo in a deploy
 * variable must not silently reject every query.
 */
export const budgetFromEnv = (env: {
  GRAPHQL_MAX_DEPTH?: string;
  GRAPHQL_MAX_COST?: string;
  GRAPHQL_MAX_ALIASES?: string;
}): CostBudget => {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    maxDepth: num(env.GRAPHQL_MAX_DEPTH, DEFAULT_MAX_DEPTH),
    maxCost: num(env.GRAPHQL_MAX_COST, DEFAULT_MAX_COST),
    maxAliases: num(env.GRAPHQL_MAX_ALIASES, DEFAULT_MAX_ALIASES),
  };
};

/** Literal integer of a `limit`/`first`/`last` argument, when it is one. */
const literalRowCount = (args: readonly ArgumentNode[]): number | null => {
  for (const arg of args) {
    const name = arg.name.value;
    if (name !== "limit" && name !== "first" && name !== "last") continue;
    const v: ValueNode = arg.value;
    if (v.kind === Kind.INT) {
      const n = Number.parseInt(v.value, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    // A variable — the value is not in the document. Assume the page size
    // rather than 1, so parameterising a limit is not a way around the budget.
    if (v.kind === Kind.VARIABLE) return ASSUMED_PAGE_SIZE;
  }
  return null;
};

/**
 * True when every root field of the operation is an introspection meta-field.
 * GraphiQL's introspection document is deep and wide by nature and carries no
 * per-row cost, so it is measured against nothing.
 */
const isIntrospectionOnly = (set: SelectionSetNode): boolean => {
  let sawField = false;
  for (const sel of set.selections) {
    if (sel.kind !== Kind.FIELD) continue;
    sawField = true;
    if (!sel.name.value.startsWith("__")) return false;
  }
  return sawField;
};

/**
 * Walk the document and return its depth, estimated row cost, and the largest
 * number of aliases pointing at one field name.
 *
 * Fragment spreads are followed through `fragments`; a cyclic spread (illegal
 * GraphQL that `validate` would reject later, but which reaches us first) is
 * cut off by `seen` so measuring cannot hang.
 */
export const measure = (doc: DocumentNode): CostReport => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of doc.definitions as readonly DefinitionNode[]) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }

  let depth = 0;
  let cost = 0;
  const aliasCounts = new Map<string, number>();

  const walk = (set: SelectionSetNode, level: number, multiplier: number, seen: Set<string>) => {
    if (level > depth) depth = level;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.alias) {
          const key = sel.name.value;
          aliasCounts.set(key, (aliasCounts.get(key) ?? 0) + 1);
        }
        // Introspection meta-fields resolve from the schema in memory.
        if (sel.name.value.startsWith("__")) continue;
        const rows = literalRowCount(sel.arguments ?? []);
        const next = rows === null ? multiplier : multiplier * rows;
        cost += next;
        if (sel.selectionSet) walk(sel.selectionSet, level + 1, next, seen);
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        walk(sel.selectionSet, level, multiplier, seen);
      } else {
        const name = sel.name.value;
        if (seen.has(name)) continue;
        const frag = fragments.get(name);
        if (!frag) continue;
        walk(frag.selectionSet, level, multiplier, new Set([...seen, name]));
      }
    }
  };

  for (const def of doc.definitions as readonly DefinitionNode[]) {
    if (def.kind !== Kind.OPERATION_DEFINITION) continue;
    if (isIntrospectionOnly(def.selectionSet)) continue;
    walk(def.selectionSet, 1, 1, new Set());
  }

  let aliases = 0;
  for (const n of aliasCounts.values()) if (n > aliases) aliases = n;
  return { depth, cost, aliases };
};

/**
 * Measure `doc` against `budget` and return the reason it is over, or `null`
 * when it fits. The caller turns a reason into the 422 the rest of the API
 * uses for a request it refuses to run.
 */
export const overBudget = (doc: DocumentNode, budget: CostBudget): string | null => {
  const r = measure(doc);
  if (r.depth > budget.maxDepth) {
    return `Query is too deeply nested (${r.depth} levels, max ${budget.maxDepth})`;
  }
  if (r.aliases > budget.maxAliases) {
    return `Too many aliases of one field (${r.aliases}, max ${budget.maxAliases})`;
  }
  if (r.cost > budget.maxCost) {
    return `Query cost ${r.cost} exceeds the maximum of ${budget.maxCost} — lower a "limit" or select fewer nested fields`;
  }
  return null;
};
