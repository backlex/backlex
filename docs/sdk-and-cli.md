---
title: SDK & CLI
description: The Backlex typed fetch wrapper and the Backlex CLI for project scaffolding.
---

Two packages ship for client-side and developer-side use.

> Not on TypeScript? Backlex also ships native clients for Python, Go, Rust,
> Java, Kotlin, Swift, Dart/Flutter, .NET, Ruby, and PHP — same API, idiomatic in
> each language. See [Client SDKs](/docs/client-sdks/).

## `backlex`

Typed fetch wrapper, browser + Node.

```ts
import { createClient } from "backlex";

const wks = createClient({
  url: "https://api.your.app",
  // For server-to-server / CI; browser apps use the cookie session and skip:
  apiKey: process.env.BACKLEX_API_KEY,
});

// CRUD
const list = await wks.from<Posts>("posts").list({
  filter: { published: { _eq: true } },
  sort: ["-views", "title"],
  fields: ["id", "title", "views"],
  limit: 25,
  offset: 0,
  meta: "filter_count",
});
const one = await wks.from<Posts>("posts").one("uuid");
const created = await wks.from<Posts>("posts").create({ title: "hi" });
const updated = await wks.from<Posts>("posts").update("uuid", { views: 42 });
// Optimistic concurrency: pass the updatedAt you loaded — a concurrent save by
// someone else then yields 409 CONFLICT instead of being silently overwritten.
await wks.from<Posts>("posts").update("uuid", { views: 43 }, { ifUnmodifiedSince: one.data.updatedAt as string });
await wks.from<Posts>("posts").delete("uuid");

// Realtime (SSE)
const off = wks.subscribe<Posts>("items:posts", (e) => {
  console.log(e.event, e.data); // created | updated | deleted
});
// later:
off();

// Auth
await wks.auth.signUp({ email, password, name });
await wks.auth.signIn({ email, password });
await wks.auth.signOut();
const session = await wks.auth.getSession();

// OAuth: returns { url } the browser navigates to (provider id from auth.providers()).
const { url } = await wks.auth.signInSocial("google", { callbackURL: "/" });
// Magic-link sign-in (requires the magic-link plugin on the workspace).
await wks.auth.signInMagicLink({ email, callbackURL: "/" });
// Describes the sign-in surface (provider list + policy flags) for rendering UI.
const surface = await wks.auth.providers();

// Workspace token (app mode) — persist across reloads and restore via createClient({ token }).
const token = wks.auth.getToken();
wks.auth.setToken(token);

// Storage — folderId is optional and scopes the file under a system_folders row.
await wks.storage.put("avatars/me.png", file, "image/png", folderId);
const res = await wks.storage.download("avatars/me.png");
const blob = await res.blob();
await wks.storage.list("avatars/");
await wks.storage.delete("avatars/me.png");

// Flows (visual workflows) — admin-scoped; mirrors `/api/flows`, the MCP
// `flows.*` tools, and GraphQL `flows`/`runFlow`.
const flow = await wks.flows.create({
  name: "notify",
  trigger: "manual:",
  operations: [{ type: "log", message: "hi" }],
});
await wks.flows.list();
await wks.flows.get(flow.data.id);
await wks.flows.update(flow.data.id, { active: false });
const run = await wks.flows.run(flow.data.id, { hello: "world" }); // { ok, error? }
await wks.flows.delete(flow.data.id);

// Schema templates — admin-scoped; mirrors `/api/admin/templates`, the MCP
// `templates.*` tools, and GraphQL `templates`/`applyTemplate`/etc. Full
// guide: docs/templates.md.
const catalog = await wks.templates.list();          // { data, defaultTemplateId, hasCollections, sampleSeeds }
const seeded = await wks.templates.apply("blog");    // idempotent — groups + sample data + bundled roles/dashboards
// seeded.data → { templateId, created[], skipped[], seeded, roles[], dashboards[] }
const tpl = await wks.templates.extract();           // workspace schema in template format
await wks.templates.applyCustom(tpl.data);           // …applied elsewhere (same idempotent semantics)
await wks.templates.clearSamples();                  // remove every template-seeded sample row
```

### Errors

Failed requests throw `BacklexError`:

```ts
import { BacklexError } from "backlex";
try {
  await wks.from("posts").create({});
} catch (e) {
  if (e instanceof BacklexError) {
    e.status   // 422
    e.code     // "VALIDATION"
    e.message  // 'Field "title" is required'
    e.details  // raw response payload
  }
}
```

### Type generation

Pair the SDK with auto-generated types so `wks.from<Posts>("posts")` is
type-safe:

```bash
bun run backlex gen-types https://api.your.app --out src/backlex-types.ts
# Or with API key:
bun run backlex gen-types https://api.your.app --key pak_xxx --out src/backlex-types.ts
```

Output:

```ts
export interface Posts {
  id: string;
  _status: string;            // only when the collection is versioned
  _publishedAt: string | null;
  ownerId: string | null;     // only when owner-scoped
  createdAt: string;
  updatedAt: string;
  title: string;
  body: string | null;
  status: "draft" | "live" | null;  // dropdown fields → string-literal union
  category: string;           // relation → FK id (expanded shape below)
  tags: string[] | null;      // relation_many → array of FK ids
}
// + 1 interface per collection
export interface Collections {
  posts: Posts;
  // ...
}
```

> **Field names match the wire exactly.** System columns (`id`, `createdAt`,
> `updatedAt`, `ownerId`, `_status`, `_publishedAt`) are camelCased the way the
> REST API serializes them; **user-defined fields keep their `snake_case`
> name** — the API never camelCases them. (Earlier codegen camelCased user
> fields, so `row.featuredImage` type-checked but was `undefined` at runtime
> against a `featured_image` column. Regenerating closes that bug class.)

#### Typed `expand()`

For every relation, codegen also emits a `<Slug>Relations` map and a
`<Slug>Expanded` convenience type, plus a generic `Expand<>` helper — so an
expanded read is fully typed:

```ts
export interface PostsRelations {
  category: Categories;        // relation → the target row
  tags: Categories[] | null;   // relation_many → an array of target rows
}
export type PostsExpanded = Expand<Posts, PostsRelations>;

// Read with expansion — the FK fields are now the related objects:
const { data } = await client.from<PostsExpanded>("posts")
  .query().expand("category", "tags").list();
data[0].category.id;     // typed: Categories
data[0].tags?.[0].id;    // typed: Categories[]

// Expand just one relation:
type PostWithCategory = Expand<Posts, PostsRelations, "category">;
```

#### Typed SDK (`--sdk`)

Add `--sdk` to also emit a typed client factory, so you skip the manual
`<T>` on every call:

```bash
bun run backlex gen-types https://api.your.app --sdk --out src/backlex.ts
```

The output adds an import of `backlex` plus:

```ts
export const createTypedClient = (opts: ClientOptions): TypedClient<Collections> =>
  typedCollections<Collections>(createClient(opts));
```

Use it — every collection is keyed by slug and fully typed:

```ts
import { createTypedClient } from "./backlex";

const db = createTypedClient({ url: "https://api.your.app", apiKey: "pak_…" });

const { data } = await db.collections.posts.list();   // data: Posts[]
await db.collections.posts.create({ title: "Hello" }); // typed Partial<Posts>

// The raw client surface (auth, storage, from<T>, …) is still available:
await db.auth.signIn({ email, password });
```

`db.collections.<slug>` is a thin proxy over `db.from(slug)` — no
per-collection runtime code is generated; the types live in `Collections`.

## `backlex` CLI

Manage any Backlex instance from your terminal or CI — same REST API as the
SDK, authenticated with a personal API key (`pak_…`).

### Installing

The npm package is **`@backlex/cli`**; the installed command is **`backlex`**.
(The bare `backlex` npm package is the SDK, not the CLI.)

```bash
# one-off, no install
npx @backlex/cli login --url https://api.your.app --key pak_xxx
bunx @backlex/cli login --url https://api.your.app --key pak_xxx

# or globally
npm i -g @backlex/cli
backlex whoami
```

Inside this monorepo it runs straight from source as `bun backlex <cmd>` (the
root maps `bun run backlex …`), no install needed.

> `migrate` is Bun-only (it uses `bun:sqlite`) and meant for self-hosting; every
> other command runs under Node, so `npx`/global installs work everywhere.

```
backlex help
backlex login [--url <url>] [--key <pak_...>|-] [--tenant <id>] [--profile <name>]
                                                 verify a key against /api/me and save a profile
backlex logout [--profile <name>] [--all]        clear saved credentials (--all removes the profile)
backlex whoami [--profile <name>] [--json]       show the identity behind the resolved key
backlex profile <list|use|add|remove>            manage saved connection profiles
backlex collections <list|get|export-schema|drop-field|fts-reindex|vectorize>
                                                 inspect the schema + rebuild search indexes
backlex items <list|get|create|update|delete|export|import|search> <slug>
                                                 data-plane CRUD + bulk export/import + search
backlex backup <list|now|download|restore|config>   logical backups + restore + schedule
backlex users <list|grant|revoke>                workspace users + role assignment
backlex roles list                               roles in the active workspace
backlex flags <list|set|delete>                  feature flags / remote config
backlex settings <get|set>                       workspace settings (whitelisted keys)
backlex functions <list|deploy|invoke|delete>    sandboxed JS functions
backlex flows <list|get|run|create|delete>       visual workflow builder
backlex agents <list|get|create|update|delete|threads|run>
                                                 AI agent definitions + one-off runs
backlex agents rooms <list|new|add|remove>       chat rooms several agents share
backlex agents say <roomId> --message "@handle …"
                                                 post in a room; the @handle picks who answers
backlex templates <list|apply|extract|clear-samples>  schema-template catalog (apply seeds groups + samples + bundles; apply --file for custom; extract exports the workspace)
backlex webhooks <list|create|test|deliveries|retry|resume|delete>  outbound webhooks
backlex jobs <list|get|retry|cancel|remove|enqueue>  durable job queue
backlex advisor [--kind …] [--fail-on error|warn]   security/perf checks (CI gate)
backlex init [dir] [--force]                     scaffold a TypeScript consumer starter
backlex sdk [lang]                               discover the official native client SDKs
backlex migrate [db-path]                        apply SQLite migrations
backlex import-db <inspect|plan|run|sources|start|status|...>
                                                 migrate an external DB (Postgres/MySQL/MongoDB/Firestore/DynamoDB/SQLite) INTO backlex (docs/migrating-in.md)
backlex gen-types <api-url> [--out <file>] [--key <pak_...>] [--sdk]
                                                 generate TS types (+ typed client with --sdk)
backlex gen-openapi [--out <file>]               fetch the live OpenAPI spec
backlex mcp --url <mcp-url> --key <pak_...> [--tenant <id>]
                                                 stdio MCP server proxying to a remote /mcp endpoint
```

### Connection context (`login` / `whoami` / `mcp` / `gen-types`)

Commands that hit the API resolve their connection the same way, with this
precedence per field:

1. explicit flag — `--url` / `--key` / `--tenant`
2. environment — `BACKLEX_URL` / `BACKLEX_API_KEY` / `BACKLEX_TENANT`
3. the saved profile — `--profile <name>`, otherwise the active profile

`backlex login` stores `{ url, key, tenant }` under a named profile (default
`"default"`) in `~/.backlex/config.json` (override with `$BACKLEX_CONFIG`). The
file holds API keys, so it's written `0600`. After that, every other command
reads the active profile — no repeated `--url`/`--key`:

```bash
backlex login --url https://api.your.app --key pak_xxx          # prompts hidden if --key omitted on a TTY
echo "$PAK" | backlex login --url https://api.your.app --key -  # CI-friendly: key from stdin
backlex whoami                                                  # user, roles, tenant
backlex profile add staging --url https://staging.your.app --key pak_yyy
backlex profile use staging
backlex profile list
```

Pass `--json` for machine-readable output (scripts / CI).

### Discovering what you can do

`backlex help` lists every command. Each command group also prints its own
focused usage when invoked with no subcommand (or an unknown one) — so you can
drill in without leaving the terminal:

```bash
backlex collections      # → the collections subcommands + flags
backlex items            # → the items subcommands + flags
```

For *this instance specifically*, `backlex collections list` is the live
"what's reachable" view — every collection the current key can read:

```bash
backlex collections list
backlex collections get posts        # fields + flags of one collection
```

### `backlex collections`

Reads `GET /api/collections`. `export-schema` dumps the full field metadata as
JSON — commit it and diff across environments (the seed for a future
`apply-schema`):

```bash
backlex collections export-schema --out schema.json
```

### `backlex items`

Data-plane CRUD over the SDK's `from(slug)` client, so it speaks the same query
DSL as the REST API. Payloads accept inline JSON, `@file`, or `-` (stdin):

```bash
backlex items list posts --filter '{"published":{"_eq":true}}' --sort -views --limit 10
backlex items get posts <id> --expand author
backlex items create posts --data '{"title":"Hello"}'
echo '{"views":42}' | backlex items update posts <id> --data -
backlex items delete posts <id>

# Bulk export / import (JSON or CSV) — round-trips through the read filters
backlex items export posts --format csv --out posts.csv
backlex items import posts posts.csv --format csv

# Relevance search (fts / vector / hybrid, per the collection's capabilities)
backlex items search posts -q "launch" --mode hybrid --limit 5
```

### `backlex backup`

Logical JSONL backups + restore + the auto-backup schedule (see
`docs/backup-restore.md`). `restore` is confirm-gated server-side, so the CLI
also demands an explicit `--confirm`:

```bash
backlex backup now --label pre-migration
backlex backup list
backlex backup download <id> --out backup.jsonl
backlex backup restore <id> --confirm
backlex backup config --schedule daily --retain 30   # omit flags to read the current schedule
```

### `backlex users` / `roles`

Admin-plane user management. `users grant` is the supported replacement for the
manual `INSERT INTO user_roles` — it resolves a role by name (or id) and
attaches it:

```bash
backlex roles list                  # find the role id/name
backlex users list
backlex users grant <userId> admin  # by name; an id works too
backlex users revoke <userId> editor
```

### `backlex flags` / `settings`

Feature flags / remote config and the whitelisted workspace settings. `--global`
targets the global flag scope instead of the active tenant:

```bash
backlex flags list
backlex flags set new-checkout --enabled true --rollout 25
backlex flags set api-config --value '{"maxItems":50}' --global
backlex flags delete new-checkout

backlex settings get
backlex settings set i18nDefaultLocale en
```

The public, per-caller *evaluated* flag map (rollout + targeting applied) is
served at `GET /api/flags` — that's what the SDK's `client.flags` reads.

### `backlex functions` / `flows`

Sandboxed JS functions and the visual workflow builder (see `docs/sandbox.md`,
`docs/jobs.md`). `functions deploy` is **create-or-update by name** — the verb
to wire into a deploy step:

```bash
backlex functions deploy resize-avatar --file ./fns/resize.js --trigger event --pattern 'items.avatars.created'
backlex functions invoke welcome --data '{"userId":"u_1"}'
backlex functions list

backlex flows list
backlex flows get <id> > flow.json     # export
backlex flows create --data @flow.json # import into another env
backlex flows run <id>
```

### `backlex agents`

Agent definitions, plus the chat **rooms** several agents share
(`docs/agents.md`). `run` names its agent and prints the answer; `say` posts in
a room and lets the room decide who replies — an `@handle` addresses one
directly, and a room set to mention-only simply records the message when
nobody is named:

```bash
backlex agents create --data '{"name":"Sales bot","tools":["collections.list"]}'
backlex agents run <agentId> --message "how many orders last month?"

backlex agents rooms new --title "Weekly numbers" --agents <id1>,<id2>
backlex agents rooms list
backlex agents say <roomId> --message "@sales-bot @data-buddy compare these"
```

### `backlex webhooks` / `jobs`

Outbound webhooks (`docs/webhooks.md`) and the durable job queue
(`docs/jobs.md`). `webhooks resume` re-enables a hook the circuit breaker
auto-disabled after repeated failures:

```bash
backlex webhooks create --name orders --url https://hooks.acme.com/x --events 'items.orders.created'
backlex webhooks test <id>
backlex webhooks deliveries --limit 20
backlex webhooks retry <deliveryId>
backlex webhooks resume <id>

backlex jobs list --status failed
backlex jobs retry <id>
```

### `backlex advisor` (CI gate)

Runs the security / performance rule checks. `--fail-on` turns it into a CI
gate — non-zero exit when a finding at or above the level is present:

```bash
backlex advisor                          # list all findings
backlex advisor --kind security --json   # machine-readable
backlex advisor --fail-on error          # exit 1 on any error-level finding
```

> **Deploy.** There is no `backlex deploy` command. Deployment goes through each
> platform's native git integration (Cloudflare Workers Builds, Vercel, Netlify)
> or the repo's `bun run deploy` (CF) — the CLI would only duplicate those. See
> `docs/deployment.md`.

### `backlex init` / `sdk`

Getting a consuming app off the ground. `init` scaffolds a self-contained
TypeScript client (non-destructive — pass `--force` to overwrite); `sdk` lists
the official native clients (Python, Go, Rust, … — see
[Client SDKs](/docs/client-sdks/)) with their install commands:

```bash
backlex init ./my-app          # writes backlex.ts + .env.example
backlex sdk                    # list every SDK + install command
backlex sdk python             # install + quickstart for one language
```

### `backlex gen-openapi`

Fetches the live OpenAPI spec (`/api/openapi.json`, admin-readable) — generated
from the collection schemas + route decorators, so it always matches the running
instance. Use it for `openapi-generator`, Postman, or the typed-model step of a
native SDK:

```bash
backlex gen-openapi --out openapi.json
openapi-generator generate -g python -i openapi.json   # typed models beside the SDK
```

### `backlex migrate`

Applies the same Drizzle migrations the API uses. Default path is
`./.data/backlex.sqlite` (or `$DATABASE_PATH`).

```bash
bun run backlex migrate
bun run backlex migrate /var/lib/backlex/data.sqlite
```

For Postgres, use `bun run db:migrate:pg` directly — the CLI is
SQLite-only for now.

### `backlex gen-types`

Fetches `/api/collections` (admin-readable; `--key` for API key auth)
and emits a TypeScript module. Wire into your build:

```jsonc
// package.json
{
  "scripts": {
    "predev": "backlex gen-types $BACKLEX_URL --out src/types/wks.ts"
  }
}
```

Re-run after schema changes. The output is deterministic — safe to commit.

### `backlex mcp`

Runs a stdio [MCP](https://modelcontextprotocol.io) server that proxies
JSON-RPC over stdin/stdout to a remote Backlex `/mcp` HTTP endpoint. This lets
local agents (Claude Desktop, Cursor, IDE plugins) talk to a deployed Backlex
instance through a single auth path — the `pak_…` key — while permissions,
rate-limits, activity logging, and the tenant boundary stay identical to every
other Backlex caller. The URL defaults to `http://localhost:8787/mcp`; the key
falls back to `$BACKLEX_API_KEY`.

```jsonc
// Claude Desktop / Cursor MCP config
{
  "mcpServers": {
    "backlex": {
      "command": "bun",
      "args": ["backlex", "mcp", "--url", "https://api.your.app/mcp", "--key", "pak_xxx"]
    }
  }
}
```

The per-key MCP tool allowlist (`mcpTools`) and read-only flag (`mcpReadOnly`)
set when the key was issued govern what the agent can call — see
`docs/api-keys-and-email.md`.

## Adding the SDK to a separate repo

The SDK is published as `backlex` (workspace today; NPM package
in a follow-up). To use locally:

```bash
bun add file:../backlex/packages/client
```

Or, once published:

```bash
bun add backlex
```

The SDK has zero dependencies beyond `@backlex/core` (types only) and
the runtime's `fetch` / `EventSource`.
