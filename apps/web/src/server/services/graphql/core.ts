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
  sidecarFields,
} from "@backlex/db";
import {
  isSingleLocale,
  loadSidecarForRows,
} from "../items/i18n-sidecar";
import { decodeCursor, encodeCursor, keysetWhere } from "../items/keyset";
import { loadAppSettings } from "../settings";
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
import { hasLocalizedField, loadCollection } from "../items/collection-loader";
import { ITEMS_AGG_FUNCS, runItemsAggregate } from "../items/aggregate";
import { searchCollectionItems } from "../items/search";
import { runBatch, type BatchOp } from "../items/batch";
import { runChangefeed } from "../items/changefeed";
import { recordSensitiveRead } from "../items/read-audit";
import { requestMeta } from "../activity";
import { runBulkUpdate } from "../items/bulk";
import { performCreate, performDelete, performUpdate, type WriteEnv } from "../items/write";
import {
  rollupRefreshStatements,
} from "../items/rollup";
import { validateAndNormalizeGeo } from "../items/geo-fields";
import {
  describeTransitions,
} from "../items/transitions";
import {
  deserialize as sharedDeserialize,
  deserializeField,
  serialize as sharedSerialize,
} from "../items/serialize";
import { assertCurrencyChangeIsSafe, canonicalizeMoneyFields } from "../items/money-fields";
import { canonicalizeEmailFields, normalizeEmailOperands } from "../items/email-fields";
import { canonicalizeUrlFields, normalizeUrlOperands } from "../items/url-fields";
import { canonicalizePhoneFields, normalizePhoneOperands } from "../items/phone-fields";
import { expandRangeOperators, rangeFieldsOf } from "@backlex/db/range";
import { parseRetiredScope } from "@backlex/db/retirement";
import { retiredFilter } from "../items/sql-helpers";
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
  /**
   * Opt-in sensitive-read auditing, mirrored from the items collection-loader.
   *
   * It has to be on THIS row, not looked up per read: the resolvers here are
   * hot and never load the items-loader row. Its absence is why GraphQL wrote
   * no `access.read` at all — the audit hook read `collection.auditReads` off a
   * shape that has never carried it, so it was `undefined` on every read and
   * the gate closed silently.
   */
  auditReads?: boolean;
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
  /**
   * Hand a background promise to the runtime, when the caller has a way to.
   *
   * The GraphQL route fills this with `keepAlive(c, p)`; a caller without a
   * Hono context (a test, an internal invocation) leaves it undefined and the
   * promise simply floats — which is what the REST path does on Bun/Node
   * anyway. It exists so a sensitive-read audit does not make the read wait
   * for its own audit row, the same rule REST follows.
   */
  defer?: (p: Promise<unknown>) => void;
  /** Per-request batch loaders for to-one `relation` field resolution, keyed
   *  by TARGET collection slug. Coalesces the per-row `WHERE id = ?` lookups a
   *  list of N parents would otherwise fire (the classic GraphQL N+1) into one
   *  `WHERE id IN (…)` per target. MUST be per-request — never module-global —
   *  or one tenant's loader could serve another's rows. Lazily created. */
  relationLoaders?: Map<string, RelationLoader>;
}

/**
 * Record an `access.read` for a GraphQL read, on the same terms REST uses.
 *
 * GraphQL wrote no audit rows at all until now — `auditRead` needs a Hono
 * `Context` and there is none here — so a workspace could switch `auditReads`
 * on for its patient records, watch the log fill from the admin UI, and have
 * every read through `/api/graphql` leave nothing behind. Both surfaces now go
 * through one service (`services/items/read-audit.ts`), the way the WRITE path
 * already shares `performCreate`/`performUpdate`.
 *
 * `ip`/`userAgent` come from `rawRequest` when the caller supplied one, and are
 * simply absent otherwise rather than fabricated. `durationMs` is left null:
 * one GraphQL request can read several collections, so a per-request elapsed
 * figure would be the same number on every row and would describe none of them.
 */
const auditGqlRead = (
  gqlCtx: GqlCtx,
  collection: { slug: string; auditReads?: boolean },
  itemId: string | null,
  payload: Record<string, unknown>,
): void => {
  if (!collection.auditReads) return;
  const { ctx, auth, rawRequest, defer } = gqlCtx;
  const meta = rawRequest ? requestMeta(rawRequest) : { ip: null, userAgent: null };
  const p = recordSensitiveRead(
    { db: ctx.db, dialect: ctx.dialect },
    collection,
    {
      userId: auth.userId,
      tenantId: auth.tenantId ?? null,
      itemId,
      payload: { ...payload, surface: "graphql" },
      ...meta,
    },
  );
  if (defer) defer(p);
  else void p.catch(() => {});
};

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
    case "url":
      // A plain String on both sides, for the same reasons as `phone` and
      // `email` — the input side accepts a bare `acme.com` as readily as a whole
      // address, and no stricter scalar could express that without making
      // GraphQL pickier than REST for a value it canonicalizes anyway. Adding
      // `url` to the union is what made this switch non-exhaustive, and the
      // compiler said so; had it been a `default:` instead, the missing case
      // would have shipped as `undefined` and taken the whole endpoint down.
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
const _serialize = (
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
const _gqlAutoGeocode = async (
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

const _validateInput = (
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
const _canonicalizeMoneyForGql = (
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
    // Sixth in a row, and the reason has not changed once: this resolver
    // hand-builds its own INSERT and its own encoders, so every field feature
    // that folds a value on the payload has to be repeated here or GraphQL
    // becomes the one surface that can write an unfolded one. Without this,
    // `unique` on a URL column and lookup-by-address both quietly stop working
    // for rows written through it. `url-surfaces.test.ts` is the gate.
    canonicalizeUrlFields(inputData, collection.fields, {
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
 * Attach `localized` fields (camelCase keys) onto already-rendered GraphQL rows,
 * batch-loading the sidecar for all ids in one query.
 *
 * Two shapes, chosen by `locale` — the same choice REST's `?locale=` makes:
 *  - `null` / `"*"` — the full `{locale: value}` map.
 *  - a locale — that locale's value, falling back to the workspace default,
 *    then `null`. Same chain as `applySidecarFromRows`, which is what the REST
 *    single-item read uses; a `localized` field then reads as the plain scalar
 *    a client wants rather than a map it has to index.
 *
 * The GraphQL type is the `JSON` scalar either way, so the projection needs no
 * schema change — the same field can carry a map or a string.
 */
const attachLocalizedMaps = async (
  ctx: Ctx,
  collection: CollectionRow,
  baseRows: Array<Record<string, unknown>>,
  rendered: Array<Record<string, unknown>>,
  allowedFields: Set<string> | null = null,
  locale: string | null = null,
  defaultLocale: string | null = null,
): Promise<void> => {
  const defs = sidecarFields(collection.fields).filter(
    (f) => !f.private && (!allowedFields || allowedFields.has(f.name)),
  );
  if (defs.length === 0 || baseRows.length === 0) return;
  const single = isSingleLocale(locale);
  const ids = baseRows.map((r) => String(r.id));
  const byRow = await loadSidecarForRows(ctx, collection.physicalTable, ids, defs);
  for (let i = 0; i < baseRows.length; i++) {
    const sidecarRows = byRow.get(String(baseRows[i]!.id)) ?? [];
    const out = rendered[i]!;
    if (single) {
      const byLocale = new Map(sidecarRows.map((r) => [r.locale as string, r]));
      for (const f of defs) {
        const req = byLocale.get(locale as string)?.[f.name];
        const def = defaultLocale ? byLocale.get(defaultLocale)?.[f.name] : undefined;
        out[camel(f.name)] = deserialize(req ?? def ?? null, f.type, ctx.dialect);
      }
      continue;
    }
    for (const f of defs) {
      const map: Record<string, unknown> = {};
      for (const r of sidecarRows) map[r.locale as string] = deserialize(r[f.name], f.type, ctx.dialect);
      out[camel(f.name)] = map;
    }
  }
};

/**
 * Workspace default locale, loaded only when a single locale was actually
 * asked for AND the collection has something to localize — the settings read
 * is a query, and full-map mode has no fallback to resolve.
 */
const defaultLocaleFor = async (
  ctx: Ctx,
  tenantId: string | null,
  collection: CollectionRow,
  locale: string | null,
): Promise<string | null> =>
  isSingleLocale(locale) && hasLocalizedField(collection.fields)
    ? ((await loadAppSettings(ctx.db, ctx.dialect, tenantId)).i18nDefaultLocale ?? null)
    : null;

/** Split a camelCase GraphQL input into a snake-keyed patch of just the
 *  `localized` fields (values are `{locale: value}` maps), for the sidecar
 *  write. Removes those keys from `data` so the base INSERT/UPDATE skips them. */
const _takeLocalizedInput = (
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

/**
 * The resolved sort, as both an ORDER BY clause and the column/direction pairs
 * keyset pagination seeks on.
 *
 * One function produces both on purpose. A cursor is only correct if it was
 * minted under the exact tuple the query orders by, so a second copy of this
 * allow-list — even one that starts identical — is a page that silently skips
 * or repeats rows the first time the two drift.
 */
interface SortPlan {
  orderBy: SQL;
  /** Ordered `(column, direction)` pairs, always ending in a unique tiebreaker. */
  keyset: Array<{ column: string; dir: "asc" | "desc" }>;
}

const buildSortPlan = (sortStr: string | undefined, collection: CollectionRow): SortPlan => {
  const plan = (cols: Array<{ column: string; dir: "asc" | "desc" }>): SortPlan => {
    // A cursor identifies ONE row, so the tuple has to be unique. The primary
    // key is appended unless the caller already sorted by it.
    const keyset = cols.some((c) => c.column === collection.pkColumn)
      ? cols
      : [...cols, { column: collection.pkColumn, dir: "desc" as const }];
    return {
      orderBy: sql`ORDER BY ${sql.join(
        keyset.map((c) => sql`${sql.identifier(c.column)} ${sql.raw(c.dir === "asc" ? "ASC" : "DESC")}`),
        sql`, `,
      )}`,
      keyset,
    };
  };
  // Default sort needs a column that exists: created_at when the collection
  // has it, otherwise the primary key (timestamps-off collections).
  const fallback = () =>
    plan(collection.hasCreatedAt ? [{ column: "created_at", dir: "desc" }] : []);
  if (!sortStr) return fallback();
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
  const cols = sortStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const dir: "asc" | "desc" = s.startsWith("-") ? "desc" : "asc";
      const column = s.replace(/^[-+]/, "");
      return sortable.has(column) ? { column, dir } : null;
    })
    .filter((x): x is { column: string; dir: "asc" | "desc" } => x != null);
  return cols.length === 0 ? fallback() : plan(cols);
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

export interface ListArgs {
  filter?: Condition;
  sort?: string;
  limit?: number;
  offset?: number;
  /** Keyset pagination. `""` starts; echo back `nextCursor` to page forward.
   *  When present, `offset` is ignored — same rule as REST's `?cursor=`. */
  cursor?: string | null;
  /** Project `localized` fields to one locale, or `"*"` for the full map. */
  locale?: string | null;
  /**
   * How to treat rows the collection's retirement flag has taken out of play —
   * the twin of REST's `?retired=`, and defaulting to `all` for the same
   * reason: retirement never hides a row from a read.
   */
  retired?: string | null;
}

export interface ListPage {
  items: Array<Record<string, unknown>>;
  /** Null on the last page. Only ever non-null in cursor mode. */
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * The list read, in the shape both `<slug>` (a bare array) and `<slug>Page`
 * (the paging envelope) are built from.
 *
 * Cursor mode fetches one row past the page to learn whether another exists,
 * exactly as REST does — `hasMore` is otherwise a guess, and a client that
 * pages until an empty response makes one extra round trip every time.
 */
export const listPageResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: ListArgs,
): Promise<ListPage> => {
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
        // …and the operands of every field type that folds its values, which
        // REST has done since each of those types shipped and this resolver
        // never did. `normalizeCondition` (from @backlex/core) normalizes the
        // DSL's SHAPE — implicit equality, nested relation filters — and knows
        // nothing about field types, so nothing here was folding anything.
        //
        // PRE-EXISTING, and not only for `url`: a GraphQL query filtering an
        // email column by `_eq: "Ada@Example.com"` matched no row while the
        // identical REST call matched it, because the column holds the folded
        // address. Same for a phone column filtered by a national-form number.
        // Found by writing the url twin of a check REST already had.
        normalizeUrlOperands(
          normalizeEmailOperands(
            normalizePhoneOperands(
              normalizeTemporalOperands(
                expandRangeOperators(
                  normalizeCondition(args.filter, { relationFields }),
                  rangeFieldsOf(collection.fields),
                ),
                collection.fields,
                ctx.dialect,
              ),
              collection.fields,
            ),
            collection.fields,
          ),
          collection.fields,
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
  const sortPlan = buildSortPlan(args.sort, collection);
  // Cursor mode replaces `offset` with a seek predicate on the sort tuple.
  // A cursor minted under a different sort has a different arity, which
  // `keysetWhere` refuses rather than paginating the wrong axis.
  const cursorMode = typeof args.cursor === "string";
  // A cursor is the sort tuple of the last row, base64url-encoded and handed
  // to the caller. That makes every keyset column READABLE by whoever holds
  // the cursor, whatever `perm.fields` says — sorting by a column the caller
  // may not select would otherwise disclose one of its values per page. So the
  // cursor path refuses a sort it cannot expose, rather than minting one.
  // (`buildSortPlan`'s allow-list is about which columns EXIST; this is about
  // which the caller may see. System columns aren't in `perm.fields`, which
  // enumerates collection fields only, so only those are checked.)
  if (cursorMode) {
    const byName = new Map(collection.fields.map((f) => [f.name, f]));
    const hidden = sortPlan.keyset.find((c) => {
      const f = byName.get(c.column);
      if (!f) return false; // a system column — always readable
      return f.private === true || (perm.fields != null && !perm.fields.has(c.column));
    });
    if (hidden) {
      throw new GraphQLError(
        `Cannot paginate by "${hidden.column}" — the cursor would expose a field you cannot read. Sort by a readable column.`,
        { extensions: { code: "FORBIDDEN" } },
      );
    }
  }
  // Both `decodeCursor` and `keysetWhere` refuse a bad cursor with an AppError.
  // Unwrapped it would reach yoga as an unknown error and be masked to
  // "Unexpected error." — the caller has to be told their cursor is stale or
  // was minted under a different sort, which is exactly what REST tells them.
  const seekWhere =
    cursorMode && args.cursor
      ? asGqlError(() =>
          keysetWhere(
            sortPlan.keyset.map((c) => ({ ref: sql`${sql.identifier(c.column)}`, dir: c.dir })),
            decodeCursor(args.cursor as string),
          ),
        )
      : null;
  // Retirement, from the same helper REST composes — the surfaces gate exists
  // because this file has hand-built its own SQL for every previous write-path
  // feature and been the one that quietly did not have it.
  const retiredScope = parseRetiredScope(args.retired ?? undefined);
  if (retiredScope === null) {
    throw new GraphQLError('`retired` must be "all", "exclude" or "only"', {
      extensions: { code: "VALIDATION" },
    });
  }
  const wheres = [
    gqlTenantWhere(collection, auth),
    userWhere,
    perm.whereSql,
    deletedWhere,
    draftWhere,
    retiredFilter(collection.fields, retiredScope, ctx.dialect),
    seekWhere,
  ].filter((x): x is SQL => x != null);
  const whereClause = wheres.length
    ? sql`WHERE ${sql.join(wheres, sql` AND `)}`
    : sql``;
  const limit = Math.min(200, Math.max(1, args.limit ?? 50));
  const offset = cursorMode ? 0 : Math.max(0, args.offset ?? 0);
  // One row past the page, to answer `hasMore` without a second COUNT.
  const fetchLimit = limit + 1;

  const fetched = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT * FROM ${sql.identifier(table)} ${whereClause} ${sortPlan.orderBy} LIMIT ${fetchLimit} OFFSET ${offset}`,
  );
  const hasMore = fetched.length > limit;
  const rows = hasMore ? fetched.slice(0, limit) : fetched;
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
  const locale = args.locale ?? null;
  await attachLocalizedMaps(
    ctx,
    collection,
    rows,
    rendered,
    perm.fields,
    locale,
    await defaultLocaleFor(ctx, auth.tenantId ?? null, collection, locale),
  );
  // The cursor is the ORDER-BY tuple of the last row ON THIS PAGE, read from
  // the RAW row — `rendered` is camelCased and permission-projected, so a sort
  // column the caller may not read would be missing from it.
  const last = rows[rows.length - 1];
  const nextCursor =
    cursorMode && hasMore && last
      ? encodeCursor(sortPlan.keyset.map((c) => last[c.column] ?? null))
      : null;
  // Same shape REST's list audit records (`routes/items/list.ts`): the query,
  // how many rows came back, and the first fifty identities — read off the RAW
  // rows, because `rendered` is permission-projected and may not carry the pk.
  auditGqlRead(gqlCtx, collection, null, {
    query: { filter: args.filter ?? null, sort: args.sort ?? null, limit, offset },
    count: rendered.length,
    ids: rows.slice(0, 50).map((r) => r[collection.pkColumn] ?? null),
  });
  return { items: rendered, nextCursor, hasMore };
};

/** The bare-array list field. Same read, envelope discarded. */
export const listResolver = async (
  gqlCtx: GqlCtx,
  collection: CollectionRow,
  args: ListArgs,
) => (await listPageResolver(gqlCtx, collection, args)).items;

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
      // The audit that is easiest to miss, and the one that matters most.
      //
      // A nested selection like `{ visits { patient } }` reads patient rows
      // through THIS loader — it never reaches `getResolver`, so hooking the
      // two top-level resolvers alone would leave the sensitive collection
      // readable, in bulk, with nothing recorded. Logged as one row for the
      // batch rather than one per id, because that is what actually happened:
      // a single `WHERE id IN (…)`.
      //
      // `byId.keys()` and not `ids`: an id the caller asked for but was not
      // allowed to see resolved to null and was never read, so recording it
      // would claim an access that did not occur.
      auditGqlRead(gqlCtx, collection, null, {
        relation: true,
        requested: ids.length,
        count: byId.size,
        ids: [...byId.keys()].slice(0, 50),
      });
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
  locale: string | null = null,
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
  await attachLocalizedMaps(
    ctx,
    collection,
    [rows[0]],
    [out],
    perm.fields,
    locale,
    await defaultLocaleFor(ctx, auth.tenantId ?? null, collection, locale),
  );
  // REST's by-id twin records the field names it returned (`routes/items/read.ts`);
  // `out` is the same projection, so the same shape holds here.
  auditGqlRead(gqlCtx, collection, id, { fields: Object.keys(out) });
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
const _gqlRollupRefresh = async (
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


/**
 * The camelCase↔snake_case boundary, in one place.
 *
 * GraphQL names every field in camelCase; a `FieldDef` — and therefore every
 * column, every `slug.from`, every rollup spec and every permission field
 * allow-list — is snake_case. This file has produced that bug before (a slug
 * resolver handed camel keys found `undefined` at every source column and
 * silently generated nothing), and it produced it because the translation was
 * done ad hoc at each site that needed it. Now the input is translated once on
 * the way in and the result once on the way out, and everything between speaks
 * the one language the write core speaks.
 */
const toSnakeInput = (
  data: Record<string, unknown>,
  collection: CollectionRow,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of collection.fields) {
    const v = data[camel(f.name)];
    if (v !== undefined) out[f.name] = v;
  }
  // The primary key of an adopted / integer-keyed collection is not in `fields`
  // but the write core requires it in the body.
  const pk = data[camel(collection.pkColumn)];
  if (pk !== undefined && !(collection.pkColumn in out)) out[collection.pkColumn] = pk;
  return out;
};

/**
 * The write core's projected row, in the shape the GraphQL type declares.
 *
 * `WriteResult.data` is already permission-projected and already carries the
 * system columns in camelCase (`createdAt`/`updatedAt`/`ownerId`); only the
 * user fields need renaming. Absent fields are filled with `null` rather than
 * omitted, which is what the hand-built response did and what a non-null-by-
 * default GraphQL client expects to read back.
 */
const toCamelOutput = (
  data: Record<string, unknown> | undefined,
  collection: CollectionRow,
): Record<string, unknown> => {
  const src = data ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (collection.fields.some((f) => f.name === k)) continue;
    out[k] = v;
  }
  for (const f of collection.fields) {
    if (f.private) continue;
    out[camel(f.name)] = src[f.name] ?? null;
  }
  return out;
};

/**
 * A `WriteEnv` for the write core, built from the GraphQL request context.
 *
 * The collection is the one `loadCollection` returns, not this file's narrower
 * `CollectionRow`. GraphQL keeps its own structural subset because its schema
 * builder only needs a handful of columns, and it already reloads the full row
 * wherever it hands work to a shared service (batch, bulk update, changefeed).
 * The write core is another of those places.
 */
export const writeEnvOf = async (
  gqlCtx: GqlCtx,
  collection: WriteEnv["collection"],
): Promise<WriteEnv> => {
  const started = Date.now();
  // What the mutation's response is projected through. Resolved here rather
  // than at each resolver so create/update/delete cannot answer differently,
  // which is exactly how the two write surfaces drifted apart in the first
  // place. Shares the request's permission cache, so it is one lookup.
  const readPerm = await resolvePermission(
    gqlCtx.ctx,
    gqlCtx.auth,
    collection.slug,
    "read",
    gqlCtx.permCache,
  );
  return {
    readFields: readPerm.allowed ? readPerm.fields : new Set<string>(),
    ctx: gqlCtx.ctx,
    collection,
    userId: gqlCtx.auth.userId,
    tenantId: gqlCtx.auth.tenantId,
    roles: gqlCtx.auth.roles,
    email: gqlCtx.auth.email ?? null,
    // GraphQL has one HTTP request behind a whole document, so per-mutation
    // request metadata would be a guess. The activity row records the surface
    // instead of inventing an IP for it.
    meta: { surface: "graphql" },
    // Impersonation rides the write env on every surface. GraphQL never sees
    // the permission middleware, so the write core's own gate is the only one
    // standing between a read-only impersonation and a mutation here.
    impersonatedBy: gqlCtx.auth.impersonatedBy ?? null,
    impersonationReadOnly: gqlCtx.auth.impersonationReadOnly ?? false,
    durationMs: () => Date.now() - started,
    // `?locale=` is a REST query parameter; a GraphQL mutation always writes the
    // full `{locale: value}` map form, which is what `null` selects.
    locale: null,
  };
};

/** Run an async write through the core, mapping its AppError to a GraphQLError. */
const asGqlErrorAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
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
  // A tenant-scoped collection has no row to write without a workspace. The
  // write core stamps `tenant_id` from `env.tenantId`; refusing here keeps the
  // error a FORBIDDEN about context rather than a constraint violation.
  if (collection.tenantScoped && !auth.tenantId) {
    throw new GraphQLError("No tenant context for a tenant-scoped collection", {
      extensions: { code: "FORBIDDEN" },
    });
  }

  const full = await loadCollection(ctx, auth.tenantId ?? undefined, collection.slug);
  const env = await writeEnvOf(gqlCtx, full);
  const res = await asGqlErrorAsync(() =>
    performCreate(env, toSnakeInput(args.data, collection), perm),
  );
  for (const fx of res.sideEffects) await fx();
  return toCamelOutput(res.data, collection);
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
  const full = await loadCollection(ctx, auth.tenantId ?? undefined, collection.slug);
  const env = await writeEnvOf(gqlCtx, full);
  const res = await asGqlErrorAsync(() =>
    performUpdate(env, args.id, toSnakeInput(args.data, collection), perm),
  );
  for (const fx of res.sideEffects) await fx();
  return toCamelOutput(res.data, collection);
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
  const full = await loadCollection(ctx, auth.tenantId ?? undefined, collection.slug);
  const env = await writeEnvOf(gqlCtx, full);
  const res = await asGqlErrorAsync(() => performDelete(env, args.id, perm));
  for (const fx of res.sideEffects) await fx();
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
      readFields: await (async () => {
        const r = await resolvePermission(ctx, auth, collection.slug, "read");
        return r.allowed ? r.fields : new Set<string>();
      })(),
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
  // An aggregate reads the audited rows too — a COUNT or a MIN over a patient
  // table tells you something about patients. REST's `/aggregate` did not log
  // it either, and closing the gap on one surface while leaving it on the other
  // would just move the blind spot, so both are closed together (see
  // `routes/items/query.ts`).
  auditGqlRead(gqlCtx, collection, null, {
    aggregate: args.agg,
    field: args.field ?? null,
    groupBy: args.groupBy ?? null,
  });
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
    // REST's `/search` records the mode + result count; this is its twin.
    auditGqlRead(gqlCtx, collection, null, {
      search: args.mode ?? "fts",
      count: Array.isArray(data) ? data.length : 0,
    });
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
