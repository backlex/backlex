/**
 * Status transitions — the lifecycle a dropdown field is allowed to move through.
 *
 * Everything in this module is PURE. Deciding whether a move is legal needs the
 * spec, the two values, the caller's roles and the row the move would leave
 * behind — all four are arguments, none of them is a query. That is why the
 * whole decision lives here and not in the server: the admin's item form calls
 * {@link allowedMoves} to build the dropdown, the transitions endpoint calls
 * {@link evaluateTransition} to explain a refusal, and the write path calls the
 * same function to enforce it. One implementation, so the form cannot offer a
 * move the server will reject.
 *
 * It carries no imports, which is why `@backlex/db/transitions` is its own
 * package export — reaching it through the package root would drag the
 * migration bundles and their `*.sql` imports into the browser build.
 *
 * ## The shape of the problem
 *
 * Twenty-six of the twenty-seven schema templates declare a status dropdown —
 * 156 of them across 152 collections — and they are not labels, they are
 * lifecycles: `draft → open → paid → void`, `requested → approved → received →
 * completed`, `pending → approved → denied → cancelled`. A hundred and nineteen
 * of them contain a state a row is not supposed to come back out of.
 *
 * Nothing stopped it. Choice membership is enforced, so `status: "banana"` is a
 * 422 — but `paid → draft` is two legal values in sequence, and every rule
 * backlex has judges the row it would end up with. A `validation.rule` sees the
 * proposed row. A `FieldCondition` sees the proposed row. A permission condition
 * sees the row as stored. **None of them can see the value the field is changing
 * FROM**, so "an invoice may not go back to draft once it is paid" was not
 * expressible anywhere in the product.
 *
 * A transition spec is that missing half: the `from` side of the move.
 *
 * ## What it enforces, and what it deliberately does not
 *
 * Enforced: the edge itself (integrity), the roles allowed to take it
 * (permission), and the sibling fields it requires (completeness).
 *
 * The split matters at the boundaries. The GRAPH is data integrity — an invoice
 * going back to draft is wrong no matter who or what did it — so it is enforced
 * on flow, booking, payment and approval writes too, which bypass permissions
 * entirely. The ROLES are permission, so on those same server-authored writes
 * there is no user to check and the role gate does not apply. See
 * {@link evaluateTransition}'s `roles` argument being `null` for that case.
 *
 * Not enforced: reachability. A spec may describe a state no path leads to; the
 * admin draws the graph and it is the admin's to get right. Refusing to save it
 * would mean solving "is this graph connected" at every schema write for a
 * property nobody has asked for.
 *
 * @module
 */

/**
 * One allowed move, or a family of them.
 *
 * `from` and `to` each accept a single value, a list, or `"*"` for "any". The
 * wildcard is what keeps a real spec short: a lifecycle usually has one or two
 * edges that matter (`paid` is final, `cancelled` needs a reason) and a long
 * tail that is simply permitted.
 */
export interface TransitionRule {
  /** The value(s) the row is moving out of. `"*"` matches any current value. */
  from: string | string[];
  /** The value(s) the row may move into. `"*"` matches any target value. */
  to: string | string[];
  /**
   * Role names allowed to make this move. Omit ⇒ anyone who may update the row.
   *
   * A permission, not an integrity rule: server-authored writes (a flow, a
   * booking, a payment webhook) have no user and are not judged by it.
   */
  roles?: string[];
  /**
   * Sibling fields that must hold a value for this move to be accepted —
   * `cancelled` needs its `cancel_reason`, `shipped` needs its `tracking_number`.
   * Judged against the row as it would be AFTER the write, so filling the reason
   * in the same PATCH that cancels the row is enough.
   */
  requires?: string[];
  /** Verb for the button that makes this move ("Mark paid"). UI only. */
  label?: string;
}

/**
 * The lifecycle of one dropdown field: which value may follow which.
 *
 * Attached to a `FieldDef` as `transitions`. The field must carry
 * `options.choices` — an unbounded set of values has no lifecycle to describe,
 * and a `from` that is not a real choice is a rule that can never fire.
 */
export interface TransitionSpec {
  /** The allowed moves. A move matched by no rule is refused. */
  allow: TransitionRule[];
  /**
   * Values a NEW row may be created with. Omit ⇒ any choice.
   *
   * Also governs the row that has no value yet: a write that fills an empty
   * status is an initial assignment, not a move, because there is no `from`
   * to judge. That is deliberate — a field added to a collection that already
   * has rows leaves every one of them empty, and treating those as transitions
   * would strand rows nobody could edit.
   */
  initial?: string[];
}

/** True when a field's value is governed by a lifecycle. */
export const hasTransitions = (field: { transitions?: TransitionSpec }): boolean =>
  Boolean(field.transitions?.allow?.length);

/** Normalize a rule side (`"draft"` / `["draft","open"]` / `"*"`) to a matcher. */
const sideMatches = (side: string | string[], value: string): boolean => {
  if (side === "*") return true;
  if (Array.isArray(side)) return side.includes("*") || side.includes(value);
  return side === value;
};

/** Every concrete value a rule side names, wildcard excluded. */
const sideValues = (side: string | string[]): string[] =>
  (Array.isArray(side) ? side : [side]).filter((v) => v !== "*");

/** Treat undefined / null / "" as "this row has no status yet". */
export const isBlankStatus = (v: unknown): boolean =>
  v === undefined || v === null || v === "";

/** Why a move was refused. Each maps to a different HTTP status at the edge. */
export type TransitionRefusal =
  /** No rule allows this edge at all. 422 — the graph says no. */
  | "not_allowed"
  /** An edge exists but this caller's roles are not on it. 403. */
  | "forbidden_role"
  /** An edge exists and is permitted, but the row is missing what it asks for. 422. */
  | "missing_fields"
  /** Create (or filling a blank) with a value `initial` does not list. 422. */
  | "not_initial";

export type TransitionVerdict =
  | { ok: true; rule: TransitionRule | null }
  | {
      ok: false;
      refusal: TransitionRefusal;
      message: string;
      /** For `missing_fields`: the field names that were empty. */
      missing?: string[];
      /** For `forbidden_role`: the roles that would have been enough. */
      roles?: string[];
    };

export interface TransitionAttempt {
  /** The value the row holds now. Blank ⇒ judged as an initial assignment. */
  from: unknown;
  /** The value the write is proposing. */
  to: string;
  /**
   * The caller's roles, or `null` for a server-authored write (flow, booking,
   * payment sync, restore). `null` skips the role gate and ONLY the role gate —
   * the graph and the required fields still apply, because they are properties
   * of the data rather than of who is asking.
   */
  roles: string[] | null;
  /** The row as it would be after the write — `requires` is judged against it. */
  row?: Record<string, unknown>;
}

/**
 * Decide whether one move is allowed, and say why when it is not.
 *
 * The order of the checks is the order of the answers a caller wants: is this
 * edge in the graph at all, may *you* take it, and is the row ready for it. A
 * missing `cancel_reason` must not read as "you cannot cancel this".
 */
export const evaluateTransition = (
  spec: TransitionSpec,
  attempt: TransitionAttempt,
): TransitionVerdict => {
  const { from, to, roles, row } = attempt;

  // No `from` to judge: this is the row's first status, not a move.
  if (isBlankStatus(from)) {
    if (spec.initial && !spec.initial.includes(to)) {
      return {
        ok: false,
        refusal: "not_initial",
        message: `"${to}" is not a starting value — a new row begins as ${orList(spec.initial)}`,
      };
    }
    return { ok: true, rule: null };
  }

  const fromStr = String(from);
  // A write that restates the value it already holds is not a transition. It
  // has to pass, or every ordinary PATCH that echoes the whole row back would
  // be refused for a field it never intended to touch.
  if (fromStr === to) return { ok: true, rule: null };

  const edges = spec.allow.filter(
    (r) => sideMatches(r.from, fromStr) && sideMatches(r.to, to),
  );
  if (edges.length === 0) {
    const reachable = nextValues(spec, fromStr);
    const hint = reachable.length
      ? `from "${fromStr}" the row can move to ${orList(reachable)}`
      : `"${fromStr}" is a final state`;
    return {
      ok: false,
      refusal: "not_allowed",
      message: `Cannot move from "${fromStr}" to "${to}" — ${hint}`,
    };
  }

  // Several rules may cover one edge (a broad `"*" → "cancelled"` plus a
  // narrow one). The caller gets the benefit of ANY of them, so a rule is only
  // refused when every candidate refuses — and the refusal reported is the one
  // from the rule that got furthest.
  let roleRefusal: TransitionVerdict | null = null;
  let fieldRefusal: TransitionVerdict | null = null;
  for (const rule of edges) {
    if (rule.roles?.length && roles !== null) {
      if (!rule.roles.some((r) => roles.includes(r))) {
        roleRefusal ??= {
          ok: false,
          refusal: "forbidden_role",
          message: `Moving from "${fromStr}" to "${to}" is limited to ${orList(rule.roles)}`,
          roles: rule.roles,
        };
        continue;
      }
    }
    const missing = (rule.requires ?? []).filter((name) =>
      isBlankStatus(row?.[name]),
    );
    if (missing.length > 0) {
      fieldRefusal ??= {
        ok: false,
        refusal: "missing_fields",
        message: `Moving to "${to}" requires ${orList(missing)}`,
        missing,
      };
      continue;
    }
    return { ok: true, rule };
  }
  // A row that is merely incomplete is closer to allowed than one the caller
  // may not touch, so report the field refusal when both happened.
  return fieldRefusal ?? roleRefusal ?? {
    ok: false,
    refusal: "not_allowed",
    message: `Cannot move from "${fromStr}" to "${to}"`,
  };
};

/**
 * Every value reachable from `from` in one move, ignoring roles and required
 * fields. Used for the "…the row can move to x or y" half of a refusal message
 * and for the admin's dropdown; {@link allowedMoves} is the version that judges
 * a concrete caller and row.
 *
 * `choices` is needed only to expand a `to: "*"` rule — a wildcard target means
 * "any of this field's values", and the spec does not carry them.
 */
export const nextValues = (
  spec: TransitionSpec,
  from: string,
  choices?: string[],
): string[] => {
  const out = new Set<string>();
  for (const rule of spec.allow) {
    if (!sideMatches(rule.from, from)) continue;
    if (rule.to === "*" || (Array.isArray(rule.to) && rule.to.includes("*"))) {
      for (const c of choices ?? []) out.add(c);
      continue;
    }
    for (const v of sideValues(rule.to)) out.add(v);
  }
  out.delete(from);
  return [...out];
};

/** A move offered to a caller, with the verdict already computed. */
export interface OfferedMove {
  to: string;
  /** The rule's `label`, when it has one — "Mark paid". */
  label?: string;
  allowed: boolean;
  /** Why not, in the same words the write path would refuse with. */
  reason?: string;
  refusal?: TransitionRefusal;
  missing?: string[];
}

/**
 * Every move this caller could make on this row right now — the answer the item
 * form and the `transitions` endpoint both render.
 *
 * Includes the refused ones, with their reason: a button that is visibly
 * disabled because `cancel_reason` is empty tells an operator what to do, while
 * a button that is simply absent tells them nothing.
 */
export const allowedMoves = (
  spec: TransitionSpec,
  args: {
    from: unknown;
    roles: string[] | null;
    row?: Record<string, unknown>;
    /** The field's choices — the candidate set when `from` is blank or `to` is `*`. */
    choices: string[];
  },
): OfferedMove[] => {
  const { from, roles, row, choices } = args;
  const candidates = isBlankStatus(from)
    ? (spec.initial ?? choices)
    : nextValues(spec, String(from), choices);
  const moves: OfferedMove[] = [];
  for (const to of candidates) {
    const verdict = evaluateTransition(spec, { from, to, roles, row });
    const rule = verdict.ok
      ? verdict.rule
      : spec.allow.find(
          (r) =>
            !isBlankStatus(from) &&
            sideMatches(r.from, String(from)) &&
            sideMatches(r.to, to),
        ) ?? null;
    moves.push({
      to,
      ...(rule?.label ? { label: rule.label } : {}),
      allowed: verdict.ok,
      ...(verdict.ok
        ? {}
        : { reason: verdict.message, refusal: verdict.refusal, missing: verdict.missing }),
    });
  }
  return moves;
};

/** True when no rule leads out of `value` — the end of the lifecycle. */
export const isTerminal = (spec: TransitionSpec, value: string): boolean =>
  !spec.allow.some((r) => sideMatches(r.from, value));

const orList = (xs: string[]): string =>
  xs.length <= 1
    ? (xs[0] ?? "")
    : `${xs.slice(0, -1).map((x) => `"${x}"`).join(", ")} or "${xs[xs.length - 1]}"`;

/**
 * Shape validation for a {@link TransitionSpec} — everything checkable without
 * the database. The one half that needs it (do these role names exist in this
 * workspace) lives in the server's collection-save path, mirroring how a
 * rollup's cross-collection checks do.
 *
 * `choices` is the field's declared value set. Every `from` / `to` / `initial`
 * is checked against it, because the alternative to rejecting a typo is a rule
 * that silently never matches — and a lifecycle rule that never matches is
 * indistinguishable from no lifecycle at all until someone does the thing it
 * was supposed to prevent.
 */
export const validateTransitionSpec = (
  fieldName: string,
  spec: unknown,
  ctx: { choices: string[]; siblingFields: string[] },
): void => {
  const where = `Field "${fieldName}"`;
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new Error(`${where}: transitions must be an object`);
  }
  const s = spec as TransitionSpec;
  if (!Array.isArray(s.allow) || s.allow.length === 0) {
    throw new Error(`${where}: transitions.allow must be a non-empty array of rules`);
  }
  if (ctx.choices.length === 0) {
    throw new Error(
      `${where}: transitions need a field with a fixed set of values — give it options.choices first`,
    );
  }
  // A choice value becomes part of the flow trigger name a transition fires
  // (`items:<slug>:transition:<field>:<from>:<to>`), and that grammar is
  // colon-separated. Rejecting the character here is the only place it can be
  // caught before a trigger silently fails to match.
  for (const c of ctx.choices) {
    if (c.includes(":")) {
      throw new Error(
        `${where}: choice "${c}" cannot contain ":" on a field with transitions — the value names the flow trigger this move fires`,
      );
    }
  }
  const known = new Set(ctx.choices);
  const checkSide = (side: unknown, label: string, index: number): void => {
    const vals = Array.isArray(side) ? side : [side];
    if (vals.length === 0) {
      throw new Error(`${where}: transitions.allow[${index}].${label} cannot be empty`);
    }
    for (const v of vals) {
      if (typeof v !== "string" || v === "") {
        throw new Error(
          `${where}: transitions.allow[${index}].${label} must be a value, a list of values, or "*"`,
        );
      }
      if (v !== "*" && !known.has(v)) {
        throw new Error(
          `${where}: transitions.allow[${index}].${label} names "${v}", which is not one of this field's choices`,
        );
      }
    }
  };
  s.allow.forEach((rule, i) => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      throw new Error(`${where}: transitions.allow[${i}] must be an object`);
    }
    checkSide(rule.from, "from", i);
    checkSide(rule.to, "to", i);
    if (rule.roles !== undefined) {
      if (!Array.isArray(rule.roles) || rule.roles.some((r) => typeof r !== "string" || !r)) {
        throw new Error(`${where}: transitions.allow[${i}].roles must be a list of role names`);
      }
    }
    if (rule.requires !== undefined) {
      if (!Array.isArray(rule.requires)) {
        throw new Error(`${where}: transitions.allow[${i}].requires must be a list of field names`);
      }
      for (const name of rule.requires) {
        if (typeof name !== "string" || !name) {
          throw new Error(`${where}: transitions.allow[${i}].requires must be a list of field names`);
        }
        if (name === fieldName) {
          throw new Error(
            `${where}: transitions.allow[${i}].requires cannot name the status field itself`,
          );
        }
        if (!ctx.siblingFields.includes(name)) {
          throw new Error(
            `${where}: transitions.allow[${i}].requires names "${name}", which is not a field on this collection`,
          );
        }
      }
    }
    if (rule.label !== undefined && (typeof rule.label !== "string" || !rule.label)) {
      throw new Error(`${where}: transitions.allow[${i}].label must be a non-empty string`);
    }
  });
  if (s.initial !== undefined) {
    if (!Array.isArray(s.initial) || s.initial.length === 0) {
      throw new Error(`${where}: transitions.initial must be a non-empty list of values`);
    }
    for (const v of s.initial) {
      if (typeof v !== "string" || !known.has(v)) {
        throw new Error(
          `${where}: transitions.initial names "${String(v)}", which is not one of this field's choices`,
        );
      }
    }
  }
};
