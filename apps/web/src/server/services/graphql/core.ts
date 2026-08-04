import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  type GraphQLFieldConfig,
  type GraphQLInputType,
  type GraphQLOutputType,
} from "graphql";
import { sql, type SQL } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import {
  compileCondition,
  type FieldDef,
  type FieldType,
  isKnownFieldType,
  isLocalized,
  resolveAutoFill,
  sidecarFields,
} from "@backlex/db";
import {
  loadSidecarForRows,
  sidecarDeleteRow,
  sidecarInsert,
  sidecarUpsert,
  splitLocalized,
} from "../items/i18n-sidecar";
import {
  AppError,
  type AuthSubject,
  type Condition,
  normalizeCondition,
} from "@backlex/core";
import {
  resolvePermission,
  type PermResolveCache,
} from "../permissions";
import { dispatchEventHandlers, publishEvent } from "../events";
import { loadCollection } from "../items/collection-loader";
import { ITEMS_AGG_FUNCS, runItemsAggregate } from "../items/aggregate";
import { searchCollectionItems } from "../items/search";
import { runBatch, type BatchOp } from "../items/batch";
import { runChangefeed } from "../items/changefeed";
import { runBulkUpdate } from "../items/bulk";
import { hashIncomingFields, scrubHashFields } from "../items/hash-fields";
import { getStagedRow, stagedDeleteSql, stagedUpsertSql, stagedViewOf } from "../items/staged";
import { enforceOnDeleteTriggers } from "../items/on-delete";
import {
  rollupRefreshAllStatements,
  rollupRefreshStatements,
} from "../items/rollup";
import { nextSequenceValues, sequenceFieldsOf } from "../items/sequence";
import { validateAndNormalizeGeo } from "../items/geo-fields";
import {
  assertInitialStates,
  assertTransitions,
  describeTransitions,
  transitionEventName,
} from "../items/transitions";
import {
  deserialize as sharedDeserialize,
  deserializeField,
  serialize as sharedSerialize,
  serializeField,
} from "../items/serialize";
import { assertCurrencyChangeIsSafe, canonicalizeMoneyFields } from "../items/money-fields";
import { canonicalizeEmailFields } from "../items/email-fields";
import { canonicalizePhoneFields } from "../items/phone-fields";
import { expandRangeOperators, rangeFieldsOf } from "@backlex/db/range";
import { normalizeTemporalOperands } from "../items/temporal-fields";
import { applyAutoGeocode, patchTouchesSources } from "../items/geocode";
import { verifyHashField } from "../items/verify";
import type { Hono } from "hono";
import type { Ctx } from "../../context";

export interface CollectionRow {
  /** collections.id — keys the `item_staged` sidecar rows. */
  id: string;
  slug: string;
  physicalTable: string;
  fields: FieldDef[];
  ownerScoped: boolean | number;
  pkColumn: string;
  hasCreatedAt: boolean;
  hasUpdatedAt: boolean;
  softDelete: boolean;
  singleton: boolean;
  versioned: boolean;
  /** Staged edits for published rows — see the items collection-loader twin. */
  stagedEdits: boolean;
  /** Whether the physical table carries a `tenant_id` column scoping rows per
   *  workspace. Managed collections get a per-tenant physical table so the name
   *  itself isolates, but adopted+tenant-scoped collections share one table and
   *  rely ENTIRELY on `tenant_id = $auth.tenantId` for isolation — every
   *  resolver below must AND in `gqlTenantWhere` exactly like the REST path's
   *  `tenantFilter`. Omitting it leaks rows across workspaces. */
  tenantScoped: boolean;
}

export interface GqlCtx {
  ctx: Ctx;
  auth: AuthSubject;
  /** Per-request L1 permission cache, threaded through every resolver so a
   *  single GraphQL query doesn't re-resolve the same (collection, action)
   *  pair across `list`/`get`/sub-selections. Populated by the GraphQL
   *  route via `getRequestPermCache(c)`. */
  permCache?: PermResolveCache;
  /** Parent Hono app + the original request — set only so the `runAgent`
   *  mutation can build an in-process sub-fetch (carrying the caller's
   *  identity) to execute the agent's allow-listed MCP tools, exactly like the
   *  REST route does. Absent on schema builds that never run an agent. */
  app?: Hono;
  rawRequest?: Request;
  /** Per-request batch loaders for to-one `relation` field resolution, keyed
   *  by TARGET collection slug. Coalesces the per-row `WHERE id = ?` lookups a
   *  list of N parents would otherwise fire (the classic GraphQL N+1) into one
   *  `WHERE id IN (…)` per target. MUST be per-request — never module-global —
   *  or one tenant's loader could serve another's rows. Lazily created. */
  relationLoaders?: Map<string, RelationLoader>;
}

/** A minimal DataLoader: `load(id)` queues the id, a microtask flushes the
 *  whole queue as one batched fetch, and same-id loads in a request dedupe. */
interface RelationLoader {
  load(id: string): Promise<unknown>;
}

export const JSONScalar = new GraphQLScalarType({
  name: "JSON",
  description:
    "Arbitrary JSON. Pass as a variable; inline literals not supported.",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: () => {
    throw new GraphQLError(
      "JSON literal not supported; pass as a variable instead.",
    );
  },
});

/**
 * A money value — `{ amount, currency }` on the way out, and on the way in
 * anything `parseMoneyInput` accepts.
 *
 * A scalar of its own rather than {@link JSONScalar}, which is what `geo` and
 * `relation_many` use, for one reason: JSON refuses inline literals outright, so
 * every GraphQL mutation touching a price would have to route it through a
 * variable. `price: 19.99` is the form a caller writes first and the form the
 * REST surface takes, and a schema that rejects it is stricter than the product
 * for no reason the caller can discover.
 *
 * Nothing is validated here. Parsing an amount needs the field's currency —
 * which a scalar does not have — so this only carries the literal through to
 * `canonicalizeMoneyForGql`, which does have the collection and the row.
 */
export const MoneyScalar = new GraphQLScalarType({
  name: "Money",
  description:
    'An amount and its currency: `{ amount: 19.99, currency: "USD" }` on read. ' +
    'On write, also a bare number (19.99), a decimal string, "19.99 USD", or ' +
    "`{ minor: 1999, currency }`. Amounts are in MAJOR units.",
  serialize: (v) => v,
  parseValue: (v) => v,
  parseLiteral: (ast) => {
    const read = (node: any): unknown => {
      switch (node.kind) {
        case "IntValue":
          return Number.parseInt(node.value, 10);
        case "FloatValue":
          return Number.parseFloat(node.value);
        case "StringValue":
          return node.value;
        case "NullValue":
          return null;
        case "ObjectValue": {
          const out: Record<string, unknown> = {};
          for (const f of node.fields) out[f.name.value] = read(f.value);
          return out;
        }
        default:
          throw new GraphQLError(
            `Money literal must be a number, a string, or an object — got ${node.kind}.`,
          );
      }
    };
    return read(ast);
  },
});

export const collectionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.collections : sqlite.schema.collections;

export const pascal = (s: string): string =>
  s.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());

export const camel = (s: string): string =>
  s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

const fieldScalar = (
  type: FieldType,
): GraphQLOutputType & GraphQLInputType => {
  switch (type) {
    case "text":
    case "longtext":
    case "uuid":
    case "timestamp":
      return GraphQLString;
    case "integer":
      return GraphQLInt;
    case "number":
      return GraphQLFloat;
    case "boolean":
      return GraphQLBoolean;
    case "json":
      return JSONScalar;
    case "relation":
    case "file":
      // Input + raw output (when target type isn't in registry): the foreign id.
      return GraphQLID;
    case "relation_many":
      // Array of foreign ids — exposed as a JSON list for now (avoids
      // tight typing complications with mutations until DataLoader lands).
      return JSONScalar;
    case "geo":
      // `{ lat, lng }`. JSON rather than a hand-written object type because the
      // INPUT side accepts four shapes (see `parseGeoPoint`) and a GraphQL
      // input object would accept exactly one of them — making the GraphQL
      // surface stricter than REST for no reason a caller could discover.
      return JSONScalar;
    case "money":
      // Its own scalar rather than JSON — see MoneyScalar for why an inline
      // `price: 19.99` has to keep working.
      return MoneyScalar;
    case "phone":
      // A plain String on both sides — the stored value IS a string, and the
      // input side accepts every form a human writes, which no stricter scalar
      // could express without making GraphQL pickier than REST for a value it
      // canonicalizes anyway.
      return GraphQLString;
    case "email":
      // A plain String on both sides, for the same reasons as `phone` — and it
      // MUST be here rather than falling off the end of the switch. A field type
      // with no mapping resolves to `undefined`, and GraphQL refuses to build a
      // schema containing one: not "that field is missing" but "the type of
      // ParEmail.email must be Output Type", which takes down every query and
      // mutation for the whole collection. The parity gate caught exactly that
      // on this branch's first run — the same class as the dropped field type
      // that once dark'd the endpoint outright.
      return GraphQLString;
    case "hash":
      // Write-only secret: accepted as a String on input, always resolves to
      // null on output (the digest never leaves the DB).
      return GraphQLString;
    case "divider":
    case "notice":
      // Presentational blocks never reach GraphQL — `loadCollection` strips them
      // before the schema builder sees the fields. This case only keeps the
      // switch exhaustive over `FieldType`; the value is never used.
      return GraphQLString;
  }
};

/**
 * Field types are read back from a JSON metadata blob that nothing re-validates,
 * so a collection written by an older build can name a type this one dropped.
 * `fieldScalar`'s switch is exhaustive over `FieldType` — which proves it
 * handles every type in the union, not that the value IS one. An unrecognised
 * type fell through and returned `undefined`, and since the schema is built
 * eagerly for the whole workspace, `new GraphQLNonNull(undefined)` threw at
 * BUILD time and took down every collection and every query, including
 * `__typename`. One legacy field, entire endpoint 500.
 *
 * Unknown types are surfaced as opaque JSON and always nullable: the data stays
 * reachable, and we make no promise about a column we can't interpret.
 */
const unknownTypeFallback = (f: FieldDef): GraphQLOutputType & GraphQLInputType | null =>
  isKnownFieldType(f.type) ? null : JSONScalar;

const fieldGqlType = (f: FieldDef): GraphQLOutputType => {
  // A `localized` field is exposed as its full `{locale: value}` map (JSON),
  // regardless of native type.
  if (isLocalized(f)) return JSONScalar;
  const fallback = unknownTypeFallback(f);
  if (fallback) return fallback;
  const t = fieldScalar(f.type);
  // A hash field always resolves to null on read (write-only), so it must stay
  // nullable on OUTPUT even when `required` — a NonNull wrapper would make every
  // row error. Required-ness is still enforced on the input side at write time.
  if (f.type === "hash") return t;
  return f.required ? new GraphQLNonNull(t) : t;
};

export const buildCollectionType = (
  collection: CollectionRow,
  collections: CollectionRow[],
  registry: Map<string, GraphQLObjectType>,
): GraphQLObjectType => {
  return new GraphQLObjectType({
    name: pascal(collection.slug),
    fields: () => {
      const fields: Record<
        string,
        {
          type: GraphQLOutputType;
          resolve?: GraphQLFieldConfig<unknown, GqlCtx>["resolve"];
        }
      > = {
        id: { type: new GraphQLNonNull(GraphQLID) },
        createdAt: { type: new GraphQLNonNull(GraphQLString) },
        updatedAt: { type: new GraphQLNonNull(GraphQLString) },
      };
      if (collection.ownerScoped) {
        fields.ownerId = { type: GraphQLString };
      }
      for (const f of collection.fields) {
        // Private / internal columns are never exposed on the read type.
        if (f.private) continue;
        if (f.type === "relation" && f.to) {
          const target = registry.get(f.to);
          const targetCollection = collections.find((c) => c.slug === f.to);
          if (target && targetCollection) {
            // Resolve the related row through the per-request batch loader so
            // a list of N parents fires ONE `WHERE id IN (…)` for this target
            // instead of N single-row lookups (the GraphQL N+1).
            const fieldKey = camel(f.name);
            fields[fieldKey] = {
              type: f.required ? new GraphQLNonNull(target) : target,
              resolve: (parent, _args, gqlCtx) => {
                const idValue = (parent as Record<string, unknown>)[fieldKey];
                if (!idValue || typeof idValue !== "string") return null;
                return getRelationLoader(gqlCtx, targetCollection).load(idValue);
              },
            };
            continue;
          }
        }
        fields[camel(f.name)] = { type: fieldGqlType(f) };
      }
      return fields;
    },
  });
};

export const buildInputType = (collection: CollectionRow): GraphQLInputObjectType => {
  return new GraphQLInputObjectType({
    name: `${pascal(collection.slug)}Input`,
    fields: () => {
      const fields: Record<string, { type: GraphQLInputType }> = {};
      for (const f of collection.fields) {
        // Auto-filled columns are read-only — not part of the write input.
        if (f.onCreate || f.onUpdate) continue;
        // All fields optional in input — server-side validates required-ness.
        // A `localized` field accepts a `{locale: value}` map (JSON).
        // Same untrusted-metadata guard as the output side — a type this build
        // doesn't know must not reach the exhaustive switch.
        fields[camel(f.name)] = {
          type: isLocalized(f) ? JSONScalar : (unknownTypeFallback(f) ?? fieldScalar(f.type)),
        };
      }
      // GraphQL requires at least one input field. A collection with no
      // user-defined fields would otherwise fail the entire schema build —
      // emit a placeholder field that's documented as "no-op".
      if (Object.keys(fields).length === 0) {
        fields._empty = {
          type: GraphQLBoolean,
        };
      }
      return fields;
    },
  });
};

/**
 * Storage encoding for a GraphQL write — the SHARED one, with a single
 * documented exception.
 *
 * This used to be a full second copy of `items/serialize`, and it went stale
 * the moment a field type was added: `geo` landed on the REST path, and here a
 * point reached the driver as a live object, which SQLite refuses to bind
 * ("Binding expected string, TypedArray, boolean, number, bigint or null") —
 * so every GraphQL create against a collection with a location 500'd. It is
 * delegated now so the next type cannot repeat that. `geo-surfaces.test.ts` is
 * the gate that caught it.
 *
 * The one deliberate difference is the Postgres timestamp. The REST encoder
 * emits an ISO string; this path has always handed the driver a `Date`, and the
 * GraphQL mutations are not covered by a Postgres-backed test, so quietly
 * changing what they bind is not a change this feature gets to make. Kept
 * explicit and narrow rather than by re-forking the whole function.
 */
const serialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => {
  if (value === undefined || value === null) return null;
  if (dialect === "pg" && type === "timestamp") {
    return value instanceof Date ? value : new Date(value as string | number);
  }
  return sharedSerialize(value, type, dialect);
};

const execute = async (ctx: Ctx, query: SQL): Promise<unknown> => {
  if (ctx.dialect === "pg") return (ctx.db as any).execute(query);
  return (ctx.db as any).run(query);
};

const fieldByCamel = (collection: CollectionRow, camelName: string): FieldDef | undefined =>
  collection.fields.find((f) => camel(f.name) === camelName);


/**
 * Run the shared auto-geocode over a GraphQL payload.
 *
 * The service speaks snake_case field names (it is the same one the REST write
 * path uses, and the field definitions are the source of both); GraphQL args
 * are camelCase. Rather than threading a key mapper through the geocode
 * service, build a snake-keyed view, let the service fill it, and copy back
 * only the points it derived — which also makes it obvious that nothing else
 * about the payload is being rewritten here.
 *
 * `stored` is the row as it exists now, for an update: a patch changing only
 * `city` still has to resolve against the `address` it did not mention.
 */
const gqlAutoGeocode = async (
  ctx: Ctx,
  collection: CollectionRow,
  data: Record<string, unknown>,
  stored?: Record<string, unknown>,
): Promise<void> => {
  if (!collection.fields.some((f) => f.type === "geo" && f.geo?.geocodeFrom?.length)) return;
  const patch: Record<string, unknown> = {};
  for (const f of collection.fields) {
    const v = data[camel(f.name)];
    if (v !== undefined) patch[f.name] = v;
  }
  const context = stored ? { ...stored, ...patch } : patch;
  await applyAutoGeocode(ctx, collection.fields, patch, context, {
    // On a create there is no "touched" question — every source column the
    // payload carries is new. On an update, only re-resolve when the patch
    // actually moved the address.
    ...(stored ? { touched: (f: FieldDef) => patchTouchesSources(f, patch) } : {}),
  });
  for (const f of collection.fields) {
    if (f.type !== "geo") continue;
    if (data[camel(f.name)] === undefined && patch[f.name] !== undefined) {
      data[camel(f.name)] = patch[f.name];
    }
  }
};

const validateInput = (
  inputData: Record<string, unknown>,
  collection: CollectionRow,
  perm: Awaited<ReturnType<typeof resolvePermission>>,
  partial: boolean,
): void => {
  for (const f of collection.fields) {
    // Auto-filled columns are system-managed — never required from the caller.
    // `localized` fields aren't required per-locale (parity with the REST path).
    if (f.onCreate || f.onUpdate || f.sequence || isLocalized(f)) continue;
    if (
      f.required &&
      !partial &&
      (inputData[camel(f.name)] === undefined ||
        inputData[camel(f.name)] === null)
    ) {
      throw new GraphQLError(`Field "${f.name}" is required`, {
        extensions: { code: "VALIDATION" },
      });
    }
  }
  for (const k of Object.keys(inputData)) {
    const f = fieldByCamel(collection, k);
    if (!f) {
      throw new GraphQLError(`Unknown field: ${k}`, {
        extensions: { code: "VALIDATION" },
      });
    }
    if (f.rollup) {
      throw new GraphQLError(
        `Field "${f.name}" is a rollup of "${f.rollup.from}" (read-only) — change the ${f.rollup.from} rows instead`,
        { extensions: { code: "VALIDATION" } },
      );
    }
    if (f.sequence) {
      throw new GraphQLError(
        `Field "${f.name}" is a sequence (server-issued, read-only) — drop it from your input`,
        { extensions: { code: "VALIDATION" } },
      );
    }
    if (f.onCreate || f.onUpdate) {
      throw new GraphQLError(`Field "${f.name}" is auto-filled (read-only)`, {
        extensions: { code: "VALIDATION" },
      });
    }
    if (perm.fields && !perm.fields.has(f.name)) {
      throw new GraphQLError(`No permission to write field "${k}"`, {
        extensions: { code: "FORBIDDEN" },
      });
    }
  }
  // Shape-check + canonicalize every point. This resolver never calls
  // `validateValue`, so without it a latitude of 91 would be stored verbatim
  // and read back by `_near` as nothing at all. Normalizing here (rather than
  // only in `serialize`) also means the hand-built response object and the
  // realtime event carry the same `{ lat, lng }` a re-read returns.
  try {
    validateAndNormalizeGeo(inputData, collection.fields, (f) => camel(f.name));
  } catch (e) {
    throw new GraphQLError((e as Error).message, { extensions: { code: "VALIDATION" } });
  }
};

/**
 * Resolve + canonicalize this mutation's money values, for the same reason
 * `validateAndNormalizeGeo` is called above and with a worse consequence if it
 * is not: these resolvers hand-build their own INSERT/UPDATE, so an amount that
 * was never paired with its currency reaches the driver either as a live object
 * — which SQLite refuses to bind, 500-ing every mutation on a collection with a
 * price — or as a number nothing scaled.
 *
 * Separate from {@link validateInput} because the update path can only do this
 * once it has loaded the row: a patch that sets `total` and not `currency` on a
 * multi-currency collection takes the currency from the row it is patching.
 */
const canonicalizeMoneyForGql = (
  inputData: Record<string, unknown>,
  collection: CollectionRow,
  existing: Record<string, unknown> | null,
): void => {
  try {
    if (existing) {
      assertCurrencyChangeIsSafe(inputData, collection.fields, existing, (f) => camel(f.name));
    }
    canonicalizeMoneyFields(inputData, collection.fields, {
      existing,
      keyOf: (f) => camel(f.name),
    });
    // Phone rides along for exactly the same reason and on exactly the same
    // schedule: this resolver never calls `validateValue`, so an un-canonical
    // number would be stored verbatim — leaving GraphQL the one surface that can
    // still put `0532 111 22 33` into a column every other surface guarantees is
    // E.164, and quietly breaking `unique`, lookup-by-number and SMS delivery
    // for rows written through it. Fourth field feature in a row where this
    // resolver needed the same fix (see #38–#41).
    canonicalizePhoneFields(inputData, collection.fields, {
      existing,
      keyOf: (f) => camel(f.name),
    });
    // Fifth in a row. Same resolver, same reason: without this, GraphQL is the
    // one surface that can put `Ada@Example.com` into a column every other
    // surface guarantees is folded — and `unique`, portal auto-link and
    // lookup-by-address all quietly stop working for rows written through it.
    canonicalizeEmailFields(inputData, collection.fields, {
      keyOf: (f) => camel(f.name),
    });
  } catch (e) {
    throw new GraphQLError((e as Error).message, { extensions: { code: "VALIDATION" } });
  }
};

/**
 * Run a check that speaks `AppError` inside a resolver that speaks
 * `GraphQLError`, preserving the code so the two surfaces refuse with the same
 * words and the same classification.
 */
const asGqlError = <T>(fn: () => T): T => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

const queryAll = async <T>(ctx: Ctx, query: SQL): Promise<T[]> => {
  if (ctx.dialect === "pg") {
    const r = (await (ctx.db as any).execute(query)) as unknown;
    if (Array.isArray(r)) return r as T[];
    if (r && typeof r === "object" && "rows" in r) return (r as { rows: T[] }).rows;
    return r as T[];
  }
  return (await (ctx.db as any).all(query)) as T[];
};

/**
 * Read decoding for a GraphQL row — the shared one, for the same reason
 * {@link serialize} is: a second copy is a second thing to remember. Hashed
 * secrets read back as null and points parse out of their stored JSON because
 * `items/deserialize` does both, not because this file repeats them.
 */
const deserialize = (
  value: unknown,
  type: FieldType,
  dialect: "pg" | "sqlite",
): unknown => sharedDeserialize(value, type, dialect);

const renderRow = (
  row: Record<string, unknown>,
  fields: FieldDef[],
  dialect: "pg" | "sqlite",
  ownerScoped: boolean,
  hasCreatedAt = true,
  hasUpdatedAt = true,
  /** Read field allow-list from the caller's permission grant. When non-null,
   *  only these field names are rendered — mirrors REST's `projectFields` so the
   *  GraphQL read path enforces the same field-level ACL (system keys id/
   *  createdAt/updatedAt/ownerId are always kept). A dropped relation FK also
   *  makes its nested resolver return null, since the parent loses that key. */
  allowedFields: Set<string> | null = null,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { id: row.id };
  if (hasCreatedAt) out.createdAt = deserialize(row.created_at, "timestamp", dialect);
  if (hasUpdatedAt) out.updatedAt = deserialize(row.updated_at, "timestamp", dialect);
  if (ownerScoped) out.ownerId = row.owner_id ?? null;
  for (const f of fields) {
    if (f.private) continue;
    if (allowedFields && !allowedFields.has(f.name)) continue;
    // Localized fields live in the sidecar, not on this base row — attached
    // separately by `attachLocalizedMaps` after the row set is fetched.
    if (isLocalized(f)) continue;
    // `deserializeField`, not `deserialize` — a money column's value is a
    // function of the ROW (its currency may be in a sibling column), and this
    // surface builds its own rows rather than going through `deserializeRow`.
    out[camel(f.name)] = deserializeField(row[f.name], f, dialect, row, fields);
  }
  return out;
};

/**
 * Attach `localized` fields as full `{locale: value}` maps (camelCase keys) onto
 * already-rendered GraphQL rows, batch-loading the sidecar for all ids in one
 * query. GraphQL always surfaces the full map (no per-locale projection), the full per-locale map.
 */
const attachLocalizedMaps = async (
  ctx: Ctx,
  collection: CollectionRow,
  baseRows: Array<Record<string, unknown>>,
  rendered: Array<Record<string, unknown>>,
  allowedFields: Set<string> | null = null,
): Promise<void> => {
  const defs = sidecarFields(collection.fields).filter(
    (f) => !f.private && (!allowedFields || allowedFields.has(f.name)),
  );
  if (defs.length === 0 || baseRows.length === 0) return;
  const ids = baseRows.map((r) => String(r.id));
  const byRow = await loadSidecarForRows(ctx, collection.physicalTable, ids, defs);
  for (let i = 0; i < baseRows.length; i++) {
    const sidecarRows = byRow.get(String(baseRows[i]!.id)) ?? [];
    const out = rendered[i]!;
    for (const f of defs) {
      const map: Record<string, unknown> = {};
      for (const r of sidecarRows) map[r.locale as string] = deserialize(r[f.name], f.type, ctx.dialect);
      out[camel(f.name)] = map;
    }
  }
};

/** Split a camelCase GraphQL input into a snake-keyed patch of just the
 *  `localized` fields (values are `{locale: value}` maps), for the sidecar
 *  write. Removes those keys from `data` so the base INSERT/UPDATE skips them. */
const takeLocalizedInput = (
  data: Record<string, unknown>,
  fields: FieldDef[],
): Record<string, unknown> => {
  const patch: Record<string, unknown> = {};
  for (const f of fields) {
    if (!isLocalized(f)) continue;
    const key = camel(f.name);
    if (!(key in data)) continue;
    patch[f.name] = data[key];
    delete data[key];
  }
  return patch;
};

const buildOrderClause = (
  sortStr: string | undefined,
  collection: CollectionRow,
): SQL => {
  // Default sort needs a column that exists: created_at when the collection
  // has it, otherwise the primary key (timestamps-off collections).
  const fallback = collection.hasCreatedAt
    ? sql`ORDER BY ${sql.identifier("created_at")} DESC`
    : sql`ORDER BY ${sql.identifier(collection.pkColumn)} DESC`;
  if (!sortStr) return fallback;
  // Allow-list of sortable columns: system columns + the collection's own
  // fields. An unknown column is dropped rather than spliced into the query —
  // this stops ORDER BY against columns outside the schema (a 500 / probing
  // oracle) even though `sql.identifier` already prevents SQL break-out.
  const sortable = new Set<string>([
    "id",
    collection.pkColumn,
    ...(collection.hasCreatedAt ? ["created_at"] : []),
    ...(collection.hasUpdatedAt ? ["updated_at"] : []),
    // Versioned collections can order by publish date / status (REST parity).
    ...(collection.versioned ? ["_status", "_published_at", "_publish_at", "_unpublish_at"] : []),
    ...collection.fields.map((f) => f.name),
  ]);
  const parts = sortStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const dir: "ASC" | "DESC" = s.startsWith("-") ? "DESC" : "ASC";
      const field = s.replace(/^[-+]/, "");
      if (!sortable.has(field)) return null;
      return sql`${sql.identifier(field)} ${sql.raw(dir)}`;
    })
    .filter((x): x is SQL => x != null);
  return parts.length === 0 ? fallback : sql`ORDER BY ${sql.join(parts, sql`, `)}`;
};

/** Tenant-isolation predicate, mirroring the REST `tenantFilter`. Returns null
 *  for non-tenant-scoped collections (the physical table name already isolates,
 *  or it's legacy/system data); `(1=0)` when scoped but the caller has no
 *  tenant (fail-closed). Every read/write resolver AND-s this into its WHERE so
 *  GraphQL never depends on `perm.whereSql` alone for cross-tenant isolation. */
const gqlTenantWhere = (
  collection: CollectionRow,
  auth: AuthSubject,
): SQL | null => {
  if (!collection.tenantScoped) return null;
  if (!auth.tenantId) return sql`(1=0)`;
  return sql`${sql.identifier("tenant_id")} = ${auth.tenantId}`;
};

const denyOrThrow = (auth: AuthSubject, slug: string) => {
  throw new GraphQLError(
    auth.userId
      ? `No read permission for ${slug}`
      : "Sign in required",
    { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
  );
};

/** Published-only filter for versioned collections unless the caller can see
 *  drafts (admin or holds publish/update). Mirrors the REST `draftFilter`.
 *  GraphQL has no `?status` param, so privileged callers see all (and can still
 *  filter on `_status` via the query filter DSL). */
const gqlDraftWhere = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  perm: { isAdmin?: boolean },
): Promise<SQL | null> => {
  if (!collection.versioned) return null;
  if (perm.isAdmin) return null;
  const { ctx, auth, permCache } = gqlCtx;
  const canSee =
    (await resolvePermission(ctx, auth, collection.slug, "publish", permCache)).allowed ||
    (await resolvePermission(ctx, auth, collection.slug, "update", permCache)).allowed;
  return canSee ? null : sql`${sql.identifier("_status")} = 'published'`;
};

export const listResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { filter?: Condition; sort?: string; limit?: number; offset?: number },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) denyOrThrow(auth, collection.slug);

  const table = collection.physicalTable;
  // Normalize the same accepted input shapes as REST (`_and` aliases,
  // nested-object relation filters, implicit-equality) before compiling.
  const relationFields = new Set(
    collection.fields
      .filter((f) => f.type === "relation" || f.type === "relation_many")
      .map((f) => f.name),
  );
  const userWhere = args.filter
    ? compileCondition(
        // `_overlaps` / `_covers` are expanded into the comparisons they stand
        // for BEFORE compiling, exactly as the REST list does. Without it this
        // surface would compile `_overlaps` as an unknown operator on the start
        // column — silently matching everything, since a comparison object with
        // no recognised operator returns TRUE.
        // …and then the timestamp operands into the form the column holds —
        // LAST, so the comparisons the expansion just emitted are coerced too.
        // Without this the expansion is correct and the comparison still is
        // not: an ISO string reaches SQLite as TEXT against an INTEGER column,
        // where every number sorts before every string, so the filter answers
        // backwards. Caught by the parity gate, which is the fifth feature
        // running where this resolver needed the fix REST already had.
        normalizeTemporalOperands(
          expandRangeOperators(
            normalizeCondition(args.filter, { relationFields }),
            rangeFieldsOf(collection.fields),
          ),
          collection.fields,
          ctx.dialect,
        ),
        auth,
        undefined,
        undefined,
        { dialect: ctx.dialect },
      )
    : null;
  // Hide soft-deleted rows (column is always `deleted_at`; managed-only).
  const deletedWhere = collection.softDelete
    ? sql`${sql.identifier("deleted_at")} IS NULL`
    : null;
  const draftWhere = await gqlDraftWhere(gqlCtx, collection, perm);
  const wheres = [
    gqlTenantWhere(collection, auth),
    userWhere,
    perm.whereSql,
    deletedWhere,
    draftWhere,
  ].filter((x): x is SQL => x != null);
  const whereClause = wheres.length
    ? sql`WHERE ${sql.join(wheres, sql` AND `)}`
    : sql``;
  const orderClause = buildOrderClause(args.sort, collection);
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  const offset = Math.max(0, args.offset ?? 0);

  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} ${whereClause} ${orderClause} LIMIT ${limit} OFFSET ${offset}`,
  );
  const rendered = rows.map((r) =>
    renderRow(
      r,
      collection.fields,
      ctx.dialect,
      !!collection.ownerScoped,
      collection.hasCreatedAt,
      collection.hasUpdatedAt,
      perm.fields,
    ),
  );
  await attachLocalizedMaps(ctx, collection, rows, rendered, perm.fields);
  return rendered;
};

/**
 * Build a per-request batch loader for one target collection. Every `.load(id)`
 * call within the same microtask is coalesced into a single
 * `SELECT * … WHERE id IN (…)`, applying the EXACT same gates as {@link
 * getResolver} (read permission, tenant scope, row-level `perm.whereSql`,
 * soft-delete, draft visibility, field projection) — only the round-trip count
 * changes. This kills the N+1 a query like `{ posts { author { name } } }`
 * would otherwise cause (one author lookup per post).
 */
const makeRelationLoader = (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
): RelationLoader => {
  type Pending = {
    id: string;
    resolve: (v: unknown) => void;
    reject: (e: unknown) => void;
  };
  let queue: Pending[] = [];
  let scheduled = false;
  // Dedupe identical ids within a request: the promise is cached so the same
  // FK referenced by many parents resolves once.
  const cache = new Map<string, Promise<unknown>>();

  const flush = async () => {
    const batch = queue;
    queue = [];
    scheduled = false;
    try {
      const { ctx, auth, permCache } = gqlCtx;
      const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
      if (!perm.allowed) denyOrThrow(auth, collection.slug); // always throws
      const ids = [...new Set(batch.map((b) => b.id))];
      const table = collection.physicalTable;
      const wheres: SQL[] = [
        sql`${sql.identifier("id")} IN (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      ];
      const tenantWhere = gqlTenantWhere(collection, auth);
      if (tenantWhere) wheres.push(tenantWhere);
      if (perm.whereSql) wheres.push(perm.whereSql);
      if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
      const draftWhere = await gqlDraftWhere(gqlCtx, collection, perm);
      if (draftWhere) wheres.push(draftWhere);
      const rows = await queryAll<Record<string, unknown>>(
        ctx,
        sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)}`,
      );
      const byId = new Map<string, unknown>();
      for (const r of rows) {
        byId.set(
          String(r.id),
          renderRow(
            r,
            collection.fields,
            ctx.dialect,
            !!collection.ownerScoped,
            collection.hasCreatedAt,
            collection.hasUpdatedAt,
            perm.fields,
          ),
        );
      }
      // A row filtered out by permission/tenant/draft simply isn't in the map →
      // null, exactly as the single-row getResolver would return.
      for (const item of batch) item.resolve(byId.get(item.id) ?? null);
    } catch (e) {
      for (const item of batch) item.reject(e);
    }
  };

  return {
    load: (id: string) => {
      const hit = cache.get(id);
      if (hit) return hit;
      const p = new Promise<unknown>((resolve, reject) => {
        queue.push({ id, resolve, reject });
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      });
      cache.set(id, p);
      return p;
    },
  };
};

const getRelationLoader = (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
): RelationLoader => {
  const loaders = (gqlCtx.relationLoaders ??= new Map());
  let loader = loaders.get(collection.slug);
  if (!loader) {
    loader = makeRelationLoader(gqlCtx, collection);
    loaders.set(collection.slug, loader);
  }
  return loader;
};

export const getResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  id: string,
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) denyOrThrow(auth, collection.slug);

  const table = collection.physicalTable;
  const wheres: SQL[] = [sql`${sql.identifier("id")} = ${id}`];
  const tenantWhere = gqlTenantWhere(collection, auth);
  if (tenantWhere) wheres.push(tenantWhere);
  if (perm.whereSql) wheres.push(perm.whereSql);
  if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
  const draftWhere = await gqlDraftWhere(gqlCtx, collection, perm);
  if (draftWhere) wheres.push(draftWhere);
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
  );
  if (!rows[0]) return null;
  const out = renderRow(
    rows[0],
    collection.fields,
    ctx.dialect,
    !!collection.ownerScoped,
    collection.hasCreatedAt,
    collection.hasUpdatedAt,
    perm.fields,
  );
  await attachLocalizedMaps(ctx, collection, [rows[0]], [out], perm.fields);
  return out;
};

/**
 * Restate any rollup column that summarises this collection, for the parents
 * this write touched.
 *
 * These resolvers hand-build their own SQL rather than going through
 * `performCreate`/`performUpdate`, so the refresh the REST write core emits has
 * to be repeated here — the one thing a second write path always forgets. The
 * gate that catches it is `rollup-surfaces.test.ts`; it caught exactly this.
 *
 * The row keys are translated back to snake_case first: everything on the
 * GraphQL side is camelCase, and the rollup spec names real columns.
 */
const gqlRollupRefresh = async (
  ctx: Ctx,
  collection: CollectionRow,
  tenantId: string | null | undefined,
  change: { before?: Record<string, unknown>; after?: Record<string, unknown>; always?: boolean },
): Promise<void> => {
  const snake = (row: Record<string, unknown> | undefined) => {
    if (!row) return undefined;
    const out: Record<string, unknown> = {};
    for (const f of collection.fields) {
      const v = row[camel(f.name)] ?? row[f.name];
      if (v !== undefined) out[f.name] = v;
    }
    return out;
  };
  const stmts = await rollupRefreshStatements(ctx, collection, tenantId, {
    ...(change.before ? { before: snake(change.before)! } : {}),
    ...(change.after ? { after: snake(change.after)! } : {}),
    ...(change.always ? { always: true } : {}),
  });
  for (const stmt of stmts) await execute(ctx, stmt);
};

export const createResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { data: Record<string, unknown> },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "create", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No create permission for ${collection.slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  validateInput(args.data, collection, perm, false);
  canonicalizeMoneyForGql(args.data, collection, null);
  // Hash `hash`-typed fields (keyed by the camelCase GraphQL input name) before
  // they hit the INSERT — same shared transform the REST write path uses.
  await hashIncomingFields(args.data, collection.fields, (f) => camel(f.name));
  // Pull `localized` fields out of the (camelCase) input into a snake-keyed
  // patch of `{locale: value}` maps; the base INSERT below then skips them.
  const localizedPatch = takeLocalizedInput(args.data, collection.fields);
  // Snapshot the maps for the response echo — `splitLocalized` mutates
  // `localizedPatch` (deletes its keys) when building the sidecar writes.
  const localizedEcho = { ...localizedPatch };

  const table = collection.physicalTable;

  // Singleton: reject when a live row already exists (scoped by tenant + the
  // caller's read permission, ignoring soft-deleted rows).
  if (collection.singleton) {
    const guardWheres = [
      gqlTenantWhere(collection, auth),
      perm.whereSql,
      collection.softDelete ? sql`${sql.identifier("deleted_at")} IS NULL` : null,
    ].filter((x): x is SQL => x != null);
    const guardClause = guardWheres.length
      ? sql`WHERE ${sql.join(guardWheres, sql` AND `)}`
      : sql``;
    const existingOne = await queryAll<{ one: number }>(
      ctx,
      sql`SELECT 1 AS one FROM ${sql.identifier(table)} ${guardClause} LIMIT 1`,
    );
    if (existingOne[0]) {
      throw new GraphQLError(
        "This collection is a singleton and already has a row",
        { extensions: { code: "VALIDATION" } },
      );
    }
  }

  // A lifecycle field's `initial` list — the one question a create can ask of
  // it. Repeated here because this resolver hand-builds its INSERT rather than
  // calling `performCreate`; `transition-surfaces.test.ts` is the gate.
  asGqlError(() => assertInitialStates(collection.fields, args.data, (f) => camel(f.name)));

  const id = crypto.randomUUID();
  const now = ctx.dialect === "pg" ? new Date() : Date.now();

  const cols: string[] = ["id"];
  const vals: unknown[] = [id];
  if (collection.hasCreatedAt) {
    cols.push("created_at");
    vals.push(now);
  }
  if (collection.hasUpdatedAt) {
    cols.push("updated_at");
    vals.push(now);
  }
  if (collection.ownerScoped) {
    cols.push("owner_id");
    vals.push(auth.userId);
  }
  // Stamp tenant_id on tenant-scoped (incl. adopted shared) tables so the row
  // is owned by the caller's workspace — mirrors the REST write path. Without
  // this a GraphQL-created row would be tenant-less and invisible/leaky.
  if (collection.tenantScoped) {
    if (!auth.tenantId) {
      throw new GraphQLError("No tenant context for a tenant-scoped collection", {
        extensions: { code: "FORBIDDEN" },
      });
    }
    cols.push("tenant_id");
    vals.push(auth.tenantId);
  }
  // Derive a point from the address columns before the INSERT is built —
  // another thing the REST write core does that this hand-built resolver has to
  // repeat or the feature only ships on one surface. `geo-surfaces.test.ts` is
  // the gate.
  await gqlAutoGeocode(ctx, collection, args.data);
  for (const f of collection.fields) {
    if (f.onCreate || f.sequence) continue; // system-managed, injected below
    const v = args.data[camel(f.name)];
    if (v === undefined) continue;
    cols.push(f.name);
    vals.push(serializeField(v, f, ctx.dialect));
  }
  // Auto-filled columns are computed + written server-side (client input was
  // rejected by validateInput) — mirrors the REST write path.
  for (const f of collection.fields) {
    if (!f.onCreate) continue;
    const v = resolveAutoFill(f.onCreate, { now, userId: auth.userId, tenantId: auth.tenantId });
    if (v === undefined) continue;
    const stored = serialize(v, f.type, ctx.dialect);
    cols.push(f.name);
    vals.push(stored);
    args.data[camel(f.name)] = deserialize(stored, f.type, ctx.dialect);
  }
  // Sequence columns. Repeated here for the same reason the rollup refresh is:
  // this resolver hand-builds its INSERT instead of calling `performCreate`, so
  // anything the REST write core does on the way in has to be done twice or it
  // only ships on one surface. `sequence-surfaces.test.ts` is the gate.
  const seqFields = sequenceFieldsOf(collection.fields);
  if (seqFields.length > 0) {
    const issued = await nextSequenceValues(
      ctx,
      auth.tenantId,
      collection.slug,
      seqFields,
      new Date(),
    );
    for (const [name, value] of Object.entries(issued)) {
      cols.push(name);
      vals.push(value);
      args.data[camel(name)] = value;
    }
  }
  const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
  const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
  await execute(
    ctx,
    sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES (${valSql})`,
  );
  // Translations sidecar: one INSERT per locale (no conflict on a fresh row).
  const createSplit = splitLocalized(localizedPatch, collection.fields, null);
  if (createSplit.localePatches.size > 0) {
    const byName = new Map(collection.fields.map((f) => [f.name, f]));
    for (const [loc, fieldMap] of createSplit.localePatches) {
      await execute(ctx, sidecarInsert(table, id, loc, fieldMap, byName, ctx.dialect));
    }
  }
  await gqlRollupRefresh(ctx, collection, auth.tenantId, { after: args.data, always: true });
  // Digest persisted — scrub it from the input before it feeds the hand-built
  // response `out` and the realtime event.
  scrubHashFields(args.data, collection.fields, (f) => camel(f.name));

  const nowIso =
    ctx.dialect === "pg"
      ? (now as Date).toISOString()
      : new Date(now as number).toISOString();
  const out: Record<string, unknown> = { id };
  if (collection.hasCreatedAt) out.createdAt = nowIso;
  if (collection.hasUpdatedAt) out.updatedAt = nowIso;
  if (collection.ownerScoped) out.ownerId = auth.userId;
  for (const f of collection.fields) {
    if (f.private) continue;
    // Localized fields: echo the input maps (snapshot taken before the split).
    if (isLocalized(f)) {
      out[camel(f.name)] = localizedEcho[f.name] ?? {};
      continue;
    }
    const v = args.data[camel(f.name)];
    out[camel(f.name)] = v ?? null;
  }
  await publishEvent(
    ctx.env,
    `items:${collection.slug}`,
    { event: "created", data: out },
    { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
  );
  return out;
};

export const updateResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { id: string; data: Record<string, unknown> },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "update", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No update permission for ${collection.slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  validateInput(args.data, collection, perm, true);
  // Hash `hash`-typed fields; empty/omitted values are dropped so the existing
  // digest survives. The re-SELECT + renderRow below re-reads from the DB and
  // masks hash columns to null, so no explicit scrub of the response is needed.
  await hashIncomingFields(args.data, collection.fields, (f) => camel(f.name));
  // Pull `localized` fields out for the sidecar upsert; base UPDATE skips them.
  const localizedPatch = takeLocalizedInput(args.data, collection.fields);

  const table = collection.physicalTable;
  const wheres: SQL[] = [sql`${sql.identifier("id")} = ${args.id}`];
  const tenantWhere = gqlTenantWhere(collection, auth);
  if (tenantWhere) wheres.push(tenantWhere);
  if (perm.whereSql) wheres.push(perm.whereSql);
  if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
  );
  if (!existing[0]) {
    throw new GraphQLError("Item not found", { extensions: { code: "NOT_FOUND" } });
  }

  // Lifecycle check, before the staged branch for the same reason the REST path
  // puts it there: a staged move must be refused when it is queued, not when
  // someone else publishes it. The merged row is built with SNAKE keys because
  // `requires` names fields, and the stored row is what it is being read from.
  const mergedForTransitions: Record<string, unknown> = { ...(existing[0] as Record<string, unknown>) };
  for (const f of collection.fields) {
    const v = args.data[camel(f.name)];
    if (v !== undefined) mergedForTransitions[f.name] = v;
  }
  const transitions = asGqlError(() =>
    assertTransitions({
      fields: collection.fields,
      before: existing[0] as Record<string, unknown>,
      patch: args.data,
      merged: mergedForTransitions,
      roles: auth.roles,
      keyOf: (f) => camel(f.name),
    }),
  );

  // Staged-edits interception — REST-parity (see performUpdate). On a
  // `stagedEdits` collection, updating a *published* row folds the (validated,
  // hashed) patch into the item's staged JSON patch instead of the live row;
  // the next publish applies it. Values are stored REST-shaped (snake field
  // names; localized fields as `{locale: value}` maps).
  if (
    collection.versioned &&
    collection.stagedEdits &&
    (existing[0] as Record<string, unknown>)._status === "published"
  ) {
    const stagedPatch: Record<string, unknown> = {};
    for (const f of collection.fields) {
      if (f.onUpdate) continue;
      const v = args.data[camel(f.name)];
      if (v !== undefined) stagedPatch[f.name] = v;
    }
    const locSplit = splitLocalized(localizedPatch, collection.fields, null);
    for (const [loc, fieldMap] of locSplit.localePatches) {
      for (const [fname, v] of Object.entries(fieldMap)) {
        const prev = stagedPatch[fname];
        stagedPatch[fname] = {
          ...(prev && typeof prev === "object" && !Array.isArray(prev)
            ? (prev as Record<string, unknown>)
            : {}),
          [loc]: v,
        };
      }
    }
    for (const name of locSplit.clearAll) stagedPatch[name] = null;
    const existingStaged = await getStagedRow(ctx, collection, args.id);
    const mergedStaged = { ...(existingStaged?.data ?? {}), ...stagedPatch };
    await execute(
      ctx,
      stagedUpsertSql(
        ctx.dialect,
        collection.id,
        args.id,
        auth.tenantId ?? null,
        mergedStaged,
        auth.userId,
      ),
    );
    // Respond with the (unchanged) live row rendered through the caller's
    // read allow-list, previewing the staged values on top — mirrors the
    // REST staged response.
    const readPermStaged = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
    const outStaged = renderRow(
      existing[0]!,
      collection.fields,
      ctx.dialect,
      !!collection.ownerScoped,
      collection.hasCreatedAt,
      collection.hasUpdatedAt,
      readPermStaged.allowed ? readPermStaged.fields : new Set<string>(),
    );
    const view = stagedViewOf(mergedStaged, collection.fields);
    for (const f of collection.fields) {
      if (f.name in view && !isLocalized(f)) {
        if (readPermStaged.allowed && readPermStaged.fields && !readPermStaged.fields.has(f.name)) continue;
        outStaged[camel(f.name)] = view[f.name];
      }
    }
    await attachLocalizedMaps(
      ctx,
      collection,
      [existing[0]!],
      [outStaged],
      readPermStaged.allowed ? readPermStaged.fields : new Set<string>(),
    );
    return outStaged;
  }

  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  // Only stamp updated_at when the collection has it; skip the UPDATE entirely
  // if there's nothing to set (no timestamp + no changed fields → empty SET).
  const sets: SQL[] = collection.hasUpdatedAt
    ? [sql`${sql.identifier("updated_at")} = ${now}`]
    : [];
  // Same as create, with the stored row supplying the address columns the
  // patch did not mention.
  await gqlAutoGeocode(ctx, collection, args.data, existing[0] as Record<string, unknown>);
  // Deferred until here for the row's currency — see canonicalizeMoneyForGql.
  canonicalizeMoneyForGql(args.data, collection, existing[0] as Record<string, unknown>);
  for (const f of collection.fields) {
    if (f.onUpdate) continue; // system-managed, injected below
    const v = args.data[camel(f.name)];
    if (v === undefined) continue;
    sets.push(sql`${sql.identifier(f.name)} = ${serializeField(v, f, ctx.dialect)}`);
  }
  // Auto-filled-on-update columns — computed + written server-side. The re-
  // SELECT below reflects them in the response, so no args.data mutation.
  for (const f of collection.fields) {
    if (!f.onUpdate) continue;
    const v = resolveAutoFill(f.onUpdate, { now, userId: auth.userId, tenantId: auth.tenantId });
    if (v === undefined) continue;
    sets.push(sql`${sql.identifier(f.name)} = ${serializeField(v, f, ctx.dialect)}`);
  }
  if (sets.length > 0) {
    await execute(
      ctx,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} WHERE ${sql.join(wheres, sql` AND `)}`,
    );
  }
  // Translations sidecar: upsert each touched locale (other locales preserved).
  const updSplit = splitLocalized(localizedPatch, collection.fields, null);
  if (updSplit.localePatches.size > 0) {
    const byName = new Map(collection.fields.map((f) => [f.name, f]));
    for (const [loc, fieldMap] of updSplit.localePatches) {
      await execute(ctx, sidecarUpsert(table, args.id, loc, fieldMap, byName, ctx.dialect));
    }
  }

  await gqlRollupRefresh(ctx, collection, auth.tenantId, {
    before: existing[0]!,
    after: args.data,
  });

  const refreshed = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.identifier("id")} = ${args.id} LIMIT 1`,
  );
  // Full (unprojected) row feeds the realtime event — the event renderer
  // re-projects per subscriber's own read allow-list downstream.
  const refreshedRow = renderRow(
    refreshed[0]!,
    collection.fields,
    ctx.dialect,
    !!collection.ownerScoped,
    collection.hasCreatedAt,
    collection.hasUpdatedAt,
  );
  await attachLocalizedMaps(ctx, collection, [refreshed[0]!], [refreshedRow]);
  await publishEvent(
    ctx.env,
    `items:${collection.slug}`,
    { event: "updated", data: refreshedRow },
    { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
  );
  // Lifecycle moves reach the automation plane only — see the same loop in
  // `performUpdate` for why this is not a second trip round the realtime bus.
  for (const t of transitions) {
    dispatchEventHandlers(
      ctx.env,
      `items:${collection.slug}`,
      {
        event: transitionEventName(t),
        data: refreshedRow,
        before: existing[0] as Record<string, unknown>,
      },
      { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
    );
  }
  // The value returned to the mutating caller must respect their READ field
  // allow-list (the `update` grant may permit writing fields they can't read).
  // Mirrors REST, which renders mutation responses through the read projection.
  const readPerm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  const out = renderRow(
    refreshed[0]!,
    collection.fields,
    ctx.dialect,
    !!collection.ownerScoped,
    collection.hasCreatedAt,
    collection.hasUpdatedAt,
    readPerm.allowed ? readPerm.fields : new Set<string>(),
  );
  await attachLocalizedMaps(
    ctx,
    collection,
    [refreshed[0]!],
    [out],
    readPerm.allowed ? readPerm.fields : new Set<string>(),
  );
  return out;
};

export const deleteResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { id: string },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "delete", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No delete permission for ${collection.slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  const table = collection.physicalTable;
  const wheres: SQL[] = [sql`${sql.identifier("id")} = ${args.id}`];
  const tenantWhere = gqlTenantWhere(collection, auth);
  if (tenantWhere) wheres.push(tenantWhere);
  if (perm.whereSql) wheres.push(perm.whereSql);
  // Already-soft-deleted rows are a clean "not found" (idempotent).
  if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);

  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
  );
  if (!existing[0]) {
    throw new GraphQLError("Item not found", { extensions: { code: "NOT_FOUND" } });
  }
  const oldRow = renderRow(
    existing[0],
    collection.fields,
    ctx.dialect,
    !!collection.ownerScoped,
    collection.hasCreatedAt,
    collection.hasUpdatedAt,
  );
  if (collection.softDelete) {
    const now = ctx.dialect === "pg" ? new Date() : Date.now();
    await execute(
      ctx,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier("deleted_at")} = ${now} WHERE ${sql.join(wheres, sql` AND `)}`,
    );
  } else {
    await execute(
      ctx,
      sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.join(wheres, sql` AND `)}`,
    );
    // Hard delete: drop the row's sidecar translations too (no FK cascade on
    // SQLite/D1). Mirrors the REST delete path.
    if (sidecarFields(collection.fields).length > 0) {
      await execute(ctx, sidecarDeleteRow(table, args.id));
    }
  }
  // Deleting the row obsoletes any staged patch — mirrors the REST delete path.
  if (collection.versioned) {
    await execute(ctx, stagedDeleteSql(collection.id, args.id));
  }
  await gqlRollupRefresh(ctx, collection, auth.tenantId, { before: existing[0]!, always: true });
  // App-layer ON DELETE relational triggers — mirrors the REST delete path.
  const touched = await enforceOnDeleteTriggers(ctx, auth.tenantId, collection.slug, args.id, (stmt) =>
    execute(ctx, stmt).then(() => undefined),
  );
  // Those triggers move rows set-wise and can't name the parents they hit, so
  // anything rolling up over a collection they touched is restated wholesale.
  for (const slug of touched) {
    for (const stmt of await rollupRefreshAllStatements(ctx, auth.tenantId, slug)) {
      await execute(ctx, stmt);
    }
  }
  await publishEvent(
    ctx.env,
    `items:${collection.slug}`,
    { event: "deleted", data: oldRow },
    { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: auth.tenantId ?? null },
  );
  return true;
};

/**
 * `<collection>Transitions(id)` — the read half of the lifecycle feature.
 *
 * Scoped exactly like the REST twin: the row is fetched through the caller's
 * own read permission (condition, tenant, soft delete), so someone who cannot
 * read a row does not learn its status from the endpoint that explains its next
 * moves. The offer itself comes from the shared `describeTransitions`, not from
 * a second copy of the rules — the whole point of putting the decision in
 * `@backlex/db/transitions` is that every surface answers identically.
 */
export const transitionsResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  id: string,
): Promise<unknown> => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No read permission for ${collection.slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  const wheres: SQL[] = [sql`${sql.identifier("id")} = ${id}`];
  const tenantWhere = gqlTenantWhere(collection, auth);
  if (tenantWhere) wheres.push(tenantWhere);
  if (perm.whereSql) wheres.push(perm.whereSql);
  if (collection.softDelete) wheres.push(sql`${sql.identifier("deleted_at")} IS NULL`);
  const rows = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(collection.physicalTable)} WHERE ${sql.join(wheres, sql` AND `)} LIMIT 1`,
  );
  if (!rows[0]) {
    throw new GraphQLError("Item not found", { extensions: { code: "NOT_FOUND" } });
  }
  return describeTransitions(collection.fields, rows[0], auth.roles, perm.fields);
};

export const verifyResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { id: string; field: string; value: string },
): Promise<boolean> => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) {
    throw new GraphQLError(
      auth.userId ? `No read permission for ${collection.slug}` : "Sign in required",
      { extensions: { code: auth.userId ? "FORBIDDEN" : "UNAUTHORIZED" } },
    );
  }
  // Reuse the ONE shared verify service (rate-limit + audit live there). It
  // works on the items `CollectionRow`, so re-load the collection through the
  // items loader rather than passing GraphQL's structurally-different row.
  const loaded = await loadCollection(ctx, auth.tenantId ?? undefined, collection.slug);
  try {
    return await verifyHashField(
      ctx,
      loaded,
      { userId: auth.userId, tenantId: auth.tenantId ?? null, roles: auth.roles },
      { whereSql: perm.whereSql, fields: perm.fields },
      args.id,
      args.field,
      args.value,
    );
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/** Shared result type for `batch<Collection>` mutations. `results` entries are
 *  JSON `{ index, op, ok, id?, data?, error? }` — heterogeneous, so a scalar. */
export const BatchResultType = new GraphQLObjectType({
  name: "BatchResult",
  fields: {
    atomic: { type: new GraphQLNonNull(GraphQLBoolean) },
    total: { type: new GraphQLNonNull(GraphQLInt) },
    succeeded: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
    results: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(JSONScalar))) },
  },
});

const normalizeBatchOps = (raw: unknown): BatchOp[] => {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new GraphQLError("operations must be a non-empty array", {
      extensions: { code: "VALIDATION" },
    });
  }
  return raw.map((o, i) => {
    const op = (o as { op?: unknown })?.op;
    if (op !== "create" && op !== "update" && op !== "delete") {
      throw new GraphQLError(`operation #${i}: op must be create|update|delete`, {
        extensions: { code: "VALIDATION" },
      });
    }
    const e = o as { id?: unknown; data?: unknown; ifUnmodifiedSince?: unknown };
    return {
      op,
      id: typeof e.id === "string" ? e.id : undefined,
      data:
        e.data && typeof e.data === "object" ? (e.data as Record<string, unknown>) : undefined,
      ifUnmodifiedSince:
        typeof e.ifUnmodifiedSince === "string" ? e.ifUnmodifiedSince : undefined,
    };
  });
};

/** Result type for `bulkUpdate<Collection>` — `results` entries are JSON
 *  `{ id, ok, error? }` (heterogeneous, so a scalar). Mirrors REST
 *  `…/bulk-update`. */
export const BulkUpdateResultType = new GraphQLObjectType({
  name: "BulkUpdateResult",
  fields: {
    total: { type: new GraphQLNonNull(GraphQLInt) },
    updated: { type: new GraphQLNonNull(GraphQLInt) },
    failed: { type: new GraphQLNonNull(GraphQLInt) },
    results: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(JSONScalar))) },
  },
});

export const bulkUpdateResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { keys: unknown; data: unknown },
) => {
  const { ctx, auth } = gqlCtx;
  const keys = Array.isArray(args.keys) ? args.keys.filter((k): k is string => typeof k === "string") : [];
  if (keys.length === 0) {
    throw new GraphQLError("keys must be a non-empty array of ids", {
      extensions: { code: "VALIDATION" },
    });
  }
  const data = args.data && typeof args.data === "object" ? (args.data as Record<string, unknown>) : {};
  const full = await loadCollection(ctx, auth.tenantId, collection.slug);
  const perm = await resolvePermission(ctx, auth, collection.slug, "update");
  if (!perm.allowed) {
    throw new GraphQLError(`No update permission on ${collection.slug}`, {
      extensions: { code: "FORBIDDEN" },
    });
  }
  try {
    return await runBulkUpdate({
      ctx,
      auth,
      collection: full,
      keys,
      data,
      perm: { whereSql: perm.whereSql, fields: perm.fields },
      meta: {},
      durationMs: () => 0,
      locale: null,
    });
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

export const batchResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { operations: unknown; atomic?: boolean },
) => {
  const { ctx, auth } = gqlCtx;
  const ops = normalizeBatchOps(args.operations);
  // The GraphQL CollectionRow is a subset; reload the full row the shared
  // batch orchestrator needs (cached, so cheap).
  const full = await loadCollection(ctx, auth.tenantId, collection.slug);
  try {
    return await runBatch({
      ctx,
      auth,
      collection: full,
      operations: ops,
      atomic: args.atomic === true,
      meta: {},
      durationMs: () => 0,
      locale: null,
    });
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};


// ── Aggregate + relevance search (REST parity) ───────────────────────────────
// Both reuse the ONE shared items service (runItemsAggregate /
// searchCollectionItems), so validation, permission clamps, and the
// draft/soft-delete oracle guards can never diverge from REST.

const surfaceAppError = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

export const aggregateResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: {
    agg: string;
    field?: string | null;
    groupBy?: string | null;
    filter?: Record<string, unknown> | null;
    limit?: number | null;
  },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) denyOrThrow(auth, collection.slug);
  if (!auth.tenantId) {
    throw new GraphQLError("Active tenant required", {
      extensions: { code: "UNAUTHORIZED" },
    });
  }
  if (!(ITEMS_AGG_FUNCS as readonly string[]).includes(args.agg)) {
    throw new GraphQLError(`agg must be one of ${ITEMS_AGG_FUNCS.join(", ")}`, {
      extensions: { code: "VALIDATION" },
    });
  }
  // Mirror the REST draft-oracle guard: COUNT/MIN/MAX over rows the caller
  // can't read would otherwise leak their existence.
  const canSeeDrafts =
    Boolean(perm.isAdmin) ||
    (await resolvePermission(ctx, auth, collection.slug, "publish", permCache)).allowed ||
    (await resolvePermission(ctx, auth, collection.slug, "update", permCache)).allowed;
  return surfaceAppError(() =>
    runItemsAggregate(
      ctx,
      auth,
      auth.tenantId as string,
      {
        collection: collection.slug,
        agg: args.agg,
        field: args.field ?? undefined,
        groupBy: args.groupBy ?? undefined,
        filter: args.filter ?? undefined,
        limit: args.limit ?? undefined,
      },
      {
        permWhere: perm.whereSql,
        allowedFields: perm.fields,
        excludeSoftDeleted: true,
        excludeDrafts: !canSeeDrafts,
      },
    ),
  );
};

export const searchResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: { q: string; mode?: string | null; limit?: number | null; locale?: string | null },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) denyOrThrow(auth, collection.slug);
  if (args.mode != null && !["fts", "vector", "hybrid"].includes(args.mode)) {
    throw new GraphQLError("mode must be fts | vector | hybrid", {
      extensions: { code: "VALIDATION" },
    });
  }
  if (args.limit != null && (args.limit < 1 || args.limit > 100)) {
    throw new GraphQLError("limit must be between 1 and 100", {
      extensions: { code: "VALIDATION" },
    });
  }
  return surfaceAppError(async () => {
    // The search service needs the items-loader row (fts/vectorize metadata
    // isn't on GraphQL's structurally-different CollectionRow) — same pattern
    // as the verify resolver above.
    const loaded = await loadCollection(ctx, auth.tenantId ?? undefined, collection.slug);
    const canSeeDrafts =
      Boolean(perm.isAdmin) ||
      (await resolvePermission(ctx, auth, collection.slug, "publish", permCache)).allowed ||
      (await resolvePermission(ctx, auth, collection.slug, "update", permCache)).allowed;
    const { data } = await searchCollectionItems(
      ctx,
      auth,
      loaded,
      {
        q: args.q,
        mode: (args.mode ?? undefined) as "fts" | "vector" | "hybrid" | undefined,
        limit: args.limit ?? undefined,
        locale: args.locale ?? undefined,
      },
      {
        permWhere: perm.whereSql,
        permFields: perm.fields,
        canSeeDrafts,
      },
    );
    return data;
  });
};

/**
 * `changes<Collection>` — one page of the incremental changefeed, the GraphQL
 * twin of REST `GET /api/items/{slug}/changes`. Delegates to the same
 * `runChangefeed` service, so permission, tenant, draft and shape handling are
 * literally the same code rather than a re-implementation that can drift.
 */
export const changesResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: {
    since?: string | null;
    limit?: number | null;
    shape?: unknown;
    fields?: string[] | null;
  },
) => {
  const { ctx, auth, permCache } = gqlCtx;
  const perm = await resolvePermission(ctx, auth, collection.slug, "read", permCache);
  if (!perm.allowed) denyOrThrow(auth, collection.slug);
  return surfaceAppError(async () => {
    const loaded = await loadCollection(ctx, auth.tenantId ?? undefined, collection.slug);
    const canSeeDrafts =
      Boolean(perm.isAdmin) ||
      (await resolvePermission(ctx, auth, collection.slug, "publish", permCache)).allowed ||
      (await resolvePermission(ctx, auth, collection.slug, "update", permCache)).allowed;
    return runChangefeed({
      ctx,
      auth,
      collection: loaded,
      perm: { whereSql: perm.whereSql, fields: perm.fields },
      canSeeDrafts,
      since: args.since ?? undefined,
      limit: args.limit ?? undefined,
      // The GraphQL arg is a JSON scalar; the service parses the same string
      // form the REST query param carries.
      shape: args.shape == null ? undefined : JSON.stringify(args.shape),
      fields: args.fields?.length ? args.fields.join(",") : undefined,
    });
  });
};
