---
title: Job queue
description: Durable background jobs — enqueue work, retry with exponential backoff, dead-letter, and delayed/scheduled execution. Cross-runtime, no extra infrastructure.
---

The **job queue** runs background work durably: enqueue a job, and Backlex
drains it off the request path, retrying with exponential backoff and moving it
to a **dead-letter** state after it exhausts its attempts. Jobs can be
**delayed/scheduled** (`runAt`) for later execution.

It rides the same cross-runtime tick that powers [cron functions](/sandbox/) —
there is **no extra infrastructure** (no CF Queues binding, no Redis): the
`jobs` table lives in your instance DB and is drained by the scheduled tick
(`scheduled` handler on Cloudflare Workers, a 30 s interval on Bun, the cron
endpoint on Vercel/Netlify). Latency is therefore up to ~1 minute on Workers —
correct for durable background work, not a low-latency RPC.

## Model

A job row carries:

| Field | Meaning |
|---|---|
| `type` | Handler: `function` or `webhook.deliver` when you enqueue one; also the internal types below. |
| `payload` | Handler input (JSON). |
| `queue` | Logical queue name (default `default`). A label for filtering — **not** an isolation boundary: the claim does not partition by queue, so naming one does not give it its own workers. |
| `status` | `pending` → `active` → `succeeded` / `failed` → `dead_letter`; or `cancelled`. |
| `runAt` | Earliest time the job is eligible to run (for delayed/scheduled jobs). |
| `attempts` / `maxAttempts` | Tries used vs. the cap before dead-lettering (default 5). |
| `lastError` | Message from the most recent failure. |
| `result` | Return value of the last successful run. |
| `progress` | `{ done, total, phase, note }` for the long-running types below. `null` means **the job has not reported**, which is not the same as 0 %. |

### Execution + retries

Each tick **claims** a batch of due jobs (`status='pending'`, or a stale
`active` lease past `JOB_LEASE_MS`), flips them to `active`, and increments
`attempts` *before* running — so a job whose isolate dies mid-run still counts
the try and is reclaimed rather than retried forever. On success the row goes
`succeeded`; on failure it is requeued with `runAt = now + backoff(attempts)`
(exponential, ±10 % jitter, capped at `JOB_BACKOFF_MAX_MS`) until `attempts`
reaches `maxAttempts`, at which point it becomes `dead_letter`.

On Postgres the claim is a single `UPDATE … FOR UPDATE SKIP LOCKED … RETURNING`
(race-free across isolates). On SQLite/D1/libSQL the serial tick claims with
guarded per-row updates.

**A deterministic refusal is not retried.** If a handler fails with a
`VALIDATION`, `FORBIDDEN`, `UNAUTHORIZED` or `NOT_FOUND` error, the job
dead-letters on the first hearing instead of backing off. A collection with no
searchable field will not have one in sixty seconds, and a revoked grant will
not come back on its own — waiting five times to be told the same thing only
hides the reason. Anything else (a driver blip, a provider timeout, an evicted
isolate) keeps the full backoff, which is what retries are for. `retry` is still
available once the cause is actually fixed.

### Dead-letter alerting

A dead-lettered job is recorded in the `activity` feed **and** published on the
`system` event channel as `system:job.dead_letter` (payload: `jobId`, `type`,
`queue`, `tenantId`, `attempts`, `error`). Subscribe an outbound webhook to
`system:job.dead_letter` (or `system:*`) to forward it to Slack / PagerDuty /
your on-call, or trigger a flow / event function on it — so an exhausted job
surfaces proactively instead of sitting silently in the queue. `webhook.deliver`
jobs are excluded from this event (their failures already show in the delivery
log + auto-disable, and re-publishing could loop while the endpoint is down).

## Handlers

- **`function`** — runs a named [function](/sandbox/) in the sandbox.
  `payload` is `{ name, input }`; `input` is passed as the function's data.
- **`webhook.deliver`** — delivers one outbound webhook. This is how all
  [webhook](/) dispatch now works: a matching event **enqueues** a
  `webhook.deliver` job per hook (queue `webhooks`) instead of sending inline,
  so a 5xx/timeout from the receiver is retried with backoff and dead-lettered
  rather than lost. Each attempt records a delivery row.

## Long-running admin operations

Four operations that used to run **inside the request** can now run on this
queue instead. They were the six most likely to exceed a request deadline and
the six with no retry, no cancel and no record of having got half way — a
vector reindex in particular makes one embedding API call per hundred rows,
over every row, with no ceiling.

Each keeps its synchronous behaviour exactly as it was and gains **`?async=1`**,
which enqueues instead and answers `202` with a `jobId`:

| Route | Job type | Attempts | Notes |
|---|---|---|---|
| `POST /api/admin/db/backups/now?async=1` | `db.backup` | 3 | The `backups` tracking row is still created synchronously, so you leave with a backup id. Its own `status` is the replay guard. |
| `POST /api/admin/db/backups/{id}/restore?async=1` | `db.restore` | **1** | Never replayed. A restore writes into live tables; a half-finished one re-run from the top is not idempotent in `overwrite` mode. |
| `POST /api/collections/{slug}/fts-reindex?async=1` | `collection.reindex` | 3 | `kinds: ["fts"]`. |
| `POST /api/collections/{slug}/vectorize?async=1` | `collection.reindex` | 3 | `kinds: ["vector"]`. Reports progress per 100-row batch. |
| `POST /api/items/{slug}/rollups/refresh?async=1` | `collection.reindex` | 3 | `kinds: ["rollups"]`. Gated on `update`, not admin — the job re-checks it. |
| `POST /api/geo/backfill/{slug}?async=1` | `geo.backfill` | 2 | Works through the whole collection, queueing its own continuation, instead of one bounded batch. Every attempt spends metered geocoder quota. |

Nothing is forced to change: the SDK, CLI, MCP and admin twins keep calling the
synchronous path and get the same response they always did.

### A queued job carries an identity, never a permission

This is the rule the design turns on, because two of these operations are
scoped by **row-level** permissions rather than by the admin role. The bundled
self-service roles grant `update` conditioned on a column, so holding `update`
on a collection is not holding it on every row of it — an unscoped geocode
backfill would write to every other customer's record and ship their addresses
to a third-party provider on the way.

So the payload carries `runAs: { userId, tenantId }` and nothing else. Role
names, workspace membership and the compiled row filter are resolved **again,
from the database, when the work runs**. A grant revoked while the job sat in
the queue therefore stops it; a filter serialized at enqueue time would still be
enforcing the grant the person held when they pressed the button.

**Three kinds of caller are refused rather than queued**, and get a `422`
pointing them at the synchronous path:

- **API keys.** A role-scoped key resolves to exactly its bound role.
  Re-resolving from the owner's id would give the job the owner's *full* role
  bundle — a scoped key escalating to its owner.
- **Workspace end-users** (the app plane). Their grants come from
  `app_user_roles` plus their organization membership, and `$org.id` /
  `$org.role` / `$user.orgs` bind off the request's subject. None of that
  survives a `{userId, tenantId}` round trip.
- **Impersonation sessions.** The read-only flag lives on the request, so a
  queued write could outlive the session that authorised it.

### Progress, and why it is also a lease

A long job writes `progress` **once per batch** — per table for a backup, per
100 rows for a vector reindex. The same write restamps the job's lease, and that
is not cosmetic: the queue re-claims anything that has been `active` longer than
`JOB_LEASE_MS` (5 minutes), and the cron fires every minute. Without a
heartbeat, a job that ran longer than the lease — which is the entire reason
these moved onto the queue — would be claimed and started a **second time**
while the first copy was still running.

### Watching one finish

```ts
const { data } = await fetch("/api/admin/db/backups/now?async=1", { method: "POST" }).then(r => r.json());
const job = await backlex.jobs.waitFor(data.jobId, {
  onProgress: (p) => console.log(`${p.done}/${p.total ?? "?"} ${p.phase ?? ""}`),
});
if (job.status !== "succeeded") throw new Error(job.lastError ?? "job failed");
```

`waitFor` resolves on **any** terminal status, including `dead_letter` — a job
that failed is an answer, not an exception, and `lastError` says why. Only the
wait itself throws, on timeout or abort. From the CLI:

```bash
backlex jobs get <id> --watch    # prints progress; exits non-zero unless it succeeded
```

## API

All routes are admin-scoped and workspace-tenant-scoped.

```http
POST   /api/jobs                 # enqueue { type, payload?, queue?, runAt?, maxAttempts?, priority? }
GET    /api/jobs?queue=&status=  # list (newest first)
GET    /api/jobs/{id}            # fetch one
POST   /api/jobs/{id}/retry      # requeue a failed / dead-lettered / cancelled job
POST   /api/jobs/{id}/cancel     # cancel a pending job
DELETE /api/jobs/{id}            # delete the row
```

`POST /api/jobs` takes `function` and `webhook.deliver` only. The internal types
— the integration, agent and long-running admin ones — are enqueued by the
product, deliberately: their payloads carry things a caller must never be able
to write, `runAs` above all.

### SDK

```ts
await backlex.jobs.enqueue({ type: "function", payload: { name: "resize", input: { id } } });
await backlex.jobs.enqueue({ type: "function", payload: { name: "digest" }, runAt: "2026-07-01T09:00:00Z" });
const { jobs } = await backlex.jobs.list({ status: "dead_letter" });
await backlex.jobs.retry(jobs[0].id);
await backlex.jobs.waitFor(jobs[0].id, { intervalMs: 3000, timeoutMs: 600_000 });
```

### MCP

`jobs.enqueue`, `jobs.list`, `jobs.get`, `jobs.retry`, `jobs.cancel`.

## Admin UI

**Jobs** (under *Automation*) lists jobs with a status filter, an enqueue
dialog, per-row retry/cancel/delete, and a detail view with the payload, result
and last error. A long-running job shows its latest progress reading under its
type; a job that has not reported shows nothing there rather than `0`.

## Retention

Finished jobs are deleted on the daily cron tick. Two clocks, because the rows
answer different questions:

| Rows | Env | Default |
|---|---|---|
| `succeeded`, `cancelled` | `JOBS_RETENTION_DAYS` | 30 days |
| `failed`, `dead_letter` | `JOBS_DEAD_LETTER_RETENTION_DAYS` | 90 days |

Set either to `0` to keep those rows forever. Nothing pruned this table before,
so on a busy workspace it outgrew the user data — and on D1 that is the whole
database.

**`pending` and `active` jobs are never deleted at any setting.** A delayed or
scheduled job legitimately carries an old `created_at` and a `run_at` in the
future; a status-blind cutoff would quietly eat work that had not run yet.

## Configuration

All optional, with defaults:

| Env | Default | Purpose |
|---|---|---|
| `JOB_MAX_ATTEMPTS` | `5` | Tries before dead-lettering. |
| `JOB_BACKOFF_BASE_MS` | `60000` | Backoff base; retry N waits `base · 2^(N-1)`. |
| `JOB_BACKOFF_MAX_MS` | `3600000` | Backoff ceiling. |
| `JOB_BATCH` | `25` | Max jobs claimed + run per tick. |
| `JOB_LEASE_MS` | `300000` | A job stuck `active` longer than this is reclaimed. |
