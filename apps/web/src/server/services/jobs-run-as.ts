/**
 * The identity a queued job acts as.
 *
 * **The rule this file exists to enforce: a job payload carries who, never what
 * they may do.** `runAs` is `{ userId, tenantId }` and nothing else. Role names,
 * the compiled `perm.whereSql`, the field allow-list — all of it is resolved
 * again here, at run time, from the database.
 *
 * Why that matters more for these jobs than for an agent turn: the six
 * operations that moved onto the queue include row-level ones. A CSV import
 * writes rows, an export reads them, a geocode backfill both reads addresses and
 * ships them to a third-party provider. The bundled self-service roles grant
 * `update` conditioned on `app_user_id = $user.id`, so a backfill that ran
 * unscoped — or scoped by a filter serialized an hour earlier — would hand one
 * end user every other customer's address. Running these as `SYSTEM_AUTH` is not
 * a shortcut, it is a privilege escalation with a queue in front of it.
 *
 * A serialized filter is the subtler half of the same bug: it would still be
 * enforcing the grant the user held when they pressed the button. Revoke their
 * role while the job sits in the queue and the revocation would not take. So the
 * payload cannot carry one, and this module is the only way a handler gets a
 * subject to resolve against.
 *
 * What is deliberately NOT reconstructed: API-key scoping (`apiKeyRoleId`,
 * `apiKeyId`, per-key MCP guards), impersonation, and the app plane. A job runs
 * as a control-plane user or it does not run. Same shape of guarantee as
 * `agents/async-run.ts` — see the caution there about what a "runs as the user"
 * promise does and does not cover.
 */
import type { AuthSubject } from "@backlex/core";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { Ctx } from "../context";
import { loadUserEmail } from "../middleware/session";
import { resolveTenantAccess } from "../middleware/tenant";

/** Stamped from the enqueuing request. A client never supplies it. */
export interface RunAs {
  userId: string;
  tenantId: string;
}

export const isRunAs = (v: unknown): v is RunAs => {
  const r = v as Partial<RunAs> | null;
  return Boolean(
    r && typeof r.userId === "string" && r.userId && typeof r.tenantId === "string" && r.tenantId,
  );
};

/**
 * Read `runAs` off a job payload, refusing anything else. A job that reached a
 * permission-scoped handler without one is a bug in the enqueuer, and the only
 * safe reading of it is "no identity", never "the system".
 *
 * `jobTenantId` is checked rather than assumed. Every handler scopes its work
 * by `job.tenantId` while resolving its authority from `runAs.tenantId`, and
 * nothing today can produce a divergent pair — `startLongJob` writes both from
 * one source, and the client allow-list refuses to enqueue these types at all.
 * But that is a property of every writer, and a property of every writer is one
 * a new writer can break. Asserting it here makes it local.
 */
export const requireRunAs = (
  payload: Record<string, unknown>,
  type: string,
  jobTenantId?: string | null,
): RunAs => {
  const runAs = payload.runAs;
  if (!isRunAs(runAs)) {
    throw new Error(`${type} job has no runAs identity`);
  }
  if (jobTenantId != null && runAs.tenantId !== jobTenantId) {
    throw new AppError(
      "FORBIDDEN",
      `${type} job names a workspace it does not run in — refusing rather than picking one.`,
    );
  }
  return runAs;
};

/**
 * Rebuild the `AuthSubject` this job's user would carry on a live request.
 *
 * Everything a permission condition can bind to is re-read: the role names
 * (`$user.roles`), the address (`$user.email`), the id and the workspace. A
 * subject assembled with a stale or missing email is not a smaller permission,
 * it is a *different* one — `$user.email` would match nothing and a role scoped
 * that way would silently see zero rows, which reads exactly like an empty
 * collection.
 *
 * Refuses, rather than degrading, when the user is gone or may no longer act in
 * the workspace. A queued job legitimately outlives the session that enqueued it;
 * it must not outlive the grant.
 *
 * The workspace check goes through the same `resolveTenantAccess` the request
 * path uses, with `apiKeyId: null`. That is not a widening: an admin-owned API
 * key can never reach a foreign workspace in the first place (the middleware
 * nulls the tenant), so a job for one only exists if a human passed the
 * interactive super-admin check — and this call re-runs it, so a demoted or
 * suspended admin's queued job stops working.
 */
export const resolveRunAsAuth = async (ctx: Ctx, runAs: RunAs): Promise<AuthSubject> => {
  const [email, access] = await Promise.all([
    loadUserEmail(ctx, runAs.userId),
    resolveTenantAccess(ctx.db, ctx.dialect, runAs.tenantId, runAs.userId, {
      apiKeyRoleId: null,
      apiKeyId: null,
      // The queue re-runs the same check the request path did, so it needs the
      // same inputs. `email` is loaded in parallel above and cannot be read
      // here without serialising the two, so the `OWNER_EMAIL` arm of the
      // operator check is deliberately not available to a queued job: a job
      // that only ran because a human was OWNER_EMAIL should stop running when
      // it is dequeued, not inherit that standing indefinitely.
      env: ctx.env,
      plane: "platform",
    }),
  ]);
  if (!access.roles) {
    throw new AppError(
      "FORBIDDEN",
      "The user this job runs as can no longer act in that workspace — their membership or admin role was removed after it was queued.",
    );
  }
  return {
    plane: "platform",
    userId: runAs.userId,
    email,
    roles: access.roles,
    tenantId: runAs.tenantId,
    // Carry forward HOW the check passed. A job queued by the instance
    // operator against a workspace they do not belong to keeps working; one
    // queued by a member stays bound to that membership, and stops the moment
    // it is revoked.
    access: access.access,
    apiKeyRoleId: null,
    // Said out loud: a queued job is never an impersonation. Carrying one over
    // would let a read-only support session's job write after the session ended.
    impersonatedBy: null,
    impersonationId: null,
    impersonationReadOnly: false,
  };
};

/** Resolve the subject and assert it still holds `admin` in the workspace. The
 *  admin-scoped jobs (backup, restore, reindex) are gated by `requireAdmin` at
 *  the route, and the gate has to hold when the work actually runs too. */
export const resolveRunAsAdmin = async (ctx: Ctx, runAs: RunAs): Promise<AuthSubject> => {
  const auth = await resolveRunAsAuth(ctx, runAs);
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError(
      "FORBIDDEN",
      "The user this job runs as no longer holds the admin role in that workspace.",
    );
  }
  return auth;
};
