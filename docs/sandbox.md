---
title: Functions / sandbox
description: User-uploaded JavaScript that runs server-side in an isolated sandbox.
---

User-uploaded JavaScript that runs server-side in an isolated sandbox.

## Three providers

A selector in `apps/web/src/server/services/sandbox/index.ts` picks one based on
the runtime + bindings:

| Priority | Provider     | Runtime                      | Async ctx.* | Isolation     |
|----------|--------------|------------------------------|-------------|---------------|
| 1        | remote-http  | any (FUNCTIONS_EXEC_URL set) | yes (HTTP RPC) | separate process / host |
| 2        | bun-worker   | Bun                          | yes (postMessage RPC) | Worker thread (soft) |
| 3        | quickjs      | anywhere (fallback)          | no          | WASM (true)   |

quickjs stays as the cross-runtime safety net — Workers / Vercel / Netlify
users still get sandbox execution (sync only) without standing up a separate
executor service.

## Triggers

| Trigger | Pattern                | Fires on                                            |
|---------|------------------------|-----------------------------------------------------|
| `http`  | (none)                 | `POST /api/functions/:name/invoke` (admin only)     |
| `event` | `items:posts:*`        | Any `publishEvent` whose channel/event matches      |
| `cron`  | `*/5 * * * *`          | Every 5 minutes (Bun scheduler / Workers triggers / Vercel cron) |

Pattern matching: `*` is a wildcard segment. `items:posts:*` matches
`items:posts:created`, `items:posts:updated`, etc.

## ctx surface

```ts
ctx.data       // input payload (request body for http; { event, data } for event; { firedAt, pattern } for cron)
ctx.user       // { id, email, roles[] } — null/anon for cron
console.log    // captured into the result's `logs[]`

// Async (bun-worker / remote-http only):
await ctx.fetch(url, init?)        // RPC; allow-list via FUNCTIONS_FETCH_ALLOW
await ctx.db.list(slug, query?)    // permission-checked read
await ctx.db.one(slug, id)         // single by id, permission-checked
await ctx.email.send({ to, subject, text, html? })
```

The sandbox returns whatever the user code returns; arrays / objects /
primitives are JSON-serialised. Errors are caught and returned as
`{ ok: false, error }`.

## Time + memory limits

| Limit       | Default | Per-function override        |
|-------------|---------|------------------------------|
| Wall time   | 5000 ms | `timeoutMs` field on function |
| Max memory  | 64 MB   | Per-provider, not exposed yet |

Exceeding the time limit terminates the worker / interrupts the VM.

## ctx.fetch allow-list

Outbound HTTP from sandbox is allow-listed via env:

```bash
FUNCTIONS_FETCH_ALLOW=api.example.com,*.cdn.io
```

`*` allows any host (development only). Empty string disables outbound
fetch. Each comma-separated entry matches the host exactly OR matches
any subdomain (e.g. `cdn.io` allows `assets.cdn.io`).

## Permissions

ctx.db proxies go through the same `resolvePermission` the REST path
uses. `event`/`cron`-triggered functions run with the **system principal**
(no user, no roles) — they bypass `authenticated` permissions. Use admin
review of `active` flag to gate trust.

`http`-triggered functions (admin-only invoke) inherit the calling
admin's auth.

## remote-http RPC bridge

The `remote-http` executor service calls back to the main app over HTTPS at
`/api/_internal/sandbox-rpc`, authenticated with `SANDBOX_RPC_TOKEN`. The
same `dispatchRpc` host-side function services both bun-worker (in-process)
and remote-http (HTTP) — so DSL + permission behaviour stay identical between
providers.

Setup:

```bash
# 1. Run the executor (templates/fn-exec-server) somewhere eval/new Function
#    are allowed — Fly.io, Railway, Render, a plain VM, Cloudflare Containers:
bun run apps/web/templates/fn-exec-server/index.ts   # listens on :8790

# 2. Point the main app at it (env / wrangler secret):
FUNCTIONS_EXEC_URL = https://your-exec-host          # base URL, no /run
SANDBOX_RPC_TOKEN  = $(openssl rand -hex 32)         # same value on both
SELF_URL           = https://api.your.app            # for ctx.* callbacks
```

## Example: enrich an item on create

```js
// trigger: event, pattern: items:posts:created
const post = ctx.data.data;
const r = await ctx.fetch(
  `https://api.openai.com/v1/embeddings`,
  {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.user.email /* placeholder */}`,
    },
    body: JSON.stringify({ model: "text-embedding-3-small", input: post.title }),
  },
);
console.log("embedded", post.id, "in", r.status);
return { id: post.id, len: r.text.length };
```

## Example: nightly digest (cron)

```js
// trigger: cron, pattern: 0 9 * * *  (09:00 UTC daily)
const recent = await ctx.db.list("posts", {
  filter: { created_at: { _gt: "$now" } },   // last day, roughly
  limit: 50,
});
if (recent.length === 0) return { skipped: true };
await ctx.email.send({
  to: "team@example.com",
  subject: `${recent.length} new posts today`,
  text: recent.map((p) => `- ${p.title}`).join("\n"),
});
return { sent: recent.length };
```

## Security model

- **soft sandbox (bun-worker)**: deletes `fetch/process/Bun/require/module/WebSocket` from globalThis before evaluating user code; not a true sandbox — admin-trusted code only.
- **true sandbox (quickjs)**: WASM-isolated, no host access by default. Sync-only and slow.
- **out-of-process (remote-http)**: user code runs in a separate executor service (`templates/fn-exec-server`) — soft within that process, but isolated from the API host. Run the executor least-privilege; back it with a microVM runner for hard isolation of untrusted code.

For admin-uploaded automation, bun-worker (full async, self-host) is fine. On
edge runtimes, point `FUNCTIONS_EXEC_URL` at a remote-http executor for
DB-aware functions, or fall back to the in-isolate QuickJS-WASM sandbox.
