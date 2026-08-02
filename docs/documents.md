---
title: Document generation
description: Render a row into a PDF from a stored HTML template — contracts, quotes, invoices, agreements — and email it, all from a flow.
---

Fourteen of the twenty-six schema templates carry documents: `contracts`,
`agreements`, `quotes`, `invoices`, `offers`. backlex could hold the data for
one and never produce the artefact somebody signs or pays. **Document
generation** closes that: a stored HTML template plus a row becomes a PDF.

The usual shape is two flow ops:

```json
[
  { "type": "document.render", "templateKey": "invoice", "filename": "invoice-{{ data.no }}" },
  {
    "type": "email",
    "to": "{{ data.email }}",
    "subject": "Invoice {{ data.no }}",
    "text": "Your invoice is attached.",
    "attach": ["{{ $last.key }}"]
  }
]
```

## Configuring a renderer

**There is no renderer out of the box, on purpose.** An unconfigured deployment
refuses to render and says which variables to set.

That is a deliberate choice against the obvious alternative — bundling a
pure-JS PDF library. The PDF standard-14 fonts are WinAnsi, which has no `ş`,
`ğ`, `ı` or `İ`. A fallback that silently drops a customer's name from a
contract is worse than one that is honestly absent. Embedding a Unicode font
would fix the glyphs and still leave tables, page breaks and running headers to
hand-roll, which is a browser's job.

So both backends drive a real browser:

| Provider | Set | Notes |
|---|---|---|
| **Cloudflare Browser Rendering** | `PDF_CF_ACCOUNT_ID`, `PDF_CF_API_TOKEN` | Over the REST API, not the Worker binding — so it works from **all four runtimes**, not just Workers. The token needs the *Browser Rendering — Edit* scope. |
| **Gotenberg** | `PDF_GOTENBERG_URL` (+ optional `PDF_GOTENBERG_USER` / `PDF_GOTENBERG_PASS`) | Chromium behind HTTP, Apache-2.0, one container. The answer for a deployment that will not send its contracts to a third party. |

`PDF_PROVIDER` pins one (`cf-browser` or `gotenberg`). A pinned provider whose
credentials are missing yields **no renderer**, rather than quietly falling
through to the other one — an operator who named a provider wants that provider,
and a silent substitution is how a contract renders somewhere they did not
intend.

## Row data is interpolated as HTML

A template's body is HTML and `{{ … }}` values are substituted into it
**unescaped**, exactly like an email template's body. On most of the schema
templates a row is filled in by an end user — a form submission, a customer
portal — so treat row values as untrusted markup when you write a template.

Two things reduce what that can do:

- **JavaScript is off** in the Cloudflare renderer. Nothing needs it to lay out
  an invoice, and leaving it on would let a value in a row run code inside the
  renderer.
- **Gotenberg runs on your network, Cloudflare's does not.** That is the
  material difference between the two backends: a hostile `<img src="…">` in a
  row is fetched by whichever browser renders it. Give the Gotenberg container
  no route to anything internal you would not expose anyway.

## Templates

A template is a **complete HTML document**, not a fragment. backlex does not
wrap it: a contract sets its own fonts, page size and print styles, and a
wrapper would fight that.

```bash
curl -X PUT "$APP_URL/api/admin/documents/templates/invoice" \
  -H 'content-type: application/json' \
  -d '{
    "name": "Invoice",
    "bodyHtml": "<html><head><meta charset=\"utf-8\"><style>@page{size:A4}</style></head><body><h1>Fatura {{ data.no }}</h1><p>{{ data.customer }}</p></body></html>",
    "footerHtml": "<span style=\"font-size:9px\">Sayfa <span class=\"pageNumber\"></span> / <span class=\"totalPages\"></span></span>",
    "pageOptions": { "format": "A4", "margin": "20mm" },
    "filename": "fatura-{{ data.no }}"
  }'
```

Everything is interpolated with the same `{{ … }}` engine as email templates —
body, running header, running footer and filename alike.

| Field | Notes |
|---|---|
| `bodyHtml` | Required on create. A whole document. |
| `headerHtml` / `footerHtml` | Running header/footer, drawn on every page. Chromium's `pageNumber` / `totalPages` spans work. |
| `pageOptions` | `format` (A4 default), `landscape`, `margin`, `printBackground`. |
| `filename` | Suggested output name, templated. `.pdf` is appended if missing. |

**Backgrounds print by default.** Every browser's print path turns them off,
which is why an invoice with a coloured header renders as a white rectangle;
someone who wrote a background into a template meant it. Set
`printBackground: false` to opt out.

### Workspace overrides

Templates resolve exactly like `email_templates`: a **workspace row overrides an
instance-wide default with the same key**, and the list shows one row per key
rather than both. Editing an inherited default from inside a workspace creates
the override — it never changes what other workspaces render. Deleting removes
only the workspace's own row; an inherited default returns a 404 rather than
silently doing nothing.

## Rendering

```bash
curl -X POST "$APP_URL/api/admin/documents/render" \
  -H 'content-type: application/json' \
  -d '{"templateKey":"invoice","vars":{"data":{"no":"2026-114","customer":"Ayşe Yılmaz"}}}' \
  -o invoice.pdf
```

Returns the PDF bytes. `html` may be sent instead of `templateKey` for a
one-off — exactly one of the two, never both.

A render past **20 MB** is refused rather than stored: a generated contract is
tens of kilobytes, so anything near that is a runaway template (an unbounded
loop over a relation), not a long document.

## The `document.render` flow op

Renders and puts the result in storage. The outcome lands on `{{ $last }}` as
`{ key, filename, size, renderer }`.

| Field | |
|---|---|
| `templateKey` \| `html` | Exactly one. Neither renders nothing; both would let the inline body silently beat the stored template. |
| `vars` | Extra values on top of `data` / `$user` / `$last`. |
| `filename` | Overrides the template's, templated. |
| `writeBack` | `{ collection, id, field }` — stores the key on a row, so the document is reachable from the record it describes. |

**The storage key is random, not derived from the filename.** Two invoices both
called `invoice.pdf` would otherwise overwrite each other — and a filename comes
from row data, so deriving the object path from it would let whoever filled in
the row choose where the object lands.

## Attaching it to an email

The `email` op's `attach` takes **storage keys**, templated:

```json
{ "type": "email", "to": "{{ data.email }}", "subject": "…", "text": "…",
  "attach": ["{{ $last.key }}"] }
```

Two limits, and both are enforcement rather than convention:

- **Keys only, never a URL.** A URL would turn the mail path into a fetcher that
  posts whatever it was pointed at to an address the same flow chose — request
  forgery with the email as the exfiltration channel.
- **Only this workspace's own generated documents.** Storage is one namespace
  across every tenant, so the prefix alone would let a flow in one workspace
  mail out another's contract given its key — and a key can travel in through
  the row a flow reads. The check is scoped to the running workspace.

Five files per message. See [Flows](/flows/) for the calendar-invite sibling,
`ics`.

## Getting it signed

A document somebody has to sign goes out through
[E-signature](/e-signature/) instead — `document.sign` freezes this same
interpolated HTML, mints a public link per signer, and re-renders the whole
thing with the signatures and a certificate once they are all in.

## Surfaces

Admin-only throughout — a template is interpolated and handed to a browser, so
authoring one is the same trust level as authoring a flow, not a content-editor
permission. Every surface funnels through one service, so the workspace-override
rule and the no-renderer refusal hold identically on all of them.

| Surface | |
|---|---|
| **REST** | `GET/PUT/DELETE /api/admin/documents/templates[/:key]`, `POST /api/admin/documents/render` (returns the PDF) |
| **SDK** | `client.documents.list / save / delete / render` — `render` resolves to `Uint8Array` |
| **GraphQL** | `documentTemplates`, `saveDocumentTemplate`, `deleteDocumentTemplate`, `renderDocument` (base64, since GraphQL has no byte type) |
| **MCP** | `documents.templates_list / _save / _delete`, `documents.render` |
| **CLI** | `backlex documents <list\|save\|delete\|render>` |
| **Admin** | *Document templates* under Settings — editor, live HTML preview, and a **Render PDF** button that produces the real thing |

`documents.render` over MCP returns the metadata and a byte count, **not** the
bytes: base64 in a tool result fills an agent's context window for no benefit.
Use the flow op or the SDK when the file has to go somewhere.

The admin preview is an **approximation** — page breaks, running headers and
margins exist only in the renderer, so *Render PDF* is what tells you whether a
template actually works.
