---
title: Vector search & AI
description: Semantic (vector) search over your collections — pgvector on Postgres, native vectors on Turso/libSQL, Cloudflare Vectorize on D1.
---

backlex can embed your records and run semantic (vector) search over them. Mark
a collection vectorizable, and every write auto-embeds the chosen fields and
stores the vector; queries embed the search text and run approximate
nearest-neighbour (ANN) search. The same vectors back the [Ask AI](/ask-ai)
page's `vector.search` tool.

Two things have to be in place: a **vector store** (where vectors live) and an
**embedding provider** (text → vector). Which vector store you get depends on
your database.

## Vector store by database

Where vectors live depends on the database:

- **Postgres** has the `pgvector` extension built in — nothing extra.
- **Turso / libSQL** has native vector functions (`F32_BLOB` columns,
  `vector_distance_cos()`) — vectors live in-database, no extra service.
- **D1 and plain Bun SQLite** have no vector primitives (D1 can't load
  extensions; `bun:sqlite` has no vector funcs), so they must pair with
  **Cloudflare Vectorize**.

| Database | Vector store | Extra setup |
| --- | --- | --- |
| **Postgres** (Neon, Supabase, self-host) | `pgvector` (in your DB) | none — works out of the box |
| **Turso / libSQL** (`LIBSQL_URL`) | native libSQL vectors (in your DB) | none — works out of the box |
| **Cloudflare D1** | **Cloudflare Vectorize** (required) | create + bind indexes (below) |
| **Bun SQLite** (`bun:sqlite`) | none — use Turso/libSQL or Postgres instead | switch to `LIBSQL_URL` (even `file:`) for in-DB vectors |
| **Xata Postgres** | Cloudflare Vectorize | Xata ships no `pgvector`, so pair it with Vectorize |

If none is configured, the vector endpoints fail loudly with a "configure a
vector backend" message rather than silently no-op'ing.

> **Turso/libSQL vector search is exact (brute-force), not approximate.** It
> scans every row in the collection's namespace and orders by cosine distance —
> correct for any dimension (including `openai-3-large` at 3072, which exceeds
> Vectorize's 1536 cap) and exact per namespace. The libSQL ANN index
> (`vector_top_k`) is a future optimization for very large collections.

## Enable native vectors on Turso / libSQL

Point the app at a libSQL database with `LIBSQL_URL` (a Turso `libsql://…` URL
plus `LIBSQL_AUTH_TOKEN`, or a local `file:…`/`:memory:` path). The migration
adds an `F32_BLOB` embedding column to each per-model table automatically; on
write the chosen fields are embedded and stored in-database. Then configure an
[embedding provider](#embedding-providers) and a default model:

```bash
LIBSQL_URL=libsql://my-db-org.turso.io
LIBSQL_AUTH_TOKEN=eyJ...
OPENAI_API_KEY=sk-...            # or an [ai] binding / EMBEDDING_HTTP_URL
EMBEDDING_DEFAULT_MODEL=openai-3-small
```

No index to create and nothing to bind — unlike Vectorize, the vectors live in
the same database as your rows.

> On **backlex.cloud** this is automatic: every project is D1, and provisioning
> creates and binds a per-project Vectorize index for you. Managed AI is
> metered + capped per plan; Free projects bring their own model over
> [MCP](/mcp) instead. Self-hosters configure the pieces below.

## Enable vectors on a self-hosted D1 / SQLite deploy

You're on Cloudflare Workers. Create a Vectorize index per embedding model you
want (dimensions are fixed at creation), then bind it in `wrangler.toml`.

```bash
# pick the model(s) you need — dimensions must match the model
wrangler vectorize create workeros-bge-m3   --dimensions=1024 --metric=cosine
wrangler vectorize create workeros-openai-1536 --dimensions=1536 --metric=cosine
```

```toml
# wrangler.toml — uncomment only the models you created (CF validates bindings
# at deploy, so a binding to a non-existent index breaks the deploy).
[[vectorize]]
binding = "VECTORIZE_BGE_M3"
index_name = "workeros-bge-m3"

# Workers AI bge-m3 needs the AI binding:
[ai]
binding = "AI"
```

Then configure an **embedding provider** for that model (see below) and set a
default model so vectorizable collections embed without per-collection config:

```toml
[vars]
EMBEDDING_DEFAULT_MODEL = "bge-m3"
```

## Embedding providers

The embedding model determines the provider (and the index dimensions):

| Model key | Provider | Dimensions | Needs |
| --- | --- | --- | --- |
| `bge-m3` | Workers AI | 1024 | `[ai]` binding |
| `openai-3-small` | OpenAI | 1536 | `OPENAI_API_KEY` |
| `openai-3-large` | OpenAI | 3072 | `OPENAI_API_KEY` (exceeds Vectorize's 1536 max — Postgres or Turso/libSQL only) |
| `self-host-bge-m3` | Self-host (TEI / Ollama / vLLM) | 1024 | `EMBEDDING_HTTP_URL` (+ `EMBEDDING_HTTP_TOKEN`) |

OpenAI and self-host run on **your own keys** (your cost). On backlex.cloud the
Workers-AI path runs through the control-plane gateway (metered + hard-capped);
self-hosted, it uses your own `[ai]` binding.

## Make a collection vectorizable

Turn on the collection master switch and flag the text fields to embed. On each
write, the flagged `text` / `longtext` fields are concatenated and embedded; the
vector is upserted under the collection's namespace.

```jsonc
// collection
{
  "vectorize": true,            // master switch
  "vectorizeModel": "bge-m3",   // optional; defaults to EMBEDDING_DEFAULT_MODEL
  "fields": [
    { "name": "title", "type": "text", "vectorize": true },
    { "name": "body",  "type": "longtext", "vectorize": true }
  ]
}
```

Embedding on write is **best-effort** — a provider/store hiccup is logged but
never blocks the item write.

In the admin UI: toggle **Vector search (semantic)** on the collection's
Settings card (it also hosts the embedding-model picker and warns when the
chosen model's provider or the vector store isn't configured — readiness comes
from `GET /api/vector/capabilities`), and flip **Vectorize** on each
text/longtext field in the Add/Edit field dialog.

### Backfilling existing rows

Rows written before the toggle are **not** embedded automatically (each row is
one embedding-provider call, so backfill is a deliberate action — unlike the
[full-text index](/full-text-search), which auto-backfills). Run it once from
the Settings card's **Embed all rows** button, or:

```bash
POST /api/collections/articles/vectorize
# → { "ok": true, "processed": 1240, "skipped": 12, "total": 1252 }
```

## Endpoints

Under `/api/vector` (see also the `vector.search` MCP tool):

| Endpoint | Purpose |
| --- | --- |
| `GET /capabilities` | store + per-model readiness (drives the admin model picker) |
| `POST /embed-upsert` | server embeds `text`, then upserts |
| `POST /search` | server embeds the query `text`, then ANN-searches |
| `POST /upsert` | upsert pre-computed vectors |
| `POST /query` | search by a pre-computed query vector |
| `POST /delete` | delete by id (namespace-scoped) |

Vectors are isolated per collection via a `namespace` (the collection slug), so
one index safely holds many collections.

## Hybrid search

Vector (semantic) search and [full-text](/full-text-search) (keyword) search are
complementary — embeddings capture meaning, the keyword index captures exact
terms. `POST /api/items/{slug}/search` with `mode: "hybrid"` runs both and fuses
them with Reciprocal Rank Fusion, returning whole rows with the caller's read
permission and tenant scope enforced. See
[Full-text & hybrid search](/full-text-search) for the endpoint, RRF details,
and the `fts` / `searchable` collection flags.
