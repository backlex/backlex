---
title: Full-text & hybrid search
description: Keyword (full-text) search over your collections, fused with vector search for hybrid relevance ranking.
---

backlex can rank a collection's rows against a query string three ways:

- **`fts`** — keyword/full-text search over an inverted index (Postgres
  `tsvector` + GIN; SQLite FTS5). Token-precise, no embedding cost.
- **`vector`** — semantic search over embeddings (see
  [Vector search](/vector-search)).
- **`hybrid`** — both of the above run independently, then fused with
  **Reciprocal Rank Fusion (RRF)** so a row ranked highly by *either* backend
  floats up and a row ranked by *both* wins.

Full-text search is **managed-collection only** and works on every database
backlex runs on — no extra service. Unlike vector search there's no embedding
provider to configure.

## How the index works

Mark a collection `fts: true` and flag the text fields to index with
`searchable: true`. On every write the flagged `text` / `longtext` fields are
concatenated and folded into the index; on delete they're removed. The index
content is maintained by the item-write hooks (best-effort — an index hiccup is
logged but never blocks the underlying write, exactly like vectorization).

Where the index lives depends on the dialect:

| Database | Index | Ranking |
| --- | --- | --- |
| **Postgres** | a `_fts tsvector` column on the physical table, GIN-indexed | `ts_rank_cd` |
| **SQLite** (D1 / Bun / Turso) | an FTS5 shadow table `<table>__fts(item_id, content)` | `bm25()` |

Both use a language-agnostic tokenizer (`'simple'` config on Postgres, the
default FTS5 tokenizer on SQLite) — **no stemming, no stop words** — so ranking
stays close across dialects. That also means matching is *token-precise*:
searching `cat` matches the word "cat" but **not** "category" or "scattered"
(a substring `LIKE` would have matched both).

> Full-text search is managed-only. Adopted tables never get DDL, so the
> index objects aren't created for them — use vector search (which keys off an
> external store) if you need relevance ranking over an adopted table.

## Make a collection searchable

```jsonc
// POST /api/collections   (or PATCH to enable on an existing one)
{
  "slug": "articles",
  "fts": true,                                   // master switch
  "fields": [
    { "name": "title", "type": "text",     "searchable": true },
    { "name": "body",  "type": "longtext",  "searchable": true },
    { "name": "slug",  "type": "text" }           // not indexed
  ]
}
```

In the admin UI: toggle **Full-text search** on the collection's Settings card,
and flip **Searchable** on each text/longtext field (Add/Edit field dialog).

### Backfilling existing rows

Enabling `fts` only indexes rows written *after* it's on. To index the rows
that already exist, run the backfill once:

```bash
POST /api/collections/articles/fts-reindex
# → { "ok": true, "processed": 1240, "skipped": 12, "total": 1252 }
```

`skipped` counts rows whose searchable fields were all empty.

## Searching

### `POST /api/items/{slug}/search`

The ranked endpoint. Returns whole rows, best-first, with the caller's read
permission (rows **and** fields), tenant scope, soft-delete, and draft
visibility all enforced — a vector hit the caller can't see never leaks,
because every candidate id is re-checked when its row is hydrated.

```jsonc
// request
{ "q": "postgres index tuning", "mode": "hybrid", "limit": 20 }

// response
{
  "data": [ /* rows, best-first */ ],
  "mode": "hybrid",        // the mode that actually ran
  "limit": 20
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `q` | — | required, non-empty |
| `mode` | auto | `fts` \| `vector` \| `hybrid`. Omit to auto-pick: `hybrid` when both backends are enabled, else whichever single one is. Requesting a backend the collection hasn't enabled returns `422`. |
| `limit` | `20` | 1–100 |
| `locale` | none | collapse `i18n_text` fields to one locale (or `*`) |

**RRF.** Each backend returns a ranked id list; every list contributes
`1 / (60 + rank)` per id (60 is the canonical RRF constant), the scores are
summed, and the top `limit` ids are hydrated. backlex over-fetches candidates
from each backend so rows dropped by the permission/visibility filters don't
starve the page.

### `?q=` on the list endpoint

When a collection has full-text search active, the list endpoint's `?q=`
upgrades from substring `LIKE` to a keyword-index **filter** — strictly more
precise. Ordering still follows your `?sort=` / the collection default; for
true relevance *ranking* use the `/search` endpoint above.

```bash
GET /api/items/articles?q=postgres&sort=-created_at
```

Collections **without** `fts` keep the legacy behaviour: `?q=` is OR-ed as
`_contains` (substring `LIKE`) across every readable text field.

## SDK

```ts
const { data, mode } = await client.from<Article>("articles").search({
  q: "postgres index tuning",
  mode: "hybrid",   // optional
  limit: 20,
});
```

## MCP

The `collections.search` tool exposes the same endpoint to agents — prefer it
over `collections.list` for "find the most relevant…" questions, since `list`
only does exact filters, not ranking.

## See also

- [Vector search & AI](/vector-search) — the semantic half of hybrid search.
- [Querying the items API](/querying) — `filter` / `sort` / `?q=` on the list endpoint.
