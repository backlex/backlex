---
title: Tag manager
description: Configure third-party marketing tags once, publish a container, and have the script your site already loads fire them.
---

backlex's web analytics tag measures your site. The **tag manager** is the other
half: it runs *other people's* tags — a Meta Pixel, a Google Ads conversion, a
TikTok pixel — from the same script, configured in the admin instead of pasted
into your HTML.

If you have used Google Tag Manager the shape will be familiar: **tags** fire on
**triggers**, triggers can test **variables**, and nothing a visitor sees changes
until you **publish**.

## What it is not

Worth saying first, because the gap between this and GTM is real and knowing it
up front saves an afternoon:

- **There is no template gallery.** Vendors come from a list backlex ships and
  reviews. You cannot add one by pasting a vendor's snippet into a template
  editor — you can paste it into a custom-code tag, which is a different thing
  with a different gate.
- **There is one draft per site.** No workspaces, no per-user branches, no merge.
  Last write wins, and the version history is the safety net.
- **Server-side tagging is not here yet.** Everything below runs in the
  visitor's browser.

## The pieces

| | |
|---|---|
| **Site** | The container. The one you already registered under **Website → Websites**; there is no second id to manage. |
| **Tag** | The thing that fires. A vendor template, an image pixel, a backlex event, or custom code. |
| **Trigger** | When it fires. Page view, DOM ready, window load, history change, click, link click, form submit, scroll depth, element visible, timer, or a custom event. |
| **Variable** | Something read off the page: a constant, a URL query parameter, a first-party cookie, a `dataLayer` key, or a JavaScript expression. |
| **Version** | A published snapshot. Rolling back moves a pointer; it does not re-derive anything. |

## Installing

One line, once, and never again:

```html
<script defer src="https://your-workspace.example.com/api/site/<site-id>.js"></script>
```

This is **the** script tag for a website — the same one **Website → Websites**
hands you, and the same one the cookie banner rides on. You paste it on a fresh
site and you do not come back: what the file CONTAINS grows as you turn things
on. Register the site and it carries the analytics tag; switch a cookie banner
on and the banner appears inside it; publish a container and the tag runtime
joins them. Nothing to re-paste, ever.

### Where it goes, and why the attribute matters

**First script in `<head>`. Keep `defer`. Never `async`.**

Those three are one rule, not three preferences, and the reason is how the
browser orders execution:

- **`defer` scripts run in DOCUMENT ORDER**, after the HTML is parsed and
  before `DOMContentLoaded`. So being first in `<head>` means this file
  executes before every other deferred script on the page — which is what lets
  a consent decision exist before anything else deferred gets to run.
- **`async` scripts run in COMPLETION ORDER** — whichever finishes downloading
  first. There is no ordering to rely on at all, so a banner shipped `async`
  would sometimes decide after the tags it is supposed to gate. That is the
  failure mode where an operator believes they are compliant because a banner
  appeared.
- Inside the file, the server fixes the order: tracker, then banner, then
  container. That is why it is ONE file rather than three — three separate tags
  could not guarantee it.

What this does and does not reach:

| | |
|---|---|
| Tags fired by **your container** | Gated. The consent map is written before the container arms its triggers. |
| **backlex's own analytics tag** | Gated. Its first pageview waits for the banner on any site running a policy. |
| A vendor tag you pasted **directly into your HTML** | **Not gated.** It is not ours to hold. Move it into the tag manager, or gate it yourself on `window.__backlexConsentGranted("marketing")`. |

There is no auto-blocking of foreign `<script>` tags — backlex does not rewrite
your markup, and a CMP that claims to do so is rewriting it. Anything you want
gated goes through the container.

> **Already running a different consent manager?** Then you do not need a
> backlex policy at all: every tag in the table's first row is gated by your
> CMP's Google Consent Mode signals as things stand, with nothing pasted. The
> categories map to `ad_storage` / `analytics_storage` /
> `functionality_storage`, and the one rule is to leave the backlex banner off —
> a backlex policy writes a total grant map that stops your manager from being
> consulted at all. Full detail, including two limits, in
> [Cookie consent → If you already run another consent
> manager](/docs/cookie-consent/#if-you-already-run-another-consent-manager).

It also carries only what you use. With no published container the file has no
tag runtime in it at all — so `window.__backlexTM` is genuinely absent until
your first publish, which is expected rather than a bug.

> **The old URL still works, and always will.** `/api/analytics/tm/<site-id>.js`
> answers exactly the same file, byte for byte. It is inside a `<script>` tag on
> every page already deployed and there is no version negotiation, so it is
> permanent — not deprecated, not sunset. New installs get the shorter path
> because the old one named two products (`analytics`, `tm`) while serving
> three.

The older `script.js` + `data-site` snippet also keeps working, but it is
**analytics only**: it cannot carry a cookie banner or your tags, and
`trackerCategory` / `signalHandling` do not reach it. If you are measuring and
nothing else it is fine; if you might ever want a banner, use the line above.

**Do not run both at once.** A page carrying the old snippet and the new one is
still measured only once — the tag refuses to boot twice on purpose — but there
is no reason to pay for two downloads.

Copy the snippet from **Tag manager → Install**, which also prints the
Content-Security-Policy lines your site needs (see below).

## Publishing, and how long it takes

Editing changes nothing a visitor sees. Publishing compiles the draft into a
document, stores it, and points the site at it.

**A publish reaches every visitor within about fifteen minutes.** That is the
browser cache on the container file, and it is the same figure GTM uses. The
alternative — putting a version number in the URL — would mean editing your
site's HTML on every publish, which is the thing a tag manager exists to avoid.

Rolling back serves an earlier version again, byte for byte. It does **not**
touch your draft: whatever you had edited is still there, unpublished.

## What a publish leaves out

A publish never fails wholesale because one tag is wrong. Anything that no
longer validates is dropped, and the publish report says which and why. You will
see this when:

- A tag's only trigger was deleted. It can never fire, so shipping it would put
  a dead entry in every visitor's download.
- A template's parameters stopped validating.
- Custom code exists but the site's custom-code setting has since been switched
  off (see below).

A **disabled** tag is simply left out, and is not reported — disabling is a
choice, not a fault.

## Custom code, and why it is off by default

A custom tag is arbitrary JavaScript on a public website. So it is gated three
ways at once: you must be an admin, the site must have **Allow custom code**
switched on, and every change is written to the audit log.

The setting is re-checked **every time you publish**, not only when you save. If
you switch it off, custom tags already on that site stop being published — they
do not keep firing because they were created while it was on. The same applies
to a JavaScript-expression variable, which is the same capability wearing a
smaller name.

There is one more thing to know, and it is your site's decision rather than
ours: custom code is injected as a `<script>` element carrying the loader's
nonce. If your Content-Security-Policy allows neither inline scripts nor a
nonce, custom tags will not run. Vendor templates are unaffected.

## Consent

Every tag declares a category — `marketing`, `analytics`, `functional`, or
`none` — and the runtime checks it before firing. The check asks the analytics
tag, which holds one grant map for the whole page, so a site gets one verdict
rather than two that drift apart. In order:

- an explicit `backlex.consent(...)` — a string, or a per-category map
- Google Consent Mode entries in `dataLayer`: `ad_storage` for marketing,
  `analytics_storage` for analytics, `functionality_storage` for functional
  (falling back to `analytics_storage` when the more specific key is absent)

An explicit call wins over `dataLayer`, because that is the site owner speaking
directly rather than us inferring. A category nothing has spoken about is
allowed to fire; `none` is never gated at all.

**Global Privacy Control and Do Not Track do NOT gate third-party tags** — they
stop backlex's own analytics tag, and only that. This page used to say
otherwise, which was wrong. Extending them to your tags would switch off live
pixels on every site at once, for visitors whose operator never chose that, so
it lands with the prior-blocking work — together with a per-site switch and a
published category for every tag, neither of which exists yet.

Changing a tag's category takes effect on your **next publish**, like every
other tag edit.

If a tag is filed under a category laxer than the vendor declares, the tag list
says so rather than silently correcting it: moving a tag between categories
changes who it fires for, and that is a decision to make on purpose.

Two of the vendors backlex ships are declared as **both** analytics and
marketing, and that is deliberate rather than a mistake:

- **Yandex Metrica** — Yandex's own documentation lets any Metrica goal drive
  Yandex Direct retargeting.
- **Microsoft Clarity** — its own consent call takes `ad_Storage`, because the
  data reaches Microsoft Advertising.

Declaring either as analytics-only would under-declare it to a consent tool that
is behaving correctly.

**Hotjar is the counter-example** and stays analytics-only, which is Hotjar's own
stated position.

## Content-Security-Policy

If your site sets a CSP, the vendors' scripts have to be allowed by *your*
policy — we cannot relax it for you. **Tag manager → Install** generates the
exact lines for the tags this container actually holds, so a site running one
pixel is not told to allow four origins.

Two caveats it will tell you about:

- **Google publishes its origins against `script-src-elem`**, not `script-src`.
  Ours covers script elements *unless* your site already sets `script-src-elem`
  explicitly, in which case our line is not inherited and you need to add the
  origins there too.
- **Some of this guidance is ours, not the vendor's.** Meta publishes no CSP
  documentation for its pixel at all; LinkedIn, Clarity and Microsoft UET do not
  either. The Install panel marks which is which.

## A note on vendor IDs

backlex validates a pixel id only loosely, on purpose. Checking each vendor's own
documentation turned up something consistent: **almost none of them publish an id
format.** Meta's get-started page shows a placeholder; Reddit's shows a
placeholder and its shipped library validates nothing; Yandex documents "an
integer" and its own examples disagree on the digit count.

So the admin says which vendors document a format and which do not, and the
validator only refuses values that could not be an id at all — a quote, an angle
bracket, a newline, a URL scheme. Rejecting a *valid* pixel id would be
indistinguishable, from where you are standing, from a backlex bug.

## Limits

- 200 tags, 200 triggers and 200 variables per site.
- A trigger condition may hold at most 40 tests, nested at most 4 deep, with at
  most 50 values in an `in` list. These bound work done on a visitor's phone.
- A `matches regex` condition is capped at 200 characters. It is compiled and
  matched **only in the browser**, so a pathological pattern costs one visitor's
  tab rather than the API — that is containment, not a guarantee, and it is
  worth writing patterns you would be happy to run yourself.
