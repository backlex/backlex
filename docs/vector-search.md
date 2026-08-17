---
title: Vector search & AI
description: Semantic (vector) search over your collections — pgvector on Postgres, native vectors on Turso/libSQL, Cloudflare Vectorize on D1.
---

Backlex can embed your records and run semantic (vector) search over them. Mark
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

Any deployment can instead point at an **external vector database** — see
[Bring your own vector database](#bring-your-own-vector-database).

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
wrangler vectorize create backlex-bge-m3   --dimensions=1024 --metric=cosine
wrangler vectorize create backlex-openai-1536 --dimensions=1536 --metric=cosine
```

```toml
# wrangler.toml — uncomment only the models you created (CF validates bindings
# at deploy, so a binding to a non-existent index breaks the deploy).
[[vectorize]]
binding = "VECTORIZE_BGE_M3"
index_name = "backlex-bge-m3"

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

### Long rows are chunked

Every embedding model has a hard input ceiling — 8192 tokens for BGE-M3, 8191
for both OpenAI models — so a row longer than that cannot be one vector. It is
split into overlapping passages of about 2000 characters (200 of overlap, cut
on the nearest paragraph, line or sentence boundary), each embedded and stored
on its own. A search returns the row once, ranked by its **best** passage.

This is automatic and needs no configuration. Three consequences worth knowing:

- **A row is capped at 32 chunks** — roughly 64 KB of indexed text. Past that
  the remainder is not embedded, and the drop is logged with the row's id.
- **Short rows are unchanged.** A row that fits in one chunk keeps the plain
  item id as its vector id, exactly as before chunking existed, so **no
  re-index is required** — existing vectors stay valid.
- **Editing a row shortens its chunk list safely.** Cutting a document from
  five passages to two deletes the other three, so text you removed stops
  matching queries. (Vector stores here cannot delete by metadata filter, so
  this happens by deriving the ids — see `staleChunkIds` in
  `services/vectorize.ts` if you are changing that code.)

Before chunking, an over-long row failed differently on each provider and
silently on both: OpenAI rejects the request, so the row ended up with **no**
vector and was invisible to `mode: "vector"` forever, while Workers AI truncates,
so only the opening of the document was searchable.

### Retrieval: ask for the passage, not the document

Search returns whole rows. For RAG that is the wrong unit — you want the
passage that matched, to put in a prompt. Pass `passages: true` and each row
carries the chunks it matched on, best first:

```bash
curl -X POST $APP_URL/api/items/articles/search \
  -H 'content-type: application/json' \
  -d '{"q":"how do refunds work","mode":"vector","passages":true}'
```

```jsonc
{
  "data": [
    {
      "id": "…", "title": "Billing handbook", "body": "…the whole document…",
      "_passages": [
        { "text": "Refunds are issued to the original method within…", "score": 0.83, "index": 4 },
        { "text": "A partial refund leaves the subscription active…", "score": 0.71, "index": 5 }
      ]
    }
  ],
  "mode": "vector", "limit": 20
}
```

Also on `client.from("articles").search({ q, passages: true })`, on the
`collections.search` MCP tool, and in GraphQL as a `passages` argument feeding a
`passages` field on the row.

Three things to know:

- **Vector and hybrid only.** A row matched by the keyword index alone has no
  passages and is returned without the key — an empty array would read as
  "this row matched no text".
- **At most three passages per row**, so one long document cannot fill a
  prompt on its own.
- **Withheld when the caller's permission carries a field allow-list.** A
  passage is text as embedded — every `vectorize` field concatenated — so
  returning it would hand back in full a field the row itself is stripped of.
  Chunk boundaries do not follow field boundaries, so it cannot be censored per
  field; the honest answer is to omit it.

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

**MCP:** agents get the same surface — `vector.search`, `vector.upsert`,
`vector.capabilities` (readiness check), plus `schema.update_collection`
(`vectorize` / `vectorizeModel`) and `schema.vectorize_backfill` for the
manual embed backfill.

**CLI:** `backlex collections vectorize <slug>` runs the backfill and prints
the processed/skipped counts.

## Hybrid search

Vector (semantic) search and [full-text](/full-text-search) (keyword) search are
complementary — embeddings capture meaning, the keyword index captures exact
terms. `POST /api/items/{slug}/search` with `mode: "hybrid"` runs both and fuses
them with Reciprocal Rank Fusion, returning whole rows with the caller's read
permission and tenant scope enforced. See
[Full-text & hybrid search](/full-text-search) for the endpoint, RRF details,
and the `fts` / `searchable` collection flags.

## Bring your own vector database

If you already run **Pinecone** or **Qdrant**, point backlex at it instead of
using the database-native store. Both are configured by environment variables
and take precedence over `pgvector` / libSQL — wiring one on a Postgres
deployment is read as "I mean it".

Resolution order: Vectorize bindings → Pinecone → Qdrant → `pgvector` → libSQL →
none.

### Per-model indexes are not optional

An index (Pinecone) or collection (Qdrant) **fixes its vector dimension at
creation**, and the embedding models do not share dimensions:

| Model | Dimensions |
| --- | --- |
| `bge-m3`, `self-host-bge-m3` | 1024 |
| `openai-3-small` | 1536 |
| `openai-3-large` | 3072 |

So each model you intend to use needs its own index. A model with no index
configured **throws** on use rather than falling back to another one — a
cross-dimension write would be rejected anyway, but a same-dimension write would
succeed and silently poison every search result in that index.

The admin's model picker reads this: a model without an index shows as
unavailable rather than failing at first embed.

### Pinecone

```bash
PINECONE_API_KEY=pcsk_…
# The index HOST, not its name — copy it from the Pinecone console or
# `describe_index`. Taking the host avoids a control-plane lookup per cold start.
PINECONE_INDEX_OPENAI=my-1536-idx-abc123.svc.us-east-1.pinecone.io
PINECONE_INDEX_OPENAI_LARGE=my-3072-idx-abc123.svc.us-east-1.pinecone.io
PINECONE_INDEX_BGE_M3=my-1024-idx-abc123.svc.us-east-1.pinecone.io
PINECONE_INDEX_SELF_HOST_BGE_M3=…
```

Namespaces map onto Pinecone's native namespaces. Because Pinecone carries the
namespace on the *request* rather than the record, an upsert batch spanning
several namespaces is split into one call each.

### Qdrant

Works with Qdrant Cloud or a self-hosted instance; the API key is optional, so a
local Qdrant needs only a URL.

```bash
QDRANT_URL=https://xyz.eu-central.aws.cloud.qdrant.io:6333
QDRANT_API_KEY=…                      # omit for a local/anonymous instance
QDRANT_COLLECTION_OPENAI=items-1536
QDRANT_COLLECTION_OPENAI_LARGE=items-3072
QDRANT_COLLECTION_BGE_M3=items-1024
QDRANT_COLLECTION_SELF_HOST_BGE_M3=…
```

Create each collection with the matching size, e.g.:

```bash
curl -X PUT "$QDRANT_URL/collections/items-1024" \
  -H "api-key: $QDRANT_API_KEY" -H 'content-type: application/json' \
  -d '{"vectors":{"size":1024,"distance":"Cosine"}}'
```

Namespaces are stored as a `namespace` payload field and filtered on, rather
than as a collection each: Qdrant filters payload cheaply, and
collection-per-namespace would multiply setup without adding isolation.
