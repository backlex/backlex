---
title: MCP (Model Context Protocol)
description: Expose a Backlex workspace to AI agents — Claude Desktop, Cursor, IDE plugins — over the MCP Streamable HTTP and stdio transports.
---

Backlex ships a built-in MCP (Model Context Protocol) server so AI
agents can read schema, query collections, manage storage, and invoke
sandbox functions through one authenticated endpoint. The same identity
model the rest of the API uses (personal access keys / sessions /
permissions DSL) carries over — agents never see anything their key
isn't allowed to see.

## Endpoints

Two mounts, same tool set:

| Mount | Auth | Use case |
|---|---|---|
| `POST /mcp` | Any authenticated identity (cookie session, `pak_…` API key, app-plane bearer). Permissions DSL filters results per the caller's roles. | Tenant agents (a workspace member wires Claude Desktop to their own Backlex). |
| `POST /api/admin/mcp` | Same as above **plus** the system `admin` role. | Ops bots, CI agents — fails loudly on non-admin auth instead of silently returning empty results. |

Both speak the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)
in **stateless** mode: each POST is one JSON-RPC message, the response
is `application/json` with the result. There is no `GET /mcp` — `2026-07-28`
removed the GET stream from the transport, so its absence is now the spec's
shape rather than ours.

## Protocol revisions

The server is **dual-era**. `2026-07-28` deleted the `initialize` handshake and
moved version, identity and capabilities into per-request `_meta`, but it also
opened a twelve-month deprecation window — and every client in the field today
still opens with `initialize`. So both are served on the same path, and which
one you get is a property of the **request**, never of a connection:

| You send | You get |
|---|---|
| `_meta["io.modelcontextprotocol/protocolVersion"] = "2026-07-28"` (or the matching header) | The modern shape: `resultType`, `_meta["io.modelcontextprotocol/serverInfo"]`, and `ttlMs` / `cacheScope` on the cacheable methods. Standard headers are validated against the body. |
| Anything else, including nothing at all | Byte-for-byte the pre-2026 shape. None of the new fields appear. |

Accepted revisions, newest first: **`2026-07-28`**, `2025-11-25`, `2025-06-18`,
`2025-03-26`. A request that declares nothing is assumed to be `2025-03-26`.

`initialize` deliberately never negotiates `2026-07-28` — that revision has no
handshake, so answering it there would send the client into
`notifications/initialized` on a protocol that deleted the concept. It
negotiates `2025-11-25` instead.

### `server/discover`

The modern replacement for the handshake, and the probe a dual-era client uses
to tell a modern server from a legacy one. It answers in the modern shape no
matter what the request declared:

```jsonc
{
  "supportedVersions": ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
  "capabilities": { "tools": {…}, "resources": {…}, "prompts": {…}, "extensions": {} },
  "instructions": "backlex MCP server — …",
  "resultType": "complete",
  "_meta": { "io.modelcontextprotocol/serverInfo": { "name": "backlex", "version": "0.0.1" } },
  "ttlMs": 3600000,
  "cacheScope": "public"
}
```

`extensions` is declared rather than omitted, so a client can tell "supports
none" from "predates the field". One extension is implemented — see below. MCP
Apps and Enterprise Managed Authorization are not.

### The Tasks extension

`io.modelcontextprotocol/tasks` gives a client a **durable handle** for work
that outlives a connection. A client opts in per request, in its
`_meta` capabilities:

```jsonc
"io.modelcontextprotocol/clientCapabilities": {
  "extensions": { "io.modelcontextprotocol/tasks": {} }
}
```

**This server has no task table, and that is the design.** The extension is the
protocol shape of two records that were already durable and tenant-scoped:

| handle | backed by |
|---|---|
| `run:<id>` | `agent_runs` — one agent turn |
| `job:<id>` | the durable job queue |

The id carries its own kind, so `tasks/get` knows which store to read without a
lookup table and a third handle can be added later without a migration.

| method | behaviour |
|---|---|
| `tasks/get` | current status, plus `result` on `completed` or `error` on `failed` |
| `tasks/update` | acknowledged. Nothing here surfaces `inputRequests`, and the spec's instruction for that case is to acknowledge and ignore unknown keys — refusing would strand a conforming client that always sends them |
| `tasks/cancel` | **cooperative**: acknowledged always, honoured for jobs. An agent turn is deliberately not cancellable — its tool calls have already happened, which is the same reason a turn is never replayed |

Status mapping: `queued`/`running`/`pending`/`active` → `working`,
`done`/`succeeded` → `completed`, `error`/`failed`/`dead_letter` → `failed`,
`cancelled` → `cancelled`. `dead_letter` reports as `failed` rather than
`cancelled` because a job that exhausted its retries has failed, and
`cancelled` would imply somebody chose it.

Two rules worth knowing:

- **A task is never handed to a client that did not ask for one.** A
  `CreateTaskResult` is a different result shape; a client that has not opted in
  reads it as a failed call or, worse, as the answer.
- **An unknown task id and another workspace's task id answer identically.**
  Otherwise a task id would be a probe for whether someone else's run exists.

### Cache hints

`2026-07-28` requires `ttlMs` + `cacheScope` on `tools/list`, `prompts/list`,
`resources/list`, `resources/read` and `resources/templates/list`.
**`cacheScope` here is a security decision, not a tuning knob** — `public` lets a
shared intermediary keep one copy and hand it to the next caller, which is only
true of results that are identical for everyone:

| Result | `cacheScope` | Why |
|---|---|---|
| `server/discover`, `prompts/list`, `resources/templates/list` | `public` | Static per deploy, identical for every caller. |
| `tools/list` | `private` | Filtered by the caller's per-key **and** per-role allowlist. |
| `resources/list`, `resources/read` | `private` | The workspace's own collections, behind the permission DSL. |

`tools/list` is also returned in a **deterministic (sorted) order**, which is
what makes it cacheable at all — and what keeps an LLM provider's prompt cache
from missing on every reconnect because two of the 300+ tools swapped places.

### Transport rules we enforce

- **`Origin`** — when present it must match `APP_URL` or a workspace-allowed
  origin (DNS-rebinding defense); a missing `Origin` (non-browser client) is fine.
- **`MCP-Protocol-Version`** — when present it must be a supported revision, else
  `400` with `-32022` (`UnsupportedProtocolVersion`) whose `data.supported` lists
  what to retry with. When it and the body's `_meta` both name a version, they
  **must agree**.
- **`Mcp-Method` / `Mcp-Name`** — mirrored from `method` and `params.name` /
  `params.uri`. Required on a modern request; validated in **every** era when
  present, because a header that disagrees with the body is how a gateway and
  the server that executes the call end up doing different things. A mismatch is
  `400` with `-32020` (`HeaderMismatch`). `Mcp-Name` values wrapped in the
  Base64 sentinel (`=?base64?…?=`) are decoded before comparison.
- **Unknown method** — `-32601`, answered with HTTP `404` for a modern caller and
  HTTP `200` for a legacy one (which has always read it that way).
- **No JSON-RPC batching** — removed in 2025-06-18; an array body is rejected with
  `400`. Send one message per POST.
- **`Mcp-Session-Id` / `Last-Event-ID`** — ignored. This transport was already
  sessionless and never resumable, which is the one place the implementation was
  ahead of the spec rather than behind it.

## Tools

### Tool kind metadata

`tools/list` decorates every tool descriptor with the standard MCP
`annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`,
`openWorldHint`) so spec-aware clients can auto-approve reads and warn on
destructive calls — plus two backlex-specific fields the
[Ask AI Tools tab](/docs/ask-ai/#tools-tab) uses for at-a-glance badges:

- `kind` — `"read"` / `"write"` / `"destruct"`. This is the **single source of
  truth**: it drives both the `annotations` above and the per-key read-only
  guard, so the badge and the security gate can never disagree. When a tool
  doesn't set it, `resolveKind` derives it from the verb token after the last
  dot (`.list_*` / `.read*` / `.search*` / `.get*` / `.describe*` → `read`;
  `.delete*` / `.drop*` / `.revoke*` / `.suspend*` → `destruct`; **everything
  else → `write`**, a fail-safe so a new mutating tool is blocked for read-only
  keys until reviewed). Set `kind` explicitly only when the heuristic would
  misclassify (e.g. `collections.aggregate` / `ai.query` are reads with
  non-read verbs).
- `adminOnly` — `true` for tools that are only reachable through
  `/api/admin/mcp` (today: `functions.list`, `functions.invoke`). Pure
  metadata; the actual gating lives in the route's `requireAdmin`
  middleware, not in the dispatcher.

Clients that don't know about the extra fields ignore them — both are
additive to the standard MCP descriptor.

### Structured output schemas

Tools whose `structuredContent` has a stable, knowable shape declare an
`outputSchema` (MCP 2025-06-18) so a spec-aware client can validate / type the
result: `schema.list_collections`, `schema.describe_collection`,
`collections.aggregate`, and `collections.list` (the `{ data, limit, offset,
meta? }` envelope — the rows inside `data` stay open since they're arbitrary
collection records). Data-passthrough tools that return arbitrary user rows
(`collections.read`, `vector.search`, …) omit it rather than ship a schema that
wouldn't match.

### Resource links in results

`schema.create_collection` and `schema.describe_collection` attach a
`resource_link` content block pointing at `backlex://collection/<slug>` (after
the text / `structuredContent`). A 2025-06-18-aware client renders it as a
follow-up: the agent can pull the collection's full schema + sample rows as a
resource instead of composing a separate `resources/read`.

### Schema

| Tool | Description |
|---|---|
| `schema.list_collections` | Discovery — every collection visible to the active workspace, with field counts and adopted/owner-scoped flags. |
| `schema.describe_collection` | Full field schema for one collection — types, relations, validation, defaults. |
| `schema.create_collection` | Create a managed or adopted collection from a field list. |
| `schema.update_collection` | Patch a collection's metadata or field list (additive only). |
| `schema.drop_collection` | Delete managed collections (destructive) or archive adopted ones. |
| `templates.list` | List the schema-template catalog (blog, ecommerce, crm, …) with category, recommended flag and sample-row counts. |
| `templates.apply` | Seed a vertical template's collections + sample data into the workspace (idempotent; admin). |

### Collections (data)

| Tool | Description |
|---|---|
| `collections.list` | List items with Directus-shaped `filter`, `sort`, `fields`, `limit`, `offset`. |
| `collections.read` | Read a single item by id. |
| `collections.insert` | Create a new item (server-side validated against the collection schema). |
| `collections.update` | PATCH a single item by id. |
| `collections.delete` | Delete an item by id. |
| `collections.bulk_insert` | Insert many rows in one call with bounded concurrency; per-row results returned. |
| `collections.bulk_update` | Patch many rows by id in one call; per-row results returned. |
| `collections.batch` | Mixed create/update/delete on one collection in a single call; `atomic: true` runs it all-or-nothing (Postgres / self-host SQLite). |

### Storage

| Tool | Description |
|---|---|
| `storage.list` | List files with prefix / folder / search filters. |
| `storage.get` | Fetch a file's bytes — inline as text for small JSON/text, base64 resource for binaries. |
| `storage.upload` | Upload a file — `text` for UTF-8, `base64` for binary. |
| `storage.delete` | Delete a file by logical key. |
| `storage.sign_url` | Issue a short-lived signed URL for sharing without exposing the bytes. |
| `uploads.list` | List resumable (TUS) upload sessions, filterable by status. |
| `uploads.get` | Inspect one upload session — declared size, committed offset (resume point), status. |
| `uploads.abort` | Abort an in-progress resumable upload and discard its staged parts. |
| `items.publish` | Publish a versioned-collection item now (needs the `publish` permission). |
| `items.unpublish` | Revert a versioned item to draft (clears any pending schedule). |
| `items.schedule_publish` | Schedule (or cancel) a future publish the cron tick applies when due. |
| `flags.list` | List feature-flag definitions (global defaults + workspace overrides). |
| `flags.set` | Create/update a flag — enabled, value, and targeting (condition + rollout). |
| `flags.remove` | Delete a feature flag (workspace or `scope:"global"`). |

### Vector / search

| Tool | Description |
|---|---|
| `vector.search` | Embed a text query, run ANN search, return matches with score + metadata. |
| `vector.upsert` | Embed and upsert text records (id + text + metadata). |

### GraphQL

| Tool | Description |
|---|---|
| `graphql.execute` | Run any query or mutation against the auto-generated workspace schema. |

### Permissions & roles

| Tool | Description |
|---|---|
| `permissions.list_for_role` | Permission rows attached to a role (collection, action, condition, fields). |
| `permissions.grant` | Bind a (collection, action) permission to a role with optional DSL condition + field allow-list. |
| `permissions.revoke` | Delete a permission row by id. |
| `roles.list` | List every role in the active workspace. |
| `roles.create` | Create a new role. |
| `roles.assign` | Assign a role to a user. |
| `roles.unassign` | Remove a role from a user. |

### API keys

| Tool | Description |
|---|---|
| `apikeys.list` | List PAKs owned by the active user. |
| `apikeys.create` | Create a PAK — the secret is returned once. |
| `apikeys.revoke` | Revoke a PAK by id. |

### Functions

| Tool | Description |
|---|---|
| `functions.list` | List sandbox functions (admin-only — upstream gate enforced). |
| `functions.invoke` | Invoke an HTTP-triggered function by name (admin-only). |

### Webhooks & flows

| Tool | Description |
|---|---|
| `webhooks.list` | List outgoing webhooks. |
| `webhooks.create` | Register a new webhook with event patterns + signing secret. |
| `webhooks.delete` | Delete a webhook by id. |
| `webhooks.test` | Fire a synthetic test delivery against a webhook. |
| `flows.list` | List visual workflows. |
| `flows.get` | Fetch a single flow's full definition. |
| `flows.run` | Run a flow synchronously with an input payload. |
| `jobs.enqueue` | Enqueue a durable background job (`function` or `webhook.deliver`); retries with backoff + dead-letter, optional `runAt` scheduling. |
| `jobs.list` | List jobs, filterable by queue + status. |
| `jobs.get` | Fetch a single job (payload, result, lastError). |
| `jobs.retry` | Requeue a failed / dead-lettered / cancelled job. |
| `jobs.cancel` | Cancel a pending job. |

### AI agents & chat rooms

An external agent (Claude Desktop, Cursor, a CI bot) can both **drive** a
Backlex agent and **take part in a team room** — the same rooms the admin's Chat
page shows, so a message posted here appears on your teammates' screens.

| Tool | Description |
|---|---|
| `agents.list` | List the workspace's AI agents — model, tool allow-list, whether memory is on. |
| `agents.get` | Fetch one agent's full definition by id. |
| `agents.run` | Send a message to a named agent and run one turn to completion. Starts a fresh thread unless `threadId` is given. Returns `{ answer, steps, stoppedReason, threadId }`. |
| `agents.rooms_list` | List the workspace's rooms with their participants and routing mode. |
| `agents.room_send` | Post a message in a room. `@handle` addresses an agent; otherwise the room's routing mode decides — possibly nobody, which is a valid outcome. |

Two things worth knowing before wiring this up:

- **The turn runs inside the tool call.** The async path (`{"async": true}`)
  needs a signed-in user, so an API-key caller always gets the synchronous
  shape: `agents.room_send` returns once the agents it woke have answered.
  A room where you mention three agents will take as long as the slowest.
- **Posting is supported; watching is not.** The room's realtime channel
  (`agent:thread:<id>`) is gated on an admin session, so an MCP client can post
  and read a transcript but can't subscribe to one live. Poll
  `agents.rooms_list` / the REST transcript if you need to follow along.

Attribution follows the caller's identity: a `pak_…` key's messages are
recorded against the user that key belongs to, not against the MCP client.

### Notifications & users

| Tool | Description |
|---|---|
| `notifications.list` | List notifications addressed to the active user. |
| `notifications.send` | Send a notification to one or more users. |
| `notifications.mark_read` | Mark one notification (or all of them) as read. |
| `messaging.send_push` | Send a native push (FCM / APNs / Web Push) to a user's registered devices, plus an in-app row. Requires a workspace push provider (Settings → Push). |
| `messaging.send_sms` | Send an SMS (Twilio / Amazon SNS) to a user's registered phone numbers. Standalone — no in-app row. Requires a workspace SMS provider (Settings → SMS). |
| `users.list` | List control-plane users (admin-only). |
| `users.invite` | Invite a user to the workspace with a chosen role. |
| `users.suspend` | Suspend a user. |
| `users.activate` | Reactivate a suspended user. |

### Database & activity

| Tool | Description |
|---|---|
| `db.execute_sql` | Run raw SQL against the workspace database (admin-only; bypasses DSL — pair with per-key allowlist). |
| `db.list_tables` | List every physical table (Backlex + collections + adopted). |
| `activity.search` | Search the audit log by action, collection, item, user, date range. |

### Tenants & app-users

| Tool | Description |
|---|---|
| `tenants.list` | Workspaces the active user is a member of. |
| `tenants.switch` | Switch the active workspace (persisted on the user profile). |
| `app_users.list` | List workspace end-users (`app_users` pool — distinct from control-plane users). |
| `app_users.set_roles` | Replace an app-user's role assignments. |
| `app_users.update` | Patch app-user metadata (name, status). |

### SSO (SAML)

| Tool | Description |
|---|---|
| `saml.providers_list` | List SAML IdPs configured for the workspace's end-user auth surface. |
| `saml.providers_create` | Register a new SAML provider (inline cert or metadata URL/XML). |
| `saml.providers_delete` | Remove a SAML provider. |

### Sharing & folders

| Tool | Description |
|---|---|
| `shared_links.list` | List public record-share links. |
| `shared_links.create` | Mint a new share link (optional expiry + field allow-list). |
| `shared_links.revoke` | Revoke a share link by id. |
| `folders.list` | List storage folders. |
| `folders.create` | Create a new storage folder. |
| `folders.delete` | Delete a folder (files inside become root-level, not deleted). |

### Revisions & comments

| Tool | Description |
|---|---|
| `revisions.list` | List historical revisions of an item in a versioned collection. |
| `revisions.revert` | Roll an item back to a previous revision. |
| `comments.list` | List comments on a record (or recent comments workspace-wide). |
| `comments.post` | Post a new comment on a record. |
| `comments.delete` | Delete a comment by id. |

### Embedding & settings

| Tool | Description |
|---|---|
| `embedding.upsert` | Embed text records and upsert into the vector store (alias surface of `vector.upsert`). |
| `settings.get` | Read workspace settings (defaults, branding, flags). |
| `settings.update` | Patch workspace settings (admin-only). |

### AI-native

Three tools delegate to an LLM (via the Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set, else the direct Anthropic provider via `ANTHROPIC_API_KEY`) and wire the structured reply back into Backlex sub-fetches:

| Tool | Description |
|---|---|
| `ai.query` | Translate a natural-language question (`top customers last month`) into a Directus `filter` + `sort` + `limit`, then run it. Returns the query the model picked alongside the rows. |
| `ai.suggest_schema` | Draft a collection schema from a prose description. Returns a `fields` array suitable for `schema.create_collection` plus a per-field rationale. Does NOT auto-apply. |
| `ai.import_csv` | Inline CSV → schema inference (default) or bulk-insert into an existing collection (when `collection` is set). 10k row / 5MB cap. The insert path doesn't need a model — only inference does. |

All three fail fast with `UNAVAILABLE` when neither `AI_GATEWAY_API_KEY` nor `ANTHROPIC_API_KEY` is set. Token usage is surfaced in `structuredContent.usage` so callers can budget. None of them auto-apply destructive changes — every mutation is a follow-up tool call the agent must make explicitly.

Every tool delegates to the same REST endpoint the admin UI uses, so:

- **Permissions DSL** filters reads, fields, and condition checks identically.
- **Activity log** entries land for writes/deletes/invokes.
- **Vectorize hooks** fire on collection writes when configured.
- **Audit metadata** (api-key `lastUsedAt`, request ip / user-agent) is updated.

## Quick start — Claude Desktop

1. Create a personal access key in **Admin → API Keys** (or `POST /api/api-keys`). Copy the full `pak_…` secret — it's only shown once.
2. Add a stdio entry to your Claude Desktop config:

   ```json
   {
     "mcpServers": {
       "backlex": {
         "command": "npx",
         "args": [
           "-y", "@backlex/cli", "mcp",
           "--url", "https://your-backlex.example.com/mcp",
           "--key", "pak_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
         ]
       }
     }
   }
   ```

   `npx` pulls the published `@backlex/cli` on first run — no repo checkout or absolute path needed.
3. Restart Claude Desktop. The MCP server appears under the 🔌 icon; the
   13 tools listed above are now callable from any conversation.

The CLI proxies stdio ↔ HTTP — your machine never opens a DB connection
or holds a long-lived session. Revoke the key from the admin UI to cut
agent access instantly.

## Quick start — Cursor

Cursor reads the same `mcpServers` shape under `Settings → MCP → Add`:

```json
{
  "command": "npx",
  "args": [
    "-y", "@backlex/cli", "mcp",
    "--url", "https://your-backlex.example.com/mcp",
    "--key", "pak_…"
  ]
}
```

## Direct HTTP

If your client speaks Streamable HTTP natively, point it straight at
`/mcp` with a bearer header:

```bash
curl -X POST https://your-backlex.example.com/mcp \
  -H 'Authorization: Bearer pak_xxxxxxxx_…' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```bash
curl -X POST https://your-backlex.example.com/mcp \
  -H 'Authorization: Bearer pak_xxxxxxxx_…' \
  -H 'Content-Type: application/json' \
  -d '{
    "jsonrpc":"2.0","id":2,"method":"tools/call",
    "params":{
      "name":"collections.list",
      "arguments":{"collection":"products","limit":5,"filter":{"in_stock":{"_eq":true}}}
    }
  }'
```

## Security model

- Bearer `pak_…` keys impersonate their owner — same roles, same tenant. A role-scoped key narrows further.
- The admin mount additionally checks `auth.roles.includes("admin")`. A non-admin key returns 403 before any tool runs.
- Permissions DSL `whereSql` + `fields` are evaluated on every read; an agent cannot read rows or fields it has no permission for.
- `functions.invoke` stays admin-only in MVP because the underlying `/api/functions/{name}/invoke` endpoint is admin-only — the MCP layer doesn't loosen that.
- Storage writes are tenant-prefixed at the physical-key layer; cross-tenant access isn't reachable from the tool surface.

### MCP guards

Tool-level restrictions live in two places, both independent of the permissions
DSL and both **narrowing only** — neither can grant anything the DSL denies:

- **Per key** (`api_keys.mcp_tools` / `mcp_read_only`) — scoped to the
  credential.
- **Per role** (`roles.mcp_tools` / `mcp_read_only`) — scoped to the *person*,
  so minting a fresh key doesn't shed the restriction.

A call must satisfy both. The composition rules:

| | Rule |
|---|---|
| Across roles | The effective allowlist is the **union** of the lists on roles that set one. A role with `NULL` has *no MCP policy* and is ignored — **not** read as "allow everything". |
| Read-only across roles | Sticks if **any** role sets it; a second role can't lift it. |
| Role ↔ key | The two allowlists **intersect**; read-only ORs. |
| Admin roles | Excluded entirely — `admin` already means unrestricted. |

The null-means-no-opinion rule is load-bearing: every signed-in user carries the
policy-free `authenticated` role, so the "most permissive role wins" reading the
permission DSL uses would cancel every restriction anyone configured.

Allowlist entries are exact tool ids (`collections.read`) or namespace globs
(`collections.*`, or a bare `*`). A glob stops at its own namespace boundary —
`collections.*` matches `collections.read` but not `collections_admin.read`.

Set role guards from **Settings → Roles & permissions → *(edit a role)* → MCP
access**, or over the API:

```bash
curl -X PATCH $APP/api/roles/$ROLE_ID -H 'content-type: application/json' \
  -d '{"mcpTools":["schema.*","collections.read"],"mcpReadOnly":true}'
```

Every refusal is written to the audit log as an `mcp.denied` row naming the tool
and which side refused — see [MCP tool auditing](./audit-logs.md#mcp-tool-auditing).

#### Per-key guards

The two key-level fields, in detail:

| Field | Effect |
|---|---|
| `mcp_tools` (JSON array, default `[]` on new keys; legacy NULL stays permissive) | When set, the dispatcher hides every tool not in the list from `tools/list` and 403s any out-of-list `tools/call`. NULL = unrestricted. The create endpoint now defaults the column to `[]` so a fresh `pak_*` can't call any tool until the owner opts in — POST a key with explicit `"mcpTools": null` (or PATCH it later) to recover the old permissive shape. |
| `mcp_read_only` (bool, default false) | When true, any tool whose `kind` is not `read` (i.e. every `write` / `destruct` tool) returns `isError: true` before any upstream call. The check uses the tool's resolved `kind` — the same value `tools/list` advertises — so it tracks the tool's true behaviour, not a separate verb list that could drift. REST routes for the same identity are unaffected. |

These run **before** the upstream permission DSL, so a read-only caller gets a clear `tool "collections.delete" is a destruct operation; this caller is MCP read-only` message instead of bouncing around the REST layer. A key whose DSL allows `delete` can still be MCP-locked to read-only. Refusals name which side refused ("this API key's MCP allowlist" vs "the MCP allowlist on this caller's roles") so the fix lands on the right screen.

`backlex://me` reports the caller's own effective scope — `mcp.allowlist`,
`mcp.roleAllowlist`, and `mcp.readOnly` — so an agent that hits a FORBIDDEN can
tell whether the limit travels with its key or with its identity.

### Rate limiting

Both MCP mounts are rate-limited at **120 requests / minute**, bucketed per
authenticated identity (the API-key owner, falling back to IP). It runs after
auth and is independent of the REST limiter — a single key can't drive unbounded
`tools/call` volume into the expensive `ai.*` / `graphql.execute` fan-out. The
counter uses the same Durable-Object-backed limiter as the rest of the app
(in-memory fallback off Workers), and fails open if the runtime env is missing.

Configure both from the admin UI (**API Keys → 🔌 button → Connect MCP**) or via the API:

```bash
curl -X PATCH https://your-backlex.example.com/api/api-keys/<id>/mcp-guards \
  -H 'Authorization: Bearer pak_<admin-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "mcpReadOnly": true,
    "mcpTools": ["schema.list_collections", "collections.list", "collections.read"]
  }'
```

The "Connect MCP" modal also generates copyable install snippets for Claude Desktop, Cursor, and curl — pre-filled with the workspace's MCP URL and the key's plaintext secret (only when called right after creation; otherwise a `pak_<prefix>_<paste-secret-here>` placeholder).

## Resources

Beyond tools, Backlex exposes **MCP resources** so attach-aware clients (Claude Desktop) can browse the workspace from their resource picker:

| URI | Read returns |
|---|---|
| `backlex://schema` | Every collection's slug + field list (workspace-level directory). |
| `backlex://collection/<slug>` | The collection's full field schema + the first 5 rows of data. |
| `backlex://openapi` | The workspace's full OpenAPI 3.1 spec — every REST endpoint, params, and schema. Handy when an agent writes code against the API. |
| `backlex://roles` | Every role and its permission rules. **Admin mount only** (`/api/admin/mcp`), since `/api/roles` is admin-gated. |
| `backlex://me` | The current caller's identity, roles, tenant — plus its own **MCP scope** (`mcp.readOnly`, `mcp.allowlist`), so an agent can reason about what it's allowed to do. |

Resource reads sub-fetch the same REST surface tools use, so permissions DSL still filters what the agent sees. The per-key MCP allowlist also gates resources — an agent that can't call `collections.list` won't see the resource either.

`backlex://collection/{slug}` is also advertised at `resources/templates/list` as a **resource template**, so template-aware clients offer "open collection …" with the slug as a fill-in (and that slug is completable — see below).

Subscriptions (`resources/subscribe`) aren't implemented — that requires a long-lived `GET /mcp` SSE stream which the stateless POST-only transport doesn't carry. Track collection changes through webhooks / flows for now.

## Completions

The server implements `completion/complete` (capability `completions`), so clients autocomplete prompt and resource-template arguments as the user types:

| Argument | Completes to |
|---|---|
| `collection` / `slug` | the caller's readable collection slugs (prefix-filtered; permission DSL applies) |
| `language` (on `generate_sdk_code`) | the supported SDK languages (`typescript`, `python`, `go`, …) |
| `role` (on `explain_permissions`) | the workspace's role names (admin identity; empty otherwise) |

Free-text arguments (`intent`, …) return an empty completion. Results cap at 100 values with `total` / `hasMore` set.

## Prompts

Five starter templates ship at `prompts/list`:

| Name | Arguments | Use case |
|---|---|---|
| `describe_collection` | `collection` | Walk through schema + 3 sample rows; produce a plain-language description of what the collection stores. |
| `generate_queries` | `collection`, `intent?` | Propose 3-5 useful Directus-shaped `filter` queries with rationales. |
| `permission_rule` | `collection`, `intent` | Translate "X role can do Y" into a permissions DSL `condition` + `fields` allow-list. |
| `explain_permissions` | `collection`, `role` | The inverse of `permission_rule`: translate a role's DSL permission rows for a collection into plain English (per action, with conditions + field allow-lists). Admin identity. |
| `generate_sdk_code` | `collection`, `intent`, `language` | Emit ready-to-run code for an official client SDK that performs the task — real schema fields + the SDK's actual query/CRUD/auth API. |

Each `prompts/get` renders a single user message with the collection context pre-injected, so the LLM arrives with the schema in-window without having to call a discovery tool first.

`generate_sdk_code` additionally injects a compact, accurate API reference for the
chosen `language` (one of `typescript, python, go, rust, ruby, php, dart, java,
kotlin, csharp` — common aliases like `ts`, `js`, `py`, `rb`, `.net`/`dotnet`/`c#`
are normalized). Because every SDK shares the same canonical filter grammar, the
generated query is portable: the JSON a `generate_queries` answer produces drops
straight into the `filter` of the code `generate_sdk_code` writes. Example:

```jsonc
// prompts/get generate_sdk_code { collection: "orders", intent: "list paid orders over $100, newest first", language: "python" }
// → renders an instruction whose answer is, e.g.:
res = (client.from_("orders").query()
       .where(lambda f: f.and_(f.eq("status", "paid"), f.gte("total", 100)))
       .order_by("-created_at").list())
```

## Limitations & roadmap

- **No `subscriptions/listen`.** `2026-07-28` replaced the GET stream and
  `resources/subscribe` with one long-lived POST-response stream. We serve
  neither: holding a stream open per client is the wrong shape for a Worker
  isolate, and the reactive SSE surface already covers the use case on its own
  endpoint. `GET /mcp` is `405`, which is what the revision prescribes.
- **MCP Apps and Enterprise Managed Authorization** are not implemented. Tasks
  is (see above) — it turned out to be the protocol shape of the durable job
  queue this server already had (see [Jobs](/docs/jobs/)), so it needed no new
  storage.
- **No `CreateTaskResult` from `tools/call` yet.** The task methods and the
  handles work, but no tool currently *returns* a task instead of blocking. The
  obvious first one is `agents.run`, which already has a durable `agent_runs`
  row and an async path.
- **No MRTR.** Tools never return `resultType: "input_required"`, so elicitation
  and sampling are not offered. Both are also deprecated as *client* features in
  this revision; the tool-approval path is the direction that replaces them.
- **OAuth: RFC 9207 `iss` and CIMD are not implemented.** The authorization
  responses are minted by better-auth's OAuth provider, not by this code, so the
  `iss` parameter and the shift from Dynamic Client Registration to Client ID
  Metadata Documents land with the better-auth upgrade rather than here. DCR
  still works and remains supported for backwards compatibility.

See `apps/web/src/server/mcp/` for the implementation —
`protocol.ts` owns the dual-era rules — and
`apps/web/tests/mcp.test.ts` plus `apps/web/tests/mcp-protocol-2026.test.ts`
for executable contract examples.
