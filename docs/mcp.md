---
title: MCP (Model Context Protocol)
description: Expose a workeros workspace to AI agents — Claude Desktop, Cursor, IDE plugins — over the MCP Streamable HTTP and stdio transports.
---

workeros ships a built-in MCP (Model Context Protocol) server so AI
agents can read schema, query collections, manage storage, and invoke
sandbox functions through one authenticated endpoint. The same identity
model the rest of the API uses (personal access keys / sessions /
permissions DSL) carries over — agents never see anything their key
isn't allowed to see.

## Endpoints

Two mounts, same tool set:

| Mount | Auth | Use case |
|---|---|---|
| `POST /mcp` | Any authenticated identity (cookie session, `pak_…` API key, app-plane bearer). Permissions DSL filters results per the caller's roles. | Tenant agents (a workspace member wires Claude Desktop to their own workeros). |
| `POST /api/admin/mcp` | Same as above **plus** the system `admin` role. | Ops bots, CI agents — fails loudly on non-admin auth instead of silently returning empty results. |

Both speak the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http)
in **stateless** mode: each POST is one JSON-RPC message, the response
is `application/json` with the result. We don't expose `GET /mcp`
(resumable SSE) yet — long-lived streams are awkward on Cloudflare
Workers' subrequest budget. Re-issue requests instead of relying on a
persistent session.

## Tools

### Tool kind metadata

`tools/list` decorates every tool descriptor with two optional fields the
[Ask AI Tools tab](./ask-ai.md#tools-tab) uses for at-a-glance badges:

- `kind` — `"read"` / `"write"` / `"destruct"`. When a tool definition
  doesn't set it explicitly, the dispatcher derives the value from the
  verb token after the last dot in the name (`.list_*` / `.read*` /
  `.search*` / `.get*` / `.describe*` → `read`; `.delete*` / `.drop*` /
  `.revoke*` / `.suspend*` → `destruct`; everything else → `write`).
  Override `kind` directly on the `McpTool` object only when the
  heuristic would misclassify.
- `adminOnly` — `true` for tools that are only reachable through
  `/api/admin/mcp` (today: `functions.list`, `functions.invoke`). Pure
  metadata; the actual gating lives in the route's `requireAdmin`
  middleware, not in the dispatcher.

Clients that don't know about the extra fields ignore them — both are
additive to the standard MCP descriptor.

### Schema

| Tool | Description |
|---|---|
| `schema.list_collections` | Discovery — every collection visible to the active workspace, with field counts and adopted/owner-scoped flags. |
| `schema.describe_collection` | Full field schema for one collection — types, relations, validation, defaults. |
| `schema.create_collection` | Create a managed or adopted collection from a field list. |
| `schema.update_collection` | Patch a collection's metadata or field list (additive only). |
| `schema.drop_collection` | Delete managed collections (destructive) or archive adopted ones. |

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

### Storage

| Tool | Description |
|---|---|
| `storage.list` | List files with prefix / folder / search filters. |
| `storage.get` | Fetch a file's bytes — inline as text for small JSON/text, base64 resource for binaries. |
| `storage.upload` | Upload a file — `text` for UTF-8, `base64` for binary. |
| `storage.delete` | Delete a file by logical key. |
| `storage.sign_url` | Issue a short-lived signed URL for sharing without exposing the bytes. |

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
| `flows.invoke` | Run a flow synchronously with an input payload. |

### Notifications & users

| Tool | Description |
|---|---|
| `notifications.list` | List notifications addressed to the active user. |
| `notifications.send` | Send a notification to one or more users. |
| `notifications.mark_read` | Mark one notification (or all of them) as read. |
| `users.list` | List control-plane users (admin-only). |
| `users.invite` | Invite a user to the workspace with a chosen role. |
| `users.suspend` | Suspend a user. |
| `users.activate` | Reactivate a suspended user. |

### Database & activity

| Tool | Description |
|---|---|
| `db.execute_sql` | Run raw SQL against the workspace database (admin-only; bypasses DSL — pair with per-key allowlist). |
| `db.list_tables` | List every physical table (workeros + collections + adopted). |
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

Three tools delegate to an LLM (via the Vercel AI Gateway when `AI_GATEWAY_API_KEY` is set, else the direct Anthropic provider via `ANTHROPIC_API_KEY`) and wire the structured reply back into workeros sub-fetches:

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
       "workeros": {
         "command": "bun",
         "args": [
           "/abs/path/to/workeros/packages/cli/bin/workeros.ts",
           "mcp",
           "--url", "https://your-workeros.example.com/mcp",
           "--key", "pak_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
         ]
       }
     }
   }
   ```

   On a globally-installed CLI, swap the absolute path for `workeros`.
3. Restart Claude Desktop. The MCP server appears under the 🔌 icon; the
   13 tools listed above are now callable from any conversation.

The CLI proxies stdio ↔ HTTP — your machine never opens a DB connection
or holds a long-lived session. Revoke the key from the admin UI to cut
agent access instantly.

## Quick start — Cursor

Cursor reads the same `mcpServers` shape under `Settings → MCP → Add`:

```json
{
  "command": "bun",
  "args": [
    "/abs/path/to/workeros/packages/cli/bin/workeros.ts",
    "mcp",
    "--url", "https://your-workeros.example.com/mcp",
    "--key", "pak_…"
  ]
}
```

## Direct HTTP

If your client speaks Streamable HTTP natively, point it straight at
`/mcp` with a bearer header:

```bash
curl -X POST https://your-workeros.example.com/mcp \
  -H 'Authorization: Bearer pak_xxxxxxxx_…' \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```bash
curl -X POST https://your-workeros.example.com/mcp \
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

### Per-key MCP guards

Two extra defense-in-depth layers live on `api_keys`, independent of the permissions DSL:

| Field | Effect |
|---|---|
| `mcp_tools` (JSON array, default `[]` on new keys; legacy NULL stays permissive) | When set, the dispatcher hides every tool not in the list from `tools/list` and 403s any out-of-list `tools/call`. NULL = unrestricted. The create endpoint now defaults the column to `[]` so a fresh `pak_*` can't call any tool until the owner opts in — POST a key with explicit `"mcpTools": null` (or PATCH it later) to recover the old permissive shape. |
| `mcp_read_only` (bool, default false) | When true, every write tool — insert / update / delete / create / drop / upload / bulk_* / upsert / grant / revoke / assign / unassign / invoke / send / mark_read / test / invite / suspend / activate — returns `isError: true` before any upstream call. REST routes for the same identity are unaffected. |

These run **before** the upstream permission DSL, so a read-only key gets a clear `tool "collections.delete" is a write operation; this API key is MCP read-only` message instead of bouncing around the REST layer. A key whose DSL allows `delete` can still be MCP-locked to read-only.

Configure both from the admin UI (**API Keys → 🔌 button → Connect MCP**) or via the API:

```bash
curl -X PATCH https://your-workeros.example.com/api/api-keys/<id>/mcp-guards \
  -H 'Authorization: Bearer pak_<admin-key>' \
  -H 'Content-Type: application/json' \
  -d '{
    "mcpReadOnly": true,
    "mcpTools": ["schema.list_collections", "collections.list", "collections.read"]
  }'
```

The "Connect MCP" modal also generates copyable install snippets for Claude Desktop, Cursor, and curl — pre-filled with the workspace's MCP URL and the key's plaintext secret (only when called right after creation; otherwise a `pak_<prefix>_<paste-secret-here>` placeholder).

## Resources

Beyond tools, workeros exposes **MCP resources** so attach-aware clients (Claude Desktop) can browse the workspace from their resource picker:

| URI | Read returns |
|---|---|
| `workeros://schema` | Every collection's slug + field list (workspace-level directory). |
| `workeros://collection/<slug>` | The collection's full field schema + the first 5 rows of data. |

Resource reads sub-fetch the same REST surface tools use, so permissions DSL still filters what the agent sees. The per-key MCP allowlist also gates resources — an agent that can't call `collections.list` won't see the resource either.

Subscriptions (`resources/subscribe`) aren't implemented — that requires a long-lived `GET /mcp` SSE stream which the stateless POST-only transport doesn't carry. Track collection changes through webhooks / flows for now.

## Prompts

Three starter templates ship at `prompts/list`:

| Name | Arguments | Use case |
|---|---|---|
| `describe_collection` | `collection` | Walk through schema + 3 sample rows; produce a plain-language description of what the collection stores. |
| `generate_queries` | `collection`, `intent?` | Propose 3-5 useful Directus-shaped `filter` queries with rationales. |
| `permission_rule` | `collection`, `intent` | Translate "X role can do Y" into a permissions DSL `condition` + `fields` allow-list. |

Each `prompts/get` renders a single user message with the collection context pre-injected, so the LLM arrives with the schema in-window without having to call a discovery tool first.

## Limitations & roadmap

- **No resumable SSE.** Only `POST /mcp` is implemented; `GET /mcp` returns 405. Subscriptions, sampling, and progress notifications wait on this.
- **Stateless transport.** No `Mcp-Session-Id` header; every request stands alone.
- **No OAuth flow.** Agents authenticate via a pre-provisioned PAK. The hosted-Claude case (where the user shouldn't have to paste a secret) is a separate epic.

See `apps/web/src/server/mcp/` for the implementation and
`apps/web/tests/mcp.test.ts` for executable contract examples.
