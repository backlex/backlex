---
title: Cookie consent
description: The policy a site publishes to its visitors — which categories it asks about, what happens before they answer, and how backlex's own tag is classified.
---

A site registered for [web analytics](/analytics/) can also publish a **consent
policy**: what its visitors are asked, and what is withheld until they answer.

This page covers the policy, the artifact a decision points at, and
[the banner](#the-banner) that renders it. The tags it gates are configured next
door in the [tag manager](./tag-manager.md); both attach to a website you
register under **Website → Websites**.

In the admin it is **Website → Cookie consent**. It used to be a tab inside
Analytics, which put a compliance decision inside a reporting page and made the
site registry reachable only through one of its three consumers.

> **What the browser enforces today, and what it does not.** Per-category
> gating is live, and so is the banner: `undecidedBehaviour` is honoured before
> a visitor answers — see [The banner](#the-banner) below.
>
> `trackerCategory` is still **published but not consumed**. It ships in
> `GET /api/consent/config`, and the tag files itself under `analytics`
> regardless, so a site that chose `none` is gated anyway when a visitor
> declines analytics. Setting it records the posture you chose; the gating
> phase is what delivers it.

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

## Presets are a starting point, and they are not regional

Three named readings are offered — **GDPR / ePrivacy**, **CCPA / CPRA** and
**KVKK** — as combinations of settings that already exist:

| Preset | Before a decision | Our tag | GPC / DNT | Language |
|---|---|---|---|---|
| GDPR / ePrivacy | `block` | `analytics` | `tracker` | `en` |
| CCPA / CPRA | `allow` | `analytics` | `all` | `en` |
| KVKK | `block` | `analytics` | `tracker` | `tr` |

A preset is a **selector, not a posture**. Every value it names you could have
typed yourself; what it saves you is knowing which combination of three
independent fields your regulator implies.

**Nothing applies one for you.** There is no endpoint that writes a preset —
not in REST, the SDK, GraphQL, MCP or the CLI. Choosing one fills the form in
front of you, and you press Save; the refusal on a first save stays the only way
a posture is ever stored. That is deliberate: a preset that wrote to the row
would be the same acquiring-a-posture-by-omission the refusal exists to prevent,
wearing a friendlier name.

**They are named after regimes, and they are still not matched against your
visitors.** backlex will not pick a posture from an IP, and cannot:

- The file that delivers the banner is served `public, max-age=900` behind a
  memo keyed on `(site, origin)`. A body that varied by the caller's country
  would hand the **first** visitor's posture to everyone behind that cache —
  warmed by an American, a European gets tags fired before consent, on a page
  where a banner appeared.
- `Vary` cannot fix it. Every geo source that exists here — `request.cf.country`,
  `cf-ipcountry`, `x-vercel-ip-country`, `x-nf-geo` — is a header the **edge**
  injects after the browser has already sent its request. No cache can key on a
  header the client never sent.
- The evidence could not even show it happened: a consent record names the
  artifact by its hash, and both visitors would name the same one — graded
  `current`, the grade that means the evidence is sound.

Two more reasons worth knowing before you ask for it anyway: backlex sees a
visitor's **country and never their state**, so nothing can be scoped to
California, which is the only place CCPA applies; and on a self-hosted install
there is no geo header at all.

**One site, one policy, one posture.** If you need two, run two sites.

## If you already run another consent manager

You may not need any of the above. **If the consent manager you already run
emits Google Consent Mode v2, backlex already obeys it.** Nothing to paste, no
setting to turn on, no policy to create.

Check that first rather than assuming it: every major CMP supports Consent Mode
v2 and most enable it by default, because Google has required it since March
2024 of anyone serving EEA or UK traffic through its ad products — but it is a
setting in your CMP, and a setting can be off. Open your site with a console and
confirm `dataLayer` contains a `consent` entry before you rely on any of this.

That is not a feature that was built for this; it falls out of how the grant map
works. backlex seeds a grant map only when it is delivering its *own* banner. On
a site with no backlex policy the map starts empty, so the tag falls through to
reading the `dataLayer` your CMP already writes.

**What it covers:** backlex's own analytics tag, and every tag the tag manager
compiles — the whole vendor list, on the same signal.

| Your CMP sets | backlex reads it for |
|---|---|
| `ad_storage` | tags filed as **marketing** |
| `analytics_storage` | tags filed as **analytics**, and backlex's own tag |
| `functionality_storage` | tags filed as **functional** (falling back to `analytics_storage` when your CMP does not set it) |

**Only an explicit `denied` blocks.** A key your CMP never sets is not a refusal,
so prior blocking in this mode is delivered by *your* CMP's `default` call — the
inline `gtag('consent', 'default', {…: 'denied'})` that a conforming Consent Mode
install runs in the head before anything else. backlex honours that call; it
cannot substitute for one that is missing.

### Leave the backlex banner off, and this is the reason

Do not run both. A backlex policy with `enabled: true` compiles a **total** grant
map into the page — every category, always — and that map is consulted *before*
the `dataLayer`. So on a site running the backlex banner, your consent manager's
verdict is not read **in either direction**: it cannot grant a category backlex
has not been told about, and it cannot deny one backlex was told to allow.

That precedence is deliberate — a visitor's own recorded answer must outrank an
inference about them — but it means two managers on one page is not "belt and
braces". It is one manager, silently chosen for you.

### Two limits worth knowing before you rely on it

**A tag refused before the visitor accepted does not fire retroactively.** Tags
are gated at the instant their trigger raises. If a pageview tag was refused and
the visitor then presses Accept, that tag does not run for the page they are
standing on — the next navigation picks it up. This is the ordinary behaviour of
every tag manager, and it is stated here rather than discovered.

**backlex writes no consent record in this mode, and that is correct.** The
evidence half of this feature — the immutable artifact, the hash, the
`consent_records` row — describes a decision made through backlex's own banner
against a document backlex can produce. Your CMP's decision is yours to
evidence; backlex records nothing about it, sets no `blx_consent` cookie, and
sends `c: null` on the wire rather than claiming a consent it did not obtain.

All of the above is pinned by `apps/web/tests/consent-external-cmp.test.ts`,
which boots the real tag and the real container in a DOM and watches what
leaves. It exists because this behaviour was an accident of two unrelated
decisions before it was a promise, and an accident is one refactor away from
being gone.

## Global Privacy Control and Do Not Track

A third setting, `signalHandling`, decides how far those two browser signals
reach. **Unlike the two above it has a default**, because here one answer is
plainly safe:

| | |
|---|---|
| `tracker` | **The default.** The signals stop backlex's own tag and nothing else. Your other tags are governed by consent alone. |
| `all` | The signals additionally deny **every** optional category, so the tag manager refuses third-party tags too. This is the CCPA reading, where GPC is a legal opt-out rather than a preference. |
| `off` | Neither signal is read. |

**Why `all` is not the default, even though it is the stricter answer.** Every
tag you create is filed under `marketing` unless you say otherwise, so turning
this on globally would stop working pixels on every site at once, for visitors
whose operator never chose anything. A compliance feature that silently breaks
measurement teaches operators to switch it off, which is worse than asking.

**Ordering, when several things have an opinion.** An explicit decision — from
the banner, or from `backlex.consent()` — wins over the signals, because it is
your site speaking about *this* visitor rather than a browser-wide preference.
The signals in turn beat a stale `gtag` entry. And `off` turns the *signals*
off, not consent: a recorded refusal is still a refusal.

**How long a change takes to arrive.** Up to fifteen minutes, the same as any
tag change. The per-site file is served `public, max-age=900`, so a browser that
already has it does not ask again until that expires — measured in a real
browser, not assumed. When it does ask, it gets the new file: the setting is
folded into the file's ETag precisely so that a revalidation cannot be answered
`304` with the old switch still in it, which would make the staleness unbounded
rather than bounded.

`off` exists because Do Not Track is a standard the W3C retired and a header
some browsers set by default; Global Privacy Control is neither, and in
California it carries legal weight. Turning both off is a decision, so it is
spelled out rather than inferred from a missing attribute.

> The old `data-respect-dnt` attribute still works on the plain
> `/api/analytics/script.js` install, and only there. It cannot work on the tag
> manager's snippet at all: `document.currentScript` is `null` for a
> dynamically injected script, so there is no element to read an attribute
> from. That is why this is a policy field and not a second attribute.

## What the tracker is filed as, and what that now does

`trackerCategory` used to be recorded and published and read by nothing — the
tag filed itself under `analytics` regardless. It is now delivered to the
browser in the per-site file, so `none` really does mean "strictly necessary,
measures everyone".

The two settings are **orthogonal**. Filing the tag as `none` answers the
consent question; it does not answer the signal question. A site that wants to
measure through GPC has to say so with `signalHandling: "off"` as well.

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

## The artifact a decision points at

A recorded consent is only evidence if the thing it names cannot change
afterwards. If a record pointed at `consent_policies`, an operator editing the
wording next month would silently rewrite what every past visitor is held to
have agreed to.

So every save compiles the policy into an **artifact** — a canonical JSON
document of what a visitor is shown — hashes it with SHA-256, and archives it in
`consent_versions`. The hash is the identity: it is what the public config
endpoint serves as its `ETag`, and it is what a consent record will store.

### There is no publish step, and that is deliberate

The tag manager next door has drafts, a publish, a version number and a
rollback. Consent has none of them, because it has no draft: `consent_policies`
is one row per site and `enabled` is already the live switch. Adding a publish
step would create a state this feature should never have — *"I corrected the
wording but visitors are still being shown the old text"* — on the one surface
where stale copy is a legal problem rather than a cosmetic one.

The archive is therefore **content-addressed**, keyed on `(site_id, hash)`
rather than a counter:

- Saving the same content twice adds nothing. An empty patch, a form re-submit,
  or reverting to last week's wording all resolve to an artifact that already
  exists.
- There is no `max(version) + 1` to race on.
- History is a list of distinct artifacts, not a log of clicks. Use `activity`
  for who-changed-what-when; that is what it is for.

`consent_policies.artifact_hash` carries the current artifact's digest. It is
derived, not a pointer — it is recomputed from the row on every save and always
agrees with what is being served, so it can never disagree with `enabled` about
which policy is live.

### What is in the artifact, and what is not

Five fields of the policy row are deliberately excluded, because the artifact
describes *what a visitor agreed to* rather than *what the table holds*:

| Excluded | Why |
|---|---|
| `updatedAt` / `createdAt` | An empty save moves `updatedAt`. Including it would make the hash a clock reading, so every no-op save would mint an artifact and bust every visitor's cache. |
| `tenantId` | The artifact is served with `Access-Control-Allow-Origin: *` to every visitor of a customer's domain. A workspace id has no business travelling there. |
| `enabled` | Whether to show a banner is not something a visitor agreed to. It stays on the row and is read fresh on every request, so switching a banner off is instant and toggling it never mints an artifact. |
| `signalHandling` | Same argument, and a sharper consequence. The artifact is **recompiled and re-hashed on every read** rather than served from storage, so a field added here changes the hash of every policy the moment it deploys — archiving every recorded decision and re-asking every visitor about a change none of them was shown. It travels in the per-site container instead, which nothing hashes. |

That last row is why changing `signalHandling` does not appear in a site's
version history: nothing about the document a visitor was shown has changed.

Locale keys in `wording` are **sorted** before hashing. Without that, two
byte-identical policies saved with their locales in a different order hash
differently — and worse, the two dialects disagree with each other, because
Postgres `jsonb` re-sorts object keys by (length, bytes) while SQLite stores the
text as written. A consent record written against one database would then not
resolve against the other.

## The config endpoint

```
GET /api/consent/config?s=<siteId>
```

Public, uncredentialed, `Access-Control-Allow-Origin: *`, `Cache-Control:
public, max-age=300`, with an `ETag` that revalidates to a `304`. This is what a
banner running on the customer's own domain reads.

**The `ETag` is the artifact hash itself** — a strong validator, `"<64 hex>"` —
and it is named in `Access-Control-Expose-Headers` so cross-origin script can
actually read it. That is not a caching detail: the hash cannot travel in the
body, because the body is what is hashed, so this header is the only way a
banner learns which artifact it is showing. A recorded consent stores that value. It carries no session, and
the query behind it names its columns explicitly, so nothing the operator
configured about the *site* — ignored IPs, excluded paths, the site's internal
name — can reach it.

An unknown site id, a policy that is switched off, a site with no policy, and a
policy orphaned by a deleted site all answer **identically**:

```json
{"v":1,"enabled":false}
```

`200`, never `404`. Site ids are public — they ship in the `<script>` snippet —
so a status code that differed by whether an id exists would be an oracle for
enumerating them. A live artifact carries no `enabled` key at all, so the
banner's rule is `if (cfg.enabled === false) return;`.

Do not set `If-None-Match` by hand. It is not a CORS-safelisted request header,
so an author-set value triggers a preflight this route does not answer; the
`304` path works through the browser's own cache revalidation on a plain
`fetch`.

**One caching caveat, stated rather than hidden.** Behind the browser's
five-minute cache there is a per-isolate memo of up to a minute. Saving
invalidates the isolate that handled the save, so an operator's own next request
is correct — but on a distributed deploy another isolate may serve the previous
artifact briefly. An operator who edits wording and immediately reloads a second
tab may see the old copy for up to a minute.

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
recorded, and it no longer deletes the artifact archive either — a record points
at an artifact by hash, so removing the artifacts would leave every past record
naming a document nobody can produce. The policy row is configuration; the
archive and the records are evidence. Deleting the **site** takes all three,
because that removes the subject the evidence is about.

Recorded consent is removed through [erasure](/erasure/) with
`subject.type = "consent_id"`, or by the visitor themselves through the banner's
"forget me" control. An `email` or `app_user` erasure request will **not** reach
it: a consent record carries no address and no account, and the only handle is
the id in the visitor's own browser.

## Surfaces

| Surface | How |
|---|---|
| REST | `GET/PUT/DELETE /api/admin/consent/policies/{siteId}`, `GET …/{siteId}/versions`, `GET …/{siteId}/records`, `GET /api/admin/consent/postures/suggested` |
| SDK | `client.consent.savePolicy(siteId, { … })`, `client.consent.versions(siteId)`, `client.consent.records(siteId)`, `client.consent.suggestedPostures()` |
| GraphQL | `consentPolicies`, `consentPolicy`, `consentVersions`, `consentRecords`, `consentSavePolicy`, `consentDeletePolicy`, `consentSuggestedPostures` |
| MCP | `consent.policies`, `consent.policy`, `consent.versions`, `consent.records`, `consent.save_policy`, `consent.delete_policy`, `consent.suggested_postures` |
| CLI | `backlex consent <policies\|policy\|versions\|records\|set\|rm\|wording\|postures>` |

The two PUBLIC endpoints are deliberately absent from this table —
`GET /api/consent/config` and `POST`/`DELETE /api/consent/record`. They are
reached by a banner on a foreign origin with no credential, so an SDK method
would have to carry credentials the banner must not hold.

All five call the same `services/consent`, so the refusal above is not five
implementations that can drift — it is one, reached five ways. That is what
`consent-surfaces.test.ts` exists to hold: a surface that quietly supplied its
own default would look correct in isolation and would have routed around the one
rule the feature is built on.

## The banner

A site with an **enabled** policy gets a banner, and it arrives inside the file
the page already loads — `/api/site/<site-id>.js`, the same one that
carries the tracker and your tag container. There is nothing extra to install.

### Prior blocking is why it is not a separate file

The container runtime arms its triggers **synchronously**, and a page-view
trigger fires immediately. So whatever decides which tags may run has to have
decided *before* that call — which rules out a banner that fetches its own
configuration, because a network round trip cannot finish first.

A banner that fetches would appear, record a decision, and block nothing on
first paint. That is the failure this whole feature exists to avoid, so the
policy is compiled into the per-site file and the file is ordered
tracker → banner → container. By the time your tags are armed, the grant map
already says no.

The cost is that a policy edit reaches visitors on the same fifteen-minute
cache window as a container publish, rather than instantly.

### backlex's own tag is held too

The file order gates the CONTAINER because the container *starts* after the
banner. It did not, for a long time, gate the analytics tracker — because the
tracker *finishes* before the banner: the last thing it does on boot is send a
pageview. Measured on production, that was one `POST /api/analytics/collect`
before the visitor had chosen anything, on every site running a policy.

Two things fix it, and both are needed:

- **The undecided posture is compiled in.** The tracker starts with the grant
  map your policy configured instead of the pre-policy default, so its answer
  is yours from its first synchronous call.
- **The first pageview waits for the banner.** The posture alone is a guess
  about someone who may have already answered: a returning visitor's decision
  lives in the `blx_consent` cookie, and only the banner reads it. Waiting is
  what stops an `allow` posture from overrunning a recorded refusal, and what
  stops a `block` posture from silently dropping the first pageview of everyone
  who had already accepted.

The wait is an ordering fix, not a delay — the banner is in the same file and
calls `backlex.consent()` before it renders anything, so the release is
synchronous. It is also not *spent* on a refusal: with the usual `block`
posture the banner releases the held pageview into a denial, and a visitor who
then presses **Accept** is still counted on the page they landed on. A visitor
who never answers is never counted, which is the point.

Sites with no policy are untouched: the plain `/api/analytics/script.js`
install receives neither field and behaves exactly as before.

### Where the script tag goes

**First script in `<head>`, and keep `defer`.** `defer` scripts execute in
document order, so first-in-head is what puts the consent decision ahead of
every other deferred script on the page. `async` would forfeit that — async
scripts execute in completion order, so there is no ordering to rely on.

What it reaches, and what it does not, is in
[the tag manager guide](/tag-manager/#where-it-goes-and-why-the-attribute-matters):
tags fired by your container are gated, backlex's own tag is gated, and a
vendor script you pasted directly into your own HTML is **not** — backlex does
not rewrite your markup. Move those into the container.

### What it stores

One first-party cookie on **your** domain, `blx_consent`, holding a random
opaque id, the categories granted, the policy version shown, and a timestamp.
It carries `SameSite=Lax`, and `Secure` only on `https` — an unconditional
`Secure` would make a browser drop the whole cookie on an http page, so every
visitor would be asked again on every page.

It cannot be `HttpOnly`, and that is not a choice: the banner runs on your
origin, backlex is cross-origin to it, so a `Set-Cookie` from backlex would be
a third-party cookie — blocked in Safari and Firefox, partitioned in Chrome.
The decision travels to the server in the beacon body instead, which is why
`POST /api/consent/record` takes a subject id rather than reading a cookie.

The id is random and derived from nothing about the visitor. It exists because
the analytics visitor id rotates at UTC midnight by design and therefore cannot
key a consent record that has to outlive it.

> **Showing a banner starts processing that the tracker alone did not.** Every
> recorded decision stores a salted hash of the visitor's IP, their
> user-agent, and a country derived from the request — that is what makes the
> record evidence. If you chose backlex's tracker partly because it stores
> nothing on the device, note that the banner is a separate decision with its
> own basis, and say so in your privacy notice.

### What a visitor sees

Accept all, Reject all, and Manage — which reveals a checkbox per category you
offered, and a Save. Rejecting is exactly as many clicks as accepting, which is
the requirement, not a courtesy.

Manage also shows a **Strictly necessary** row, checked and disabled. It is not
a choice and is not offered as one; it is there because the site does set those
cookies whatever the visitor answers, and saying so is more honest than a panel
that implies everything is optional. Its two strings are `necessaryLabel` and
`necessaryBody`, which the policy has always accepted.

The banner renders in a **shadow root**, so your CSS cannot break it and its CSS
cannot leak into your page. Two honest limits: a browser without `attachShadow`
falls back to a namespaced element with weaker isolation, and a shadow root does
**not** escape your Content-Security-Policy — a strict `style-src` can block the
banner's stylesheet while its markup still renders.

### Withdrawal

GDPR Art. 7(3) requires taking consent back to be as easy as giving it, so there
are two ways to reopen the banner and neither of them costs the visitor a
search.

**Mark up an element.** Any element carrying `data-backlex-consent-open` opens
the preference centre when clicked — no script of your own, which matters on a
hosted CMS where a footer link is all you get:

```html
<a href="#" data-backlex-consent-open>Cookie settings</a>
```

**Or call it.** `window.__backlexConsent` publishes four things:

| | |
|---|---|
| `open()` | Reopen the banner, with the boxes as the visitor last left them. |
| `close()` | Dismiss it without deciding. Only meaningful once they have. |
| `withdraw()` | Deny every optional category, drop the cookie, and ask the server to erase the record. |
| `decision()` | What is on file: `{ id, g, v, t }`, or `null`. |

The handle exists from the moment the per-site file runs, including on page
loads where the banner never appears because the visitor already answered —
which is, of course, the only kind of page load on which withdrawal is a
question at all.

#### What the reopened banner offers that the first one does not

A close control, a **Withdraw** link, and the visitor's **consent id**. The
first two exist only once a decision is on file: an undecided visitor is given
no exit that is not a decision, and pays nothing for it, because Reject all is
one click on the first layer.

The id is the part worth reading twice. A consent record for an anonymous
visitor is reachable **by that id and nothing else** — see
[Data-subject erasure](./erasure.md), which is explicit that an `email` request
does not reach it. Showing it is what turns the right to erasure into something
a visitor can actually exercise, and `withdraw()` exercises it for them.

Withdrawing re-mints the id afterwards. A later decision therefore cannot be
joined to the record just erased, which is the difference between "erased" and
"erased until you press a button".

**The id is not a secret, and showing it does not make it one.** It already
lives in a first-party cookie any script on your page can read, and it travels
in every decision beacon. What it authorises is exactly one thing: deleting the
consent record it names — which is the subject's own right. It grants no read
access, and `DELETE /api/consent/record` answers `{"cleared":true}` whether the
id was real or not, so it cannot be used to find out whose is.

### Which language a visitor sees

The banner picks the locale block whose language the visitor's browser asked
for, and **only** from blocks you actually wrote. A visitor whose browser asks
for German, on a site where you wrote English and Turkish, gets your default —
not backlex's built-in German, because substituting text you never reviewed is
the same mistake as defaulting the posture. With no match, `defaultLocale` wins.

The recorded decision names the locale that was **rendered**, not the policy's
default, so a consent record tells you which of your texts that visitor was
actually held to.

This is the one thing the banner infers about a visitor, and it is deliberately
not a posture: it changes no grant, no category and no hash. `Accept-Language`
choosing between two texts you already wrote is a different claim from an IP
guess deciding whether a tag may fire.

### Wording

Your `wording` wins **per key**, not per locale block: translate the title and
nothing else and you get your title with backlex's everything-else, in English
or Turkish, rather than a half-empty banner. Every string is inserted with
`textContent` — never `innerHTML` — which is why the API stores your text
unescaped and a test fails if the banner source so much as mentions `innerHTML`.

## What this does not do yet

Stated plainly, because a consent feature is a compliance claim and the failure
mode is an operator believing they are covered because a setting exists:

- **No standalone preference centre.** Reopening the banner *is* the preference
  centre — it carries the categories, the consent id and the withdrawal. What
  is not built is a dedicated page listing every cookie you set, name by name.
- **No geo-targeted posture.** backlex will not choose your compliance posture
  from a visitor's IP, and the reason is structural rather than a backlog item —
  see [Presets are a starting point](#presets-are-a-starting-point-and-they-are-not-regional).
  One site, one policy, one posture; if you need two, run two sites.
- **No automatic cookie scanning.** Enumerating the cookies a site actually sets
  needs a headless-browser crawler; you declare yours.
- **backlex issues no IAB TCF consent string, and this is a prohibition rather
  than a gap.** The TCF specification states that a TC string *"may only be
  created by an IAB Europe TCF registered CMP using its assigned CMP ID"*, and
  that *"vendors or any other third-party service providers must neither create
  nor alter TC Strings"*. backlex is not a registered CMP, so writing one would
  not be an incomplete implementation — it would be a document backlex is not
  permitted to author. Vendors check: the Global CMP List exists so a receiving
  vendor can confirm a CMP ID is real, and strings from a de-registered CMP must
  be discarded outright. Letting you paste your own CMP ID into backlex would
  not fix that, because the string would still not have been produced by the
  software that ID belongs to.
- **backlex is also not a registered IAB *vendor*.** These are two different
  roles and only naming one of them would leave the other unstated: a CMP
  collects consent, a vendor is who consent is collected *for*. backlex does not
  appear in the Global Vendor List, so your CMP cannot disclose it and cannot
  record a per-vendor consent for it. If your compliance position depends on
  every party being enumerated in a TC string, backlex is not enumerated.
- **What does work is the other direction:** backlex reads the consent your own
  registered CMP has already obtained. See [If you already run another consent
  manager](#if-you-already-run-another-consent-manager). That path gates
  backlex's tag and every tag the tag manager compiles, and it makes no
  framework claim on your behalf.
