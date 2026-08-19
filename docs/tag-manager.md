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
| **Site** | The container. The one you already registered under Analytics → Sites; there is no second id to manage. |
| **Tag** | The thing that fires. A vendor template, an image pixel, a backlex event, or custom code. |
| **Trigger** | When it fires. Page view, DOM ready, window load, history change, click, link click, form submit, scroll depth, element visible, timer, or a custom event. |
| **Variable** | Something read off the page: a constant, a URL query parameter, a first-party cookie, a `dataLayer` key, or a JavaScript expression. |
| **Version** | A published snapshot. Rolling back moves a pointer; it does not re-derive anything. |

## Installing

One line, and it replaces the analytics snippet rather than joining it:

```html
<script defer src="https://your-workspace.example.com/api/analytics/tm/<site-id>.js"></script>
```

That file carries the analytics tag *and* the tag runtime, so a site that
installs it gets both from one request. The older
`script.js` + `data-site` snippet keeps working exactly as before — if you are
only measuring and not managing tags, there is nothing to change.

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
`none` — and the runtime checks it before firing, using the signals the
analytics tag already reads:

- Google Consent Mode entries in `dataLayer` (`ad_storage` for marketing tags,
  `analytics_storage` for analytics ones)
- `navigator.globalPrivacyControl`
- Do Not Track
- an explicit `backlex.consent("denied")`

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
