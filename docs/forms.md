---
title: Public forms
description: Embeddable, unauthenticated forms that write submissions into a collection — with honeypot/rate-limit/Turnstile spam protection and full REST/SDK/GraphQL/MCP/CLI parity.
---

Embeddable, unauthenticated forms that write submissions straight into a
collection. Build the form in the admin (**Data → Forms**), then share the
public link (`/f/<token>`) or drop the iframe snippet (`/embed/f/<token>`)
into any site. Submissions run the exact same write path as an authenticated
create — field validation, hashed fields, flows, webhooks, realtime events and
the audit trail all apply unchanged.

## How it works

- A form row stores the target collection, an **ordered subset of exposed
  fields** (with optional label/help overrides), display settings, and the
  SHA-256 hash of its public token (`frm_<hex>`, shown exactly once on
  create/rotate — same scheme as record share links).
- `GET /api/public/forms/:token` returns the render definition: exposed
  fields only, with type, label, required flag, dropdown choices and
  validation hints. Nothing else about the collection leaks.
- `POST /api/public/forms/:token/submit` writes through `performCreate` with a
  **null user** and the exposed field set as the permission clamp. Unknown or
  unexposed keys are silently dropped; the created row id is never returned to
  the submitter.
- On **versioned collections** submissions land as `draft` — an instant
  moderation queue: review in the admin, publish what you accept.

## Field eligibility (v1)

Only scalar fields can be exposed: `text`, `longtext`, `integer`, `number`,
`boolean`, `timestamp` (dropdowns are `text` + choices). Excluded: relation /
file / hash / json / uuid, `private`, `computed`, `localized`, and
server-auto-filled (`onCreate`) fields. The fence is enforced at definition
time AND re-derived on every public read/submit, so a field that later becomes
ineligible silently disappears from the form instead of leaking.

## Spam protection

Three independent layers on submit:

1. **Honeypot** — the public page renders an invisible `website` input; a
   filled value fakes a success response and writes nothing.
2. **Per-form/IP rate limit** — 10 submissions/minute per (form, IP), separate
   from the global API limiter (Durable Object on Workers, in-process
   elsewhere).
3. **Cloudflare Turnstile** (opt-in per form) — set `TURNSTILE_SITE_KEY` +
   `TURNSTILE_SECRET_KEY` in the environment, then flip the form's Turnstile
   toggle. Verification is **fail-closed**: turnstile-enabled forms reject
   every submit when the secret is missing. The form pages' CSP allows the
   widget (`script-src`/`frame-src challenges.cloudflare.com`).

## Embedding

`/embed/f/<token>` serves a compact variant with `frame-ancestors *` (and no
`X-Frame-Options`), so it can be iframed from any origin — same mechanism as
dashboard embeds. `/f/*` and `/embed/*` are `run_worker_first` paths on
Cloudflare so the Worker (not Static Assets `_headers`) controls their CSP.

```html
<iframe src="https://your-app.example/embed/f/frm_…" width="100%" height="600" frameborder="0"></iframe>
```

## Token lifecycle

- **Create** → returns `{ token, url, embedUrl }` once. Only the hash is stored.
- **Rotate** (`POST /api/admin/forms/:id/rotate-token`) → old link dies
  immediately, new one-time token returned. Use when a link leaks.
- **Deactivate** (`active: false`) → both public endpoints 404 without
  deleting the form.
- **Delete** → the form definition is removed; submitted rows stay.

## Surfaces

Everything goes through one service (`services/forms.ts`):

| Surface | Entry |
|---|---|
| REST | `/api/admin/forms` (+ `/eligible-fields/:collection`, `/:id/rotate-token`), public `/api/public/forms/:token` |
| SDK | `client.forms.*` |
| GraphQL | `publicForms` / `publicForm`, `createPublicForm` / `updatePublicForm` / `deletePublicForm` / `rotatePublicFormToken` |
| MCP | `forms.*` (list, get, eligible_fields, create, update, rotate_token, delete) |
| CLI | `backlex forms <list\|get\|fields\|create\|update\|rotate-token\|delete>` |

Parity gate: `apps/web/tests/forms-surfaces.test.ts`; core behaviour:
`apps/web/tests/forms.test.ts`.

## Not in v1

- Relation / file-upload fields (public uploads are a separate security
  surface).
- Localized fields.
- Multi-step forms and per-form themes.
