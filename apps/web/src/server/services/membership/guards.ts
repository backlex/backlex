/**
 * The two rules that keep a membership list governable, written once for both
 * planes.
 *
 * They existed only on the app plane, in `services/app-orgs.ts`, where they are
 * enforced on every mutation and pinned by 38 request-path tests. The platform
 * plane — the one that SUPERVISES the app plane — had neither: an admin could
 * delete the sole owner of a workspace with one unconfirmed click, there was no
 * ownership-transfer route to recover, and no route to change a member's role
 * at all. The customer-facing plane treated "an org can never be ownerless" as
 * a hard invariant with a test; the plane above it did not have the guard.
 *
 * So the rules move here and both planes call them. Two implementations of one
 * invariant is the shape that let them diverge in the first place — and the
 * divergence was silent, because each plane's tests only ever exercised its own
 * copy.
 *
 * The vocabularies differ and that is fine: an app-plane org has
 * `owner > admin > member`, a workspace adds `editor` between admin and member
 * (deprecated, folded into `member` at the HTTP boundary, still readable on
 * rows written before that). Rank is passed in rather than assumed, so neither
 * plane has to pretend it has the other's ladder.
 */
import { AppError } from "@backlex/core";

/** Higher outranks lower. A rank of 0 means "not a member". */
export type RankMap = Readonly<Record<string, number>>;

/**
 * Workspace membership ladder.
 *
 * `editor` sits between `admin` and `member` because rows written before it was
 * deprecated still carry it, and a guard that treated an unknown string as rank
 * 0 would quietly let anyone act on those people. Reading a value the API no
 * longer accepts is a different thing from accepting it.
 */
export const WORKSPACE_RANK: RankMap = {
  owner: 4,
  admin: 3,
  editor: 2,
  member: 1,
};

/** App-plane organization ladder — mirrors `ORG_ROLE_RANK` in `@backlex/core`. */
export const ORG_RANK: RankMap = {
  owner: 3,
  admin: 2,
  member: 1,
};

/**
 * May this actor act on this target?
 *
 * Three rules, in order:
 *   - a null actor is the CONTROL PLANE acting on behalf of nobody (an operator
 *     through the admin API). Deliberately outside the ladder: you are the
 *     author of the workspace, so there is nobody above you to be protected
 *     from. `services/app-orgs.ts` already passed `actor: null` for exactly
 *     this and the meaning is preserved.
 *   - acting on YOURSELF is always allowed. Leaving, or demoting yourself, is
 *     not an escalation — and refusing it would strand a member who wants out.
 *   - otherwise the target must not OUTRANK the actor. Equal rank is ALLOWED:
 *     co-owners are peers, and one owner removing another is an ordinary act in
 *     a workspace with two of them. What is refused is acting UPWARDS — an
 *     `admin` demoting an `owner` — which is the escalation this exists to stop.
 *
 * The equal-rank case is the one worth stating, because it was briefly written
 * the other way here. `services/app-orgs.ts` has shipped the permissive reading
 * since organizations landed, with 38 request-path tests and a documented
 * contract, and tightening it during a refactor that was supposed to UNIFY the
 * two planes would have changed a live feature nobody asked to change. It also
 * had a concrete cost: an owner could no longer revoke a pending invitation that
 * named `owner`, because the invite row outranks nobody but ties with them.
 * `assertNotLastOwner` is what keeps a group from being emptied, not this.
 */
export const assertMayActOn = (
  actor: { id: string; role: string } | null,
  targetId: string,
  targetRole: string,
  rank: RankMap,
): void => {
  if (!actor) return;
  if (actor.id === targetId) return;
  const actorRank = rank[actor.role] ?? 0;
  const targetRank = rank[targetRole] ?? 0;
  if (targetRank > actorRank) {
    throw new AppError(
      "FORBIDDEN",
      `A "${actor.role}" can't act on a "${targetRole}"`,
    );
  }
};

/**
 * Refuse a change that would leave nobody in charge.
 *
 * Takes the count as a number rather than querying, because the two planes
 * count different tables and threading a query builder through here would put
 * dialect branching in a file whose subject is policy. The caller counts; this
 * decides.
 *
 * `role` is the target's CURRENT role: demoting or removing someone who is not
 * an owner can never produce an ownerless group, so the count is only consulted
 * when it can actually change the answer.
 */
export const assertNotLastOwner = (
  currentRole: string,
  ownerCount: number,
  what: "workspace" | "organization",
): void => {
  if (currentRole !== "owner") return;
  if (ownerCount > 1) return;
  throw new AppError(
    "VALIDATION",
    `This is the ${what}'s last owner — promote someone else first`,
  );
};

/**
 * Only an owner may mint an owner.
 *
 * Separate from `assertMayActOn` because it is about the role being GRANTED
 * rather than the person being acted on: an `admin` outranks a `member` and may
 * therefore act on them, but promoting that member to `owner` would hand out a
 * standing the admin does not hold. The app plane had this rule; the platform
 * plane had no promotion route at all, so it could not have had it.
 */
export const assertMayGrant = (
  actor: { id: string; role: string } | null,
  nextRole: string,
  rank: RankMap,
): void => {
  if (!actor) return;
  const actorRank = rank[actor.role] ?? 0;
  const nextRank = rank[nextRole] ?? 0;
  if (nextRank > actorRank) {
    throw new AppError(
      "FORBIDDEN",
      `A "${actor.role}" can't grant "${nextRole}"`,
    );
  }
};
