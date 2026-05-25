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

| Tool | Description |
|---|---|
| `schema.list_collections` | Discovery — every collection visible to the active workspace, with field counts and adopted/owner-scoped flags. |
| `schema.describe_collection` | Full field schema for one collection — types, relations, validation, defaults. |
| `collections.list` | List items with Directus-shaped `filter`, `sort`, `fields`, `limit`, `offset`. |
| `collections.read` | Read a single item by id. |
| `collections.insert` | Create a new item (server-side validated against the collection schema). |
| `collections.update` | PATCH a single item by id. |
| `collections.delete` | Delete an item by id. |
| `storage.list` | List files with prefix / folder / search filters. |
| `storage.get` | Fetch a file's bytes — inline as text for small JSON/text, base64 resource for binaries. |
| `storage.upload` | Upload a file — `text` for UTF-8, `base64` for binary. |
| `storage.delete` | Delete a file by logical key. |
| `functions.list` | List sandbox functions (admin-only — upstream gate enforced). |
| `functions.invoke` | Invoke an HTTP-triggered function by name (admin-only). |

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

## Limitations & roadmap

- **No `resources/list` content.** The MCP `resources` API returns empty — schema discovery happens through tools instead. We may surface collections as resources in a later phase.
- **No resumable SSE.** Only `POST /mcp` is implemented; `GET /mcp` for resumable streams returns 405.
- **No prompts.** `prompts/list` returns empty.
- **Stateless transport.** There is no `Mcp-Session-Id` header; every request stands alone.

See `apps/web/src/server/mcp/` for the implementation and
`apps/web/tests/mcp.test.ts` for executable contract examples.
