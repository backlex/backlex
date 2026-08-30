---
name: backlex
description: Drive a backlex backend correctly — auth, collections, the query grammar, permissions, and the MCP endpoint. Use when writing code against a backlex instance (a server exposing /api/..., the `backlex` npm package, or an MCP server at /mcp), and especially before the first request, because most of what fails on a first attempt fails for a reason that is not guessable from the endpoint alone.
license: Apache-2.0
metadata:
  project: backlex
  homepage: https://github.com/backlex/backlex
  docs: https://backlex.com/docs
---

# Driving a backlex backend

backlex is a self-hostable backend platform: collections (tables) exposed over
REST + GraphQL, auth, storage, realtime, jobs, flows and an MCP server, running
on Cloudflare Workers, Bun, Node, Vercel, Netlify, Deno, Lambda, GCP or Azure.

**Two auth planes, and confusing them is the most common structural mistake.**
`platform` is the operator plane — the people who run the instance, `/api/...`,
admin roles. `app` is the customer's own end users — `/api/t/{workspace}/...`,
their own accounts. A platform user is not an app user and an app user cannot
reach `/api/...`. Pick the plane before picking the endpoint.

## Before the first request

| | |
|---|---|
| Health probe | **`/health`** — not `/api/health`, which is a 404 that reads exactly like "the server is down" |
| Sign in | `POST /api/auth/sign-in/email` with `{email, password}` |
| Active workspace | `X-Backlex-Tenant: <id>` header |
| Errors | `{ "error": { "code", "message", "details" }, "requestId" }` |

**Always send an `Origin` header from a server-side caller.** Auth is
better-auth, which CSRF-rejects a request with no `Origin` — a browser always
sends one, `fetch` from Node/Bun/an edge function does not. This is the single
most common "my credentials are correct and I still get 403".

```bash
curl -X POST "$URL/api/auth/sign-in/email" \
  -H 'content-type: application/json' -H "Origin: $URL" \
  -d '{"email":"…","password":"…"}' -c cookies.txt
```

**Read `error.code`, not the HTTP status.** The status is derived from the code
(`UNAUTHORIZED` → 401, `FORBIDDEN` → 403, `NOT_FOUND` → 404, `VALIDATION` → 422,
`CONFLICT` → 409, `RATE_LIMITED` → 429, `PAYLOAD_TOO_LARGE` → 413, `INTERNAL` →
5xx), so the code is the stable thing to branch on. `VALIDATION` carries
`details` with the failing fields.

## Reading data

`GET /api/items/{collection}` takes the filter grammar below. The same grammar
is used by the SDK, GraphQL and the MCP tools — learn it once.

| operator | meaning |
|---|---|
| `_eq` `_neq` | equals / not equals |
| `_gt` `_gte` `_lt` `_lte` | comparison |
| `_in` `_nin` | in / not in a list |
| `_contains` `_starts_with` `_ends_with` | substring (case-sensitive) |
| `_icontains` `_istarts_with` `_iends_with` | substring (case-insensitive) |
| `_between` | inclusive range |
| `_null` `_empty` `_nempty` | presence |
| `_and` `_or` `_not` | grouping |
| `__` | traverse a relation: `author__name` |

```
GET /api/items/posts?filter={"status":{"_eq":"published"},"author__name":{"_icontains":"aylin"}}
                    &fields=id,title,author__name&sort=-created_at&limit=50
```

Paginate with `?cursor=` (keyset), not `?offset=` — the response carries
`has_more` and the next cursor, and keyset pagination is the only one that stays
correct while rows are being written.

## Writing schema

`POST /api/collections` is the **single** create endpoint, and the `adopted`
flag decides what it does:

- `adopted: false` (default) — backlex creates the physical table and owns it.
- `adopted: true` — the table already exists; backlex only records metadata and
  will not touch its DDL.

**Schema application is additive only.** It never drops or alters an existing
column. Removing a field is a separate, deliberate call (`dropField`) so that a
destructive change is always something someone chose.

## The TypeScript SDK

```ts
import { createClient } from "backlex";

// Operator plane: an API key or a platform session.
const backlex = createClient({ url: "https://api.example.com", apiKey: process.env.BACKLEX_KEY });

// App plane: your own end users. `workspace` is required for this mode.
const app = createClient({ url: "https://api.example.com", workspace: "acme" });
await app.auth.signIn({ email, password });
```

`client.agentChat` is app-plane only and throws without `workspace` rather than
addressing `/api/t/undefined/...` and returning a 404 that reads like a missing
agent.

## The MCP server

`POST /mcp` (tenant) and `POST /api/admin/mcp` (admin, additionally requires the
platform `admin` role). POST only; `GET`/`DELETE` are 405 by design — the
transport is stateless and was never resumable.

- Current revision **`2026-07-28`**, and `2025-11-25` / `2025-06-18` /
  `2025-03-26` are still answered. A request declaring the new revision gets
  `resultType`, `_meta` and cache hints; anything else gets the old shape
  unchanged.
- `server/discover` reports supported versions, capabilities and identity, and
  needs no handshake. Call it first if you want to know what you are talking to.
- Under `2026-07-28` the standard headers are validated against the body:
  `Mcp-Method` must equal `method`, and `Mcp-Name` must equal `params.name`
  (or `params.uri`). A mismatch is `400` with JSON-RPC `-32020`.

**Tool names differ by mount.** The tenant mount hyphenates
(`schema-list_collections`) because strict clients enforce
`^[a-zA-Z0-9_-]{1,64}$`; the admin mount keeps the canonical dotted id
(`schema.list_collections`). `tools/call` accepts either.

## Traps worth knowing before you hit them

1. **A new API key can call no MCP tools at all.** `POST /api/api-keys` without
   `mcpTools` returns `mcpTools: []` — default-deny, on purpose. List the tools
   the key should reach (`["collections.*", "schema.read"]`); `mcpTools: null`
   mints an unrestricted key and is worth reaching for deliberately, not by
   default.
2. **`Origin` on server-side auth calls.** See above; it is a 403 that looks
   like bad credentials.
3. **`/health`, not `/api/health`.**
4. **An agent's tool calls are bounded by the caller.** Running a backlex agent
   does not escalate: its tool calls re-enter as the user who started the turn,
   under their permission rules and their MCP guards.
5. **Permissions are per (collection, action)** with an optional condition DSL
   over `$user.id`, `$user.email`, `$user.roles`, `$tenant.id` and `$now`. An
   empty result is usually a permission narrowing the rows, not an empty table.

## Where the full reference is

`docs/querying.md` (filter grammar in full), `docs/permissions.md` (the DSL),
`docs/mcp.md` (every tool, the transport rules), `docs/sdk-and-cli.md` (the SDK
and the `backlex` CLI), `docs/auth-planes.md` (the platform/app split).
