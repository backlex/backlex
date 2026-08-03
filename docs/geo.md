---
title: Geo fields
---

A `geo` field stores a point on the earth and makes a collection answer the
question its address columns never could: **which of these is close to me.**

```http
POST /api/items/clinics
{ "name": "Dr Yılmaz", "location": { "lat": 41.0082, "lng": 28.9784 } }

GET /api/items/clinics
  ?filter={"location":{"_near":{"lat":41.0082,"lng":28.9784,"radius":"5km"}}}
  &sort=location
```

Nearest first, inside five kilometres.

## Why this exists

Fifteen of the twenty-seven schema templates carry an address as loose text —
`address`, `city`, `postal_code`, `country`, on venues, warehouses, clinics,
properties, customers and technicians. Forty-five columns in all. That is fine
for printing on an invoice and useless for dispatch: there was no coordinate
type, no distance operator, and nothing that turned a written address into a
point, so "the three nearest technicians" meant exporting the table and looping
in the caller.

## Adding one

In the admin, add a field and pick **Location**. Over the API:

```http
POST /api/collections
{
  "slug": "clinics",
  "fields": [
    { "name": "address", "type": "text" },
    { "name": "city", "type": "text" },
    { "name": "country", "type": "text" },
    {
      "name": "location",
      "type": "geo",
      "geo": { "geocodeFrom": ["address", "city", "country"] }
    }
  ]
}
```

`geo` is optional. A bare `{ "name": "location", "type": "geo" }` is a
coordinate pair someone types or picks, and that is the common case.

| Key | Meaning |
|---|---|
| `geocodeFrom` | Field names joined into an address and looked up when a write supplies no point. Order is the address format. |
| `defaultCenter` | Where the admin's map preview opens for a row with no point. UI only — never written to a row. |

A `geo` column takes no `unique`, `indexed`, `searchable`, `vectorize`,
`localized`, `default`, `computed`, `rollup` or `sequence` — all of them assume
a scalar, and a clinic is not somewhere else in French.

## The value

Stored as `{ "lat": …, "lng": … }` and read back that way, always. Four input
shapes are accepted, because four are what arrive:

| Sent | Why it is accepted |
|---|---|
| `{ "lat": 41.0082, "lng": 28.9784 }` | canonical |
| `{ "latitude": …, "longitude": … }` | what geocoding APIs and Firestore exports emit |
| `[28.9784, 41.0082]` | GeoJSON coordinate order — **longitude first** |
| `"41.0082, 28.9784"` | what a maps app puts on the clipboard |

All four are normalized on the way in, on every surface, so the 201 body, the
next read, the realtime event and the changefeed all agree. Latitude outside
−90…90 or longitude outside −180…180 is a 422 — a bad coordinate that reached
storage would make every later distance query wrong with nothing to flag it.

## `_near`

```json
{ "location": { "_near": { "lat": 41.0082, "lng": 28.9784, "radius": "5km" } } }
```

`radius` is a number of kilometres, or a string with a unit: `km`, `m`, `mi`,
`nmi`. The unit is part of the value rather than a separate parameter because a
bare number is ambiguous in exactly the way that silently matches a thousand
times too much — `500` is a sensible radius in metres and an absurd one in
kilometres.

- A row with no point is **near nothing**, including the origin.
- `_near` on a non-`geo` field is a 422, not an empty page.
- The scalar operators (`_eq`, `_contains`, …) are refused on a `geo` field —
  they would compare the stored JSON as text. `_null` / `_nempty` still work,
  and answer "which rows have not been located yet?".
- It works in **permission conditions** too, which is what makes "this role
  reads only the sites in its region" expressible.

`_near` reaches every surface a filter does: REST, the SDK, GraphQL, and the
`collections-list` MCP tool.

### Sorting by distance

`sort=location` orders nearest-first; `sort=-location` reverses it. The origin
is the `_near` in the same request's filter — there is no other point it could
mean, so a sort on a `geo` field with no `_near` on it is a 422 that says so
rather than ordering rows by the text of their JSON.

Works with keyset pagination (`?cursor=`) like any other sort.

### Distance in the response

There isn't one, deliberately. The row already carries its coordinates and the
caller already knows the origin it asked about, so distance is a pure function
of things both ends hold. `@backlex/db/geo` exports it, and it is the *same*
function the server filtered with:

```ts
import { distanceKm } from "@backlex/db/geo";

const origin = { lat: 41.0082, lng: 28.9784 };
rows.map((r) => ({ ...r, km: distanceKm(r.location, origin) }));
```

Projecting a synthetic column into every response would have cost the same
number, computed twice.

## How the distance is computed

An **equirectangular projection** around the query origin: flatten that patch of
globe, then use Pythagoras on it.

```
d² ≈ (Δlat)² + (Δlng · cos(lat₀))²
```

Every trigonometric term is evaluated in JavaScript against the origin — one
point, known before the query is built — so what reaches SQL is a handful of
bound constants and `+`, `-`, `*` and a `CASE`.

**Nothing ever takes a square root.** The filter compares squared distance
against squared radius and the sort orders by squared distance; squaring is
monotonic over non-negative reals, so both answers are identical to the ones
real distances would give.

That matters because the alternatives are not portable. PostGIS is a Postgres
extension with no D1 equivalent. Haversine needs `sin`/`cos`/`asin`, and SQLite
only has those when its build enabled `SQLITE_ENABLE_MATH_FUNCTIONS` — a
property of whichever binary the deploy target links, not something a query can
check. The same is true of `sqrt`. What is left runs everywhere.

**Accuracy.** Within about 0.1% of great-circle distance at a 50 km radius,
about 0.5% at 300 km, and increasingly optimistic beyond that or above 85°
latitude. Longitude differences are folded the short way round, so a radius that
straddles the antimeridian behaves — 179°E and 179°W are 0.2° apart, not 359.8°.

**`_near` is a scan.** There is no index that helps: a B-tree over a JSON blob
orders by its text, and an expression index is not portable to SQLite. Narrow
the candidate set with the filters you already have (`city`, `status`, a tenant)
and proximity stays cheap.

## Geocoding

With `geocodeFrom` set, a write that supplies no point derives one from the
address columns beside it.

```http
POST /api/items/clinics
{ "name": "Dr Yılmaz", "address": "Sultanahmet", "city": "İstanbul", "country": "Türkiye" }
→ 201 { "location": { "lat": 41.0082, "lng": 28.9784 }, … }
```

Three rules, each because the opposite is worse:

- **Never over an explicit point.** A coordinate someone typed, or dropped a pin
  for, is better information than a string match. An explicit `null` is a
  decision too, and is left alone.
- **Never fatal.** A geocoder that is down, rate-limited or misconfigured does
  not stop someone saving a customer record. The point stays null and the write
  succeeds.
- **Never during an import.** See below.

On update, the lookup re-runs only when the patch touched a source column — and
resolves against the stored row merged with the patch, so changing just `city`
still uses the `address` the patch never mentioned.

### Providers

| `GEOCODE_PROVIDER` | Credentials | Notes |
|---|---|---|
| `google` | `GEOCODE_GOOGLE_API_KEY` | No confidence score reported. |
| `mapbox` | `GEOCODE_MAPBOX_TOKEN` | `relevance` maps to `confidence`. |
| `nominatim` | none, or `GEOCODE_URL` for a self-hosted instance | OpenStreetMap. |
| `console` | — | Resolves nothing. The default. |

`GEOCODE_LANGUAGE` and `GEOCODE_COUNTRY` bias results and are passed to whichever
provider is active. `GEOCODE_USER_AGENT` identifies you to Nominatim (defaults to
`backlex (<APP_URL>)`).

Unset, a deployment gets `console`, which resolves nothing and says so. There is
no built-in fallback because a geocoder is a *dataset*, not an algorithm —
guessing a country centroid would put pins in real places that are wrong, which
is worse than an empty field an operator can see is empty.

The **public Nominatim is never the automatic default**: its usage policy
forbids exactly the bulk traffic a backfill produces. Reaching it takes an
explicit `GEOCODE_PROVIDER=nominatim`; a busy workspace should run its own and
point `GEOCODE_URL` at it.

### One-off lookups

```http
POST /api/geo/geocode   { "address": "Sultanahmet, İstanbul" }
POST /api/geo/reverse   { "lat": 41.0082, "lng": 28.9784 }
```

`data` is `null` when the provider found nothing — an unplaceable address is a
normal answer, not an error. `formatted` is the place the provider actually
matched, which is the only way to notice that "Springfield" resolved to the
wrong Springfield. Signed-in callers only: the endpoints touch no row, but they
spend a metered third-party quota, and an open one is someone else's free
geocoding proxy.

### Backfill

**A CSV/JSON import does not geocode.** It is the one write path with no bound on
how many rows it processes, and a geocoder is metered and slow — the public
Nominatim asks for no more than one request a second, so a thousand-row file
would become a request that cannot finish, having spent the quota and located an
arbitrary prefix. An adopted table arrives with addresses and no points for the
same practical reason.

```http
POST /api/geo/backfill/clinics   { "field": "location", "limit": 50 }
→ { "data": { "located": 48, "unresolved": 1, "skipped": 1, "remaining": 212 } }
```

Bounded per call (default 50, ceiling 500). Loop while `remaining > 0`. It only
ever **fills a missing point, never revises one** — so re-running is safe, and a
pin an operator hand-corrected survives it. Requires `update` on the collection.

```bash
bun backlex collections backfill-geo clinics location --batch 100
```

The CLI loops for you and prints progress as it goes.

## Surfaces

| | |
|---|---|
| REST | `_near` filter, distance sort, `POST /api/geo/{geocode,reverse,backfill/:slug}` |
| SDK | `from(slug).list({ filter: { location: { _near: … } } })`, `from(slug).backfillGeo(field, limit?)`, `distanceKm` from `@backlex/db/geo` |
| GraphQL | `filter` / `sort` arguments; points are the `JSON` scalar |
| MCP | `geo.geocode`, `geo.reverse`, `geo.backfill` (proximity goes through `collections-list`'s filter — one way to ask, not two) |
| CLI | `backlex collections backfill-geo <slug> <field>` |

`apps/web/tests/geo-surfaces.test.ts` is the gate that keeps them in step.

## In the admin

The field editor offers three ways to fill a point in, in the order an operator
reaches for them: **find from address** (the same lookup the write path makes,
reading the address inputs live), **use my location**, and two coordinate boxes
that also accept a pasted `"lat, lng"` in either half.

The map preview is **click-to-load**. Rendering an embedded map on form open
would send the row's coordinates to a third-party tile server every time anyone
opened the record — for a customer's home address, a disclosure nobody asked
for. Nothing contacts an outside host until a button is pressed.

There is no bundled click-to-place map: a real one means shipping a mapping
library and a tile subscription into every deployment, including the air-gapped
ones, to replace two number inputs and a lookup button.

## What is deliberately not supported

- **Polygons, lines, and GeoJSON geometry.** A `geo` field is a point. Areas
  need a spatial index to be worth anything, and that is PostGIS — which does
  not exist on D1.
- **A distance column in the response.** See above: the client can compute it
  from data it already has, with the same function.
- **Bulk geocoding inside a write.** That is what the backfill endpoint is.
