---
title: E-signature
description: Send a generated document out to be signed — a public link per signer, a drawn or typed signature, and a re-rendered PDF carrying the signatures and a certificate.
---

[Document generation](/documents/) turns a row into a PDF. For five of the
schema templates that PDF is only halfway: rental `agreements`, field-service
and fleet `contracts`, real-estate `offers` and legal `documents` all end in
somebody signing. **E-signature** is the rest of it — and it is native, so
neither you nor your customers need a DocuSign account.

The usual shape is one flow op:

```json
{
  "type": "document.sign",
  "templateKey": "lease",
  "title": "Lease {{ data.no }}",
  "signers": [
    { "email": "{{ data.tenant_email }}", "name": "{{ data.tenant }}", "role": "Tenant" },
    { "email": "office@example.com", "name": "Acme Property", "role": "Landlord" }
  ],
  "ordered": true,
  "writeBack": { "collection": "leases", "id": "{{ data.id }}", "field": "signed_doc" }
}
```

Each signer gets an email with a link to `/sign/<token>`. They read the
document, draw or type a signature, and agree to sign electronically. When the
last one is in, backlex re-renders the document with the signatures and a
certificate page appended, stores it, writes its key onto the row, and emails
everyone a copy.

## What is signed is what was sent

The interpolated HTML is **snapshot onto the request when it is sent**. It is
never re-derived from the template and the row afterwards.

That is the property everything else rests on. Re-deriving would mean a
corrected price, a renamed customer or an edited template silently changes the
document under somebody who already read it — and a document that changes
after it is read is not a document anybody can sign. The snapshot also makes
the signed PDF reproducible after the row is deleted and the template rewritten.

`documentHash` is SHA-256 of that snapshot — the **source**, not the PDF bytes.
Two renders of one document are not byte-identical across renderer versions, so
a PDF hash would fail a re-verification that is perfectly fine. The hash appears
on the signing page, on the certificate and on the API.

A renderer is required to **create** a request, not just to complete one. An
unconfigured deployment refuses at the point the operator is still looking at
the form, rather than after a signer has read the contract and drawn their name.
See [Document generation](/documents/) for `PDF_PROVIDER` and friends.

## The link is the whole grant

There are no accounts on the signer's side. `/sign/<token>` is public and the
token is the entire authorisation, exactly like a [form](/forms/) token or a
share link — so only its SHA-256 is stored. The plaintext appears in the
invitation email and on the create response, once. Nothing can reproduce it.

That is also why two operations mint a **new** token rather than re-sending the
old one:

| | |
|---|---|
| **Resend** | The link went to the wrong address, or leaked into a forwarded thread. A resend that left the previous link live would fix neither. |
| **Void** | Cancelling replaces every outstanding token, so links already delivered stop resolving — rather than relying on each read path to check a status. |

The signer's page never shows the other signers' addresses. A counterparty's
email is not this signer's to read just because they share a contract.

## Signing

A signature is **drawn** on a canvas or **typed**. The drawn one arrives as a
`data:image/png;base64,…` and is parsed rather than trusted — PNG only, base64
only, magic-number checked, size-capped — because it ends up interpolated into
HTML a headless browser is asked to render. An `svg+xml` can carry script; a
payload with a quote in it could close the `src` attribute. Both are refused at
the door.

The consent wording is **server-owned**. The page displays exactly the string
the API sends and the certificate quotes exactly that string. If the browser
supplied it, the person being held to the signature would be the one choosing
what the evidence says they agreed to.

It is localised, and that does not weaken the above: the page says which
language it is painting in (`?lang=`, else `Accept-Language`), the server
chooses the sentence, and the sentence it chose is what gets stored. Somebody
signing a Turkish lease is entitled to agree to something they can read — a
consent notice in a language the signer does not speak is weaker evidence than
one they do. Unknown tags fall back to English. The certificate lists every
distinct wording that was agreed to, so two signers shown different languages
are both represented.

Signing is one-shot. The transition is a conditional update confirmed by its
own result, so a double-tapped button or a retried request cannot produce two
signatures, two certificates or two completion emails.

Recorded per signer: the timestamp, the IP, the user agent, the consent text
and whether the mark was drawn or typed. All of it lands on the certificate
page.

**The IP is worth only as much as your runtime makes it worth.** On Cloudflare
it comes from `CF-Connecting-IP`, which the edge sets and a client cannot
forge. On Bun, Vercel and Netlify it falls back to the first `X-Forwarded-For`
hop — a header the signer's own browser can set — unless your proxy overwrites
it. Treat the timestamp, the consent and the document hash as the load-bearing
evidence; treat the IP as corroboration, and configure your proxy if you need
it to be more.

### Order

`ordered: true` means each link only opens once the one before it has signed —
and the next signer is emailed **on the transition**, not up front. Mailing
everybody at once would hand out links that answer "it is not your turn yet",
which reads as a broken link rather than as a queue.

Unordered is the default: everyone may sign whenever, and the request completes
when the last one does.

### Declining

One refusal ends the whole request. A contract two of three people signed is
not partially signed, and leaving it open would keep the remaining links live
against something nobody can complete.

## The signed document

The signed PDF is a **re-render of the snapshot** with a signature block and a
certificate page added — not a PDF edited after the fact. backlex has no PDF
manipulation library and does not want one; the renderer is a browser, and
composing HTML is what a browser is for.

The block goes just before `</body>` so the document's own styles still apply.
A template that wants to place it itself puts `<!--backlex:signatures-->`
where it should land — useful when a contract has a designated signature area
mid-document. Every value in it is escaped, including the operator's own labels:
a role typed into the admin is still arbitrary text arriving in a document a
browser executes.

Expiry is **derived** from `expiresAt`, never written. A stored `expired`
status would need something to run to become true, and a deployment whose cron
is wedged would keep handing out signable links. This way the passage of time
alone closes the request, on every surface at once. Default 30 days.

### When the renderer is down at the wrong moment

Signing commits the signature *before* the render, deliberately — a renderer
that is unreachable for those few seconds must not throw away a signature that
was validly given, and must not tell the person who just signed that it failed.
The request is left with every signature in and no artefact, and
`POST /api/admin/signatures/:id/finalize` produces the copy afterwards. It is
the one recovery path this feature has, and it exists because every signing
link is spent by then.

## Attaching, and where the file goes

The completed copy is emailed to everyone who signed plus any `notifyEmails`,
using the [`attachments` contract](/documents/) added for calendar invites. The
storage key is random rather than derived from the filename, for the same
reason it is in document generation: a filename comes from row data.

`writeBack` puts the signed document's key onto the row it describes, so the
contract is reachable from the record.

## The flow op

| Field | |
|---|---|
| `templateKey` \| `html` | Exactly one. |
| `title` / `message` | What the signer is told, and a note in the invitation. Templated. |
| `signers` | A list, or **one template that resolves to an array** — a lease with two tenants carries its own counterparties and cannot be written out statically. |
| `ordered` | Sequential signing. |
| `expiresInDays` | 1–365, default 30. |
| `writeBack` | `{ collection, id, field }` for the signed key. |
| `notifyEmails` | Extra recipients of the completed copy. |

`{{ $last }}` carries `{ id, status, sent, signers: [{ id, email, status }] }`
and **no signing links**. Everything on `$last` is readable by every op after
it — a `webhook` posting it onward, a `log` writing it to the server log — and
a link is a bearer credential for somebody else's signature. Customise the
invitation through the `signature_request` email template instead, which is the
right seam for it anyway.

Two email templates are used, both overridable per workspace like any other:

| Key | When |
|---|---|
| `signature_request` | The invitation. `{{ title }}`, `{{ message }}`, `{{ url }}`, `{{ signer.name }}`, `{{ expiresAt }}`. |
| `signature_completed` | Everyone has signed. `{{ title }}`, `{{ signers }}`, `{{ documentHash }}`. The signed PDF is attached. |

## Surfaces

Admin-only on the operator's side — sending a document commits the workspace to
something, and the body is interpolated HTML handed to a browser. The signer's
side needs no account at all.

| Surface | |
|---|---|
| **REST** | `GET/POST /api/admin/signatures`, `GET /api/admin/signatures/:id`, `.../document`, `.../void`, `.../finalize`, `.../signers/:signerId/resend` |
| **Public** | `GET /api/public/sign/:token`, `.../document`, `POST .../sign`, `.../decline` |
| **SDK** | `client.signatures.list / get / create / void / resend / finalize / document` |
| **GraphQL** | `signatureRequests`, `signatureRequest`, `createSignatureRequest`, `voidSignatureRequest`, `resendSignatureInvite`, `finalizeSignatureRequest` |
| **MCP** | `signatures.list / get / send / void / resend` |
| **CLI** | `backlex signatures <list\|get\|send\|void\|resend\|finalize\|download>` |
| **Admin** | *Signatures* under Settings — status per signer, resend, cancel, download the signed copy |

**MCP does not return the signing links, and has no signing tool.** A tool
result is transcript — summarised, forwarded, stored — and a link is a bearer
credential for somebody else's signature; the invitation has already gone out
by email. Signing itself is the *signer's* act, authenticated by a link token
and nothing else, so an agent holding an admin key signing on somebody's behalf
is precisely what the design refuses. The CLI is the one surface that does
print the links, because a terminal is the operator's own screen and
`--no-send` exists for exactly that.

## What this is not

It is not a qualified electronic signature (QES) under eIDAS, and it does not
claim to be. What it produces is an **advanced-ish** electronic signature: the
document is frozen and hashed, the signer is identified by control of an
emailed link, and intent plus consent are recorded with a timestamp, an IP and
a user agent. That is the same evidentiary shape as the mainstream e-signature
products, and it is enough for the agreements these schema templates model. A
signature requiring a certified identity check or a qualified certificate needs
a trust-service provider, which is a different integration.
