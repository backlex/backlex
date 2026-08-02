/**
 * Approvals — the pure half.
 *
 * Everything here is a function of its arguments: no clock, no database, no
 * network. The question "given these approvers and this policy, is it settled
 * yet, and how?" is the part that is easy to get subtly wrong and impossible to
 * test through four HTTP surfaces, so it lives on its own — same split as
 * `booking.ts`, where the slot math is pure and the DB half is a service.
 */

/** How many approvals settle a request. */
export const APPROVAL_POLICIES = ["all", "any", "quorum"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

/** Terminal states are everything but `pending`. */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const APPROVER_STATUSES = ["pending", "viewed", "approved", "rejected"] as const;
export type ApproverStatus = (typeof APPROVER_STATUSES)[number];

export const MAX_APPROVERS = 20;
export const MAX_REASON = 1000;
export const DEFAULT_EXPIRY_HOURS = 72;
export const MAX_EXPIRY_HOURS = 24 * 365;

/** Only the fields the outcome depends on — callers pass whole rows. */
export interface ApproverLike {
  status: string;
  orderIndex?: number;
}

export interface SettleInput {
  policy: ApprovalPolicy;
  /** Read only when `policy === "quorum"`. */
  quorum: number;
  approvers: ApproverLike[];
}

/**
 * Whether the request has reached a terminal outcome, and which.
 *
 * `null` means still pending. The rules, and why each is what it is:
 *
 * - **`all`** — every approver must approve. ONE rejection settles it as
 *   rejected immediately: there is no way back to unanimity, so continuing to
 *   collect approvals would only waste the other approvers' time.
 * - **`any`** — the first approval settles it. It is rejected only when
 *   EVERY approver has rejected; a single refusal under `any` is not a veto,
 *   which is the whole point of asking several people.
 * - **`quorum`** — `quorum` approvals settle it. It is rejected as soon as
 *   enough people have rejected that the quorum can no longer be reached
 *   (`rejected > total - quorum`), rather than waiting for the rest to answer
 *   a question whose result is already fixed.
 *
 * A request with no approvers can never settle by decision — the caller is
 * responsible for refusing to create one.
 */
export const settleOutcome = (
  input: SettleInput,
): "approved" | "rejected" | null => {
  const total = input.approvers.length;
  if (total === 0) return null;
  const approved = input.approvers.filter((a) => a.status === "approved").length;
  const rejected = input.approvers.filter((a) => a.status === "rejected").length;

  if (input.policy === "any") {
    if (approved >= 1) return "approved";
    if (rejected >= total) return "rejected";
    return null;
  }

  // `all` is quorum-of-everyone; expressing it that way keeps one code path
  // and makes the "can the target still be reached?" test identical.
  const target =
    input.policy === "all" ? total : Math.min(Math.max(1, input.quorum), total);

  if (approved >= target) return "approved";
  if (rejected > total - target) return "rejected";
  return null;
};

/**
 * Whose turn it is, for an `ordered` request.
 *
 * Returns the index of the first approver who has not decided. Everyone after
 * them is waiting, and their links must not open yet — otherwise "ordered"
 * would be advisory, and a second approver who happened to read their mail
 * first could decide ahead of the person meant to gate it.
 *
 * Callers pass approvers already sorted by `orderIndex`; sorting here would
 * hide a caller that forgot, and the DB query is what guarantees the order.
 */
export const currentTurn = (approvers: ApproverLike[]): number => {
  const i = approvers.findIndex(
    (a) => a.status !== "approved" && a.status !== "rejected",
  );
  return i;
};

/** Whether this approver may decide right now. */
export const canDecide = (
  approvers: ApproverLike[],
  index: number,
  ordered: boolean,
): boolean => {
  const self = approvers[index];
  if (!self) return false;
  if (self.status === "approved" || self.status === "rejected") return false;
  if (!ordered) return true;
  return currentTurn(approvers) === index;
};

/**
 * Where an `approval.request` step is allowed to sit.
 *
 * The step suspends the flow, and its continuation is "every operation AFTER
 * it at the top level". Inside `onSuccess` / `onError` / `then` / `else` there
 * is no such scope: the runner would park the top-level remainder and silently
 * lose the rest of the branch the author wrote. Unlike a long `delay`, it also
 * cannot degrade to waiting inline.
 *
 * So a nested one is refused at SAVE time rather than discovered at run time,
 * when the only symptom is a request nothing ever resumes.
 *
 * Returns a human-readable path to the first offender, or `null` if the tree
 * is fine. Takes `unknown` because callers hand it freshly-parsed JSON.
 */
export const findNestedApproval = (operations: unknown, path = "operations"): string | null => {
  if (!Array.isArray(operations)) return null;
  const BRANCHES = ["onSuccess", "onError", "then", "else", "onRejected"] as const;
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i] as Record<string, unknown> | null;
    if (!op || typeof op !== "object") continue;
    for (const branch of BRANCHES) {
      const nested = op[branch];
      if (!Array.isArray(nested)) continue;
      const here = `${path}[${i}].${branch}`;
      for (let j = 0; j < nested.length; j++) {
        const child = nested[j] as Record<string, unknown> | null;
        if (child && typeof child === "object" && child.type === "approval.request") {
          return `${here}[${j}]`;
        }
      }
      const deeper = findNestedApproval(nested, here);
      if (deeper) return deeper;
    }
  }
  return null;
};

/**
 * A settled request's outcome, expressed as the value to write onto the
 * subject row. `null` means "write nothing" — a `write_back` that names no
 * value for this outcome is how an operator says "only record approvals".
 */
export interface WriteBackSpec {
  collection?: string;
  id?: string;
  field?: string;
  approvedValue?: unknown;
  rejectedValue?: unknown;
}

export const writeBackPatch = (
  spec: WriteBackSpec | null | undefined,
  outcome: ApprovalStatus,
): { collection: string; id: string; data: Record<string, unknown> } | null => {
  if (!spec?.collection || !spec.id || !spec.field) return null;
  // `expired` writes the rejected value: to everything downstream, a request
  // nobody answered in time is a request that was not approved. Treating it as
  // a third case would mean every consumer had to handle a state that means
  // exactly what `rejected` already means.
  const value =
    outcome === "approved"
      ? spec.approvedValue
      : outcome === "rejected" || outcome === "expired"
        ? spec.rejectedValue
        : undefined;
  if (value === undefined) return null;
  return { collection: spec.collection, id: spec.id, data: { [spec.field]: value } };
};
