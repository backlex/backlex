---
title: Product analytics & crash reporting
description: Track product events from your apps, measure funnels and cohort retention, and triage deduplicated crash reports — over REST, the SDK, GraphQL, MCP and the CLI.
---

Backlex ingests **product events** and **crash reports** from your apps, and
answers the questions a Firebase/Amplitude-shaped stack is usually bolted on
for: how many people use the product, where they fall out of a flow, whether
they come back, and what's breaking.

This is deliberately *product* analytics — how your **users** behave. It sits
next to, not on top of, the two adjacent surfaces:

| Page | Answers |
|---|---|
| **Analytics** (this) | What are my users doing? What's crashing for them? |
| [Usage](/docs/usage-metering/) | How much API budget is this workspace burning? |
| [Traces](/docs/tracing/) | Why was *this one request* slow? |

## Anatomy

Three system tables (dual-dialect, in `packages/db/src/{pg,sqlite}/schema.ts`).
All three are FK-free, pruned by retention, and safe to truncate.

- **`analytics_events`** — one row per tracked event. Carries `name`,
  `distinct_id`, optional `user_id` / `session_id`, free-form `props` JSON, and
  the context fields `path` / `referrer` / `source` / `release` / `country`.
- **`error_groups`** — the deduplicated identity of one bug, with a lifetime
  `events` counter, `first_seen` / `last_seen`, and a triage `status`.
- **`error_events`** — individual captured occurrences (stack + context).

### `distinctId` is the unit of counting

Every unique-visitor count, funnel cohort and retention cohort is keyed by
**`distinctId`** — a stable, client-generated anonymous id — not `userId`. That
is what makes pre-signup traffic measurable, and it means a visitor who later
signs in still counts once rather than twice.

The SDK generates one and persists it in `localStorage`. After sign-in, call
`identify()` to attach your own user id without losing the anonymous history:

```ts
client.analytics.identify(user.id, { userId: user.id });
```

### Event time is client-supplied, and clamped

`ts` defaults to server time. A client may backdate it — an offline mobile queue
replaying yesterday's events is the point — but the server clamps it to
**at most 7 days in the past and 5 minutes in the future**, so a device with a
broken clock can't rewrite last quarter's numbers or park rows in 2049.

Backfilling historical analytics from another provider is therefore *not*
supported through this endpoint; those rows would all collapse onto the 7-day
boundary.

## Measuring a website (the drop-in tag)

Everything above assumes your app calls `track()`. For a website — a marketing
site, a docs site, anything you did not want to add an SDK to — register the
site and paste one line:

```html
<script defer src="https://your-workspace.example.com/api/analytics/script.js"
        data-site="<site-id>"></script>
```

Register it under **Website → Websites** (or `backlex analytics sites add --name
"Marketing" --domain example.com`, which prints the snippet for you). The site
id is public by design: it names a destination, it does not authenticate one.

The tag reports a `page_view` on load and on every SPA route change — it wraps
`pushState` / `replaceState` and listens for `popstate` and `hashchange`, so a
client-side router is measured without extra code. Custom events use the global
it installs:

```js
backlex("signup", { plan: "pro" });
```

### It is cookieless, and what that costs

The tag stores **nothing** on the visitor's device: no cookie, no
`localStorage`, no `sessionStorage`. The visitor id is derived server-side from
a daily-rotating hash of the request's IP and user-agent; neither is ever
written to a column.

Two things follow, and neither is hidden in the UI:

- **This is pseudonymous, not anonymous.** The salt is derived from a secret
  the operator holds (`ANALYTICS_SALT`, falling back to `AUTH_SECRET`), so an
  operator with an IP and user-agent could recompute an id. What it does buy is
  real: nothing on the device, and no id that outlives the day.
- **Cohort reports exclude it.** At 00:00 UTC every visitor becomes new. A
  retention grid or a multi-day funnel built on rotating ids would not be
  incomplete — it would be *wrong*, showing every returning visitor as new. So
  those two reports filter to durable (SDK) ids, and the overview reports
  `cookielessShare` alongside a per-day visitor figure so you can see which
  number you are reading.

Rotating `ANALYTICS_SALT` resets every visitor identity at once. That is a
legitimate privacy lever and also a visible discontinuity in the numbers.

### Consent, and what "cookieless" does and does not mean

The tag ships **the mechanical half of Consent Mode**: it reads gtag's
`dataLayer`, `navigator.globalPrivacyControl` and `DNT`, and it exposes an
explicit override for a consent tool that is not gtag-shaped:

```js
backlex.consent("denied");                 // grants nothing
backlex.consent("granted");                // grants every optional category
backlex.consent({ analytics: true });      // a decision, per category
backlex.consent(null);                     // back to undecided
```

The tag holds a **grant map** over the four categories the tag manager files
tags under — `functional`, `analytics`, `marketing`, and `none`, which is never
gated. The tag files *itself* under `analytics`, so denying that category stops
it; denying only `marketing` does not.

**The object form is a decision, not a patch.** A category you leave out is
denied, not left alone — the same rule the server applies when it stores a
consent record, because absence is not consent. Pass the whole map.

An explicit call wins over the dataLayer — that is the site owner speaking
directly rather than us inferring. A category nothing has spoken about is
allowed. GPC and DNT are checked separately and stop the tag whatever the map
says.

The same map gates your third-party tags through the tag manager: see
[Cookie consent](cookie-consent.md). GPC and DNT do **not**
reach those — they stop this tag only.

**The state is enforced on the server too**: a denied event is dropped by the
collect route regardless of what a modified tag chooses to send, because a
client-side check is advice and this is the half an operator can point at in an
audit. Note what the stock tag actually puts on the wire, though — it reports
`"granted"` only when a site explicitly granted, and reports nothing at all
when the visitor has not answered. It never reports a denial, because a denied
tag stops before it builds a request: a visitor who said no, or whose browser
said no for them, sends nothing. That is the intended behaviour and it is also
why the server cannot tell "declined" from "never visited" — closing that gap
needs the consent banner, which has a durable subject id to attach a decision
to.

GA4's *other* half of Consent Mode is behavioural modeling — statistically
inferring the conversions it was not allowed to observe. That is not
reproducible here and is not imitated quietly.

Be precise about the privacy claim itself. The visitor id is
`sha256(ANALYTICS_SALT ‖ utcDay ‖ tenant ‖ site ‖ ip ‖ user-agent)`, truncated.
Nothing is stored on the device, no IP or user-agent is written to any column,
and the id stops working at UTC midnight. But the operator holds the salt, so
an operator with an IP and a user-agent could recompute an id: this is
**pseudonymous, not anonymous**, and the second word is the one to use.

### Per-site settings

| Setting | Effect |
|---|---|
| **Bots filtered** | Declared crawlers are dropped rather than labelled `bot`. |
| **Origin checked** | Events whose origin is not the registered domain are refused. Subdomains count as the same site. |
| **Excluded paths** | Never recorded. A leading or trailing `*` is supported (`/admin/*`). |
| **Ignored IPs** | Never recorded — your office, a monitoring probe. |

All four are enforced **server-side** and are editable from **Websites →
Settings**.

Three of them are also **validated** there, because each fails silently when it
holds something unusable rather than something wrong:

| Refused | Why it would never fire |
|---|---|
| A domain that is not a host (`my site`, a sentence) | It is compared against the request's real origin host, so with **Origin checked** on — the default — every event is dropped with a 202 and no error anywhere. A full URL, a port, an IDN and `localhost` are all fine; they are reduced to the host. |
| A path with no leading `/`, or one carrying a query | `pathExcluded` compares against `location.pathname` with the query already stripped, and an entry without a `*` is an exact match. `admin` and `/search?q=x` exclude nothing. |
| A bare `*` | It matches every page — measurement off for the whole site in one keystroke. |
| An ignored IP that is not an address, or a CIDR range | The request IP is compared exactly. `203.0.113.0/24` and `office` never match. Both address families are accepted. | The tag's own opt-outs (`DNT`, `globalPrivacyControl`,
consent state, and skipping `localhost` unless `data-allow-localhost="true"`)
are advice a client can decline to follow; these are not.

> **The origin check is not a security boundary.** `Origin` is forgeable by any
> non-browser client. It stops a snippet copied onto a staging host and casual
> abuse; what bounds a determined caller is the per-(site, IP) rate limit, and
> the endpoint is append-only — it can never read a row back.

### Why the tag does not use the ingest endpoint

`POST /api/analytics/collect` exists separately from `POST /api/analytics/events`
because four things make the latter unusable from a `<script>` on someone
else's domain: the app's CORS layer is credentialed with an origin allowlist;
the SDK always sends `credentials: "include"`, which a wildcard origin rejects;
`navigator.sendBeacon` cannot set the `X-Backlex-Ingest-Key` header; and
`distinctId` is required, which a cookieless tag does not have.

So collect opts out of that CORS layer, answers `Access-Control-Allow-Origin: *`
**without** credentials, and takes a `text/plain` body — which keeps the request
"simple", so there is no preflight and a beacon fired during page unload still
arrives.

## Ingest

`POST /api/analytics/events` and `POST /api/analytics/errors` are append-only
and take a batch (max 500 per request). Malformed rows are dropped and counted
in `rejected` rather than failing the batch — one bad event must not cost a
mobile client its whole offline queue.

### The publishable ingest key

> A website registered under **Websites** needs none of this. Its script tag
> authenticates by the site id baked into it and reads no key at all — the key
> below is only for events sent from an app, a server job or your own SDK
> calls. See *Why the tag does not use the ingest endpoint* above.

Browser and mobile bundles authenticate with a **publishable** key
(`alk_…`), created per workspace from **Analytics → App SDK key** (or
`backlex analytics ingest-key mint`). It grants append-only ingest and cannot
read a single row back, so it is safe to ship in client code.

Only its SHA-256 hash is stored — the plaintext is shown once. Minting again
rotates it and immediately invalidates the previous key.

```ts
const client = createClient({
  url: "https://your-workspace.example.com",
  ingestKey: "alk_…",
});

await client.analytics.track("page_view", { plan: "pro" }, { path: "/pricing" });
```

Server-side callers don't need one — a normal API key or session authenticates
ingest too. A request with none of the three is rejected: anonymous ingest into
an arbitrary workspace would let anyone poison another tenant's numbers.

> **Do not treat the origin allow-list as what protects a leaked key.** A
> *browser* caller does need its origin under **Settings → Auth → Redirect
> URLs**, because the SDK sends `credentials: "include"` and that forces a
> credentialed preflight. But `curl`, a mobile build and a server send no
> `Origin` at all and are let through — and those are exactly where a scraped
> publishable key would be replayed from. What actually bounds a leaked key is
> that it is append-only, reads nothing back, and is capped at 120
> requests/minute per workspace+IP. Rotate it if it leaks.

Ingest is rate-limited to 120 requests/minute per workspace+IP. Batch, and
you'll never come near it.

### Crash reporting

`captureErrors()` forwards uncaught errors and unhandled promise rejections
automatically, and returns an unsubscribe function:

```ts
const stop = client.analytics.captureErrors({ release: "1.4.0" });
```

Or report explicitly — `trackError` accepts a real `Error` and reads its
message, name and stack off it:

```ts
try { await checkout(); }
catch (err) { await client.analytics.trackError(err, { release: "1.4.0" }); }
```

**Grouping.** Occurrences fold into one `error_group` by a fingerprint of
`type` + the *normalized* message + the top 3 stack frames. Normalization
strips the parts that vary per occurrence — numbers, UUIDs, hex addresses and
URLs — so `…for user 4821` and `…for user 913` are one bug, not two thousand.

**Triage.** A group is `open`, `resolved` or `ignored`. A new occurrence
**reopens** a resolved group (a regression is news) but never reopens an
ignored one — that's the whole point of ignoring it. The group's `events`
counter is a lifetime total and survives retention pruning, so an old bug keeps
its history after its individual payloads age out.

## Analysis

### Overview

`GET /api/admin/analytics/overview?from=&to=` — total events, unique visitors
and sessions, a **zero-filled** daily series (a quiet day is a zero, not a gap),
and top-N breakdowns by event name, path, referrer and source. Default window
is 30 days; the maximum span is 365.

### Saved segments

A segment is a reusable filter. Save one, then pass its id as `segmentId` to
any report — overview, sessions, channels, revenue, funnel, retention — or pick
it from the dropdown in the admin header.

```json
{ "all": [
  { "field": "country", "op": "eq", "value": "DE" },
  { "field": "deviceType", "op": "eq", "value": "mobile" }
] }
```

A leaf is `{field, op, value}`, `{prop, op, value}` for a `props` key, or
`{revenue, value}` for an amount. Leaves combine with `all`, `any` and `not`.
Operators: `eq`, `neq`, `contains`, `startsWith`, `endsWith`, `in`, `isSet`,
`isNotSet` — plus `gt` / `gte` / `lt` / `lte` for revenue.

> **This is the highest-severity input in the feature**, because a definition
> ends up inside a WHERE clause on every report it touches. The mitigation is
> structural, not sanitizing: **field names come from a closed allowlist** and
> are looked up to a column, never interpolated; **every value is bound**;
> `props` keys are bound as a JSON path with the `json_valid` guard that stops
> one malformed blob raising; and node count, nesting depth and `in`-list
> length are all capped, so a saved segment cannot become a way to make the
> database do unbounded work on every dashboard load.

A stored definition is **re-validated on every read**, never trusted. One saved
under an older, looser validator — or edited outside the API — filters
*nothing* rather than filtering wrongly. An id belonging to another workspace
resolves to nothing too, because the lookup is tenant-scoped.

**String matching does not use `LIKE`.** D1 rejects a bound LIKE pattern
outright (`LIKE or GLOB pattern too complex`), and it does so only on D1 — not
in bun:sqlite, so a test suite will not catch it. `contains` / `startsWith` /
`endsWith` use position and substring functions with bound values instead.

Sequence segments ("did A, then B, within N minutes") are deliberately absent:
the funnel report already answers that question directly, and a sequence
*segment* is a different composition.

### Ecommerce & revenue

`GET /api/admin/analytics/revenue?from=&to=&siteId=` — revenue by currency, by
acquisition channel, by campaign, and the top items.

Record a purchase from the tag:

```js
backlex("purchase", {
  revenue: 15000,          // MINOR units — 150.00
  currency: "TRY",
  items: [{ name: "Mug", quantity: 2, price: 2500 }],
});
```

…or from the SDK, where the signature says so:

```ts
await client.analytics.trackPurchase({
  amountMinor: 15_000,
  currency: "TRY",
  items: [{ name: "Mug", quantity: 2, price: 2_500 }],
});
```

> **Nothing is ever summed across currencies, and there is no combined total
> anywhere.** This repo has no FX rate source, so 100 TRY + 100 EUR is not 200
> of anything — and a merged figure would look entirely plausible, which is
> what makes it dangerous. Every row carries its own currency, so the mistake
> is unavailable to a caller rather than merely discouraged.

Amounts stay in minor units end to end; only the admin's formatter divides.
`revenue` and `currency` are columns (they landed in the first phase), so no
report has to read JSON to get a total — only the item breakdown reads
`props.items`, and it does so in JS from a bounded read rather than with a
`jsonb_array_elements` / `json_each` branch.

**`props` is read without the driver's JSON parser.** Selecting the column
object makes Drizzle parse the value while assembling the result row, and a
malformed blob throws *there* — before any of our code runs. One such row
would 500 an entire revenue report, and, worse, also 500 the raw-event view
that an operator would use to find it. Both queries therefore select `props` as
a bare expression and parse it defensively; an unreadable blob is reported as
absent, which is true and leaves the rest of the row usable.

### Channels & attribution

`GET /api/admin/analytics/channels?from=&to=&siteId=` — GA4's Default Channel
Groups (Direct, Organic Search, Paid Search, Organic Social, Paid Social,
Email, Affiliate, Display, Referral) plus a `source / medium` breakdown.

> **Attribution is the last non-direct touch WITHIN a session.** That is a
> weaker claim than GA4's, and the number looks identical, so the admin and the
> CLI both say it out loud. Cookieless visitor ids rotate at UTC midnight, so a
> campaign that brought someone in three days ago cannot be joined to this
> visit. Within a session, a touch carrying attribution wins over a bare direct
> hit regardless of order — a visitor who opens a bookmark and then clicks an
> emailed link in the same session came from Email.

Classification is **derived at query time, never stored**. A `channel` column
would freeze today's rules into yesterday's rows: adding a new social network
to the list would leave every historical visit from it reading as Referral
forever. Deriving it means the whole history reclassifies the moment the rules
change, which is what anyone comparing quarters actually wants.

The rules themselves live in `services/analytics-channels.ts` as pure
functions with no database, so they are cheap to test and cheap to adjust. An
explicit paid medium beats whatever the referrer looks like — an ad click and
an organic result share `google.com` and differ only in the tag, and getting
that backwards files every paid campaign as free traffic. An unrecognised
referrer falls through to `Referral`, which is a correct answer rather than a
guess, and is why the host lists can stay short.

### Sessions

`GET /api/admin/analytics/sessions?from=&to=&siteId=` — sessions, bounce rate,
average duration, pages per session, and the top landing and exit pages. A
30-minute gap between one visitor's hits ends a session, which is GA's
definition.

There is **no sessions table**: a window function reconstructs the boundaries
from the events already stored, so nothing is written twice and nothing can
drift. Two details are load-bearing:

- It partitions by `(distinct_id, day)` and filters on `day`, not `ts`. The
  index that serves it is `(tenant_id, day, distinct_id, ts)`; a range
  predicate on `ts` would sit outside that prefix and scan the workspace's
  whole history.
- It covers tag traffic only (`site_id IS NOT NULL`). A server-side SDK event
  is not a visit, and counting one would inflate every figure here.

Bounces count as zero duration rather than being dropped — excluding them would
flatter the average by roughly 2×. The admin shows the block only when there is
tag traffic to compute it from: four confident zeros about something never
measured is worse than an absent card.

### Realtime

`GET /api/admin/analytics/realtime?siteId=` — the last 30 minutes, bucketed by
minute and zero-filled, with the top paths, referrers and countries inside that
window.

It is deliberately **not** built on the `hour` column. Hourly buckets are the
wrong grain for a 30-minute view, and materializing `hour` existed to dodge
date functions over *long* ranges; here the range is short and bounded, so one
narrow query plus JS bucketing is cheaper and needs no dialect branch at all.

Buckets are anchored to a whole minute, so two polls seconds apart return the
same boundaries rather than a chart that shimmers on every refresh. The read is
capped at 5,000 rows; when that cap bites, `truncated` is `true` and every
count below it is a floor rather than a total — the admin says so out loud
rather than under-reporting silently. The admin's **Live** toggle polls every
10 seconds (not the 5 that Logs and Traces use — each poll scans a 30-minute
window, and every open tab pays for it).

### Funnels

`POST /api/admin/analytics/funnel` with 2–8 event names. A visitor counts at
step N only if they fired it **strictly after** their first step N−1 **and**
within `windowDays` of their **own** step-1 time — the standard "converted
within X days of entering" definition, not a fixed calendar window.

```bash
backlex analytics funnel --steps page_view,signup,purchase --window 7
```

> Ordering is strict, so two events that share a millisecond aren't ordered
> relative to each other and won't convert. Separate `track()` calls get
> distinct timestamps for free; only a single `trackBatch()` with no explicit
> `ts` can collide — pass `ts` if you batch a sequence.

### Retention

`POST /api/admin/analytics/retention` groups visitors into daily cohorts by
their **first-ever** active day — computed over their whole history, not just
the selected window, so a long-standing user who happened to return this week
isn't miscounted as new. `values[n]` is how many of that cohort were active n
days later. Offsets cap at 30 days. Pass `event` to define "active" as one
specific event rather than any.

The admin grid leaves cells blank when their calendar day hasn't arrived yet —
an unreached cell is *not measured*, which is a different claim from 0%.

## Dashboards

`analytics` is a [BI panel](/docs/embedded-dashboards/) kind, so any of these
metrics can be dropped onto a dashboard and published to a public embed:

```json
{ "kind": "analytics", "viz": "line", "config": { "metric": "series", "rangeDays": 30 } }
```

Metrics: `totals`, `series`, `top-events`, `top-paths`, `top-referrers`,
`sources`, `top-countries`, `top-devices`, `top-campaigns`, `sessions`,
`channels`, `revenue`, `realtime` (which ignores `rangeDays` — "the last 30
minutes" is the metric, not a window), `funnel` (with `steps` + `windowDays`),
and `retention` (with an optional `event`).

A panel may also carry `siteId` and `segmentId`. The segment is resolved
through the same tenant-scoped lookup every other caller uses, so a panel
cannot borrow another workspace's filter — and because a segment only ever
*narrows* a result, it adds nothing to the public-embed disclosure surface that
the note above describes.

All of this is now reachable from **Insights → New panel → analytics**. It was
API-only before: the server had supported the `analytics` panel kind since
before this feature, but the admin editor never offered it, so every metric was
invisible to anyone not writing HTTP by hand. `analytics-parity-meta.test.ts`
keeps the server's metric list and the editor's dropdown from drifting apart
again. Unlike `items-aggregate` panels there is no per-role clamp to apply on
an embed — the stream has no row-level owner, only counts — so analytics panels
are treated like `sql` panels: admin-authored, and public only because an admin
explicitly enabled the embed.

## Retention (data lifecycle)

Both streams are pruned by the daily cron sweep:

| Env var | Default | What it drops |
|---|---|---|
| `ANALYTICS_RETENTION_DAYS` | 90 | Tracked events older than N days. |
| `ANALYTICS_SALT` | `AUTH_SECRET` | Secret the cookieless visitor hash derives from. Rotating it resets every visitor identity. |
| `ERRORS_RETENTION_DAYS` | 90 | Error *occurrences* older than N days. A group is only dropped once it has no occurrences left **and** hasn't been seen since the cutoff — an active bug keeps its full counter. |

## Surfaces

Mirrors the multi-surface parity rule (REST + SDK + GraphQL + MCP + CLI). The
parity gate is `apps/web/tests/analytics-surfaces.test.ts`; the Postgres twin of
the funnel/retention SQL is pinned in `apps/web/tests/analytics-pg.test.ts`.

### REST

Ingest (publishable key / API key / session): `POST /api/analytics/events`,
`POST /api/analytics/errors`.

Public web tag (no auth; the site id is the only parameter):
`POST /api/analytics/collect`, `GET /api/analytics/script.js`.

Admin (`/api/admin/analytics`, admin-only): `GET|POST /segments`,
`PATCH|DELETE /segments/{id}`, `GET /revenue`, `GET /channels`, `GET /sessions`, `GET /realtime`, `GET|POST /sites`,
`PATCH|DELETE /sites/{id}`, `GET /overview`,
`GET /event-names`, `POST /funnel`, `POST /retention`, `GET /events`,
`GET /errors`, `GET /errors/{id}`, `PATCH /errors/{id}`, `DELETE /errors/{id}`,
`GET|POST|DELETE /ingest-key`.

### SDK

```ts
client.analytics.track(name, props?, extra?);
client.analytics.trackBatch(events);
client.analytics.trackError(err, extra?);
client.analytics.captureErrors({ release });
client.analytics.identify(distinctId, { userId });

await client.analytics.overview({ from, to });
await client.analytics.funnel({ steps: ["a", "b"], windowDays: 7 });
await client.analytics.retention({ event: "page_view" });
await client.analytics.realtime();
await client.analytics.sessions({ siteId });
await client.analytics.channels({ siteId });
await client.analytics.revenue({ siteId, segmentId });
await client.analytics.segments.create({ name: "Germany", definition });
await client.analytics.errors.list({ status: "open" });
await client.analytics.errors.update(id, { status: "resolved" });
await client.analytics.ingestKey.mint();

await client.analytics.sites.list();
await client.analytics.sites.create({ name: "Marketing", domain: "example.com" });
await client.analytics.sites.update(id, { filterBots: false });
await client.analytics.sites.delete(id);
```

### GraphQL

Queries `analyticsSegments`, `analyticsRevenue`, `analyticsChannels`, `analyticsSessions`, `analyticsRealtime`, `analyticsSites`, `analyticsOverview`, `analyticsEventNames`, `analyticsFunnel`,
`analyticsRetention`, `analyticsEvents`, `errorGroups`, `errorGroup`.
Mutations `trackEvents`, `trackErrors`, `updateErrorGroup`, `deleteErrorGroup`,
`createAnalyticsSite`, `updateAnalyticsSite`, `deleteAnalyticsSite`,
`createAnalyticsSegment`, `updateAnalyticsSegment`, `deleteAnalyticsSegment`.
Ingest is admin-gated on this surface — the publishable-key path is REST-only,
since that's what client bundles use.

### MCP

`analytics.segments`, `analytics.segment_save`, `analytics.segment_delete`,
`analytics.revenue`, `analytics.channels`, `analytics.sessions`, `analytics.realtime`, `analytics.sites`, `analytics.site_create`, `analytics.site_update`,
`analytics.site_delete`, `analytics.overview`, `analytics.event_names`, `analytics.funnel`,
`analytics.retention`, `analytics.events`, `errors.list`, `errors.get`,
`errors.update`, `errors.delete`. The reporting verbs are classified `read`, so
they stay available to read-only API keys.

### CLI

```bash
backlex analytics overview --days 30
backlex analytics funnel --steps page_view,signup,purchase --window 7
backlex analytics retention --event page_view
backlex analytics errors --status open
backlex analytics error <id>
backlex analytics resolve <id> | ignore <id> | reopen <id>
backlex analytics track deploy_finished --props '{"version":"1.4.0"}'
backlex analytics report-error --message "nightly job failed" --type CronError
backlex analytics ingest-key mint
backlex analytics realtime
backlex analytics sessions --days 30
backlex analytics channels --days 30
backlex analytics revenue --days 30
backlex analytics segments
backlex analytics overview --segment <id>
backlex analytics sites
backlex analytics sites add --name "Marketing" --domain example.com
backlex analytics sites rm <id>
```

`track` and `report-error` exist so a CI job or shell script can mark a deploy
or a failed batch without pulling in the SDK.

## Admin UI

**Observability → Analytics**, five tabs over one shared time window:
Overview (counters, daily chart, top-N), Realtime (the last 30 minutes, with a
Live toggle), Funnel (a step builder that only offers event names you've
actually tracked), Retention (the cohort grid), and Errors (crash groups +
triage, with the stack trace and affected-visitor count in the detail dialog).

Registering a website is **not** here — it is **Website → Websites**, its own
page, because the tag manager and the cookie banner attach to the same registry
and neither is a measurement feature. Analytics stays under Observability
because the stream it reports over is not site-scoped: `analytics_events.site_id`
is nullable for SDK and server-side traffic.

## Implementation notes

- Funnel and retention are parameterized CTE chains — one round-trip regardless
  of cohort size. The only dialect branch is timestamp shape: Postgres binds
  `Date` against `timestamptz` and adds the window as an `interval`; SQLite
  binds epoch milliseconds and adds integers.
- `analytics_events.day` is a denormalized `YYYY-MM-DD` column so cohort
  grouping never needs date functions, which have no portable spelling across
  Postgres / SQLite / D1. Same trick as `usage_counters.day`.
- Batch inserts are chunked to ~90 bound parameters per statement. D1 caps a
  statement at ~100, so an unchunked 500-event insert fails outright with
  `too many SQL variables`. Same budget and reasoning as
  `services/migrate-ingest.ts`.
- `error_groups.id` is derived deterministically from
  `(tenantId, fingerprint)`, which lets ingest upsert with a single atomic
  `ON CONFLICT (id)` — no check-then-insert race, and no reliance on a unique
  index over a nullable `tenant_id` (SQLite treats NULLs as distinct there, so
  such an index would not dedupe the default workspace).
