---
title: Distributed tracing
description: W3C traceparent propagation across SDK → API → functions, a span per request, and the admin Traces panel + CLI.
---

backlex propagates a [W3C Trace Context](https://www.w3.org/TR/trace-context/)
(`traceparent`) header across every hop of a request — SDK → API → functions —
and records a span per request so you can see one logical operation stitched
together in the admin **Traces** panel.

## What you get

- **One `traceId` per operation.** The SDK stamps a `traceparent` on every
  call. The API continues that trace (a fresh child span id, the caller's span
  as parent) and re-advertises it on the `traceparent` response header. A
  function's outbound `fetch()` re-emits the header, so a call that loops back
  into the API shows up as a *multi-span* trace under the same id.
- **A span per request**, persisted to the `spans` table — `traceId`, `spanId`,
  `parentSpanId`, name (`METHOD /path`), status, duration, tenant, user.
- **An admin Traces panel** (Observability → Traces) — recent traces newest
  first, filter by path / errors-only, click a row for the span waterfall.
- **A CLI** — `backlex traces list` and `backlex traces get <traceId>`.

## The header

```
traceparent: 00-<32-hex trace id>-<16-hex span id>-<8-bit flags>
00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01
```

- **version** `00`.
- **trace id** — shared by every span in the operation.
- **span id** — the current request's span.
- **flags** — `01` = sampled.

An inbound `traceparent` is *continued* (same trace id, the request becomes a
child span). A missing/malformed header starts a fresh trace (per spec).

## SDK

Tracing is **on by default** — every request carries a freshly-started
`traceparent`:

```ts
import { createClient } from "backlex";
const client = createClient({ url: "https://api.your.app", apiKey });
await client.from("posts").list(); // sends traceparent: 00-…-…-01
```

Control it via the `tracing` option:

```ts
// Off entirely:
createClient({ url, tracing: false });

// Continue an existing trace (e.g. one already active in the browser). Return a
// traceparent to continue it, or undefined to start a fresh one for that call:
createClient({ url, tracing: () => window.__traceparent });
```

The current span is also re-exported for advanced use: `makeTraceparent`,
`newTraceId`, `newSpanId`.

## Functions

A function's `ctx.fetch()` (the sandbox's allow-listed outbound fetch)
automatically carries the invoking request's `traceparent` — unless the function
set its own. A function that calls back into the backlex API therefore continues
the same trace, and both spans appear in the one waterfall.

## Admin API

Admin-only (the panel + CLI use these):

- `GET /api/admin/traces?path=&minStatus=&from=&limit=` — recent traces
  (summaries: name, root status, span count, duration, started-at, hasError).
- `GET /api/admin/traces/{traceId}` — every span of one trace, earliest-first.

## CLI

```bash
backlex traces list                 # recent traces
backlex traces list --min-status 400 --path /api/items
backlex traces get <traceId>        # the span waterfall
```

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `TRACES_SAMPLE_RATE` | `1` | Fraction (`0`..`1`) of requests whose span is persisted. Lower it on very high-traffic instances. The span write is non-blocking, so full sampling is the sensible default. |
| `TRACES_RETENTION_DAYS` | `7` | Days to keep span rows before the daily `cronTick` prunes them. `0` disables pruning. |

Span writes never block or fail a request — telemetry must not break the call
that produced it. On Cloudflare Workers the write is registered with
`waitUntil`; elsewhere it's fire-and-forget.

> **Note.** This is in-app tracing for the admin panel — there is currently no
> exporter to an external OpenTelemetry collector (OTLP). The wire format is
> standard `traceparent`, so adding an OTLP/HTTP exporter later is additive.
