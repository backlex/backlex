---
title: Job queue
description: Durable background jobs — enqueue work, retry with exponential backoff, dead-letter, and delayed/scheduled execution. Cross-runtime, no extra infrastructure.
---

The **job queue** runs background work durably: enqueue a job, and backlex
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
| `type` | Handler: `function` or `webhook.deliver`. |
| `payload` | Handler input (JSON). |
| `queue` | Logical queue name (default `default`). |
| `status` | `pending` → `active` → `succeeded` / `failed` → `dead_letter`; or `cancelled`. |
| `runAt` | Earliest time the job is eligible to run (for delayed/scheduled jobs). |
| `attempts` / `maxAttempts` | Tries used vs. the cap before dead-lettering (default 5). |
| `lastError` | Message from the most recent failure. |
| `result` | Return value of the last successful run. |

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

## Handlers

- **`function`** — runs a named [function](/sandbox/) in the sandbox.
  `payload` is `{ name, input }`; `input` is passed as the function's data.
- **`webhook.deliver`** — delivers one outbound webhook. This is how all
  [webhook](/) dispatch now works: a matching event **enqueues** a
  `webhook.deliver` job per hook (queue `webhooks`) instead of sending inline,
  so a 5xx/timeout from the receiver is retried with backoff and dead-lettered
  rather than lost. Each attempt records a delivery row.

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

### SDK

```ts
await backlex.jobs.enqueue({ type: "function", payload: { name: "resize", input: { id } } });
await backlex.jobs.enqueue({ type: "function", payload: { name: "digest" }, runAt: "2026-07-01T09:00:00Z" });
const { jobs } = await backlex.jobs.list({ status: "dead_letter" });
await backlex.jobs.retry(jobs[0].id);
```

### MCP

`jobs.enqueue`, `jobs.list`, `jobs.get`, `jobs.retry`, `jobs.cancel`.

## Admin UI

**Jobs** (under *Automation*) lists jobs with a status filter, an enqueue
dialog, per-row retry/cancel/delete, and a detail view with the payload, result
and last error.

## Configuration

All optional, with defaults:

| Env | Default | Purpose |
|---|---|---|
| `JOB_MAX_ATTEMPTS` | `5` | Tries before dead-lettering. |
| `JOB_BACKOFF_BASE_MS` | `60000` | Backoff base; retry N waits `base · 2^(N-1)`. |
| `JOB_BACKOFF_MAX_MS` | `3600000` | Backoff ceiling. |
| `JOB_BATCH` | `25` | Max jobs claimed + run per tick. |
| `JOB_LEASE_MS` | `300000` | A job stuck `active` longer than this is reclaimed. |
