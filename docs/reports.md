---
title: Scheduled reports
description: Print a dashboard to a PDF and mail it — on demand from the admin, or on a schedule from a cron flow. Reuses the Insights panels, the PDF renderer and the email transport; reachable over REST, the SDK, GraphQL, MCP, and the CLI.
---

# Scheduled reports

A dashboard already answers "what happened this month?" — but only for someone
who opens the admin and looks. A **report** is that same dashboard as a static
PDF: rendered on demand from the Insights page, or mailed on a schedule by a
`cron` flow.

Nothing here is a new subsystem. The panels come from
[Embedded BI dashboards](/docs/embedded-dashboards), the PDF from the renderer
in [Document generation](/docs/documents), and the mail from the transport in
[API keys & email](/docs/api-keys-and-email). This feature is the join.

## The one-op version

The whole scheduled-report use case is a flow with a `cron` trigger and one
`report.deliver` op:

```json
{
  "name": "Monthly revenue to the accountant",
  "trigger": "cron:0 8 1 * *",
  "operations": [
    {
      "type": "report.deliver",
      "dashboardId": "b1c2…",
      "to": "accounting@example.com",
      "subject": "Revenue — {{ $now.month }}"
    }
  ]
}
```

In the admin, that is the **Deliver report** step in the flow builder: pick a
dashboard from the list, type the recipients, done.

## What the PDF contains

Every panel in the dashboard, in its saved order, drawn the way the Insights
page draws it:

| Panel viz | In the PDF |
|---|---|
| `counter` | the number, large |
| `bars`, `stacked-bars` | grouped / stacked bars with a value axis |
| `line`, `area`, `sparkline` | a line, with each series labelled at its end |
| `pie`, `donut` | a ring with labels, values and percentages |
| `radial` | horizontal bars — the same comparison, easier to read on paper |
| `radar`, `table`, anything else | the rows as a table |

The charts are **hand-written inline SVG**, not recharts. The renderer is a
real browser, so it *could* run a chart library — but then the print snapshot
would race the script that draws the chart. A chart that is already drawn when
the HTML arrives cannot lose that race. The consequence worth knowing: the
document is entirely self-contained. No script, no external stylesheet, no
font, no image, nothing to fetch.

Two things are printed rather than hidden:

- **A panel that failed** prints its error in a red box. Dropping it would make
  a month with a broken revenue query look like a month with no revenue.
- **A truncated table** says so — at most 20 rows and 8 columns, with a
  footnote naming what was left out.

`{{ … }}` inside row data survives verbatim. This matters more here than it
looks: document templates are themselves stored in collections, so a cell
containing `{{ total }}` is ordinary content, and interpolating the report page
would silently replace it with nothing.

## Where the file goes

Under `documents/<tenant>/<uuid>/<name>.pdf` — the same prefix a
`document.render` op writes to. That is deliberate: an `email` op refuses to
attach any key outside the running workspace's document prefix, and that check
is what stops a flow mailing out another tenant's contract. Sharing the prefix
means a report is attachable by the same guard rather than needing a second one.

The key is random, never derived from the filename. A filename comes from the
dashboard's name, and deriving the object path from it would let that name
decide where the object lands.

So a flow that wants to write its own covering message just omits `to`:

```json
[
  { "type": "report.deliver", "dashboardId": "b1c2…" },
  {
    "type": "email",
    "to": "team@example.com",
    "subject": "This week",
    "html": "<p>Numbers attached. Ask me anything.</p>",
    "attach": ["{{ $last.key }}"]
  }
]
```

## Identity, and what a report may read

The dashboard runs with the **caller's** identity — the admin who pressed the
button, or the flow's user. A report is not an embed: there is no anonymous
path into it, and no token that opens one. A panel reading a collection that
identity cannot read comes back as an error printed on the page, not as data.

Recipients are capped at **25 per report**, and each gets their own message
rather than all appearing in one `To:` header. A flow that resolved recipients
from a row would otherwise be a bulk sender with the workspace's own numbers as
the payload.

## Requirements

A **PDF renderer must be configured** — `PDF_CF_ACCOUNT_ID` +
`PDF_CF_API_TOKEN`, or `PDF_GOTENBERG_URL`. Without one, every surface refuses
with `422` and says so. There is deliberately no bundled fallback renderer; see
[Document generation](/docs/documents) for why.

On managed cloud the email gateway cannot carry attachments. The covering mail
still goes, and the response carries `attachmentsDropped: true` so the caller
can say the report did not travel with it.

## Surfaces

| Surface | Call |
|---|---|
| REST | `POST /api/admin/dashboards/{id}/report` |
| SDK | `client.dashboards.report(id, input)` / `.reportPdf(id, input)` |
| GraphQL | `mutation { deliverDashboardReport(id, input) { … } }` |
| MCP | `dashboards.report` |
| CLI | `backlex dashboards report <id> [--to …] [--out file.pdf]` |
| Flows | the `report.deliver` op |

Request body (all optional):

```jsonc
{
  "filename": "revenue-august",          // default: <dashboard>-<date>.pdf
  "pageOptions": { "format": "A4", "landscape": false },
  "email": { "to": "a@x.com, b@x.com", "subject": "…", "templateKey": "…" },
  "download": true                       // answer PDF bytes instead of metadata
}
```

`download` and `email` are mutually exclusive — a request that asked for both
has one of the two intents wrong, so it is refused rather than guessed at.

The response:

```jsonc
{
  "key": "documents/<tenant>/<uuid>/revenue-august.pdf",
  "filename": "revenue-august.pdf",
  "size": 148213,
  "renderer": "cf-browser-rendering",
  "dashboard": { "id": "b1c2…", "name": "Revenue" },
  "panels": 7,
  "failedPanels": 0,
  "sentTo": ["a@x.com", "b@x.com"]
}
```

## Where the code lives

- `packages/core/src/report.ts` — `buildReportHtml`, pure. No DB, no fetch, no
  clock: the caller passes the rows and the timestamp, so one input is one
  fixed string and the layout is unit-testable without a browser.
- `packages/core/src/panels.ts` — the row → series detection, shared with the
  admin's chart renderer so the PDF and the screen agree on which column is the
  label.
- `apps/web/src/server/services/reports.ts` — `deliverReport`: run, build,
  render, store, mail. Every surface calls this one function.
- `apps/web/tests/report-delivery.test.ts`,
  `apps/web/tests/reports-surfaces.test.ts` — the behaviour and the parity gate.
