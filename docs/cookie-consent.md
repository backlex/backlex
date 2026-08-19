---
title: Cookie consent
description: The policy a site publishes to its visitors — which categories it asks about, what happens before they answer, and how backlex's own tag is classified.
---

A site registered for [web analytics](/analytics/) can also publish a **consent
policy**: what its visitors are asked, and what is withheld until they answer.

This page covers the policy — the configuration half. The banner that renders
it, the visitor's recorded decision, and the gating of third-party tags are
built on top of it and are documented separately as they land.

```bash
backlex consent set <siteId> \
  --undecided block \
  --tracker none \
  --categories analytics,marketing \
  --enabled
```

## Two decisions have no default, and the API refuses to invent one

`undecidedBehaviour` and `trackerCategory` are required the first time a policy
is saved. Not "recommended" — the column is `NOT NULL` with no `DEFAULT`, the
service rejects a first save that omits either, and every surface (REST, SDK,
GraphQL, MCP, CLI) refuses in the same terms.

That is deliberate, and it is the same reasoning [captcha](/api-keys-and-email/)
uses for its `onError` setting: when both answers are correct somewhere and
wrong somewhere else, a default is a position nobody chose, applied silently.

### `undecidedBehaviour` — before the visitor answers

| Value | What happens | Where it is right |
|---|---|---|
| `block` | Nothing optional fires until they decide | Required under GDPR / ePrivacy. Costs you measurement on every visitor who ignores the banner. |
| `allow` | Optional tags fire until they decline | The CCPA / CPRA opt-out model. **Not lawful in the EU.** |

One codebase serves both regimes because this is a per-site choice rather than a
build-time one.

### `trackerCategory` — backlex's own tag

backlex's [web analytics tag](/analytics/) is unusual among measurement scripts:
it stores **nothing** on the visitor's device — no cookie, no `localStorage`, no
`sessionStorage` — and its visitor id is derived on the server and rotates every
UTC midnight.

That matters legally, because ePrivacy Art. 5(3) is triggered by *storing or
accessing information on the visitor's terminal equipment*. A tag that does
neither is arguably outside it. This is the position Plausible and Fathom take.

It is also a **legal position, not a fact**, and it varies by member state. So
the choice is yours:

| Value | What happens |
|---|---|
| `none` | The tag counts as strictly necessary and measures everyone. |
| `analytics` | The tag waits for consent, like any other analytics tag. |

Either way, processing a visitor's IP still needs a lawful basis. `none` is a
claim that Art. 5(3) does not apply; it is not a claim that nothing is
processed.

## Categories

`categoriesOffered` is a **list**, not a switch:

- `functional` — remembers preferences, such as language or region
- `analytics` — aggregate understanding of which pages are used
- `marketing` — advertising relevance

A site running only a support widget should not be made to ask about advertising
it does not do, which is why this is a list and why an empty one is valid.

**`none` — strictly necessary — is never offered.** A site cannot run without
it, so presenting it as a choice implies one the visitor does not have.

These four values are the same list the tag manager files each tag under. They
are declared in both places rather than imported across the boundary, so a
workspace with no tags still has a working consent surface;
`consent-policy.test.ts` pins the literal values so a rename on either side
fails loudly instead of producing a category nothing gates on.

## The wording is server-owned

`wording` is stored on the policy and served from it. The page never supplies
it.

This is the principle [e-signature](/e-signature/) states for signature consent,
applied here: if the browser supplies the text, the person being held to the
record is the one choosing what the evidence says they agreed to.

`GET /api/admin/consent/wording/suggested` returns a starting point in English
and Turkish. It is a **suggestion, not a fallback** — nothing reads it at serve
time, and a policy saved with no wording renders the banner's own built-in
strings rather than a legal statement nobody reviewed.

## One policy per site

`site_id` is the primary key of `consent_policies`, not a unique column beside a
synthetic `id`. "Exactly one policy per site" is a real invariant, and putting it
in the key means a save is one atomic `ON CONFLICT (site_id) DO UPDATE` rather
than a check-then-insert that loses to a concurrent writer.

A later save may omit both postures; the stored choice is carried forward. An
admin fixing a typo in the banner copy is not re-deciding the site's compliance
posture, and if omission reset it, every wording edit would be a silent legal
change.

## What is recorded

Every operator change writes an `activity` row (`consent.update` /
`consent.delete`) carrying the posture, because *"who moved this site from
`block` to `allow`, and when"* is the first question asked after a complaint and
the current row cannot answer it.

A **visitor's** decision is not activity. It is evidence, it arrives from the
banner on the visitor's own device, and it is stored separately — see the
consent-records surface when it lands.

Deleting a policy stops the banner. It does **not** delete consent already
recorded: that goes through [erasure](/erasure/), never a side effect of
reconfiguring a site.

## Surfaces

| Surface | How |
|---|---|
| REST | `GET/PUT/DELETE /api/admin/consent/policies/{siteId}` |
| SDK | `client.consent.savePolicy(siteId, { … })` |
| GraphQL | `consentPolicies`, `consentPolicy`, `consentSavePolicy`, `consentDeletePolicy` |
| MCP | `consent.policies`, `consent.policy`, `consent.save_policy`, `consent.delete_policy` |
| CLI | `backlex consent <policies\|policy\|set\|rm\|wording>` |

All five call the same `services/consent`, so the refusal above is not five
implementations that can drift — it is one, reached five ways. That is what
`consent-surfaces.test.ts` exists to hold: a surface that quietly supplied its
own default would look correct in isolation and would have routed around the one
rule the feature is built on.

## What this does not do yet

Stated plainly, because a consent feature is a compliance claim and the failure
mode is an operator believing they are covered because a setting exists:

- **Nothing is rendered or blocked yet.** This ships the policy; the banner, the
  preference centre, the visitor records and the prior blocking of third-party
  tags are separate surfaces.
- **No automatic cookie scanning.** Enumerating the cookies a site actually sets
  needs a headless-browser crawler; you declare yours.
- **No IAB TCF.** The technical surface is plannable; the certification half —
  registering with IAB Europe, a CMP ID, passing their validator — is not
  something code can do for you.
