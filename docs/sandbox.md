---
title: Functions / sandbox
description: User-uploaded JavaScript that runs server-side in an isolated sandbox.
---

User-uploaded JavaScript that runs server-side in an isolated sandbox.

## Three providers

A selector in `apps/web/src/server/services/sandbox/index.ts` picks one. By
default it picks the strongest isolation the deployment can offer:

| Provider     | Selected when                          | Async ctx.* | Isolation     |
|--------------|----------------------------------------|-------------|---------------|
| remote-http  | `FUNCTIONS_EXEC_URL` is set            | yes (HTTP RPC) | separate process / host |
| quickjs      | otherwise — the default everywhere     | no          | WASM (true)   |
| bun-worker   | `FUNCTIONS_SANDBOX=bun-worker`, on Bun | yes (postMessage RPC) | **none** — see below |

quickjs is the cross-runtime default — Workers / Vercel / Netlify / Node / Bun
all get sandbox execution (sync only) without standing up a separate executor
service.

**On quickjs, every `ctx.*` host call refuses by name.** It is not that the
calls are missing: the bundled QuickJS ships only synchronous WASM, so there is
no way to suspend the guest while a host promise settles, and the provider
installs each host call as a function that throws

> host I/O is not available on the in-isolate QuickJS runtime … set
> `FUNCTIONS_EXEC_URL` to an out-of-isolate executor, or, on a Bun self-host
> where function authors are the operator, `FUNCTIONS_SANDBOX=bun-worker`

rather than leaving it undefined — which would fail as "undefined is not an
object" and send you looking at your own code. So a function that needs
`ctx.fetch`, `ctx.db`, `ctx.email`, `ctx.push` or `ctx.ai` needs one of those
two settings.

### bun-worker is not a sandbox, and is opt-in

It used to be chosen automatically on any Bun self-host. It is not isolation of
any kind — measured against a real Bun Worker running the provider's own
construction:

```js
await import("node:process")   // -> the API host's entire env
await import("node:fs")        // -> any file the process can read
globalThis.Bun.spawnSync([…])  // -> arbitrary commands
```

and none of it can be closed from inside the worker. `Bun` is defined
`configurable: false, writable: false`, so it cannot be deleted or redefined,
and `import()` is a keyword no parameter can shadow. The `delete`d globals in
`worker-entry.ts` are defence in depth, not a boundary.

Function authoring is gated on the `admin` role, and `POST /api/tenants` grants
`admin` to whoever creates a workspace. So on a **multi-tenant** Bun self-host,
"can author a function" and "can run commands on the API host and read
`DATABASE_URL`" were the same permission.

Set `FUNCTIONS_SANDBOX=bun-worker` only where the people writing functions are
the people running the deployment — a single-tenant self-host, or a dev box.
Anywhere else, use `FUNCTIONS_EXEC_URL` and run the executor as its own
least-privilege service.

| `FUNCTIONS_SANDBOX` | Effect |
|---|---|
| unset / `auto` | remote-http if `FUNCTIONS_EXEC_URL` is set, else quickjs |
| `quickjs` | pin the in-isolate WASM sandbox |
| `remote-http` | pin the external executor (errors if the URL is missing) |
| `bun-worker` | opt into the in-process worker (errors off Bun) |

An unrecognised value reads as `auto`, so a typo cannot silently downgrade
isolation.

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

// Async (bun-worker / remote-http only — on quickjs each of these throws):
await ctx.fetch(url, init?)        // RPC; allow-list via FUNCTIONS_FETCH_ALLOW
await ctx.db.list(slug, query?)    // permission-checked read
await ctx.db.one(slug, id)         // single by id, permission-checked
await ctx.email.send({ to, subject, text, html? })
await ctx.push.send({ userId | userIds, title, body, url?, data? })
await ctx.ai.generate({ prompt, system?, model?, maxTokens?, timeoutMs? })
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
`/api/_internal/sandbox-rpc`. The same `dispatchRpc` host-side function
services both bun-worker (in-process) and remote-http (HTTP) — so DSL +
permission behaviour stay identical between providers.

Setup:

```bash
# 1. Run the executor (templates/fn-exec-server) somewhere eval/new Function
#    are allowed — Fly.io, Railway, Render, a plain VM, Cloudflare Containers:
bun run apps/web/templates/fn-exec-server/index.ts   # listens on :8790

# 2. Point the main app at it (env / wrangler secret):
FUNCTIONS_EXEC_URL = https://your-exec-host          # base URL, no /run
SANDBOX_RPC_TOKEN  = $(openssl rand -hex 32)         # main app only
SELF_URL           = https://api.your.app            # for ctx.* callbacks
```

### The executor never holds the shared secret

`SANDBOX_RPC_TOKEN` is set on the **main app only**. What the executor receives,
in each `/run` body's `rpcToken`, is a short-lived signed **grant** carrying the
`(userId, email, roles, tenantId)` of that one invocation; the executor echoes
it back as its bearer, and the callback derives the subject from the signature.

That matters because the executor is a soft sandbox running user-authored code
in-process. Anything it can read, a function author can read — wrapping
`globalThis.fetch` and calling `ctx.db` once is enough to capture its own
Authorization header. Before the grant existed, the callback took its subject
from the request **body** and the shared token was the only thing behind it, so
that captured header could be replayed naming any workspace: `email.send`,
`push.send` and `ai.generate` do no permission or membership check of their own,
so another workspace's mail transport, devices and AI budget were all reachable.

A stolen grant is worth only the invocation it was minted for, and it expires.

**If you wrote your own executor**, forward the `/run` body's `rpcToken`
verbatim — the shipped template already does. An executor that instead sends
`SANDBOX_RPC_TOKEN` from its own env still authenticates and still gets
`ctx.fetch` / `ctx.db` (those re-resolve permissions from the database), but
`email.send`, `push.send` and `ai.generate` refuse, naming this fix.

## Example: enrich an item on create

```js
// trigger: event, pattern: items:posts:created
const post = ctx.data.data;
const { text, usage } = await ctx.ai.generate({
  prompt: `Write a one-sentence summary of this post:\n\n${post.body}`,
  system: "You write plain, factual summaries. No preamble.",
  maxTokens: 200,
});
console.log("summarised", post.id, usage);
return { id: post.id, summary: text };
```

`ctx.ai.generate` goes through the same provider chokepoint as everything else
in the product: no key lives in your function. The workspace's **Settings · AI**
credential is resolved server-side and, on managed cloud, generation runs on the
platform gateway with no key to configure at all. Every call is
[metered](/docs/usage-metering/) against the workspace as an AI call.

- `model` is optional — omitted, the workspace default applies. On managed cloud
  the gateway forwards only Workers AI (`@cf/…`) ids and uses its own default
  for anything else, so naming a model is a hint on self-host and ignored there.
- The answer is `{ text, usage? }`. `usage` carries tokens on a direct provider
  key and neurons on the managed gateway, and is **absent** when the provider
  reported nothing.
- `timeoutMs` defaults to 60s. It is the generation's own deadline: a function's
  `timeoutMs` stops the *guest*, and on the bun provider that terminates the
  worker thread while a host call already in flight keeps going.
- A function running with no workspace bound is refused rather than falling back
  to the deployment's own key.
- Not available on the quickjs provider — see the note under
  [Three providers](#three-providers).

For a reasoning loop with tools and memory rather than one call, the feature is
[agents](/docs/agents/); for one step inside an automation, it is the `ai.generate` /
`ai.classify` [flow operations](/docs/flows/).

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

- **true sandbox (quickjs)** — the default. WASM-isolated, no host access at
  all. Sync-only and slow. Safe to hand to anyone who can hold the `admin` role.
- **out-of-process (remote-http)** — user code runs in a separate executor
  service (`templates/fn-exec-server`). Soft *within* that process, but isolated
  from the API host, and the executor holds no deployment secret (see
  [the grant](#the-executor-never-holds-the-shared-secret)). Run it
  least-privilege — its own host or container, no extra secrets, restricted
  egress — and back it with a microVM runner for hard isolation of genuinely
  untrusted code.
- **no sandbox (bun-worker)** — opt-in, and the name is the warning. The
  `delete` of `fetch/process/Bun/require/module/WebSocket` stops a bare
  identifier reference and nothing more: `globalThis.Bun` survives it
  (non-configurable) and `import("node:fs")` was never covered. Code that runs
  here can do anything the API process can do. Only for a deployment where the
  function authors ARE the operator.

The question to ask is not "is my code trusted" but **"who can author a
function here?"** `POST /api/tenants` grants `admin` to whoever creates a
workspace, so unless workspace creation is closed and every admin is you, that
answer includes people you have not met.
