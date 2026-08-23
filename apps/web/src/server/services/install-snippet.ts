/**
 * The one script tag a website needs, built in one place.
 *
 * One website, one tag, pasted once. Its CONTENTS grow as the operator turns
 * things on — enable a cookie banner and the banner appears inside the same
 * file, publish a tag container and the tags do too, with nothing to re-paste.
 *
 * ── Why this is a module and not a template literal at each call site ─────
 * Four surfaces hand an operator a snippet: the admin's Websites page, the tag
 * manager's install tab, the CLI, and the SDK's site rows. Before this they
 * built the string themselves, and two of them built a DIFFERENT one — the
 * analytics-only drop-in, which cannot carry a consent banner. An operator who
 * pasted it and then switched a banner on got no banner and no error, because
 * the banner ships inside the per-site file and nothing else can carry it.
 *
 * The admin and the CLI cannot import this (it is server-side), so they read
 * the `snippet` field the site rows now carry. That is the same string, from
 * here, and it is why the path below can move without touching them.
 */

/**
 * Escape a value for a double-quoted HTML attribute.
 *
 * This output is HTML BY CONTRACT — the whole point is that a human pastes it
 * into their own page — so the two interpolated values have to be safe there,
 * and measurement says neither is safe by construction:
 *
 *   `new URL("http://" + host).origin` does NOT reject a double quote. It
 *   throws on a space and on `<`, so those cannot arrive, but `a"x.com`
 *   survives verbatim and `a%22.com` DECODES to one. `origin` is derived from
 *   the request's Host header.
 *
 *   `siteId` on the tag manager's install route is `z.string().min(1)`, not a
 *   uuid — it is narrowed later by a tenant-scoped lookup, not by the schema.
 *
 * Neither is exploitable today: the snippet is delivered as JSON to an
 * authenticated, uncached admin response, and the admin renders it as a React
 * text child. A poisoned Host only ever poisons the poisoner's own reply. But
 * "a string that becomes HTML on someone else's site" is the wrong place to
 * rely on three separate facts staying true, and the emitter is one function
 * now, so it costs four lines to stop relying on them.
 *
 * `&` first, or the escapes escape each other.
 */
const attr = (v: string): string =>
  v
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const installSnippet = (origin: string, siteId: string): string =>
  `<script defer src="${attr(origin)}/api/site/${attr(siteId)}.js"></script>`;
