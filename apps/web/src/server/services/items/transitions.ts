/**
 * Status transitions on the write path — the thin server half.
 *
 * The decision itself is pure and lives in `@backlex/db/transitions`: the spec,
 * the two values, the caller's roles and the resulting row are all arguments.
 * What is left here is the plumbing that every write surface needs and none of
 * them should re-derive — which fields carry a lifecycle, what the row is moving
 * from, and how a refusal becomes an `AppError`.
 *
 * Two things are worth knowing before wiring a new write surface to it.
 *
 * **The graph is integrity; the roles are permission.** `roles: null` skips the
 * role gate and only the role gate. Server-authored writes — a flow, a booking,
 * a payment webhook, an approval resolution — bypass permissions by design and
 * have no user to judge, but an invoice going back to draft is wrong no matter
 * what wrote it. So they pass `null`, not "skip the whole check".
 *
 * **A restore is not a write.** Backup restore, external-DB migration and
 * template seeding load rows that already exist somewhere else, in whatever
 * state they are already in; making them replay a lifecycle from the start
 * would refuse most of the data. Those paths do not call this at all — they go
 * through `ingestRows`, which never has.
 *
 * @module
 */

import { and, eq, inArray, isNull, or } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError } from "@backlex/core";
import type { Ctx } from "../../context";
import {
  allowedMoves,
  type FieldDef,
  evaluateTransition,
  getChoiceValues,
  hasTransitions,
  isBlankStatus,
  isTerminal,
  type OfferedMove,
  type TransitionSpec,
} from "@backlex/db";

/** One move a write is making — what the transition event reports. */
export interface DetectedTransition {
  field: string;
  from: string;
  to: string;
}

/** The fields on a collection that carry a lifecycle. */
export const transitionFieldsOf = (fields: FieldDef[]): FieldDef[] =>
  fields.filter((f) => hasTransitions(f));

/**
 * Enforce the `initial` list on a create.
 *
 * A create has no `from`, so the only question a lifecycle can ask of it is
 * whether the row is allowed to *start* here. Roles are not consulted: `initial`
 * is a property of the value, and gating who may create a row is what the
 * `create` permission is for.
 */
export const assertInitialStates = (
  fields: FieldDef[],
  data: Record<string, unknown>,
  keyOf: (f: FieldDef) => string = (f) => f.name,
): void => {
  for (const f of transitionFieldsOf(fields)) {
    const value = data[keyOf(f)];
    if (isBlankStatus(value)) continue;
    // Same reason as the update path: choice membership is only enforced by
    // `validateValue` for the `dropdown` interface, and a lifecycle field's
    // values ARE its choices.
    if (!getChoiceValues(f).includes(String(value))) {
      throw new AppError(
        "VALIDATION",
        `Field "${f.name}": "${String(value)}" is not one of this field's values`,
      );
    }
    const verdict = evaluateTransition(f.transitions as TransitionSpec, {
      from: null,
      to: String(value),
      roles: null,
    });
    if (!verdict.ok) {
      throw new AppError("VALIDATION", `Field "${f.name}": ${verdict.message}`);
    }
  }
};

/**
 * Enforce every lifecycle move an update is making, and return the ones it made.
 *
 * `before` is the row as stored, `patch` the incoming change, `merged` the row
 * the write would produce — `requires` is judged against the last of the three
 * so that filling a cancellation reason in the same PATCH that cancels the row
 * is accepted.
 *
 * Returns the moves so the caller can announce them; a patch that names the
 * field but restates its current value transitions nothing and returns nothing.
 */
export const assertTransitions = (args: {
  fields: FieldDef[];
  before: Record<string, unknown>;
  patch: Record<string, unknown>;
  merged: Record<string, unknown>;
  /** Caller roles, or `null` for a server-authored write. See the module note. */
  roles: string[] | null;
  /** Payload key for a field — GraphQL's inputs are camelCase. */
  keyOf?: (f: FieldDef) => string;
}): DetectedTransition[] => {
  const { fields, before, patch, merged, roles } = args;
  const keyOf = args.keyOf ?? ((f: FieldDef) => f.name);
  const moves: DetectedTransition[] = [];
  for (const f of transitionFieldsOf(fields)) {
    const key = keyOf(f);
    if (patch[key] === undefined) continue;
    const from = before[f.name] ?? before[key];
    const to = patch[key];
    // Clearing a status is not a move along the graph — there is no `to` to
    // match a rule against. Left to `required` to reject when it should be.
    if (isBlankStatus(to)) continue;
    // The target must be one of the field's own choices, checked HERE and not
    // left to `validateValue` — which only enforces choice membership when the
    // interface is `dropdown`, so a `radio` (or any other choice-bearing
    // interface) accepts arbitrary text. That matters for two reasons: a rule
    // written `to: "*"` would otherwise let a caller move the row to a value
    // that is not in the lifecycle at all, and the accepted value goes on to
    // NAME the transition event, where a caller-chosen `paid:whatever` shares
    // its first segment with the real `paid` and would fire a flow armed for it.
    const choices = getChoiceValues(f);
    if (!choices.includes(String(to))) {
      throw new AppError(
        "VALIDATION",
        `Field "${f.name}": "${String(to)}" is not one of this field's values`,
        { field: f.name, to: String(to), refusal: "not_allowed" },
      );
    }
    const verdict = evaluateTransition(f.transitions as TransitionSpec, {
      from,
      to: String(to),
      roles,
      row: merged,
    });
    if (!verdict.ok) {
      const code = verdict.refusal === "forbidden_role" ? "FORBIDDEN" : "VALIDATION";
      throw new AppError(code, `Field "${f.name}": ${verdict.message}`, {
        field: f.name,
        from: isBlankStatus(from) ? null : String(from),
        to: String(to),
        refusal: verdict.refusal,
        ...(verdict.missing ? { missing: verdict.missing } : {}),
      });
    }
    if (!isBlankStatus(from) && String(from) !== String(to)) {
      moves.push({ field: f.name, from: String(from), to: String(to) });
    }
  }
  return moves;
};

/**
 * The channel + event name a move is announced under.
 *
 * The edge is IN the event name rather than in the payload, because that is
 * what makes it addressable by the trigger grammar flows already have:
 * `event:items:invoices:transition:status:*:paid` fires only when an invoice
 * reaches `paid`, with no condition to write and nothing to re-check. A flow
 * that wants every move subscribes to the `…:transition` prefix instead, since
 * `matchesTrigger` matches on whole colon-separated segments.
 *
 * Which is also why a choice value may not contain a colon on a field with
 * transitions — `validateTransitionSpec` refuses it at save time.
 */
export const transitionEventName = (t: DetectedTransition): string =>
  `transition:${t.field}:${t.from}:${t.to}`;

/**
 * Check that every role a transition rule gates on actually exists in this
 * workspace — the one half of spec validation that needs the database, exactly
 * as `validateRollupTargets` is for a rollup.
 *
 * Worth a query on every collection save because the failure it prevents is
 * silent and permanent: a rule gated on a role name nobody holds is not a
 * stricter rule, it is a move NOBODY can ever make, and the row it applies to
 * is stuck in whatever state it is in. A typo produces exactly that, and there
 * is no later moment where it announces itself.
 *
 * Bundled roles and workspace roles both count; a role row with a NULL
 * `tenant_id` is a platform-wide one and is visible from every workspace.
 */
export const validateTransitionRoles = async (
  ctx: Ctx,
  tenantId: string,
  fields: FieldDef[],
): Promise<void> => {
  const wanted = new Set<string>();
  for (const f of transitionFieldsOf(fields)) {
    for (const rule of (f.transitions as TransitionSpec).allow) {
      for (const r of rule.roles ?? []) wanted.add(r);
    }
  }
  if (wanted.size === 0) return;
  const t = ctx.dialect === "pg" ? pg.schema.roles : sqlite.schema.roles;
  const names = [...wanted];
  const rows = (await (ctx.db as any)
    .select({ name: t.name })
    .from(t)
    .where(
      and(inArray(t.name, names), or(eq(t.tenantId, tenantId), isNull(t.tenantId))),
    )) as Array<{ name: string }>;
  const found = new Set(rows.map((r) => r.name));
  const missing = names.filter((n) => !found.has(n));
  if (missing.length > 0) {
    throw new AppError(
      "VALIDATION",
      `Transition rule names role(s) that do not exist in this workspace: ${missing.join(", ")}`,
    );
  }
};

/**
 * Explain every move a caller could make on a row right now — the shape both
 * `GET /items/:slug/:id/transitions` and the admin's item form render.
 */
export interface FieldTransitions {
  field: string;
  /** The value the row holds now, or null when it has none yet. */
  current: string | null;
  /** True when no rule leads out of the current value — the lifecycle is over. */
  terminal: boolean;
  moves: OfferedMove[];
}

export const describeTransitions = (
  fields: FieldDef[],
  row: Record<string, unknown>,
  roles: string[] | null,
  /**
   * The caller's read field allow-list (`permission.fields`), or `null` for
   * "every field".
   *
   * Required, not optional-by-omission: holding `read` on a collection is not
   * holding it on every column, and this endpoint's whole job is to report a
   * field's VALUE. Without the clamp a role whose grant excludes `status`
   * could read it here, having been refused it on the row itself — the same
   * class of gap as an endpoint that resolves a permission and then ignores
   * its row condition.
   */
  readableFields: Set<string> | null,
): FieldTransitions[] => {
  return transitionFieldsOf(fields)
    .filter((f) => !readableFields || readableFields.has(f.name))
    .map((f) => {
      const spec = f.transitions as TransitionSpec;
      const current = row[f.name];
      return {
        field: f.name,
        current: isBlankStatus(current) ? null : String(current),
        terminal: !isBlankStatus(current) && isTerminal(spec, String(current)),
        moves: allowedMoves(spec, {
          from: current,
          roles,
          // The row is only read for `requires`, and a field the caller may not
          // read is one they cannot fill either — so an unreadable sibling
          // reports as still missing rather than as quietly satisfied.
          row: readableFields ? pickReadable(row, readableFields) : row,
          choices: getChoiceValues(f),
        }),
      };
    });
};

/** A shallow copy of a row holding only the fields the caller may read. */
const pickReadable = (
  row: Record<string, unknown>,
  allowed: Set<string>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (allowed.has(k)) out[k] = v;
  return out;
};
