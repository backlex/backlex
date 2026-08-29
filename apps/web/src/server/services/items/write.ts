import { sql, type SQL } from "drizzle-orm";
import {
  type FieldDef,
  matchesCondition,
  resolveAutoFill,
  sidecarFields,
} from "@backlex/db";
import {
  AppError,
  type AuthSubject,
  type Condition,
  type OrgRole,
} from "@backlex/core";
import type { Ctx } from "../../context";
import { dispatchEventHandlers, publishEvent } from "../events";
import { recordActivity } from "../activity";
import { runSyncHooks } from "../sync-hooks";
import { recordRevision } from "../revisions";
import { embedAndUpsert, deleteVector } from "../vectorize";
import { indexFts, deleteFts } from "../fts";
import type { CollectionRow } from "./collection-loader";
import { serialize, serializeField, deserialize, deserializeRow, projectFields } from "./serialize";
import {
  collectFieldWarnings,
  enforceFieldConditions,
  enforceValidationRules,
  type FieldWarning,
  validateAppUserLinks,
  validateBody,
  validateRelations,
} from "./validate";
import { normalizeGeoFields } from "./geo-fields";
import { assertCurrencyChangeIsSafe, canonicalizeMoneyFields } from "./money-fields";
import { canonicalizeEmailFields } from "./email-fields";
import { canonicalizeUrlFields } from "./url-fields";
import { canonicalizePhoneFields } from "./phone-fields";
import { applyAutoGeocode, patchTouchesSources } from "./geocode";
import { hashIncomingFields, scrubHashFields, scrubPrivateFields } from "./hash-fields";
import { assertRowsWithinLimit } from "../usage";
import { enforceOnDeleteTriggers } from "./on-delete";
import {
  rollupRefreshAllStatements,
  rollupRefreshStatements,
  type RollupChange,
} from "./rollup";
import {
  appendPositionSql,
  type OrderField,
  orderFieldsOf,
  readBackPositions,
  sameScope,
} from "./order";
import { judgeableCondition } from "../permission-relations";
import { nextSequenceValues, sequenceFieldsOf, type SequencePool } from "./sequence";
import { applySlugs, resolveSlugsForWrite, slugFieldsOf } from "./slug";
import { assertInitialStates, assertTransitions, transitionEventName } from "./transitions";
import {
  echoLocalized,
  sidecarClear,
  sidecarDeleteRow,
  sidecarInsert,
  sidecarUpsert,
  splitIsEmpty,
  splitLocalized,
  validateLocalePatches,
} from "./i18n-sidecar";
import {
  deletedFilter,
  execute,
  fromOf,
  nowFor,
  pkEq,
  queryAll,
  selectStar,
  tenantFilter,
  usesOwnershipSideTable,
  whereOf,
} from "./sql-helpers";
import {
  getStagedRow,
  stagedDeleteSql,
  stagedUpsertSql,
  stagedViewOf,
} from "./staged";

/**
 * Shared item-write core. The single-item REST handlers AND the batch endpoint
 * both call these so create/update/delete stay byte-identical across the two
 * surfaces. Each `perform*` validates, executes its physical write (against
 * `env.db` — `ctx.db` normally, a transaction handle in atomic-batch mode), and
 * returns its async side-effects (vectorize, realtime/flow/webhook events,
 * audit, revisions) as thunks the caller runs *after* the write (or after the
 * transaction commits). They THROW `AppError` on failure — the single-item
 * handlers let it bubble to the error middleware, the non-atomic batch catches
 * it per-row, and the atomic batch lets it abort the whole transaction.
 */

export interface ResolvedPerm {
  whereSql: SQL | null | undefined;
  fields: Set<string> | null;
  /**
   * The raw conditions behind `whereSql`, so a WRITE can be judged against the
   * row it PROPOSES rather than only against rows that already exist.
   *
   * `whereSql` answers "which rows may I touch", which is the whole question
   * for read and delete and only half of it for create and update. Before this
   * field existed, `performCreate` read `perm.fields` and nothing else, and
   * `performUpdate` used `whereSql` solely to choose WHICH row — never to
   * check what the row BECAME. So the canonical B2B rule that
   * `docs/app-organizations.md` sells,
   * `{ org_id: { _eq: "$org.id" } }`, filtered reads, updates and deletes and
   * did not constrain an insert: a member could plant a row into another
   * organization and simply not read it back. The Postgres RLS projection of
   * the SAME condition emits `WITH CHECK` for INSERT, so the database was
   * stricter than the API in front of it.
   *
   * `null` means at least one matching permission row carried no condition —
   * i.e. unrestricted — and is the value an internal, non-user-initiated write
   * passes deliberately.
   *
   * REQUIRED rather than optional. The audit's shape was a guarantee nobody
   * had to state; making every call site name its answer is what stops the
   * next one inheriting a permissive default by silence.
   */
  conditions: Condition[] | null;
}

export interface WriteEnv {
  ctx: Ctx;
  collection: CollectionRow;
  userId: string | null;
  tenantId: string | null | undefined;
  roles: string[];
  /** Caller email, when known — lets a field condition rule resolve
   *  `$user.email`. Optional; omitted ⇒ null. */
  email?: string | null;
  /** requestMeta(c.req.raw) — ip/ua/etc. for the activity row. */
  meta: Record<string, unknown>;
  /** The operator behind an impersonated write. Threaded onto the activity row
   *  so "what did support do while acting as a customer" stays a query. */
  impersonatedBy?: string | null;
  /** True for a read-only impersonation. Checked HERE as well as at the
   *  permission middleware, and the division of labour is deliberate rather
   *  than duplicated: the middleware covers every REST route that declares a
   *  collection action (storage included), while this covers every path that
   *  reaches a row write — GraphQL, batch, bulk and CSV import — none of which
   *  passes through that middleware. GraphQL in particular hand-builds its own
   *  resolvers and has repeatedly been the surface a guard was missing from. */
  impersonationReadOnly?: boolean;
  durationMs: () => number;
  /** ?locale= write target for `localized` (sidecar) fields. */
  locale: string | null;
  /**
   * The fields this caller may READ, or `null` for no restriction — what the
   * write's RESPONSE is projected through.
   *
   * Deliberately not the write permission's list. A permission row is per
   * (role, collection, ACTION), so `update` and `read` carry independent field
   * lists and nothing intersects them: a role can be granted `update:
   * [internal_score]` while its `read` names only `title`. Projecting the
   * response through the write list then hands that caller a column they are
   * not allowed to see — and not merely the value they just sent, since the
   * projection filters the whole refreshed row, so a second field in the update
   * list comes back carrying whatever an admin last put in it.
   *
   * The response is a READ. The write grant authorises the write; it does not
   * authorise reading the result back. See
   * `tests/mutation-response-projection.test.ts`.
   *
   * Required rather than optional on purpose — a caller that forgets it should
   * not silently inherit either answer.
   */
  readFields: Set<string> | null;
  /**
   * Skip synchronous hooks for this write.
   *
   * Opt-OUT rather than opt-in on purpose: a validation hook that silently does
   * not run is a worse failure than a restore being slow, so a caller who
   * forgets the flag still gets the guarantee. Set it for machine-driven bulk
   * writes — restore, seed, template apply, CSV import — where firing a
   * blocking HTTP call per row is both pointless and ruinous.
   */
  skipSyncHooks?: boolean;
  /**
   * Skip the address→point geocode a `geo` field with `geocodeFrom` would
   * otherwise trigger.
   *
   * Set by the CSV import, which is the one path through here that writes an
   * unbounded number of rows in one request. Geocoders are metered and slow —
   * the public Nominatim asks for no more than one request a second — so a
   * thousand-row file would become a twenty-minute request that times out
   * partway, having spent the quota and located an arbitrary prefix of the
   * file. `POST /api/geo/backfill/{slug}` fills those rows in afterwards, in
   * batches the caller sizes and can watch.
   *
   * Deliberately NOT tied to `skipSyncHooks`: that flag means "this write is
   * machine-driven", which is a different question from "this write is one of
   * very many". A `batch` of twenty rows an operator submitted should geocode.
   */
  skipGeocode?: boolean;
  /** Physical-write DB handle. Defaults to ctx.db; an atomic batch passes its
   *  transaction handle so the writes commit/roll back together. */
  db?: unknown;
  /** Atomic mode: when set, write statements are pushed here (in order) instead
   *  of executing immediately. The caller replays them inside one transaction
   *  so the whole batch commits or rolls back together. Reads (existence /
   *  before-snapshot) still run against ctx.db during the prepare phase. */
  collect?: SQL[];
  /**
   * Pre-allocated sequence values, shared across the creates of one bulk run
   * (batch, CSV import) so an n-row import costs one allocation statement per
   * sequence field instead of n. Optional: a create that finds the pool empty
   * allocates its own, so getting the size wrong is a slowdown, never a
   * duplicate. See `services/items/sequence.ts`.
   */
  sequencePool?: SequencePool;
  /**
   * App-plane organization context, when the request has one.
   *
   * `authSubjectOf` used to build its subject from `{userId, email, roles,
   * tenantId}` alone while `AuthSubject` carries these three as well — so
   * `$org.id`, `$org.role` and `$user.orgs` all resolved to null/empty on the
   * write side. That would have made the write-condition check below evaluate
   * every org rule against a null org and refuse every insert, which is a
   * worse bug than the one it fixes. The org context has to arrive here before
   * the check can mean anything.
   */
  orgId?: string | null;
  orgRole?: OrgRole | null;
  orgIds?: string[];
}

/** Execute a write statement, or queue it when collecting for an atomic batch. */
const emit = async (env: WriteEnv, stmt: SQL): Promise<void> => {
  if (env.collect) {
    env.collect.push(stmt);
    return;
  }
  // Unique/FK violations are mapped to clean 4xx inside execute().
  await execute(env.ctx, stmt, env.db);
};

/**
 * Restate any rollup column that summarises this collection, for the parents
 * this write touched.
 *
 * Pushed through `emit` like any other write statement — NOT deferred to a side
 * effect — so it lands inside an atomic batch's transaction and rolls back with
 * the row that provoked it. A total that survived a rolled-back line would be
 * wrong with nothing left to explain it.
 *
 * Order matters and is the caller's job: call this AFTER the row write has been
 * emitted, so the aggregate the statement computes already sees it.
 */
const emitRollupRefresh = async (env: WriteEnv, change: RollupChange): Promise<void> => {
  const stmts = await rollupRefreshStatements(
    env.ctx,
    env.collection,
    env.tenantId,
    change,
  );
  for (const stmt of stmts) await emit(env, stmt);
};

export type SideEffect = () => Promise<void>;

export interface WriteResult {
  id: string;
  /** The projected row (create/update) or the deleted row (delete). */
  data?: Record<string, unknown>;
  /** Advisory (warning/info) validation hints — non-blocking. */
  warnings?: FieldWarning[];
  sideEffects: SideEffect[];
}

const authOf = (env: WriteEnv) => ({ tenantId: env.tenantId ?? null, roles: env.roles });

/** Full auth subject for the DSL evaluator (field-condition rule matching). */
const authSubjectOf = (env: WriteEnv): AuthSubject => ({
  userId: env.userId,
  email: env.email ?? null,
  roles: env.roles,
  tenantId: env.tenantId ?? null,
  // Carried so `$org.id` / `$org.role` / `$user.orgs` resolve on the write
  // side too. Their absence here is why the write-condition check could not
  // have been added without this line first: every org-scoped rule would have
  // been judged against a null org and refused everything.
  orgId: env.orgId ?? null,
  orgRole: env.orgRole ?? null,
  orgIds: env.orgIds ?? [],
});

/**
 * Does the row a write PROPOSES satisfy the permission's own condition?
 *
 * This is a `WITH CHECK`, in the Postgres sense, and it is deliberately a
 * different question from `perm.whereSql`. `whereSql` chooses which existing
 * rows the caller may touch; this asks whether the result is a row they were
 * allowed to produce. Read, update and delete were fenced by the first; create
 * was fenced by nothing, and update never re-asked after the patch.
 *
 * MULTIPLE CONDITIONS ARE OR-ED, matching how roles combine everywhere else: a
 * caller holding two roles that each grant `create` under different conditions
 * may create a row satisfying either.
 *
 * DOTTED RELATION KEYS ARE SKIPPED, NOT REFUSED. `packages/db/src/permission.ts`
 * returns a hard `false` for any key containing a dot, while the SQL compiler
 * lowers the same key to a correlated EXISTS. So a rule like
 * `{ "author.department": { _eq: "…" } }` filters reads correctly today and
 * would deny every write if evaluated in memory. Refusing writes that the
 * product has been accepting for months, on a rule the operator wrote for
 * reads, is not a security fix — it is an outage. Such a condition is skipped
 * and the skip is LOGGED, so the gap is visible rather than silent.
 */
const assertWriteConditions = (
  env: WriteEnv,
  perm: ResolvedPerm,
  proposed: Record<string, unknown>,
  action: "create" | "update",
): void => {
  // `null` = at least one matching permission row was unconditional.
  if (perm.conditions === null || perm.conditions.length === 0) return;

  const subject = authSubjectOf(env);
  // Localized columns live in the `_i18n` sidecar, one value per locale, and
  // `splitLocalized` has already pulled them off `data` by the time we get
  // here. There is no single value to compare, so a condition keyed on one is
  // narrowed out rather than judged against `undefined` — which was
  // fail-closed for `_eq` and fail-OPEN for `_neq` / `_nin` / `_null`, with no
  // log line either way.
  const localized = new Set(
    env.collection.fields.filter((f) => f.localized).map((f) => f.name),
  );
  const unjudgeable = localized.size > 0 ? (f: string) => localized.has(f) : undefined;
  const skipped: Condition[] = [];
  let matched = false;
  for (const cond of perm.conditions) {
    // NARROWED, not skipped whole. The first version of this asked "does this
    // condition contain a relation key anywhere" and skipped the entire rule if
    // so — which meant one dotted key disarmed every other key beside it, and
    // `{$and: [{org_id: {_eq: "$org.id"}}, {"project.status": {_eq: "open"}}]}`
    // is the shape a B2B schema writes the moment it has two tables. The org
    // half was silently unenforced on writes while the SQL compiler honoured
    // both halves on reads.
    const judgeable = judgeableCondition(cond, unjudgeable) as Condition | null;
    if (judgeable === null) {
      skipped.push(cond);
      continue;
    }
    if (matchesCondition(proposed, judgeable, subject)) {
      matched = true;
      break;
    }
  }
  if (matched) return;
  // Nothing was left to judge in ANY condition — every one was relation paths
  // all the way down. Treat that as "no opinion" rather than a denial.
  if (skipped.length === perm.conditions.length) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "permission-write-check-skipped",
        reason: "every condition uses a relation path the in-memory evaluator cannot judge",
        collection: env.collection.slug,
        action,
        tenantId: env.tenantId ?? null,
      }),
    );
    return;
  }

  const mode = env.ctx.env.PERMISSION_WRITE_CHECK ?? "warn";
  const detail = {
    msg: "permission-write-check",
    collection: env.collection.slug,
    action,
    userId: env.userId,
    tenantId: env.tenantId ?? null,
    orgId: env.orgId ?? null,
    // The failing FIELDS, never their values: a rejected row is the caller's
    // own payload, but this line lands in shared logs.
    fields: perm.conditions.flatMap((c) => Object.keys(c as Record<string, unknown>)),
    skippedRelationConditions: skipped.length,
    mode,
  };
  if (mode !== "enforce") {
    console.warn(JSON.stringify({ level: "warn", ...detail, action_taken: "allowed" }));
    return;
  }
  console.warn(JSON.stringify({ level: "warn", ...detail, action_taken: "refused" }));
  throw new AppError(
    "FORBIDDEN",
    `This ${action} would produce a row outside what your permission on "${env.collection.slug}" allows.`,
  );
};


/** Refuse a write made by a read-only impersonation. See
 *  `WriteEnv.impersonationReadOnly` for why this lives here as well as at the
 *  permission middleware. */
const assertNotReadOnlyImpersonation = (env: WriteEnv, action: string): void => {
  if (!env.impersonationReadOnly) return;
  throw new AppError(
    "FORBIDDEN",
    `This is a read-only impersonation — "${action}" on "${env.collection.slug}" is refused. ` +
      "Start one with `readOnly: false` if acting on the customer's behalf is intended.",
  );
};

export const performCreate = async (
  env: WriteEnv,
  dataIn: Record<string, unknown>,
  perm: ResolvedPerm,
): Promise<WriteResult> => {
  assertNotReadOnlyImpersonation(env, "create");
  let data = dataIn;
  const { ctx, collection } = env;
  const table = collection.physicalTable;
  // Hard workspace row cap (#12) — checked against the half-hourly sweep
  // gauge, so it's approximate by design (a burst can overshoot until the
  // next sweep). Single chokepoint: REST, batch, GraphQL, and MCP all create
  // through here.
  if (env.tenantId) await assertRowsWithinLimit(ctx, ctx.env, env.tenantId);
  let id: string;
  // Integer-keyed managed collections (external-DB migration creates these)
  // share the adopted contract: backlex never invents numeric keys, so the
  // body must carry the PK. uuid/text PKs keep auto-generating a UUID.
  if (collection.adopted || collection.pkType === "integer") {
    const pkVal = data[collection.pkColumn];
    if (pkVal === undefined || pkVal === null || pkVal === "") {
      throw new AppError(
        "VALIDATION",
        `Primary key "${collection.pkColumn}" is required in the body for ${
          collection.adopted ? "adopted" : "integer-keyed"
        } collections`,
      );
    }
    id = String(pkVal);
    delete data[collection.pkColumn];
  } else {
    id = crypto.randomUUID();
  }
  // Pull `localized` fields out of `data` up front so the base INSERT never
  // targets a sidecar-only column, and validate each provided per-locale value.
  const localeSplit = splitLocalized(data, collection.fields, env.locale);
  validateLocalePatches(localeSplit, collection.fields);
  validateBody(data, collection.fields, false, perm.fields);
  // Canonicalize every accepted point shape into `{ lat, lng }` on the payload
  // itself, so the INSERT, the 201 body, the realtime event and the audit entry
  // all carry what the column will hold — see ./geo-fields.
  normalizeGeoFields(data, collection.fields);
  // Resolve every money value's currency and quantize it to that currency's
  // exponent, on the payload, for the same reason the line above exists: the
  // 201 body, the realtime event, the activity entry and the FTS text are all
  // built from `data`, so it has to hold what a read of this row will return.
  // The conversion to the stored integer happens later, in `serializeField`.
  try {
    canonicalizeMoneyFields(data, collection.fields);
    // …and every phone value into E.164, on the payload, for the same reason
    // again. A create that echoed back the `0532 111 22 33` the caller sent
    // would put a number no SMS provider accepts into the 201 body, the realtime
    // event and — through the changefeed — the client's offline store, while the
    // column held something else entirely.
    canonicalizePhoneFields(data, collection.fields);
    // …and every address into its canonical form, on the payload, for the same
    // reason a third time. A create that echoed back `  Ada@Example.COM ` would
    // hand the caller a string that does not equal the row it just made.
    canonicalizeEmailFields(data, collection.fields);
    // …and every web address, for the same reason a fourth time. A create that
    // echoed back the `Acme.COM` the caller sent would hand them a string that
    // does not equal the row it just made.
    canonicalizeUrlFields(data, collection.fields);
  } catch (e) {
    throw new AppError("VALIDATION", (e as Error).message);
  }
  // Derive a point from the address columns when the caller supplied none.
  // See ./geocode for when this fires, and `skipGeocode` for when it must not.
  if (!env.skipGeocode) {
    await applyAutoGeocode(ctx, collection.fields, data, data);
  }
  await validateRelations(data, collection.fields, ctx, env.tenantId);
  await validateAppUserLinks(data, collection.fields, ctx, env.tenantId);
  // Enforce conditional `required` effects against the proposed row (runs before
  // hashing so a rule sees the plaintext the user typed).
  enforceFieldConditions(data, collection.fields, authSubjectOf(env));
  // Cross-field validation rules run on the same plaintext proposed row.
  enforceValidationRules(data, collection.fields, authSubjectOf(env));
  // A lifecycle field can only ask one thing of a create — whether the row is
  // allowed to START here. There is no `from` to judge against.
  assertInitialStates(collection.fields, data);
  const warnings = collectFieldWarnings(data, collection.fields, authSubjectOf(env));
  // Replace any `hash` field's plaintext with its scrypt digest before the row
  // is built. Empty values are dropped (see hashIncomingFields).
  await hashIncomingFields(data, collection.fields);

  // Synchronous hooks run LAST in the validation phase — after
  // `hashIncomingFields`, so a hook never sees a plaintext password — and can
  // reject the write or patch the payload. A patched body is re-validated:
  // the hook is external, so its output is no more trusted than the client's.
  if (!env.skipSyncHooks) {
    const hooked = await runSyncHooks(ctx, {
      tenantId: env.tenantId ?? null,
      collection: collection.slug,
      phase: "beforeCreate",
      id: null,
      data,
      actor: { userId: env.userId, email: env.email ?? null, roles: env.roles },
    });
    if (hooked.data !== data) {
      data = hooked.data;
      validateBody(data, collection.fields, false, perm.fields);
    }
  }

  if (collection.singleton) {
    const existingOne = await queryAll<{ one: number }>(
      ctx,
      sql`SELECT 1 AS one FROM ${fromOf(collection)} ${whereOf(tenantFilter(collection, authOf(env)), deletedFilter(collection))} LIMIT 1`,
      env.db,
    );
    if (existingOne[0]) {
      throw new AppError("VALIDATION", "This collection is a singleton and already has a row");
    }
  }
  const now = nowFor(ctx.dialect);

  const cols: string[] = [collection.pkColumn];
  const vals: unknown[] = [id];
  if (collection.hasCreatedAt) {
    cols.push(collection.createdAtColumn ?? "created_at");
    vals.push(now);
  }
  if (collection.hasUpdatedAt) {
    cols.push(collection.updatedAtColumn ?? "updated_at");
    vals.push(now);
  }
  if (collection.ownerScoped && !collection.adopted) {
    cols.push("owner_id");
    vals.push(env.userId);
  }
  if (collection.tenantScoped) {
    if (!env.tenantId) {
      throw new AppError(
        "VALIDATION",
        "Active tenant could not be resolved; cannot insert into tenant-scoped collection",
      );
    }
    cols.push("tenant_id");
    vals.push(env.tenantId);
  }
  // Auto-filled columns are computed + written server-side (client input was
  // rejected by validateBody), so they can't be spoofed.
  for (const f of collection.fields) {
    if (!f.onCreate) continue;
    const v = resolveAutoFill(f.onCreate, { now, userId: env.userId, tenantId: env.tenantId });
    if (v === undefined) continue;
    const stored = serialize(v, f.type, ctx.dialect);
    cols.push(f.name);
    vals.push(stored);
    // Feed the response / event / index the read-form value (e.g. an ISO
    // timestamp) so it matches what a subsequent GET returns.
    data[f.name] = deserialize(stored, f.type, ctx.dialect);
  }
  // Sequence columns — the document number this row gets. Allocated LAST in the
  // validation phase, once the row is known to be insertable, so a payload that
  // was going to be rejected anyway doesn't burn a number off the series. It
  // still can't be gap-free (the insert itself may fail on a constraint the
  // validator doesn't model), but the common case of a bad request no longer
  // leaves a hole. Deliberately NOT routed through `emit`: the value has to
  // exist before the INSERT is built, so the counter is bumped against ctx.db,
  // outside any atomic batch's transaction — see `./sequence`.
  const seqFields = sequenceFieldsOf(collection.fields);
  if (seqFields.length > 0) {
    const issued = await nextSequenceValues(
      ctx,
      env.tenantId,
      collection.slug,
      seqFields,
      new Date(),
      env.sequencePool,
    );
    for (const [name, value] of Object.entries(issued)) {
      cols.push(name);
      vals.push(value);
      // Feed the response / event / index the issued value, so a client that
      // just created an invoice can show its number without re-reading.
      data[name] = value;
    }
  }
  // Slug columns — the URL this row is addressed by. Resolved HERE, after the
  // sync hooks have had their say and after the sequence above, for two
  // reasons: a hook that fills in the title must be able to feed the fold, and
  // a slug is allowed to fold from a freshly-issued document number.
  //
  // Written onto `data` rather than pushed straight at the INSERT so the 201
  // body, the realtime event, the activity row and the FTS/embed text all say
  // what the column will hold — the same rule geo, money, phone and email each
  // had to learn. The generic column loop below then picks it up like any other
  // value, so nothing here has to know how a text column is serialized.
  if (slugFieldsOf(collection.fields).length > 0) {
    applySlugs(data, await resolveSlugsForWrite(ctx, collection, data, { db: env.db }));
  }
  // Order columns — where this row lands in the list it belongs to. A caller
  // that STATES a position keeps it (a CSV import, a restore and a template's
  // sample rows all carry their own arrangement, and overruling them would
  // scramble exactly the data that was already in order). One that says nothing
  // gets appended to the end.
  //
  // The value pushed is a SUBQUERY, not a number this process read: the database
  // evaluates it at insert time, so the second row of a batch sees the first and
  // two concurrent creates cannot both take the same position. Same move as the
  // rollup refresh, and the reason a fifty-row import numbers 1…50 rather than
  // giving every row the same 1.
  const orderFields = orderFieldsOf(collection.fields);
  const appendedOrder: OrderField[] = [];
  for (const f of orderFields) {
    const stated = data[f.name];
    if (stated !== undefined && stated !== null && stated !== "") continue;
    const scopeDef = f.spec.scope
      ? collection.fields.find((x) => x.name === f.spec.scope)
      : undefined;
    const scopeValue = scopeDef
      ? serializeField(data[scopeDef.name], scopeDef, ctx.dialect)
      : null;
    cols.push(f.name);
    vals.push(appendPositionSql(collection, env.tenantId, f, scopeValue));
    appendedOrder.push(f);
    // Drop an explicit null so the loop below doesn't name the column twice.
    delete data[f.name];
  }
  for (const f of collection.fields) {
    // `sequence` is skipped for the same reason `onCreate` is: the column was
    // already pushed above, and pushing it twice makes the INSERT name one
    // column twice — a syntax error on both dialects.
    if (data[f.name] === undefined || f.onCreate || f.sequence) continue;
    cols.push(f.name);
    vals.push(serializeField(data[f.name], f, ctx.dialect));
  }

  // The WITH CHECK, placed HERE and not earlier: everything above may still
  // rewrite `data` — sync hooks, geo/money/phone canonicalisation, auto-filled
  // columns, an issued sequence number, a folded slug, an appended order — and
  // judging the caller's raw payload instead of the row that is about to exist
  // would be checking a different object than the one the rule is about.
  //
  // The stamped columns are folded in because a condition may name them and
  // they are not in `data`: `owner_id` is server-set from the session, and
  // `tenant_id` likewise. An `appendPositionSql` order column is deliberately
  // NOT resolved — it is a subquery the database evaluates at insert time, so
  // no value exists to judge, and a rule keyed on a hand-arranged position is
  // not a shape this is for.
  assertWriteConditions(
    env,
    perm,
    {
      ...data,
      [collection.pkColumn]: id,
      ...(collection.ownerScoped && !collection.adopted ? { owner_id: env.userId } : {}),
      ...(collection.tenantScoped ? { tenant_id: env.tenantId } : {}),
    },
    "create",
  );

  const colSql = sql.join(cols.map((n) => sql.identifier(n)), sql`, `);
  const valSql = sql.join(vals.map((v) => sql`${v}`), sql`, `);
  await emit(env, sql`INSERT INTO ${sql.identifier(table)} (${colSql}) VALUES (${valSql})`);
  // Translations sidecar: one INSERT per locale touched (no conflict possible on
  // a fresh row). Emitted through the same chokepoint so it joins the atomic
  // batch / transaction and rolls back with the base row.
  if (!splitIsEmpty(localeSplit)) {
    const byName = new Map<string, FieldDef>(collection.fields.map((f) => [f.name, f]));
    for (const [loc, fieldMap] of localeSplit.localePatches) {
      await emit(env, sidecarInsert(table, id, loc, fieldMap, byName, ctx.dialect));
    }
  }
  if (usesOwnershipSideTable(collection) && env.userId) {
    await emit(
      env,
      sql`INSERT INTO ${sql.identifier("item_ownership")} (${sql.identifier("collection_id")}, ${sql.identifier("item_id")}, ${sql.identifier("owner_id")}, ${sql.identifier("created_at")})
          VALUES (${collection.id}, ${id}, ${env.userId}, ${now})`,
    );
  }
  // The position the database chose is only knowable once the INSERT has run —
  // which is the price of it being a subquery, and worth paying. Read it onto
  // the payload so the 201 body, the realtime event, the activity row and the
  // client's offline store all say where the row actually is. Skipped while
  // COLLECTING an atomic batch: nothing has executed yet, so there is nothing to
  // read (see readBackPositions).
  if (appendedOrder.length > 0 && !env.collect) {
    Object.assign(data, await readBackPositions(ctx, collection, id, appendedOrder, env.db));
  }
  // A new row always joins (or fails to join) some parent's aggregate — there
  // is no "touched no watched field" shortcut on a create.
  await emitRollupRefresh(env, { after: data, always: true });

  // Digest is persisted — scrub it from the payload before it feeds the
  // response, event, audit and embed/FTS side-effects.
  scrubHashFields(data, collection.fields);
  scrubPrivateFields(data, collection.fields);
  const out: Record<string, unknown> = { id, ...data, ...echoLocalized(localeSplit, env.locale) };
  if (collection.hasCreatedAt) out.createdAt = deserialize(now, "timestamp", ctx.dialect);
  if (collection.hasUpdatedAt) out.updatedAt = deserialize(now, "timestamp", ctx.dialect);
  if (collection.ownerScoped) out.ownerId = env.userId;
  const projected = projectFields(out, env.readFields);

  const sideEffects: SideEffect[] = [
    () => embedAndUpsert(ctx, collection, env.tenantId ?? null, id, data),
    () => indexFts(ctx, collection, id, data),
    () =>
      publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "created", data: out },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: env.tenantId ?? null },
      ),
    () =>
      recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: env.userId,
          tenantId: env.tenantId ?? null,
          action: "create",
          collection: collection.slug,
          itemId: id,
          ...env.meta,
          payload: data,
          response: { data: projected },
          durationMs: env.durationMs(),
          impersonatedBy: env.impersonatedBy ?? null,
        },
      ),
  ];
  return { id, data: projected, warnings: warnings.length ? warnings : undefined, sideEffects };
};

export const performUpdate = async (
  env: WriteEnv,
  id: string,
  patchIn: Record<string, unknown>,
  perm: ResolvedPerm,
  opts?: {
    /** Optimistic-concurrency precondition: the `updatedAt` the caller loaded
     *  the row with. When set and the row has moved since, the update is
     *  refused with 409 CONFLICT instead of silently last-write-winning. */
    ifUnmodifiedSince?: string;
    /** Bypass staged-edits interception and write the live row directly.
     *  Set by `?live=1` (route gates it on publish permission) and by the
     *  publish endpoint / cron when *applying* a staged patch. */
    live?: boolean;
  },
): Promise<WriteResult> => {
  assertNotReadOnlyImpersonation(env, "update");
  let patch = patchIn;
  const { ctx, collection } = env;
  const table = collection.physicalTable;
  // Split localized fields out before base validation/write (same as create).
  const localeSplit = splitLocalized(patch, collection.fields, env.locale);
  validateLocalePatches(localeSplit, collection.fields);
  validateBody(patch, collection.fields, true, perm.fields);
  normalizeGeoFields(patch, collection.fields);
  await validateRelations(patch, collection.fields, ctx, env.tenantId);
  await validateAppUserLinks(patch, collection.fields, ctx, env.tenantId);
  // Hash `hash`-typed fields; an empty/omitted value is dropped so the existing
  // digest is left untouched ("leave blank to keep").
  await hashIncomingFields(patch, collection.fields);

  // Same placement and reasoning as create: after hashing (so a hook never
  // sees plaintext), and a patched body is re-validated because the hook's
  // output is no more trusted than the client's.
  if (!env.skipSyncHooks) {
    const hooked = await runSyncHooks(ctx, {
      tenantId: env.tenantId ?? null,
      collection: collection.slug,
      phase: "beforeUpdate",
      id,
      data: patch,
      actor: { userId: env.userId, email: env.email ?? null, roles: env.roles },
    });
    if (hooked.data !== patch) {
      patch = hooked.data;
      validateBody(patch, collection.fields, true, perm.fields);
    }
  }

  const tenantWhere = tenantFilter(collection, authOf(env));
  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere, deletedFilter(collection))} LIMIT 1`,
    env.db,
  );
  if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
  const beforeRow = deserializeRow(existing[0], collection.fields, ctx.dialect, collection.ownerScoped);

  // Money, like the geocode below, has to wait for `existing`: a patch that
  // sets only `total` on a per-row-currency collection takes its currency from
  // the row it is being applied to, and there is nowhere else to read it. The
  // guard runs first — a patch that moves the row to a currency with a
  // different number of decimals reinterprets the integer already in the
  // column, so it is refused unless the amount is restated in the same write.
  //
  // The consequence of the ordering is that a `beforeUpdate` sync hook observes
  // money exactly as the caller sent it, where on create it sees the canonical
  // form. Both are validated; only the shape differs.
  try {
    assertCurrencyChangeIsSafe(patch, collection.fields, existing[0]);
    canonicalizeMoneyFields(patch, collection.fields, { existing: existing[0] });
    // Phone waits for `existing` for the same reason money does, in the milder
    // form: a patch that sets only `phone` on a collection whose region lives in
    // a sibling column reads that column off the row it is patching.
    canonicalizePhoneFields(patch, collection.fields, { existing: existing[0] });
    // Email needs no `existing` — an address carries everything required to
    // fold it, which is the same asymmetry that spared it a read edge.
    canonicalizeEmailFields(patch, collection.fields);
    // URL needs no `existing` either, and for the same reason as email: an
    // address carries everything required to fold it.
    canonicalizeUrlFields(patch, collection.fields);
  } catch (e) {
    throw new AppError("VALIDATION", (e as Error).message);
  }

  // Re-derive a point when the patch moved the address it was derived from — a
  // patch that changes only `city` still has to resolve against the `address`
  // it did not mention, hence the merged row. A patch that touches no source
  // column re-resolves nothing, so an unrelated save never spends a provider
  // call. This is the one geo step that must run AFTER `existing` is loaded.
  if (!env.skipGeocode) {
    await applyAutoGeocode(ctx, collection.fields, patch, { ...beforeRow, ...patch }, {
      touched: (f) => patchTouchesSources(f, patch),
    });
  }

  // Optimistic-concurrency guard: refuse the write when the row moved after
  // the caller loaded it. Compared as epoch ms so ISO-format differences
  // between dialects don't matter. Advisory and opt-in — callers that don't
  // send the precondition keep today's last-write-wins behavior.
  if (opts?.ifUnmodifiedSince !== undefined && collection.hasUpdatedAt) {
    const expectedMs = new Date(opts.ifUnmodifiedSince).getTime();
    if (Number.isNaN(expectedMs)) {
      throw new AppError("VALIDATION", "Invalid If-Unmodified-Since value — expected a timestamp");
    }
    const currentRaw = beforeRow.updatedAt;
    const currentMs =
      currentRaw instanceof Date ? currentRaw.getTime() : new Date(String(currentRaw ?? "")).getTime();
    if (!Number.isNaN(currentMs) && currentMs !== expectedMs) {
      throw new AppError("CONFLICT", "This record was modified after you loaded it", {
        currentUpdatedAt: currentRaw ?? null,
      });
    }
  }

  // Enforce conditional `required` against the POST-patch row: a rule that
  // references fields the PATCH omits is still judged against the merged result.
  const mergedForConditions: Record<string, unknown> = { ...beforeRow };
  for (const f of collection.fields) {
    if (patch[f.name] !== undefined) mergedForConditions[f.name] = patch[f.name];
  }
  enforceFieldConditions(mergedForConditions, collection.fields, authSubjectOf(env));
  enforceValidationRules(mergedForConditions, collection.fields, authSubjectOf(env));
  const warnings = collectFieldWarnings(mergedForConditions, collection.fields, authSubjectOf(env));

  // Lifecycle check. Sits here — before the staged-edits interception below —
  // for the same reason the validation above does: a staged save has to surface
  // the same 4xx a live one would, or an operator queues a move that will only
  // fail when someone else publishes it. `requires` is judged against the merged
  // row, so the write that cancels an order may supply its reason at the same
  // time. The moves are announced further down, after the row has actually
  // moved (a staged patch returns before that point and announces nothing).
  const transitions = assertTransitions({
    fields: collection.fields,
    before: beforeRow,
    patch,
    merged: mergedForConditions,
    roles: env.roles,
  });

  // Staged-edits interception: on a `stagedEdits` collection, an ordinary
  // PATCH against a *published* row never touches the live row — the (already
  // validated + hashed) patch is folded into the item's staged JSON patch
  // instead, and `publish` applies it later. Draft/archived rows and `live`
  // callers fall through to the normal write below. Sits after validation so
  // a staged save surfaces the same 4xx a live save would.
  if (
    collection.versioned &&
    collection.stagedEdits &&
    !opts?.live &&
    (beforeRow as Record<string, unknown>)._status === "published"
  ) {
    // Judged HERE, on the way in, and not only at the live UPDATE below.
    //
    // This branch returns before `assertWriteConditions` ever runs, so a staged
    // patch used to be stored unjudged. Manual publish re-checks it — the
    // publish route threads the caller's real conditions — but the cron sweep
    // applies the SAME patch with `conditions: null`, justified in
    // `scheduled-publish.ts` by "the scheduler is publishing what an operator
    // already staged and approved". That premise holds only while `update` is
    // an operator-only verb, and a collection that grants it to an end-user
    // makes it false: the staged patch is then authored by someone whose
    // permission nobody re-asks about.
    //
    // Checking on the way in is the fix that does not depend on who applies it
    // later. A patch that could not be written live cannot be staged either.
    assertWriteConditions(env, perm, { ...beforeRow, ...patch }, "update");

    // Canonical staged shape: base fields post-hash from `patch`; localized
    // fields as their full `{locale: value}` map (splitLocalized with a null
    // write-locale routes maps back into the sidecar on apply); a locale-less
    // null (clear-all-locales) stays a null.
    const stagedPatch: Record<string, unknown> = { ...patch };
    for (const [loc, fieldMap] of localeSplit.localePatches) {
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
    for (const name of localeSplit.clearAll) stagedPatch[name] = null;

    const existingStaged = await getStagedRow(ctx, collection, id);
    const mergedStaged: Record<string, unknown> = {
      ...(existingStaged?.data ?? {}),
      ...stagedPatch,
    };
    await emit(
      env,
      stagedUpsertSql(
        ctx.dialect,
        collection.id,
        id,
        env.tenantId ?? null,
        mergedStaged,
        env.userId,
      ),
    );
    // Response: the live row with the staged patch previewed on top, flagged
    // `_staged`. `updatedAt` is NOT bumped — the live row didn't move.
    const preview: Record<string, unknown> = {
      ...beforeRow,
      ...stagedViewOf(mergedStaged, collection.fields),
    };
    const projectedPreview = projectFields(preview, env.readFields);
    // Set after projection — `_staged` is a system annotation, not a field.
    projectedPreview._staged = true;
    const auditPatch = stagedViewOf(stagedPatch, collection.fields);
    const sideFx: SideEffect[] = [
      () =>
        recordActivity(
          { db: ctx.db, dialect: ctx.dialect },
          {
            userId: env.userId,
            tenantId: env.tenantId ?? null,
            action: "update",
            collection: collection.slug,
            itemId: id,
            ...env.meta,
            payload: { ...auditPatch, _staged: true },
            response: { data: projectedPreview },
            durationMs: env.durationMs(),
            impersonatedBy: env.impersonatedBy ?? null,
          },
        ),
    ];
    return {
      id,
      data: projectedPreview,
      warnings: warnings.length ? warnings : undefined,
      sideEffects: sideFx,
    };
  }

  // Slug columns — resolved only for the fields this patch actually NAMES.
  //
  // That condition is the whole update-side design. A slug is a published URL,
  // and re-folding it because somebody fixed a typo in the headline would break
  // every link to the row silently — which is precisely the damage the
  // `redirects` collections in the blog and ecommerce templates exist to repair
  // by hand. So a patch that does not mention the slug leaves it exactly as it
  // was, and one that CLEARS it re-derives from what the title now says, which
  // is how "regenerate this slug" stays a discoverable action with no new API.
  //
  // Sources are read off the merged row, not the patch: clearing the slug
  // without restating the title still has to fold from the title the row holds.
  // `excludeId` keeps the row from seeing its own current slug as taken and
  // suffixing itself a little further on every save.
  //
  // Placed after the staged-edits branch above returns, so a staged save keeps
  // the operator's raw intent and does not claim a slug for a row that may
  // never be published — the value resolves on the live write that applies it.
  const slugFields = slugFieldsOf(collection.fields);
  if (slugFields.length > 0 && slugFields.some((f) => patch[f.name] !== undefined)) {
    const merged: Record<string, unknown> = { ...beforeRow, ...patch };
    const outcomes = (
      await resolveSlugsForWrite(ctx, collection, merged, { excludeId: id, db: env.db })
    ).filter((o) => patch[o.field] !== undefined);
    applySlugs(patch, outcomes);
  }

  const now = nowFor(ctx.dialect);
  const sets: SQL[] = [];
  if (collection.hasUpdatedAt) {
    sets.push(sql`${sql.identifier(collection.updatedAtColumn ?? "updated_at")} = ${now}`);
  }
  for (const f of collection.fields) {
    if (patch[f.name] === undefined) continue;
    sets.push(sql`${sql.identifier(f.name)} = ${serializeField(patch[f.name], f, ctx.dialect)}`);
  }
  // Re-parenting moves the row into a DIFFERENT list, where its old position
  // means nothing and very likely collides with a row already holding it — the
  // one state a move cannot survive. So a patch that changes the scope column
  // and says nothing about the position re-appends to the end of the list the
  // row just joined, which is where a person who drags a lesson into another
  // module expects to find it. A patch that states both is left alone.
  const reappendedOrder: OrderField[] = [];
  for (const f of orderFieldsOf(collection.fields)) {
    if (!f.spec.scope) continue;
    if (patch[f.name] !== undefined) continue;
    const scopeDef = collection.fields.find((x) => x.name === f.spec.scope);
    if (!scopeDef || patch[scopeDef.name] === undefined) continue;
    const nextScope = serializeField(patch[scopeDef.name], scopeDef, ctx.dialect);
    if (sameScope(nextScope, existing[0]?.[scopeDef.name])) continue;
    sets.push(
      sql`${sql.identifier(f.name)} = ${appendPositionSql(collection, env.tenantId, f, nextScope)}`,
    );
    reappendedOrder.push(f);
  }
  // Auto-filled-on-update columns are computed + written server-side (client
  // input was rejected by validateBody). Fold the value into `patch` so the
  // SET below emits it and the refreshed-row merge reflects it.
  for (const f of collection.fields) {
    if (!f.onUpdate) continue;
    const v = resolveAutoFill(f.onUpdate, { now, userId: env.userId, tenantId: env.tenantId });
    if (v === undefined) continue;
    const stored = serialize(v, f.type, ctx.dialect);
    sets.push(sql`${sql.identifier(f.name)} = ${stored}`);
    patch[f.name] = deserialize(stored, f.type, ctx.dialect);
  }
  // The WITH CHECK for update, judged against the row AFTER the patch lands.
  //
  // `perm.whereSql` in the statement below is a different guarantee and always
  // was: it picks WHICH row may be touched. It says nothing about what the row
  // becomes, so under `{ org_id: { _eq: "$org.id" } }` a member could PATCH
  // their own row's `org_id` to another organization's and move it out of their
  // own — the update mirror of the create hole, and the reason both halves land
  // together.
  //
  // `beforeRow` is the deserialized snapshot taken before any change; the patch
  // laid over it is what will exist. Columns the patch does not mention keep
  // their old values, which is exactly what the condition should see.
  assertWriteConditions(env, perm, { ...beforeRow, ...patch }, "update");

  if (sets.length > 0) {
    await emit(
      env,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(sets, sql`, `)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
    );
  }
  // Translations sidecar: upsert each touched locale (preserving other locales /
  // fields), then NULL any field cleared with a locale-less null. The base
  // UPDATE above already bumped `updated_at` unconditionally, so a sidecar-only
  // PATCH still moves the row's version (the single-read ETag keys on it).
  if (!splitIsEmpty(localeSplit)) {
    const byName = new Map<string, FieldDef>(collection.fields.map((f) => [f.name, f]));
    for (const [loc, fieldMap] of localeSplit.localePatches) {
      await emit(env, sidecarUpsert(table, id, loc, fieldMap, byName, ctx.dialect));
    }
    for (const name of localeSplit.clearAll) {
      await emit(env, sidecarClear(table, id, name));
    }
  }
  // Same read-back as create, and for the same reason: the appended position is
  // the database's answer, so the response and the realtime event have to ask
  // for it rather than echo the value the row used to have in its old list.
  if (reappendedOrder.length > 0 && !env.collect) {
    Object.assign(patch, await readBackPositions(ctx, collection, id, reappendedOrder, env.db));
  }
  // Re-parenting counts as two changes: the row leaves one parent's total and
  // joins another's, so `before` and `after` are both refreshed. A patch that
  // touches no field the aggregate reads emits nothing.
  await emitRollupRefresh(env, { before: beforeRow, after: patch });

  // Digest is persisted — scrub it from the patch so the merge below, the
  // response, event and audit payload never carry it.
  scrubHashFields(patch, collection.fields);
  // Private columns must not re-enter the merged row below (beforeRow already
  // omits them via deserializeRow) so the response/event/index stay clean.
  scrubPrivateFields(patch, collection.fields);
  // Refreshed row: in-memory merge of the before-row + applied patch (the only
  // columns that changed are updated_at + the patched fields). Avoids a
  // post-write SELECT so the same code path works inside an atomic batch where
  // the write hasn't committed yet.
  const refreshedRow: Record<string, unknown> = { ...beforeRow };
  for (const f of collection.fields) {
    if (patch[f.name] !== undefined) refreshedRow[f.name] = patch[f.name];
  }
  // Reflect the localized fields this write touched (native value or map).
  Object.assign(refreshedRow, echoLocalized(localeSplit, env.locale));
  if (collection.hasUpdatedAt) refreshedRow.updatedAt = deserialize(now, "timestamp", ctx.dialect);
  const projected = projectFields(refreshedRow, env.readFields);

  const sideEffects: SideEffect[] = [
    () => embedAndUpsert(ctx, collection, env.tenantId ?? null, id, refreshedRow),
    () => indexFts(ctx, collection, id, refreshedRow),
    () =>
      publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        // `before` is server-only (reactive Stage 2): the emit chokepoint uses
        // it to compute each filtered subscriber's membership transition, then
        // strips it — it never reaches a client.
        { event: "updated", data: refreshedRow, before: beforeRow },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: env.tenantId ?? null },
      ),
    () =>
      recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: env.userId,
          tenantId: env.tenantId ?? null,
          action: "update",
          collection: collection.slug,
          itemId: id,
          ...env.meta,
          payload: patch,
          response: { data: projected },
          durationMs: env.durationMs(),
          impersonatedBy: env.impersonatedBy ?? null,
        },
      ),
    () =>
      recordRevision(
        { db: ctx.db, dialect: ctx.dialect },
        {
          collection: collection.slug,
          itemId: id,
          snapshot: beforeRow,
          userId: env.userId,
          tenantId: env.tenantId ?? null,
        },
      ),
  ];
  // Announce each lifecycle move to the automation plane — flows, webhooks,
  // integrations, event functions — and to nothing else.
  //
  // `dispatchEventHandlers` rather than `publishEvent`, deliberately. The row
  // has already gone out on the realtime bus as `updated`, permission-filtered
  // per subscriber; putting it out a second time under an event name the bus
  // does not model would both duplicate the traffic and, because an
  // unrecognised channel is ungated, hand the row to anyone who asked for it.
  // The three verbs a row can undergo stay the three verbs the bus carries.
  for (const t of transitions) {
    sideEffects.push(async () => {
      dispatchEventHandlers(
        ctx.env,
        `items:${collection.slug}`,
        { event: transitionEventName(t), data: refreshedRow, before: beforeRow },
        {
          db: ctx.db,
          dialect: ctx.dialect,
          email: ctx.email,
          fullCtx: ctx,
          tenantId: env.tenantId ?? null,
        },
      );
    });
  }
  return { id, data: projected, warnings: warnings.length ? warnings : undefined, sideEffects };
};

export const performDelete = async (
  env: WriteEnv,
  id: string,
  perm: ResolvedPerm,
): Promise<WriteResult> => {
  assertNotReadOnlyImpersonation(env, "delete");
  const { ctx, collection } = env;
  const table = collection.physicalTable;
  const tenantWhere = tenantFilter(collection, authOf(env));

  const existing = await queryAll<Record<string, unknown>>(
    ctx,
    sql`SELECT ${selectStar(collection)} FROM ${fromOf(collection)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere, deletedFilter(collection))} LIMIT 1`,
    env.db,
  );
  if (!existing[0]) throw new AppError("NOT_FOUND", "Item not found");
  const oldRow = deserializeRow(existing[0], collection.fields, ctx.dialect, collection.ownerScoped);

  // Delete hooks can only veto — a `data` patch has nothing to patch — so the
  // returned payload is ignored and only the allow/deny verdict matters.
  if (!env.skipSyncHooks) {
    await runSyncHooks(ctx, {
      tenantId: env.tenantId ?? null,
      collection: collection.slug,
      phase: "beforeDelete",
      id,
      data: oldRow,
      actor: { userId: env.userId, email: env.email ?? null, roles: env.roles },
    });
  }

  if (collection.softDelete) {
    // Bump `updated_at` alongside `deleted_at` so the soft-delete surfaces in the
    // incremental changefeed (offline sync) — a tombstone whose `updated_at`
    // didn't move would fall before the client's cursor and never sync.
    const now = nowFor(ctx.dialect);
    const softSets = [sql`${sql.identifier("deleted_at")} = ${now}`];
    if (collection.hasUpdatedAt) {
      softSets.push(sql`${sql.identifier(collection.updatedAtColumn ?? "updated_at")} = ${now}`);
    }
    await emit(
      env,
      sql`UPDATE ${sql.identifier(table)} SET ${sql.join(softSets, sql`, `)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
    );
  } else {
    await emit(
      env,
      sql`DELETE FROM ${sql.identifier(table)} ${whereOf(pkEq(collection.pkColumn, id), perm.whereSql, tenantWhere)}`,
    );
    if (usesOwnershipSideTable(collection)) {
      await emit(
        env,
        sql`DELETE FROM ${sql.identifier("item_ownership")}
            WHERE ${sql.identifier("collection_id")} = ${collection.id}
            AND ${sql.identifier("item_id")} = ${id}`,
      );
    }
    // Translations sidecar rows go with a hard delete (SQLite/D1 have no FK
    // cascade). Only emit when the collection actually has a sidecar table, else
    // the DELETE would target a non-existent table.
    if (sidecarFields(collection.fields).length > 0) {
      await emit(env, sidecarDeleteRow(table, id));
    }
  }

  // Deleting the row obsoletes any staged patch for it. Guarded on `versioned`
  // (not `stagedEdits`) so patches left behind by a toggled-off setting still
  // get cleaned up.
  if (collection.versioned) {
    await emit(env, stagedDeleteSql(collection.id, id));
  }

  // The row has left every aggregate that counted it — soft-deletes included,
  // since the refresh subquery filters `deleted_at IS NULL`.
  await emitRollupRefresh(env, { before: oldRow, always: true });

  // App-layer ON DELETE relational triggers: null-out or cascade rows in other
  // collections that reference this one (no DB-level FKs in v1). Runs on both
  // hard and soft delete so a soft-deleted target still detaches its children.
  const touched = await enforceOnDeleteTriggers(ctx, env.tenantId, collection.slug, id, (stmt) =>
    emit(env, stmt),
  );
  // Those triggers move rows with set-based SQL and can't name the parents they
  // affected, so anything rolling up over a collection they touched is restated
  // wholesale. Nothing is emitted when no trigger fired, which is the norm.
  for (const slug of touched) {
    for (const stmt of await rollupRefreshAllStatements(ctx, env.tenantId, slug)) {
      await emit(env, stmt);
    }
  }

  const sideEffects: SideEffect[] = [
    () => deleteVector(ctx, collection, env.tenantId ?? null, id),
    () => deleteFts(ctx, collection, id),
    () =>
      publishEvent(
        ctx.env,
        `items:${collection.slug}`,
        { event: "deleted", data: oldRow },
        { db: ctx.db, dialect: ctx.dialect, email: ctx.email, fullCtx: ctx, tenantId: env.tenantId ?? null },
      ),
    () =>
      recordActivity(
        { db: ctx.db, dialect: ctx.dialect },
        {
          userId: env.userId,
          tenantId: env.tenantId ?? null,
          action: "delete",
          collection: collection.slug,
          itemId: id,
          ...env.meta,
          payload: oldRow,
          response: { ok: true },
          durationMs: env.durationMs(),
          impersonatedBy: env.impersonatedBy ?? null,
        },
      ),
    () =>
      recordRevision(
        { db: ctx.db, dialect: ctx.dialect },
        {
          collection: collection.slug,
          itemId: id,
          snapshot: oldRow,
          userId: env.userId,
          tenantId: env.tenantId ?? null,
        },
      ),
  ];
  return { id, data: oldRow, sideEffects };
};
