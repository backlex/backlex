/**
 * Tenant-scope scanner — a mechanical check for the ONE defect shape that
 * every confirmed isolation break in this codebase has had.
 *
 * WHY THIS EXISTS
 *
 * All three isolation breaks the 2026-08 identity audit confirmed were a single
 * missing `WHERE` clause, and a 6,300-test suite was green on all three. Every
 * isolation test we own drives a route that REMEMBERED to scope; none of them
 * can see a route that forgot, because forgetting produces a perfectly valid
 * 200 carrying somebody else's rows. Tenant isolation is a discipline spread
 * across ~200 server files with no mechanical check at all — so this is the
 * mechanical check.
 *
 * WHAT IT CHECKS
 *
 * Every Drizzle query in `apps/web/src/server/` issued against a table that
 * carries a `tenant_id` column must mention a tenant predicate in the same
 * statement. The set of tenant-scoped tables is DERIVED from
 * `packages/db/src/sqlite/schema.ts` at scan time, never hard-coded: a table
 * added next month is in scope the moment it declares `tenantId`, which is the
 * whole failure mode this file exists to stop.
 *
 * HOW IT READS THE CODE
 *
 * This is a SOURCE SCAN, not a type-aware analysis. TypeScript 7 is the Go
 * port and ships no compiler API (`require("typescript")` then
 * `ts.createProgram` throws), so there is no program to ask. What the scanner
 * does instead is resolve this repo's own three table-binding idioms — they are
 * remarkably uniform, which is what makes a source scan viable here:
 *
 *   1. `const t = tableFor(ctx.dialect)` where `tableFor` is a module-level
 *      `dialect === "pg" ? pg.schema.X : sqlite.schema.X`.        (~380 sites)
 *   2. `const t = tablesFor(ctx.dialect)` returning an object literal of such
 *      refs, used as `t.members`, `t.roles`, …                     (~90 sites)
 *   3. A direct `pg.schema.X` / `sqlite.schema.X` in the query itself.
 *
 * `(ctx.db as any)` is the DOMINANT call shape in this repo (a documented
 * consequence of `noUncheckedIndexedAccess` plus the dual-dialect union), so
 * the matcher never looks at the receiver — only at the argument of
 * `.from()` / `.insert()` / `.update()` / `.delete()`.
 *
 * MATCHING NOTHING IS A FAILURE, NOT A PASS
 *
 * A scan that silently resolves zero queries reports "0 violations", which is
 * indistinguishable from a clean bill of health and is how this class of guard
 * rots. Three things prevent that here:
 *
 *   · the scan fails outright if the schema yields no tenant-scoped tables;
 *   · it fails outright if it resolves fewer queries than `MIN_QUERIES`;
 *   · every query whose table it CANNOT resolve is reported as `unresolved`
 *     rather than skipped, and the test caps how many of those are tolerated.
 *
 * THE ALLOWLIST IS THE POINT
 *
 * A syntactic rule this blunt has real exceptions: helpers that receive a
 * tenant id and pass it down, queries reached through a parent row that already
 * carries the scope, and the handful of genuinely cross-workspace reads a
 * platform product needs (the cron sweeper, the D1 migrator, the operator's
 * workspace list). Those are not silenced by loosening the rule — they are
 * named, one by one, in `ALLOWLIST` below, each with a reason. A stale entry
 * that no longer matches anything FAILS the scan, because an exemption nobody
 * can point at is how a rule quietly stops meaning anything.
 *
 * The resulting ledger is the document this codebase did not have: every place
 * it deliberately reads across workspaces, in one file, with the reason.
 *
 * WHAT IT DOES NOT CATCH — say this out loud rather than let a green run imply
 * more than it proves:
 *
 *   · **Conditional scoping.** `if (input.tenantId !== undefined) conds.push(…)`
 *     reads as scoped, because the predicate is there in the source. Whether
 *     every caller passes a tenant is beyond a source scan. `jobs.listJobs` and
 *     `uploads.listUploads` are both this shape today.
 *   · **A guard that ignores its argument.** The prior-read rule below trusts
 *     that `getJob(ctx, id, tenantId)` applies the tenant it was handed. It
 *     does not follow the call. (A guard that ignored it would itself be a
 *     query with a tenant in scope, so this scanner checks THAT.)
 *   · **Dynamic tables.** A query against `table as never` — the physical table
 *     of a user collection — cannot be resolved and is reported as
 *     `unresolved`, not checked.
 *   · **Cross-module table helpers.** `const ft = filesTable(ctx.dialect)`
 *     where `filesTable` is imported resolves nowhere; also `unresolved`.
 *   · **Anything outside `apps/web/src/server/`.** Notably `packages/db`.
 *   · **A NEW query inside an already-allowlisted function.** An `AllowEntry`
 *     is matched by `(file, symbol)` — none of the 135 current entries narrows
 *     itself with the optional `table` field — so it exempts every query the
 *     symbol issues, including ones written after the entry. Verified by adding
 *     an unscoped `select().from(t)` to `activity.pruneOldActivity`: the scan
 *     stayed green. Narrow an entry with `table` when the symbol issues more
 *     than one query, and keep allowlisted functions small.
 *
 * Usage:
 *   bun scripts/scan-tenant-scope.ts            # human-readable report
 *   bun scripts/scan-tenant-scope.ts --json     # machine-readable
 *   bun scripts/scan-tenant-scope.ts --all      # also list allowlisted hits
 *
 * Exits 1 when there is a violation, a stale allowlist entry, or the scan
 * itself failed to see enough of the codebase to mean anything.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Repo layout
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dir, "..");
const SERVER_DIR = resolve(REPO_ROOT, "apps/web/src/server");
const SQLITE_SCHEMA = resolve(REPO_ROOT, "packages/db/src/sqlite/schema.ts");

/**
 * A floor on how much of the codebase the scan actually understood. This is
 * the anti-rot clause: if a refactor changes the table-binding idiom and the
 * resolver stops recognising it, the scan goes quiet — and a quiet scan looks
 * exactly like a clean one. There were 930 resolved queries when this was
 * written; the floor sits below that so ordinary churn does not trip it, and
 * far enough above zero that a broken resolver does. The first draft of this
 * scanner resolved 26 of those 930 because of one regex bug and still printed
 * a violation count with a straight face — this constant is that lesson.
 */
export const MIN_QUERIES = 700;

/**
 * A ceiling on queries whose target table the resolver could not name. These
 * are reported, not skipped — an unresolved query is an unchecked query. The
 * ceiling exists so the number cannot creep upward one commit at a time.
 */
export const MAX_UNRESOLVED = 15;

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

export interface AllowEntry {
  /** Path relative to the repo root. */
  file: string;
  /**
   * The enclosing symbol exactly as the scanner names it: a function name, or
   * `GET /:id` for an inline route handler (they have no name of their own).
   * Matched with `===`, so an entry covers one function and no other.
   */
  symbol: string;
  /** Restrict the exemption to one table when the symbol issues several. */
  table?: string;
  /** Why reading across workspaces is correct here. Required. */
  reason: string;
}

/**
 * Every place this codebase deliberately issues a query against a
 * tenant-scoped table without a tenant predicate.
 *
 * Adding an entry is meant to cost something: it needs a file, a symbol and a
 * sentence that survives being read by somebody else six months from now. If
 * the honest reason is "I could not see where the scope comes from", that is a
 * finding, not an exemption.
 */
export const ALLOWLIST: readonly AllowEntry[] = [
  // ── Instance-wide maintenance ───────────────────────────────────────────
  // A cron tick has no request and therefore no workspace. In the managed model
  // one Worker serves one workspace, so "every row in this database" and "every
  // row in this workspace" are the same set; on a self-hosted multi-workspace
  // deployment they are not, and each of these would sweep across all of them.
  // That is a deliberate property of the sweeper, not an oversight — but it is
  // the reason this section exists rather than being folded into the rule.
  { file: "apps/web/src/server/services/activity.ts", symbol: "pruneOldActivity", reason: "Retention sweep. Bounded by createdAt, not by workspace; there is no request tenant on a cron tick." },
  { file: "apps/web/src/server/services/activity.ts", symbol: "pruneOldActivityByPrefix", reason: "Retention sweep, narrowed by action prefix. Same reasoning as pruneOldActivity." },
  { file: "apps/web/src/server/services/revisions.ts", symbol: "pruneOldRevisions", reason: "Retention sweep over revision history, bounded by createdAt." },
  { file: "apps/web/src/server/services/traces.ts", symbol: "pruneOldSpans", reason: "Retention sweep over trace spans, bounded by createdAt." },
  { file: "apps/web/src/server/services/broadcast.ts", symbol: "pruneBroadcastMessages", reason: "Retention sweep over channel history, bounded by day." },
  { file: "apps/web/src/server/services/consent-records.ts", symbol: "pruneConsentRecords", reason: "Retention sweep over consent records, bounded by createdAt." },
  { file: "apps/web/src/server/services/form-drafts.ts", symbol: "sweepStaleFormDrafts", reason: "Retention sweep over abandoned form drafts, bounded by updatedAt." },
  { file: "apps/web/src/server/services/uploads.ts", symbol: "sweepExpiredUploads", reason: "Aborts pending uploads past expiresAt. Cron-driven; no request tenant." },
  { file: "apps/web/src/server/services/flow-schedules.ts", symbol: "pruneScheduleFires", reason: "Retention sweep over schedule fire records, bounded by fireAt." },
  { file: "apps/web/src/server/services/flow-schedules.ts", symbol: "listScheduleFlows", reason: "The cron tick has to see every active scheduled flow in the database to know which are due." },
  { file: "apps/web/src/server/services/scheduler.ts", symbol: "cronTick", reason: "Loads every cron-triggered function in the database. This IS the scheduler; a tenant predicate would need a workspace nobody supplied." },
  { file: "apps/web/src/server/services/scheduled-tasks.ts", symbol: "claimDueTasks", reason: "Claims due tasks across the database; each claimed row carries its own tenantId, which the runner then uses." },
  { file: "apps/web/src/server/services/scheduled-tasks.ts", symbol: "deleteTask", reason: "Deletes a task by the id claimDueTasks just returned." },
  { file: "apps/web/src/server/services/jobs.ts", symbol: "claimDueJobs", reason: "The queue worker claims due jobs across the database; each job row carries the tenantId the handler then runs under." },
  { file: "apps/web/src/server/services/jobs.ts", symbol: "sweep", reason: "Retention sweep inside pruneFinishedJobs, bounded by status + updatedAt." },
  { file: "apps/web/src/server/services/kpi-alerts.ts", symbol: "runKpiAlerts", reason: "Evaluates every KPI with an alert operator set; the alert then fires into the KPI row's own workspace." },
  { file: "apps/web/src/server/services/cdc.ts", symbol: "processCdcSinks", reason: "Round-robins every enabled CDC sink in the database; each sink row carries its tenantId." },
  { file: "apps/web/src/server/services/items/scheduled-publish.ts", symbol: "publishDueItems", reason: "Cron: finds every versioned collection with scheduled publishes due. Each collection row carries its tenantId." },
  { file: "apps/web/src/server/services/items/scheduled-publish.ts", symbol: "unpublishDueItems", reason: "Cron twin of publishDueItems: every versioned collection with an unpublish due, each row carrying its own tenantId." },
  { file: "apps/web/src/server/services/backup.ts", symbol: "maybeRunScheduledBackups", reason: "Cron: marks the backup rows it just started/finished, by id, inside its own sweep." },
  { file: "apps/web/src/server/services/cors-origins.ts", symbol: "refresh", reason: "Builds the process-wide CORS allow-list from every workspace's auth_config redirect URLs. The allow-list is a property of the deployment, not of one workspace." },

  // ── Addressed by an unguessable capability token ────────────────────────
  // The secret IS the containment: the row cannot be reached without holding a
  // token that was minted for it. Several of these are also the step that
  // ESTABLISHES which workspace the caller is in, so a tenant predicate would
  // need an answer the call does not have yet.
  { file: "apps/web/src/server/services/api-keys.ts", symbol: "findApiKey", reason: "Resolves a pak_ key by its hash. This is how the request's workspace is determined in the first place." },
  { file: "apps/web/src/server/services/s3/credentials.ts", symbol: "resolveS3Credential", reason: "Resolves an SigV4 access key id to its credential row, which carries the workspace the S3 request runs in." },
  { file: "apps/web/src/server/services/forms.ts", symbol: "resolveFormToken", reason: "Resolves a public form's token hash; the row it returns is what tells the hosted form which workspace it belongs to." },
  { file: "apps/web/src/server/services/dashboards.ts", symbol: "resolveEmbedToken", reason: "Resolves a dashboard embed token hash; the row carries the workspace the embed renders for." },
  { file: "apps/web/src/server/services/shared-links.ts", symbol: "resolveSharedLink", reason: "Resolves a shared-record link by token hash; the token is the whole grant." },
  { file: "apps/web/src/server/services/approvals.ts", symbol: "resolveByToken", reason: "Reads the request row an approver's emailed token already resolved to." },
  { file: "apps/web/src/server/services/signatures.ts", symbol: "resolveSignerToken", reason: "Reads the signature request a signer's token already resolved to." },
  { file: "apps/web/src/server/services/integration-webhooks.ts", symbol: "findByToken", reason: "Resolves an inbound webhook token to its sync row, which carries the workspace to write into." },
  { file: "apps/web/src/server/services/form-invites.ts", symbol: "checkFormInvite", reason: "Resolves an invite by token hash, additionally narrowed to the form the request named." },
  { file: "apps/web/src/server/services/invites.ts", symbol: "findInviteByToken", reason: "Resolves a workspace invite by its token (hashed, plus the legacy plaintext column). An invitee has no workspace until this call answers." },
  { file: "apps/web/src/server/routes/tenant-auth.ts", symbol: "revokeAppSession", reason: "Deletes an app-plane session by its bearer token. Holding the token is the authorisation." },
  { file: "apps/web/src/server/services/form-drafts.ts", symbol: "loadFormDraft", reason: "Keyed on (formId, keyHash) — the draft key is a secret held by the submitting browser." },
  { file: "apps/web/src/server/services/form-drafts.ts", symbol: "deleteFormDraft", reason: "Keyed on (formId, keyHash), same grant as loadFormDraft." },
  { file: "apps/web/src/server/lib/third-party-jwt.ts", symbol: "loadProviderByIssuer", reason: "Maps a JWT `iss` to the provider row that trusts it, and the row supplies the workspace. NOTE: with limit(1), two workspaces trusting the SAME issuer resolve to whichever row comes back first — a registration-time uniqueness question, not a missing predicate." },

  // ── Reads back a row it has just written ────────────────────────────────
  // The id is a UUID this function minted microseconds earlier. There is no
  // other workspace's row it could name.
  { file: "apps/web/src/server/services/signing-keys.ts", symbol: "storeKey", reason: "Checks for a kid collision and inserts. Signing keys are deployment-level: signingKeys.tenantId is nullable and the JWKS is served per deployment, not per workspace." },

  // ── Guarded by a tenant-scoped read in the same function ────────────────
  // The row was fetched WITH the tenant a few lines up and the function
  // returned early on a miss; the write then addresses that same row by key.
  // (`guardedByPriorRead` recognises this shape automatically when the guard is
  // a call — these are the cases where it is inline, or the verb did not match.)
  { file: "apps/web/src/server/services/backup.ts", symbol: "recordAndRunBackup", reason: "Marks the backup row it created in this same call, by the id it was handed with the tenantId beside it." },
  { file: "apps/web/src/server/services/backup.ts", symbol: "startManualBackup", reason: "Re-reads the row it just inserted for this workspace, by that row's id." },
  { file: "apps/web/src/server/services/backup.ts", symbol: "getBackupScoped", reason: "Reads by id, then compares the row's tenantId to the caller's in application code before returning it. The check exists; it is simply not in the SQL." },
  { file: "apps/web/src/server/services/jobs.ts", symbol: "claimJobById", reason: "Compare-and-set on (id, status) after a scoped read; the status guard is what makes the claim exclusive." },
  { file: "apps/web/src/server/services/jobs.ts", symbol: "runJob", reason: "Writes the outcome of the job row it was handed, by that row's id. The row came from claimDueJobs / claimJobById." },
  { file: "apps/web/src/server/services/job-progress.ts", symbol: "reportJobProgress", reason: "Writes progress for the job the worker currently holds, by that job's id." },
  { file: "apps/web/src/server/services/app-orgs.ts", symbol: "setActiveOrg", reason: "Clears activeOrgId on the app session id the caller is authenticated as; the org it would have set was resolved against tenantId first." },

  // ── Acts on a row object its caller already resolved ────────────────────
  // The function's parameter is the ROW, not an id from the wire. Whoever
  // fetched it did so with a tenant predicate; this call only writes back.
  { file: "apps/web/src/server/services/webhooks.ts", symbol: "applyDeliveryOutcome", reason: "Writes the failure counter of the hook row it was handed (the row's own tenantId is in its type)." },
  { file: "apps/web/src/server/services/webhooks.ts", symbol: "notifyAutoDisabled", reason: "Files a notification for the hook row it was handed, carrying that row's tenantId into the notification." },
  { file: "apps/web/src/server/services/sync-hooks.ts", symbol: "applyOutcome", reason: "Writes the failure counter of the SyncHookRow it was handed." },
  { file: "apps/web/src/server/services/cdc.ts", symbol: "recordSuccess", reason: "Writes the cursor of the CdcSinkRow it was handed." },
  { file: "apps/web/src/server/services/cdc.ts", symbol: "recordFailure", reason: "Writes the failure counter of the CdcSinkRow it was handed." },
  { file: "apps/web/src/server/services/integration-syncs.ts", symbol: "applyRunOutcome", reason: "Writes the run outcome of the SyncRow it was handed." },
  { file: "apps/web/src/server/services/integration-listings.ts", symbol: "noteRunFailure", reason: "Writes the failure counter of the SyncRow it was handed." },
  { file: "apps/web/src/server/services/integration-tasks.ts", symbol: "settle", reason: "Settles the task run it was given the id of, immediately after starting it." },
  { file: "apps/web/src/server/services/integration-webhooks.ts", symbol: "claimDelivery", reason: "Compare-and-set claim on a delivery row the dispatcher just selected." },
  { file: "apps/web/src/server/services/integration-webhooks.ts", symbol: "settleDelivery", reason: "Settles the delivery it just claimed, by that row's id." },
  { file: "apps/web/src/server/services/integrations.ts", symbol: "recordDelivery", reason: "Inserts a delivery record for the integration row it was handed; the row's tenantId is spread into the insert via `...input`." },
  { file: "apps/web/src/server/services/approvals.ts", symbol: "settleRequest", reason: "Compare-and-set on the ApprovalRequestRow it was handed, guarded on (id, status)." },
  { file: "apps/web/src/server/services/approvals.ts", symbol: "expireRequest", reason: "Reads the request id that expireDueRequests selected." },
  { file: "apps/web/src/server/services/approvals.ts", symbol: "expireDueRequests", reason: "Cron: expires every pending request past expiresAt across the database." },
  { file: "apps/web/src/server/services/signatures.ts", symbol: "declineDocument", reason: "Compare-and-set on the request the signer's token already resolved to." },
  { file: "apps/web/src/server/services/forms.ts", symbol: "recordFormSubmission", reason: "Increments the counter of the form row resolveFormToken already resolved from the submitted token." },
  { file: "apps/web/src/server/services/forms.ts", symbol: "recordFormBlocked", reason: "Increments the blocked counter of the same token-resolved form row." },
  { file: "apps/web/src/server/services/form-invites.ts", symbol: "consumeFormInvite", reason: "Compare-and-set on the invite checkFormInvite resolved from the submitted token." },
  { file: "apps/web/src/server/services/form-invites.ts", symbol: "releaseFormInvite", reason: "Undoes consumeFormInvite for the same invite id when the submission fails." },
  { file: "apps/web/src/server/services/form-invites.ts", symbol: "markInviteSent", reason: "Stamps sentAt on an invite the scoped create/remind path just wrote." },
  { file: "apps/web/src/server/services/api-keys.ts", symbol: "touchLastUsed", reason: "Stamps lastUsedAt on the key row findApiKey just resolved for this request." },
  { file: "apps/web/src/server/services/s3/credentials.ts", symbol: "touchS3Credential", reason: "Stamps lastUsedAt on the credential row resolveS3Credential just resolved." },
  { file: "apps/web/src/server/services/sso-provisioning.ts", symbol: "touchExternalIdentity", reason: "Stamps last-seen data on the external identity row the SSO callback just matched." },
  { file: "apps/web/src/server/services/impersonation.ts", symbol: "resolveImpersonation", reason: "Reads an impersonation grant by the id carried in the impersonation cookie; the row's own tenantId is what the session then adopts." },
  { file: "apps/web/src/server/middleware/session.ts", symbol: "appSessionOwner", reason: "Reads the app session row the bearer token's own `sid` names, joined to its user. Deliberately unscoped: it is what TELLS the caller which tenant this credential belongs to, and the caller refuses the token unless the row's userId/tenantId match the token's `sub`/`tid`. Scoping it by the claimed tenant would make the claim check itself." },
  // ---------------------------------------------------------------------
  // Queries that RESOLVE a tenant rather than being scoped by one.
  //
  // All seven arrived at once, when the scan stopped reading a `tenantId` in a
  // `.select({ … })` projection as a tenant predicate (see `stripProjections`
  // and the builder names in `DRIZZLE_OPS`). They were never scoped; the scan
  // was looking at the output shape and calling it a filter, so each of these
  // has been an unexamined query for as long as the scanner has existed.
  //
  // Every one of them turns out to be deliberate, and the shape is the same in
  // each: the caller holds a PUBLIC identifier — a bearer token, an ingest
  // key, a site id, an issuer — and this query is what says which workspace it
  // belongs to. Scoping them by the tenant would be circular, because the
  // tenant is the answer.
  // ---------------------------------------------------------------------
  { file: "apps/web/src/server/middleware/session.ts", symbol: "findAppSession", reason: "Resolves the opaque app-session bearer to its row by token, joined to its user. The row's own tenantId is what the request then adopts; there is no tenant to filter by until this has answered." },
  { file: "apps/web/src/server/services/analytics.ts", symbol: "resolveIngestKey", reason: "Answers which workspace owns a public analytics ingest key. Reads the one settings row per workspace and compares hashes in JS; the tenant is the RESULT, so filtering by it would be circular." },
  { file: "apps/web/src/server/services/consent.ts", symbol: "getPublishedConsentConfig", reason: "Public cookie-banner config for a site id that is itself the public identifier, joined to the site so a deleted site stops answering. The tenantId is projected for metering, not for filtering." },
  { file: "apps/web/src/server/services/consent.ts", symbol: "getTagConsentSettings", reason: "Same public site-id lookup as getPublishedConsentConfig. Its own comment explains the projected tenantId: the container route meters the workspace that OWNS the site rather than whichever one tenant middleware resolved." },
  { file: "apps/web/src/server/services/schema-versions.ts", symbol: "runScheduledSnapshots", reason: "A cron that sweeps every workspace which opted into a snapshot cadence. Scanning all tenants is the job; each row's own tenantId is then used to load and act on that workspace alone." },
  { file: "apps/web/src/server/services/tag-manager.ts", symbol: "getPublishedArtifact", reason: "Serves the published tag container for a public site id, joined to the site so a deleted site stops answering. The tenantId comes back so the public route can meter the owning workspace." },
  { file: "apps/web/src/server/services/third-party-auth.ts", symbol: "assertIssuerFree", reason: "Instance-wide uniqueness check on a JWT issuer. It has to see every workspace's rows to be a uniqueness check at all, and it deliberately reports only that the issuer is taken — naming the holder would leak another tenant's configuration to whoever probes issuers." },
  { file: "apps/web/src/server/routes/tenant-auth.ts", symbol: "consumeVerification", reason: "Deletes the verification row the magic-link/OTP path just matched on its own token." },
  { file: "apps/web/src/server/services/app-user-invites.ts", symbol: "consumeAppUserInvite", reason: "Deletes the verification row the invite-accept path just matched on its own token." },
  { file: "apps/web/src/server/services/invites.ts", symbol: "bindInvite", reason: "Binds the InviteRow findInviteByToken resolved from the presented token, and clears the token in the same write." },
  { file: "apps/web/src/server/services/dashboards.ts", symbol: "runDashboardPublic", reason: "Loads the role a public dashboard embeds AS, by the embedRoleId stored on the dashboard row the embed token resolved to." },

  // ── Reached through a parent the caller scoped ──────────────────────────
  // These take a parent key (threadId, formId, siteId, orgId, collectionId) and
  // no tenant. The workspace check lives with whoever resolved that parent.
  // Where the parameter is a UUID this is containment by unguessability; where
  // it is not, it is containment by contract — and the contract is the caller's.
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "listThreadAgentIds", reason: "Reached by threadId. The thread was resolved with a tenant predicate by the caller." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "listThreadAgentIdsFor", reason: "Reached by a list of threadIds a scoped listThreads produced." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "removeThreadAgent", reason: "Reached by (threadId, agentId), both resolved by the scoped caller." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "listMessages", reason: "Reads one thread's own messages, by threadId. The thread was resolved with a tenant predicate by the caller." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "listActiveRuns", reason: "Reads one thread's own in-flight runs, by threadId, for a thread the caller resolved with a tenant predicate." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "claimRun", reason: "Reached by (threadId, agentId) from an input object that also carries tenantId; the claim's exclusivity comes from the status compare-and-set." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "syncThreadStatus", reason: "Derives a thread's status from its own runs, by threadId." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "setThreadStatus", reason: "Sets the status of the thread id its scoped caller resolved." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "ensureThreadTitle", reason: "Backfills a title from the thread's own first message, by thread id." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "appendMessage", reason: "Touches updatedAt on the thread the message was appended to." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "deleteThread", reason: "Cascades the delete to messages / thread-agents / runs by threadId, after the thread itself was deleted under a tenant predicate in the same function." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "setRunStatus", reason: "Reached by run id, produced by claimRun." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "setRunJobId", reason: "Reached by run id, produced by claimRun." },
  { file: "apps/web/src/server/services/agents/store.ts", symbol: "touchRun", reason: "Heartbeat on the run id the executor holds." },
  { file: "apps/web/src/server/services/agents/memory.ts", symbol: "dropThreadMemory", reason: "Reached by threadId; memory rows belong to the thread." },
  { file: "apps/web/src/server/services/agents/memory.ts", symbol: "listPoolRows", reason: "Reached by (agentId, scope, threadId). The agent was resolved with a tenant predicate by the caller." },
  { file: "apps/web/src/server/services/agents/memory.ts", symbol: "listFacts", reason: "Reads one agent's own memory facts, by agentId. The agent row was resolved with a tenant predicate by the caller." },
  { file: "apps/web/src/server/services/agents/memory.ts", symbol: "forgetFact", reason: "Reached by (memoryId, agentId) — the agentId is the parent check." },
  { file: "apps/web/src/server/services/agents/memory.ts", symbol: "bumpHits", reason: "Bumps hit counters on the memory ids listPoolRows just returned." },
  { file: "apps/web/src/server/services/agents/memory.ts", symbol: "lastDistilledAt", reason: "Reads the newest memory row of one thread, by threadId, to decide whether distillation is due." },
  { file: "apps/web/src/server/services/agents/memory.ts", symbol: "pendingTurnCount", reason: "Counts a thread's own messages, by threadId." },
  { file: "apps/web/src/server/services/agents/memory.ts", symbol: "distillSemantic", reason: "Reads a thread's own recent messages; the input object carries tenantId but the message window is keyed on threadId." },
  { file: "apps/web/src/server/services/app-orgs.ts", symbol: "memberRole", reason: "Reached by (orgId, appUserId); the org was resolved with a tenant predicate by the caller." },
  { file: "apps/web/src/server/services/app-orgs.ts", symbol: "ownerCount", reason: "Counts the owners of one organization, by orgId, for an org the caller resolved with a tenant predicate." },
  { file: "apps/web/src/server/services/app-orgs.ts", symbol: "sessionActiveOrg", reason: "Reads activeOrgId off the app session id the caller is authenticated as." },
  { file: "apps/web/src/server/services/form-drafts.ts", symbol: "deleteFormDrafts", reason: "Cascades to the drafts of one form, by formId, when that form is deleted under a scoped query." },
  { file: "apps/web/src/server/services/form-drafts.ts", symbol: "countFormDrafts", reason: "Counts the saved drafts of one form, by formId, for a form the caller resolved with a tenant predicate." },
  { file: "apps/web/src/server/services/form-invites.ts", symbol: "remindFormInvites", reason: "Inserts fresh token rows for invites of a form the caller resolved with tenantId." },
  { file: "apps/web/src/server/services/form-invites.ts", symbol: "deleteFormInvites", reason: "Cascades to a form's invites and their tokens, by formId, when that form is deleted." },
  { file: "apps/web/src/server/services/consent.ts", symbol: "getPolicyForSite", reason: "Reached by siteId, joined to the analytics site row that owns it." },
  { file: "apps/web/src/server/services/consent.ts", symbol: "deletePolicyForDeletedSite", reason: "Cascades a site's policy and versions by siteId, called only from the scoped site delete." },
  { file: "apps/web/src/server/services/consent-records.ts", symbol: "deleteSiteRecords", reason: "Cascades a site's consent records by siteId, called only from the scoped site delete." },
  { file: "apps/web/src/server/services/consent-records.ts", symbol: "resolveHash", reason: "Reached by (siteId, policyHash) from a visitor's browser; the site id is what identifies the workspace." },
  { file: "apps/web/src/server/services/items/staged.ts", symbol: "getStagedRow", reason: "Reached by (collection.id, itemId); the collection row was resolved with a tenant predicate by the caller." },
  { file: "apps/web/src/server/services/items/staged.ts", symbol: "stagedIdsFor", reason: "Reached by (collection.id, ids), same contract as getStagedRow." },
  { file: "apps/web/src/server/services/items/staged.ts", symbol: "deleteStagedRow", reason: "Reached by (collection.id, itemId), same contract as getStagedRow." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "loadBusy", reason: "Reads the occupying bookings of one resource, by resource.id; the resource row was resolved with a tenant predicate by the caller." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "releaseLapsedHolds", reason: "Releases lapsed holds on one resource, by resourceId." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "insertIntoSeat", reason: "Inserts the booking row whose values the scoped caller assembled (tenantId included in `values`)." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "claimSlot", reason: "Withdraws the caller's OWN booking row by the id it just inserted — this is the loser's rollback in the insert-then-verify race." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "stamp", reason: "Writes back to the BookingRow recordBooking was handed, by that row's id." },

  // ── Deployment-level, not workspace-level ──────────────────────────────
  { file: "apps/web/src/server/services/signing-keys.ts", symbol: "listRows", reason: "JWT signing keys are a property of the DEPLOYMENT: signingKeys.tenantId is nullable, the JWKS endpoint is per-origin, and every workspace's tokens are verified against the same key set." },
  { file: "apps/web/src/server/services/signing-keys.ts", symbol: "load", reason: "Loads one deployment-level signing key by id. See listRows." },
  { file: "apps/web/src/server/services/signing-keys.ts", symbol: "setStatus", reason: "Moves one deployment-level signing key through standby → in use → revoked." },
  { file: "apps/web/src/server/services/signing-keys.ts", symbol: "promoteSigningKey", reason: "Retires whatever key was in use before promoting this one — deliberately every other key in the deployment." },
  { file: "apps/web/src/server/services/signing-keys.ts", symbol: "deleteSigningKey", reason: "Deletes one deployment-level signing key by id." },
  { file: "apps/web/src/server/services/demo.ts", symbol: "resetDemoWorkspace", reason: "The playground reset. Wiping EVERYTHING in the database is the entire point of this function, and it refuses to run unless the deployment is flagged as a demo." },

  // ── Scoped by the caller's own user, not by a workspace ────────────────
  // These tables carry a nullable `tenant_id`, but every query filters on
  // `auth.userId` — the row belongs to a PERSON. Worth its own section rather
  // than being folded in above, because it is the one category here where the
  // predicate is a different axis of isolation rather than a delegated one.
  { file: "apps/web/src/server/routes/device-tokens.ts", symbol: "GET /", reason: "Lists the caller's own push registrations, filtered on auth.userId. A device token belongs to a person, not to a workspace." },
  { file: "apps/web/src/server/routes/device-tokens.ts", symbol: "POST /", reason: "Upserts one of the caller's own device tokens, matched on (userId, platform, token) and then written back by that row's id." },
  { file: "apps/web/src/server/routes/device-tokens.ts", symbol: "DELETE /{id}", reason: "Deletes one of the caller's own device tokens, guarded on (id, auth.userId)." },
  { file: "apps/web/src/server/routes/phone-numbers.ts", symbol: "GET /", reason: "Lists the caller's own SMS numbers, filtered on auth.userId." },
  { file: "apps/web/src/server/routes/phone-numbers.ts", symbol: "POST /", reason: "Upserts one of the caller's own numbers, matched on (userId, phoneNumber) and then written back by that row's id." },
  { file: "apps/web/src/server/routes/phone-numbers.ts", symbol: "DELETE /{id}", reason: "Deletes one of the caller's own numbers, guarded on (id, auth.userId)." },

  // ── The lookup that ESTABLISHES the workspace ──────────────────────────
  { file: "apps/web/src/server/routes/webhook-trigger.ts", symbol: "tableFor", reason: "Unauthenticated inbound webhook: the flow id in the URL is resolved first, and the flow row is what tells the request which workspace it runs in. The file's own header says so." },
  { file: "apps/web/src/server/services/analytics.ts", symbol: "getSiteById", reason: "The public collect endpoint resolves the site id a browser sent; the row it returns carries tenantId, which is how the ingest is attributed. There is no workspace to scope by before this answers." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "resolveResourceToken", reason: "Resolves a public booking page's token hash to its resource row, which supplies the workspace." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "resolveManageToken", reason: "Resolves a customer's manage-link token hash to their booking row. The token is the whole grant — see the file header." },

  // ── More instance-wide maintenance, and rows just written ──────────────
  { file: "apps/web/src/server/services/analytics.ts", symbol: "pruneAnalyticsEvents", reason: "Retention sweep over analytics events, bounded by ts." },
  { file: "apps/web/src/server/services/analytics.ts", symbol: "pruneErrorEvents", reason: "Retention sweep over error events, and the group rows left with no surviving occurrence. Bounded by ts / lastSeen." },
  { file: "apps/web/src/server/services/extensions.ts", symbol: "listCronExtensionHooks", reason: "The cron tick has to see every enabled extension with a cron hook; each extension row carries its own tenantId." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "createBooking", reason: "Reads back the booking row it just inserted, by the id it just minted, to return the stored shape." },
  { file: "apps/web/src/server/services/booking.ts", symbol: "cancelBooking", reason: "Compare-and-set on the ResolvedBooking it was handed, guarded on the current status so two racing cancellations produce one cancellation." },

  // ── SUSPECT — not cleared, reported in the Phase 9 findings ────────────
  // These are here so the guard can be green while the question stays open.
  // Each one is a real behaviour somebody has to decide about; none of them is
  // a reason to relax the rule.
  {
    file: "apps/web/src/server/services/invites.ts",
    symbol: "findActiveInviteByEmail",
    reason:
      "SUSPECT (by design, but worth naming): reads EVERY pending invite row in the database and matches the email in JavaScript. An invitee has no workspace before this call answers, so a tenant predicate is impossible — but the read is unbounded and grows with the whole deployment.",
  },
  {
    file: "apps/web/src/server/services/backup.ts",
    symbol: "runBackup",
    reason:
      "SUSPECT (by design, but worth naming): selects EVERY collection row in the database and filters by `options.tenantId` in JavaScript afterwards. Correct today; the filter is one refactor away from being dropped, and nothing would fail.",
  },
];

// ---------------------------------------------------------------------------
// Schema: which tables are tenant-scoped
// ---------------------------------------------------------------------------

/**
 * Drizzle's internal symbols, reached by `Symbol.for` rather than by importing
 * `drizzle-orm`. The root workspace does not install `drizzle-orm` (it lives in
 * `packages/db` and `apps/web`), so a bare import here would resolve in the
 * test runner and fail from the CLI — and this script has to work from both.
 */
const IS_TABLE = Symbol.for("drizzle:IsDrizzleTable");
const COLUMNS = Symbol.for("drizzle:Columns");
const TABLE_NAME = Symbol.for("drizzle:Name");

export interface ScopedTable {
  /** The schema export name, e.g. `appUsers` — what source code references. */
  exportName: string;
  /** The physical table name, e.g. `app_users`. */
  physical: string;
  /** `false` for the tables where a NULL tenant means "global". */
  notNull: boolean;
}

/**
 * The set of tenant-scoped tables, read out of the SQLite schema module.
 *
 * SQLite rather than Postgres because the two are edited in lockstep by house
 * rule and only one needs reading; if they ever diverge on which tables carry a
 * tenant, that is a schema bug this scanner is not the right place to catch.
 */
export const deriveScopedTables = async (): Promise<Map<string, ScopedTable>> => {
  const mod = (await import(SQLITE_SCHEMA)) as Record<string, unknown>;
  const out = new Map<string, ScopedTable>();
  for (const [exportName, value] of Object.entries(mod)) {
    if (!value || typeof value !== "object") continue;
    const table = value as Record<symbol, unknown>;
    if (!table[IS_TABLE]) continue;
    const cols = table[COLUMNS] as Record<string, { notNull?: boolean }> | undefined;
    if (!cols || !("tenantId" in cols)) continue;
    out.set(exportName, {
      exportName,
      physical: String(table[TABLE_NAME]),
      notNull: cols.tenantId?.notNull === true,
    });
  }
  return out;
};

// ---------------------------------------------------------------------------
// Source masking
// ---------------------------------------------------------------------------

/**
 * Blank out comments and quoted-string CONTENTS, preserving every offset so
 * line numbers and slices still line up with the original file.
 *
 * Template literals are deliberately left intact: `sql\`… tenant_id = …\`` is a
 * real tenant predicate, and blanking it would turn correct code into a
 * violation. Quoted strings are blanked because a route `summary` or an error
 * message can easily contain the word `tenantId` and would otherwise vouch for
 * a query that scopes nothing.
 */
export const maskSource = (src: string): string => {
  const out = src.split("");
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let j = i; j < stop; j++) if (src[j] !== "\n") out[j] = " ";
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      // A quoted string cannot span a line break in practice here, so bail at
      // one rather than let an unterminated quote (a regex like /['"]/) eat the
      // rest of the file.
      while (j < n && src[j] !== quote && src[j] !== "\n") {
        if (src[j] === "\\") j++;
        j++;
      }
      if (j < n && src[j] === quote) {
        for (let k = i + 1; k < j; k++) out[k] = " ";
        i = j + 1;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return out.join("");
};

// ---------------------------------------------------------------------------
// Statement spans
// ---------------------------------------------------------------------------

export interface Span {
  start: number;
  end: number;
}

/**
 * Cut the masked source into statement-sized spans.
 *
 * A span ends at `;`, `{` or `}` seen at parenthesis/bracket depth zero. That
 * is deliberately crude — it splits an object literal assigned at statement
 * level into pieces — but it is exact for the shape that matters: a Drizzle
 * query is one chain of `.method(...)` calls, every brace inside it sits within
 * parentheses, and it terminates at a semicolon.
 *
 * STATEMENT-level rather than block-level is the whole point. A handler that
 * scopes its `update` correctly and forgets its `select` is precisely the bug
 * shape here; searching the enclosing block for the word `tenantId` would find
 * the update's predicate and clear the select.
 */
export const statementSpans = (masked: string): Span[] => {
  const spans: Span[] = [];
  let start = 0;
  let paren = 0;
  /** Parenthesis depth at the start of each open BLOCK, innermost last. */
  const blockParen: number[] = [0];
  let inTemplate = 0;
  const cut = (i: number) => {
    if (i > start) spans.push({ start, end: i });
    start = i + 1;
  };
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "`") {
      // Template literals nest through `${…}`; tracking the count is enough to
      // stop a brace inside one from cutting a statement.
      inTemplate = inTemplate === 0 ? 1 : 0;
      continue;
    }
    if (inTemplate) continue;
    const floor = blockParen[blockParen.length - 1] ?? 0;
    if (ch === "(" || ch === "[") paren++;
    else if (ch === ")" || ch === "]") paren = Math.max(0, paren - 1);
    else if (ch === "{") {
      if (isBlockBrace(masked, i)) {
        cut(i);
        blockParen.push(paren);
      } else {
        // An object literal is a bracket group, not a new statement context.
        paren++;
      }
    } else if (ch === "}") {
      if (paren > floor) paren--;
      else {
        cut(i);
        if (blockParen.length > 1) blockParen.pop();
        paren = blockParen[blockParen.length - 1] ?? 0;
      }
    } else if (ch === ";" && paren === floor) cut(i);
  }
  if (start < masked.length) spans.push({ start, end: masked.length });
  return spans;
};

const BLOCK_KEYWORD = /\b(?:else|try|do|finally)\s*$/;

/**
 * Is the `{` at `i` a BLOCK, or an object literal?
 *
 * This distinction is the difference between a working scanner and a decorative
 * one, and it was found by break-verification rather than by reading. Every
 * route in this repo is registered as
 * `.openapi(createRoute({…}), async (c) => { …handler… })`, so the handler body
 * sits at parenthesis depth ≥ 1 for its entire length. A splitter that only
 * cuts at depth zero therefore never cuts INSIDE a handler: the whole route
 * registration is one "statement", and a `const tenantId = …` at the top of the
 * handler vouches for every query below it. Deleting a real
 * `eq(t.tenantId, tenantId)` from `routes/folders.ts` produced no finding at
 * all until this function existed.
 *
 * The rule is what the preceding token allows: `)` and `=>` introduce a body,
 * `else` / `try` / `do` / `finally` introduce a block, and everything else —
 * `(`, `,`, `=`, `:`, `return` — introduces a value.
 */
const isBlockBrace = (masked: string, i: number): boolean => {
  let j = i - 1;
  while (j >= 0 && /\s/.test(masked[j] ?? "")) j--;
  const prev = masked[j] ?? "";
  if (prev === ")") return true;
  if (prev === ">" && masked[j - 1] === "=") return true;
  if (/[A-Za-z0-9_$]/.test(prev)) return BLOCK_KEYWORD.test(masked.slice(Math.max(0, j - 12), j + 1));
  // A declared return type sits between the parameter list and the body:
  // `): Promise<void> {`, `): Promise<{ ok: boolean }> {`. Walk left over the
  // annotation; if it lands on `)` and everything skipped began with `:`, this
  // is a function body. Without this the `{` reads as an object literal, the
  // whole function collapses into ONE statement, and a `tenantId` anywhere in
  // it vouches for every query inside — which is how `documents.deleteTemplate`
  // and six others silently passed.
  const floor = Math.max(0, i - 400);
  let k = i - 1;
  while (k >= floor && /[A-Za-z0-9_$<>|&.,[\]{}:'"\s]/.test(masked[k] ?? "")) k--;
  if (k >= floor && masked[k] === ")") {
    const between = masked.slice(k + 1, i).trim();
    return between === "" || between.startsWith(":");
  }
  return false;
};

const spanAt = (spans: Span[], index: number): Span => {
  let lo = 0;
  let hi = spans.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = spans[mid];
    if (!s) break;
    if (index < s.start) hi = mid - 1;
    else if (index > s.end) lo = mid + 1;
    else return s;
  }
  return { start: index, end: index };
};

// ---------------------------------------------------------------------------
// Balanced argument extraction
// ---------------------------------------------------------------------------

/** Text of the first argument of the call whose `(` sits at `openParen`. */
const firstArg = (masked: string, openParen: number): string => {
  let depth = 0;
  for (let i = openParen; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return masked.slice(openParen + 1, i);
    } else if (ch === "," && depth === 1) return masked.slice(openParen + 1, i);
  }
  return "";
};

/**
 * Text from `start` to the end of the statement it begins — the first `;` at
 * bracket depth zero, capped so a missing semicolon cannot swallow the file.
 */
const statementFrom = (text: string, start: number): string => {
  let depth = 0;
  const cap = Math.min(text.length, start + 4000);
  for (let i = start; i < cap; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth <= 0) return text.slice(start, i);
  }
  return text.slice(start, cap);
};

/**
 * The root of the method chain whose `.` sits at `dotIndex` — everything to the
 * left of it that is still part of the same expression.
 *
 * This is how `Buffer.from`, `Array.from`, `headers.delete`, `map.delete` and
 * `ctx.storage.delete` are told apart from a Drizzle builder: the root of
 * `await (ctx.db as any).select().from(t)` contains `db`, and the root of
 * `ctx.storage.delete(key)` does not. Testing the whole enclosing statement for
 * the word `db` instead is not good enough — a handler that has a `ctx.db`
 * anywhere in the same statement would vouch for an unrelated `.delete()`.
 */
const chainRoot = (masked: string, dotIndex: number): string => {
  let i = dotIndex - 1;
  const stop = Math.max(0, dotIndex - 4000);
  while (i >= stop) {
    const ch = masked[i] ?? "";
    if (/\s/.test(ch)) {
      i--;
      continue;
    }
    if (ch === ")" || ch === "]") {
      const open = ch === ")" ? "(" : "[";
      let depth = 0;
      while (i >= stop) {
        const c = masked[i];
        if (c === ch) depth++;
        else if (c === open) {
          depth--;
          if (depth === 0) break;
        }
        i--;
      }
      i--;
      continue;
    }
    if (/[\w$.]/.test(ch)) {
      while (i >= stop && /[\w$.]/.test(masked[i] ?? "")) i--;
      continue;
    }
    break;
  }
  return masked.slice(i + 1, dotIndex);
};

/** Offset of the `{` that opens the block containing `index`, or -1. */
const blockOpenBefore = (masked: string, index: number): number => {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const ch = masked[i];
    if (ch === "}") depth++;
    else if (ch === "{") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
};

const CONTROL_KEYWORD = /\b(?:if|for|while|switch|catch|with)\s*$/;

/**
 * Where the enclosing FUNCTION body begins.
 *
 * The two context-sensitive rules below — the conditions-array hop and the
 * prior-read guard — both need a window, and the window has to be the function.
 * A fixed character budget is wrong in both directions: too small and it misses
 * a `const conds` declared at the top of a long handler, too large and it
 * borrows a `tenantId` from the PREVIOUS function and clears a query that
 * scopes nothing. Walking out through enclosing braces until one of them is
 * preceded by `=>` or a parameter list gets the real boundary.
 */
const enclosingFunctionStart = (masked: string, index: number): number => {
  let at = index;
  for (let level = 0; level < 8; level++) {
    const open = blockOpenBefore(masked, at);
    if (open < 0) return 0;
    const before = masked.slice(Math.max(0, open - 400), open).trimEnd();
    if (/=>$/.test(before)) return open + 1;
    if (before.endsWith(")")) {
      // A parameter list, not `if (…) {` / `for (…) {`.
      const openParen = matchingOpen(before, before.length - 1);
      const head = openParen > 0 ? before.slice(0, openParen).trimEnd() : "";
      if (!CONTROL_KEYWORD.test(head)) return open + 1;
    }
    at = open;
  }
  return 0;
};

/** Offset just past the `}` closing the block that opens at `open`. */
const blockEndAfter = (masked: string, open: number): number => {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return masked.length;
};

/** Offset of the `)` matching the `(` at `openIndex`, or -1. */
const matchingClose = (text: string, openIndex: number): number => {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Offset of the `(` matching the `)` at `closeIndex`, or -1. */
const matchingOpen = (text: string, closeIndex: number): number => {
  let depth = 0;
  for (let i = closeIndex; i >= 0; i--) {
    const ch = text[i];
    if (ch === ")") depth++;
    else if (ch === "(") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** Text of the whole call expression starting at `(`, argument list included. */
const callArgs = (masked: string, openParen: number): string => {
  let depth = 0;
  for (let i = openParen; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return masked.slice(openParen + 1, i);
    }
  }
  return masked.slice(openParen + 1);
};

// ---------------------------------------------------------------------------
// Table-reference resolution
// ---------------------------------------------------------------------------

const SCHEMA_REF = /\b[A-Za-z_$][\w$]*\.schema\.([A-Za-z_$][\w$]*)/g;
const IDENT = "[A-Za-z_$][\\w$]*";

export type Binding =
  | { kind: "table"; tables: string[] }
  | { kind: "map"; keys: Map<string, string> }
  /** A whole schema namespace: `const s = dialect === "pg" ? pg.schema : sqlite.schema`. */
  | { kind: "ns" };

/** Every `pg.schema.X` / `sqlite.schema.X` named in a piece of source. */
const tablesIn = (text: string): string[] => {
  const found = new Set<string>();
  SCHEMA_REF.lastIndex = 0;
  let m: RegExpExecArray | null = SCHEMA_REF.exec(text);
  while (m) {
    if (m[1]) found.add(m[1]);
    m = SCHEMA_REF.exec(text);
  }
  return [...found];
};

/**
 * Object-literal keys that map to a schema table:
 * `{ members: pg.schema.tenantMembers, roles: pg.schema.roles }`.
 *
 * The `{`-or-`,` lookback is load-bearing, and was learned the hard way. A
 * ternary — `dialect === "pg" ? pg.schema.bookings : sqlite.schema.bookings` —
 * reads to a naive `key: value` regex as the key `bookings` mapping to
 * `sqlite.schema.bookings`, which turns every single-table helper in the repo
 * into a phantom table MAP. That one mistake left 666 of ~730 queries
 * unresolvable while the scan still cheerfully reported a violation count.
 * Only a key that genuinely opens an object literal or follows a comma counts.
 */
const keysIn = (text: string): Map<string, string> => {
  const keys = new Map<string, string>();
  const re = new RegExp(`(${IDENT})\\s*:\\s*${IDENT}\\.schema\\.(${IDENT})`, "g");
  let m: RegExpExecArray | null = re.exec(text);
  while (m) {
    const prev = text.slice(0, m.index).trimEnd().at(-1);
    if ((prev === "{" || prev === ",") && m[1] && m[2]) keys.set(m[1], m[2]);
    m = re.exec(text);
  }
  return keys;
};

/**
 * What a right-hand side evaluates to, as far as this scan cares. `helpers`
 * supplies the single hop through a module-level `tableFor` / `tablesFor`.
 */
const evalRhs = (rhs: string, helpers: Map<string, Binding>): Binding | null => {
  const keys = keysIn(rhs);
  if (keys.size > 0) return { kind: "map", keys };
  const tables = tablesIn(rhs);
  if (tables.length > 0) return { kind: "table", tables };
  // `pg.schema` NOT followed by a table name is the whole namespace.
  if (/\b[A-Za-z_$][\w$]*\.schema\b(?!\s*\.)/.test(rhs)) return { kind: "ns" };

  // `tablesFor(dialect).tenants` — one key off a helper's map.
  const callKey = new RegExp(`^\\s*(?:await\\s+)?(${IDENT})\\s*\\([^()]*\\)\\s*\\.\\s*(${IDENT})`).exec(rhs);
  if (callKey?.[1] && callKey[2]) {
    const b = helpers.get(callKey[1]);
    if (b?.kind === "map") {
      const table = b.keys.get(callKey[2]);
      return table ? { kind: "table", tables: [table] } : null;
    }
    if (b?.kind === "ns") return { kind: "table", tables: [callKey[2]] };
  }

  const call = new RegExp(`^\\s*\\(?\\s*(?:await\\s+)?(${IDENT})\\s*\\(`).exec(rhs);
  if (call?.[1]) return helpers.get(call[1]) ?? null;

  // `const ct = schema.collections` where `schema` is a namespace binding.
  const member = new RegExp(`^\\s*(${IDENT})\\s*\\.\\s*(${IDENT})\\s*$`).exec(rhs.trim());
  if (member?.[1] && member[2]) {
    const b = helpers.get(member[1]);
    if (b?.kind === "ns") return { kind: "table", tables: [member[2]] };
    if (b?.kind === "map") {
      const table = b.keys.get(member[2]);
      return table ? { kind: "table", tables: [table] } : null;
    }
  }
  return null;
};

/**
 * Module-level table helpers, keyed by name.
 *
 * A file declares these once and never rebinds them, so a file-wide map is
 * exact for them. Per-handler aliases are deliberately NOT collected here —
 * see {@link resolveAt}.
 */
export const collectHelpers = (masked: string): Map<string, Binding> => {
  const helpers = new Map<string, Binding>();
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;]{0,200})?=`, "g");
  let m: RegExpExecArray | null = declRe.exec(masked);
  while (m) {
    const name = m[1];
    if (name && !helpers.has(name)) {
      const b = evalRhs(statementFrom(masked, m.index + m[0].length), helpers);
      if (b) helpers.set(name, b);
    }
    m = declRe.exec(masked);
  }
  return helpers;
};

/**
 * What `name` refers to AT `index` — the nearest preceding declaration wins.
 *
 * File-wide first-wins is not good enough, for a specific reason:
 * `services/booking.ts` binds `const t = …` to three DIFFERENT tables in three
 * different functions, and only two of the three carry a tenant column. A
 * file-wide map would attribute every query in that file to whichever came
 * first — which is worse than not resolving it, because it reports confidently
 * about the wrong table.
 */
export const resolveAt = (
  masked: string,
  index: number,
  name: string,
  helpers: Map<string, Binding>,
): Binding | null => {
  const declRe = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=;]{0,200})?=`, "g");
  let bestEnd = -1;
  let m: RegExpExecArray | null = declRe.exec(masked);
  while (m && m.index < index) {
    bestEnd = m.index + m[0].length;
    m = declRe.exec(masked);
  }
  if (bestEnd === -1) return helpers.get(name) ?? null;
  // Bounded by the declaration's own statement. An unbounded window is not a
  // harmless imprecision: `const t = tablesFor(ctx.dialect);` followed by 1200
  // characters of handler body picked up an unrelated `pg.schema.appAccounts`
  // further down and resolved `t` to the WRONG table.
  return evalRhs(statementFrom(masked, bestEnd), helpers) ?? helpers.get(name) ?? null;
};

/** The table(s) an argument expression names, or `null` when unresolvable. */
export const resolveArg = (
  arg: string,
  masked: string,
  index: number,
  helpers: Map<string, Binding>,
): string[] | null => {
  const text = arg.trim();
  const direct = new RegExp(`^${IDENT}\\.schema\\.(${IDENT})$`).exec(text);
  if (direct?.[1]) return [direct[1]];

  const member = new RegExp(`^(${IDENT})\\.(${IDENT})$`).exec(text);
  if (member?.[1] && member[2]) {
    const b = resolveAt(masked, index, member[1], helpers);
    if (b?.kind === "map") {
      const table = b.keys.get(member[2]);
      return table ? [table] : null;
    }
    // `s.appUsers` where `s` is the whole schema namespace.
    if (b?.kind === "ns") return [member[2]];
    return null;
  }

  const bare = new RegExp(`^(${IDENT})$`).exec(text);
  if (bare?.[1]) {
    const b = resolveAt(masked, index, bare[1], helpers);
    if (b?.kind === "table") return b.tables;
    return null;
  }

  // The helper called inline: `.insert(tableFor(ctx.dialect))`.
  const call = new RegExp(`^(${IDENT})\\s*\\(`).exec(text);
  if (call?.[1]) {
    const b = helpers.get(call[1]);
    if (b?.kind === "table") return b.tables;
    return null;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Tenant predicate detection
// ---------------------------------------------------------------------------

const TENANT_TOKEN = /\btenantId\b|\btenant_id\b/;

/**
 * A TYPE that mentions `tenantId` is not a tenant predicate.
 *
 * `const rows = (await db.select().from(t).where(eq(t.active, true))) as Array<{
 *    id: string; tenantId: string | null; … }>`
 *
 * — the row TYPE names the column, the query does not filter on it, and left
 * alone that annotation vouches for a query that reads every workspace's rows.
 * It cleared seven of them here, `flow-schedules.listScheduleFlows` included.
 *
 * `null` and `undefined` are deliberately absent from the alternation:
 * `.values({ tenantId: null })` is a real write of a global row, not a type.
 */
const TENANT_TYPE_NOISE =
  /\b(?:tenantId|tenant_id)\s*\??\s*:\s*(?:string|number|boolean|Date|unknown|any)\b[^,;}\n]*/g;

const stripTypeNoise = (text: string): string => text.replace(TENANT_TYPE_NOISE, "");

/**
 * A PROJECTION that mentions `tenantId` is not a tenant predicate either.
 *
 * `.select({ status: t.users.status, tenantId: t.sessions.tenantId })
 *    .from(t.sessions).where(eq(t.sessions.id, sessionId))`
 *
 * — the query READS the column and filters on something else entirely, so the
 * rows it returns still span every workspace. This is the same mistake
 * `TENANT_TYPE_NOISE` above exists for, in a different syntactic dress, and it
 * is a worse one: a type annotation is a claim about the result, a projection
 * is code, so it survives every "is this really a predicate?" reading.
 *
 * Found because `middleware/session.ts::appSessionOwner` started selecting
 * `tenantId` (it has to — binding a token's `tid` claim to the session row is
 * the whole point of the 2026-09 phase-6 fix) and its allowlist entry
 * immediately went stale: the scan had decided the query scoped itself. It
 * does not. Any query that merely names the column in its output shape would
 * have been waved through the same way.
 *
 * `.select()` and `.returning()` only. `.values()` and `.set()` stay, because
 * `tenantId` inside those is a real write of the scope, not a read of it.
 */
const PROJECTION_CALL = /\.(select|returning)\s*\(/g;

const stripProjections = (text: string): string => {
  let out = "";
  let cursor = 0;
  PROJECTION_CALL.lastIndex = 0;
  let m: RegExpExecArray | null = PROJECTION_CALL.exec(text);
  while (m) {
    const open = m.index + m[0].length - 1;
    const args = callArgs(text, open);
    out += text.slice(cursor, open + 1);
    cursor = open + 1 + args.length;
    PROJECTION_CALL.lastIndex = cursor;
    m = PROJECTION_CALL.exec(text);
  }
  return out + text.slice(cursor);
};

/**
 * Does this statement carry a tenant predicate?
 *
 * The direct case is a `tenantId` / `tenant_id` token anywhere in the statement
 * — `eq(t.tenantId, tenantId)`, an `insert().values({ tenantId })`, or a raw
 * `sql\`… tenant_id = …\``. Any table's `tenantId` counts, not just the queried
 * one, because a query joined through a parent that carries the scope IS
 * scoped, and demanding the child's own column would make that a false
 * positive.
 *
 * The indirect case is this repo's other idiom: a conditions array built a few
 * lines up (`const conds: SQL[] = [eq(t.tenantId, tenantId)]`) and spread into
 * `.where(and(...conds))`. That is resolved with exactly ONE hop — every
 * identifier passed to `where` / `values` / `set` is looked up against the
 * declarations and `.push(…)` calls in the enclosing block. One hop, not a
 * transitive walk: two hops would start clearing statements by coincidence,
 * which is the failure mode this whole scanner exists to avoid.
 */
export const hasTenantPredicate = (
  rawStatement: string,
  rawBlock: string,
  rawTail = "",
): { scoped: boolean; via?: string } => {
  const statement = stripTypeNoise(rawStatement);
  const block = stripTypeNoise(rawBlock);
  const tail = stripTypeNoise(rawTail);
  if (TENANT_TOKEN.test(stripProjections(statement)))
    return { scoped: true, via: "inline" };

  const identsIn = (text: string): string[] => {
    const out: string[] = [];
    const identRe = new RegExp(`\\b(${IDENT})\\b`, "g");
    let id: RegExpExecArray | null = identRe.exec(text);
    while (id) {
      if (id[1] && !DRIZZLE_OPS.has(id[1])) out.push(id[1]);
      id = identRe.exec(text);
    }
    return out;
  };

  const carriers: string[] = [];
  const argRe = /\.(where|values|set|having|onConflictDoUpdate)\s*\(/g;
  let m: RegExpExecArray | null = argRe.exec(statement);
  while (m) {
    carriers.push(...identsIn(callArgs(statement, m.index + m[0].length - 1)));
    m = argRe.exec(statement);
  }

  // A bounded walk back along local `const`s, three hops deep. One hop is not
  // enough for the shape `approvals.ts` uses and several files copy:
  //
  //   const scope = tenantId == null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);
  //   const where = opts.status ? and(scope, eq(t.status, opts.status)) : scope;
  //   … .where(where)
  //
  // Three hops rather than unbounded, and only through declarations INSIDE this
  // function, so the walk cannot wander far enough to find a `tenantId` that
  // has nothing to do with the query.
  const seen = new Set<string>();
  let frontier = carriers;
  for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const name of frontier) {
      if (seen.has(name)) continue;
      seen.add(name);
      // Every place in the enclosing block that DEFINES or MUTATES this name.
      const defRe = new RegExp(
        `\\b(?:(?:const|let|var)\\s+${name}\\b|${name}\\s*(?:=[^=]|\\.push\\s*\\(|\\.set\\s*\\())`,
        "g",
      );
      let d: RegExpExecArray | null = defRe.exec(block);
      while (d) {
        // To the end of the STATEMENT, not the end of the line. `const row = {`
        // puts `tenantId` on the next line and `const where = cond ? and(…) : …`
        // wraps across three — a line-bounded window misses both, which is how
        // 50 correctly-scoped queries first read as violations here.
        const init = statementFrom(block, d.index);
        if (TENANT_TOKEN.test(init)) return { scoped: true, via: name };
        next.push(...identsIn(init));
        d = defRe.exec(block);
      }
    }
    frontier = next;
  }

  // A builder assembled across several statements:
  //   const q = (ctx.db as any).select().from(t);
  //   if (input.tenantId) q = q.where(eq(t.tenantId, input.tenantId));
  // The `.from()` statement carries no predicate at all and never will.
  if (tail && !statement.includes(".where(")) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+(${IDENT})\\s*=`).exec(statement);
    const name = decl?.[1];
    if (name) {
      // `.where(` specifically, not any later use of the name. Matching any use
      // meant `const rows = await db.select().from(t)` followed by a plain
      // JavaScript `rows.filter(r => r.tenantId === …)` counted as a scoped
      // query — which reaches the right verdict by the wrong route and would
      // keep counting if the filter were deleted.
      const useRe = new RegExp(`\\b${name}\\s*(?:=\\s*${name}\\s*)?\\.\\s*where\\s*\\(`, "g");
      let u: RegExpExecArray | null = useRe.exec(tail);
      while (u) {
        // The follow-up goes back through this same function (with no tail, so
        // it cannot recurse) because `routes/activity.ts` writes
        // `if (where) qb = qb.where(where)` — the predicate is one more hop
        // away, in a `where` built from a `conds` array further up.
        if (hasTenantPredicate(statementFrom(tail, u.index), block).scoped) {
          return { scoped: true, via: `builder:${name}` };
        }
        u = useRe.exec(tail);
      }
    }
  }

  const guard = guardedByPriorRead(statement, block);
  if (guard) return { scoped: true, via: `guard:${guard}` };
  return { scoped: false };
};

/**
 * The third form of scoping this codebase uses, and the one a naive rule reads
 * as a violation: **guard, then act by key.**
 *
 *   export const retryJob = async (ctx, id, tenantId?) => {
 *     const job = await getJob(ctx, id, tenantId);   // ← the tenant check
 *     if (!job || job.status !== "failed") return false;
 *     await db.update(t).set({ … }).where(eq(t.id, id));   // ← by key alone
 *   };
 *
 * The write is unscoped in isolation, but it is unreachable for a foreign row:
 * the read one line up was given BOTH the key and the tenant, and returning
 * early on a miss is the containment. `jobs.ts` does this three times,
 * `forms.ts`, `uploads.ts`, `documents.ts`, `signatures.ts` and `app-orgs.ts`
 * all do it, and hand-allowlisting ~90 instances of one idiom would produce a
 * ledger that says the same sentence ninety times — which is a ledger nobody
 * reads, and therefore no ledger at all.
 *
 * What is required to match, and it is deliberately narrow: a call EARLIER in
 * the same block whose argument list mentions a tenant AND the very identifier
 * the query filters on. Passing the tenant to something unrelated does not
 * qualify, and neither does filtering on a key nobody vetted.
 *
 * THE ASSUMPTION THIS MAKES, stated plainly: that the guarding call really does
 * apply the tenant it was handed. The scan does not follow it — one hop only,
 * by design. So this recognises an IDIOM, not a proof, and a guard function
 * that silently ignores its `tenantId` argument would be invisible here. That
 * is a narrower blind spot than it sounds: such a function is itself a query on
 * a tenant-scoped table with a tenant in scope, so THIS scanner checks it.
 *
 * Returns the guarding call's name, or null.
 */
const guardedByPriorRead = (statement: string, block: string): string | null => {
  // What the query filters on: the bare identifiers (or member roots) handed to
  // `where` / `set`, e.g. `id` from `eq(t.id, id)`, `hook` from `eq(t.id, hook.id)`.
  const filterIds = new Set<string>();
  const argRe = /\.(where|set)\s*\(/g;
  let m: RegExpExecArray | null = argRe.exec(statement);
  while (m) {
    const args = callArgs(statement, m.index + m[0].length - 1);
    const idRe = new RegExp(`(${IDENT})(\\s*\\.\\s*${IDENT})?`, "g");
    let id: RegExpExecArray | null = idRe.exec(args);
    while (id) {
      // `t.id` is the COLUMN side; the value side is what was vetted.
      if (id[1] && !id[2] && !DRIZZLE_OPS.has(id[1])) filterIds.add(id[1]);
      else if (id[1] && id[2] && !DRIZZLE_OPS.has(id[1])) filterIds.add(id[1]);
      id = idRe.exec(args);
    }
    m = argRe.exec(statement);
  }
  if (filterIds.size === 0) return null;

  // The same key, already vetted WITH the tenant, in an earlier WHERE in this
  // function. `analytics.deleteErrorGroup` is the shape:
  //
  //   const [row] = await db.select().from(g)
  //     .where(and(tenantEq(g.tenantId, tenantId), eq(g.id, id)));
  //   if (!row) throw new AppError("NOT_FOUND", …);
  //   await db.delete(e).where(eq(e.groupId, id));   // ← this query
  //
  // The guard is a query rather than a call, so the verb rule below cannot see
  // it. Requiring the SAME identifier in both predicates is what keeps this
  // from degrading into "the function mentions a tenant somewhere".
  const prefix = block.slice(0, Math.max(0, block.length - statement.length));
  const whereRe = /\.\s*where\s*\(/g;
  let w: RegExpExecArray | null = whereRe.exec(prefix);
  while (w) {
    const args = callArgs(prefix, w.index + w[0].length - 1);
    if (
      TENANT_TOKEN.test(args) &&
      [...filterIds].some((f) => new RegExp(`\\b${f}\\b`).test(args))
    ) {
      return "an earlier scoped WHERE on the same key";
    }
    w = whereRe.exec(prefix);
  }

  // The block ends at this statement, so every call found here precedes it.
  const callRe = new RegExp(`\\b(${IDENT})\\s*\\(`, "g");
  let c: RegExpExecArray | null = callRe.exec(block);
  while (c) {
    const name = c[1] ?? "";
    if (!DRIZZLE_OPS.has(name) && READ_VERB.test(name)) {
      const args = callArgs(block, c.index + c[0].length - 1);
      if (
        TENANT_TOKEN.test(args) &&
        [...filterIds].some((f) => new RegExp(`\\b${f}\\b`).test(args))
      ) {
        return name;
      }
    }
    c = callRe.exec(block);
  }
  return null;
};

/**
 * Names that carry no scoping meaning: the Drizzle operators a `where` is built
 * from, plus the table aliases this repo uses. Without this, `and(` and `eq(`
 * would themselves count as guarding calls.
 */
/**
 * A guarding call has to be a READ. Without this the rule matched anything the
 * tenant was passed to — `recordActivity(ctx, { tenantId: job.tenantId, … })`
 * counted as a guard for a later `update … where(eq(t.id, job.id))`, which
 * reached the right verdict for the wrong reason. Naming the verb keeps the
 * rule's claim ("something looked this row up with the tenant first") true.
 */
const READ_VERB =
  /^(?:get|load|find|fetch|resolve|require|assert|ensure|lookup|read|select|list|count|check|verify)[A-Z_]?/;

const DRIZZLE_OPS = new Set([
  "and", "or", "not", "eq", "ne", "gt", "gte", "lt", "lte", "like", "ilike",
  "inArray", "notInArray", "isNull", "isNotNull", "between", "exists", "sql",
  "desc", "asc", "count", "sum", "avg", "min", "max", "arrayContains",
  "if", "for", "while", "switch", "catch", "return", "await", "typeof",
  "String", "Number", "Boolean", "Array", "Object", "Date", "JSON", "Math",
  // The query builder's OWN methods. `READ_VERB` matches `select`, so without
  // these a query's own `.select({ …, tenantId: t.tenantId })` counted as "an
  // earlier read that looked this row up with the tenant" — the query vouching
  // for itself, out of its projection. `appSessionOwner` in
  // `middleware/session.ts` is where that showed: it filters on a session id
  // alone and the scan called it `guard:select`.
  "select", "selectDistinct", "selectDistinctOn", "returning",
]);

// ---------------------------------------------------------------------------
// Enclosing symbol
// ---------------------------------------------------------------------------

const FN_DECL = new RegExp(
  `(?:\\b(?:export\\s+)?(?:async\\s+)?function\\s+(${IDENT})\\b)` +
    `|(?:\\b(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=;]{0,200})?=\\s*(?:async\\s*)?(\\()?)`,
  "g",
);

/**
 * A human-usable name for where a query lives, so an allowlist entry can point
 * at it. Route handlers in this repo are inline arrows inside a
 * `.openapi(createRoute({ method, path }), handler)` chain and have no name at
 * all, so the nearest preceding `method`/`path` pair stands in for one —
 * `GET /:id` is what a reader would call it anyway.
 */
export const enclosingSymbol = (src: string, masked: string, index: number): string => {
  let fnName = "";
  let fnAt = -1;
  FN_DECL.lastIndex = 0;
  let m: RegExpExecArray | null = FN_DECL.exec(masked);
  while (m && m.index < index) {
    if (m[1]) {
      fnName = m[1];
      fnAt = m.index;
    } else if (m[2] && m[3]) {
      // `const NAME = (` is only a function when the parameter list is followed
      // by `=>`. Without this check `const rows = (await db.select()…)` reads as
      // a declaration and every allowlist entry ends up named `rows` — which is
      // both useless to a reader and unstable across edits.
      const open = m.index + m[0].length - 1;
      const close = matchingClose(masked, open);
      // `[^=]` and not `[^=;]`: a return type like
      // `Promise<{ cutoff: Date; ok: boolean }>` contains semicolons, and
      // excluding them made every such function invisible to this check.
      if (close > 0 && /^\s*(?::[^=]{0,200})?=>/.test(masked.slice(close + 1, close + 260))) {
        fnName = m[2];
        fnAt = m.index;
      }
    }
    m = FN_DECL.exec(masked);
  }

  // Route markers live in quoted strings, which `masked` has blanked — read
  // them from the original source.
  const routeRe = /\bmethod:\s*"([a-z]+)"[\s\S]{0,600}?\bpath:\s*"([^"]*)"/g;
  let route = "";
  let routeAt = -1;
  let r: RegExpExecArray | null = routeRe.exec(src);
  while (r && r.index < index) {
    route = `${(r[1] ?? "").toUpperCase()} ${r[2] ?? ""}`;
    routeAt = r.index;
    r = routeRe.exec(src);
  }

  if (routeAt > fnAt && route) return route;
  return fnName || "<module>";
};

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export interface Violation {
  file: string;
  line: number;
  symbol: string;
  table: string;
  op: string;
  snippet: string;
}

export interface Unresolved {
  file: string;
  line: number;
  symbol: string;
  op: string;
  arg: string;
}

export interface ScanResult {
  scopedTableCount: number;
  filesScanned: number;
  queriesChecked: number;
  scopedQueries: number;
  /** How many queries each scoping rule accounted for. */
  scopedBy: Record<string, number>;
  violations: Violation[];
  unresolved: Unresolved[];
  allowlistHits: { entry: AllowEntry; hits: Violation[] }[];
  staleAllowlist: AllowEntry[];
  errors: string[];
}

const listFiles = (dir: string): string[] => {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
      if (name.includes(".generated.")) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out.sort();
};

const lineOf = (src: string, index: number): number =>
  src.slice(0, index).split("\n").length;

const QUERY_OP = /\.\s*(from|insert|update|delete)\s*\(/g;

/**
 * A Drizzle builder names its handle at the root of the chain, and this repo
 * spells it `db` — `ctx.db`, `(ctx.db as any)`, the bare `db` a service
 * receives — or `tx` inside a transaction.
 */
const DB_RECEIVER = /\b(?:db|tx|trx)\b/;

/**
 * The three text windows a verdict is computed from, for one query site.
 *
 * Extracted so the scan and the unit tests compute them the SAME way. When the
 * test built its own windows it accidentally handed `hasTenantPredicate` the
 * whole file as the "enclosing function", and the case asserting that one
 * function cannot borrow another's tenant predicate passed for the wrong
 * reason — it was testing the test.
 */
export const windowsFor = (
  masked: string,
  spans: Span[],
  at: number,
): { statement: string; block: string; tail: string } => {
  const span = spanAt(spans, at);
  const fnStart = enclosingFunctionStart(masked, at);
  return {
    statement: masked.slice(span.start, span.end),
    // The enclosing FUNCTION body, so neither the conditions-array hop nor the
    // prior-read guard can borrow evidence from the function next door.
    block: masked.slice(fnStart, span.end),
    // What follows, inside the same function — only a builder filtered in a
    // LATER statement needs it.
    tail: masked.slice(span.end, blockEndAfter(masked, Math.max(0, fnStart - 1))),
  };
};

/**
 * Every Drizzle query site in one source string, with the predicate verdict for
 * each. Table resolution is deliberately NOT applied — this is the matcher on
 * its own, which is what the unit tests need to pin.
 */
export const predicateVerdictsFor = (
  src: string,
): { line: number; op: string; scoped: boolean; via?: string }[] => {
  const masked = maskSource(src);
  const spans = statementSpans(masked);
  const out: { line: number; op: string; scoped: boolean; via?: string }[] = [];
  QUERY_OP.lastIndex = 0;
  let m: RegExpExecArray | null = QUERY_OP.exec(masked);
  while (m) {
    const at = m.index;
    const op = m[1] ?? "";
    m = QUERY_OP.exec(masked);
    if (!DB_RECEIVER.test(chainRoot(masked, at))) continue;
    const w = windowsFor(masked, spans, at);
    out.push({ line: lineOf(src, at), op, ...hasTenantPredicate(w.statement, w.block, w.tail) });
  }
  return out;
};

export const scanTenantScope = async (
  allowlist: readonly AllowEntry[] = ALLOWLIST,
): Promise<ScanResult> => {
  const scoped = await deriveScopedTables();
  const errors: string[] = [];
  if (scoped.size === 0) {
    errors.push(
      `no tenant-scoped tables derived from ${relative(REPO_ROOT, SQLITE_SCHEMA)} — ` +
        `the schema shape changed and this scan checked nothing`,
    );
  }

  const files = listFiles(SERVER_DIR);
  const raw: Violation[] = [];
  const unresolved: Unresolved[] = [];
  let queriesChecked = 0;
  let scopedQueries = 0;
  const scopedBy: Record<string, number> = {};

  for (const full of files) {
    const rel = relative(REPO_ROOT, full);
    const src = readFileSync(full, "utf8");
    if (!src.includes(".schema.")) continue;
    const masked = maskSource(src);
    const spans = statementSpans(masked);
    const helpers = collectHelpers(masked);

    QUERY_OP.lastIndex = 0;
    let m: RegExpExecArray | null = QUERY_OP.exec(masked);
    while (m) {
      const op = m[1] ?? "";
      const openParen = m.index + m[0].length - 1;
      const arg = firstArg(masked, openParen);
      const at = m.index;
      m = QUERY_OP.exec(masked);

      // `.delete()` / `.from()` with no argument, or with a string literal
      // (`map.delete("key")`), is not a table query.
      if (!arg.trim() || /^["'`]/.test(arg.trim())) continue;
      // `Buffer.from`, `Array.from`, `headers.delete`, `map.delete` and
      // `ctx.storage.delete` all share these method names. A Drizzle builder's
      // chain ROOT names the handle — `db` in this repo (`ctx.db`,
      // `(ctx.db as any)`), or `tx` inside a transaction.
      if (!DB_RECEIVER.test(chainRoot(masked, at))) continue;

      const tables = resolveArg(arg, masked, at, helpers);
      if (!tables) {
        // Reported, never skipped: an unresolved query is an UNCHECKED query,
        // and the ceiling in `scanTenantScope` keeps the number from creeping.
        unresolved.push({
          file: rel,
          line: lineOf(src, at),
          symbol: enclosingSymbol(src, masked, at),
          op,
          arg: arg.trim().replace(/\s+/g, " ").slice(0, 80),
        });
        continue;
      }

      const hit = tables.find((t) => scoped.has(t));
      if (!hit) continue;
      queriesChecked++;

      const w = windowsFor(masked, spans, at);
      const verdict = hasTenantPredicate(w.statement, w.block, w.tail);
      if (verdict.scoped) {
        scopedQueries++;
        const kind = (verdict.via ?? "?").split(":")[0] ?? "?";
        const bucket = kind === "inline" || kind === "guard" || kind === "builder" ? kind : "carrier";
        scopedBy[bucket] = (scopedBy[bucket] ?? 0) + 1;
        if (process.env.SCAN_TRACE) {
          console.error(`SCOPED ${rel}:${lineOf(src, at)} ${op}(${hit}) via=${verdict.via}`);
        }
        continue;
      }
      raw.push({
        file: rel,
        line: lineOf(src, at),
        symbol: enclosingSymbol(src, masked, at),
        table: hit,
        op,
        snippet: w.statement.trim().replace(/\s+/g, " ").slice(0, 160),
      });
    }
  }

  // Partition against the allowlist.
  const allowlistHits = allowlist.map((entry) => ({ entry, hits: [] as Violation[] }));
  const violations: Violation[] = [];
  for (const v of raw) {
    // Exact symbol match, deliberately. Substring matching looked friendlier
    // and was wrong twice over: `pruneOldActivity` swallowed the hits belonging
    // to `pruneOldActivityByPrefix`, whose own entry then read as STALE, and
    // one entry silently covering a sibling function is exactly the kind of
    // over-broad exemption this ledger exists to prevent.
    const bucket = allowlistHits.find(
      ({ entry }) =>
        entry.file === v.file &&
        entry.symbol === v.symbol &&
        (entry.table === undefined || entry.table === v.table),
    );
    if (bucket) bucket.hits.push(v);
    else violations.push(v);
  }
  const staleAllowlist = allowlistHits.filter((b) => b.hits.length === 0).map((b) => b.entry);

  if (queriesChecked < MIN_QUERIES) {
    errors.push(
      `only ${queriesChecked} queries against tenant-scoped tables were resolved ` +
        `(floor is ${MIN_QUERIES}) — the resolver no longer recognises this ` +
        `codebase's table-binding idiom, so a quiet result means nothing`,
    );
  }
  if (unresolved.length > MAX_UNRESOLVED) {
    errors.push(
      `${unresolved.length} queries name a table this scan could not resolve ` +
        `(ceiling is ${MAX_UNRESOLVED}) — each one is an UNCHECKED query`,
    );
  }

  return {
    scopedTableCount: scoped.size,
    filesScanned: files.length,
    queriesChecked,
    scopedQueries,
    scopedBy,
    violations,
    unresolved,
    allowlistHits,
    staleAllowlist,
    errors,
  };
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `bun scripts/scan-tenant-scope.ts [--json] [--all] [--unresolved]

  --json        machine-readable output
  --all         also print every allowlisted site (the cross-workspace ledger)
  --unresolved  print queries whose target table could not be resolved

Exits 1 on a violation, a stale allowlist entry, or a scan that saw too little
of the codebase to mean anything.`;

const main = async () => {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  const json = argv.includes("--json");
  const all = argv.includes("--all");
  const showUnresolved = argv.includes("--unresolved");

  const r = await scanTenantScope();
  if (json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(
      `scanned  ${r.filesScanned} files under apps/web/src/server against ` +
        `${r.scopedTableCount} tenant-scoped tables`,
    );
    console.log(
      `queries  ${r.queriesChecked} against a tenant-scoped table — ` +
        `${r.scopedQueries} carry a tenant predicate, ${r.violations.length} do not, ` +
        `${r.allowlistHits.reduce((n, b) => n + b.hits.length, 0)} allowlisted`,
    );
    console.log(
      `scoped   ${Object.entries(r.scopedBy)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k}=${n}`)
        .join("  ")}`,
    );
    console.log(
      `skipped  ${r.unresolved.length} quer${r.unresolved.length === 1 ? "y" : "ies"} whose table could not be resolved (ceiling ${MAX_UNRESOLVED}) — run with --unresolved`,
    );
    console.log();

    if (r.violations.length === 0 && r.errors.length === 0) {
      console.log("✓ no unscoped query against a tenant-scoped table");
    } else if (r.violations.length === 0) {
      // Never print the tick beside an error. "0 violations" from a scan that
      // could not read the codebase is the exact shape this tool exists to
      // stop, and it should not look like a pass for even one line.
      console.log("· 0 violations — but see the failures below; this scan is not a clean bill of health");
    } else {
      console.log(`✗ ${r.violations.length} UNSCOPED QUER${r.violations.length === 1 ? "Y" : "IES"}`);
      for (const v of r.violations) {
        console.log(`  ${v.file}:${v.line}  ${v.symbol}  ${v.op}(${v.table})`);
        console.log(`      ${v.snippet}`);
      }
    }
    console.log();

    if (all) {
      console.log("── deliberate cross-workspace reads ────────────────────────");
      for (const { entry, hits } of r.allowlistHits) {
        console.log(`  ${entry.file}  ${entry.symbol}${entry.table ? ` [${entry.table}]` : ""}`);
        console.log(`      ${entry.reason}`);
        for (const h of hits) console.log(`      · line ${h.line}  ${h.op}(${h.table})`);
      }
      console.log();
    }

    if (showUnresolved && r.unresolved.length > 0) {
      console.log(`── unresolved table expressions (${r.unresolved.length}) ────────────`);
      for (const u of r.unresolved) {
        console.log(`  ${u.file}:${u.line}  ${u.symbol}  ${u.op}(${u.arg})`);
      }
      console.log();
    }

    for (const e of r.staleAllowlist) {
      console.log(`✗ STALE ALLOWLIST ENTRY — ${e.file} ${e.symbol} matches nothing any more`);
    }
    for (const e of r.errors) console.log(`✗ ${e}`);
  }

  return r.violations.length > 0 || r.staleAllowlist.length > 0 || r.errors.length > 0 ? 1 : 0;
};

if (import.meta.main) {
  process.exit(await main());
}
