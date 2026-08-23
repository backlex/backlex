/**
 * Cross-document links in `docs/` actually resolve.
 *
 * This exists because 98 of them did not, in shipped user-facing docs, and
 * nothing in the repo noticed. The docs site serves the repo-root `docs/`
 * folder under a `/docs` base — `apps/docs/src/content.config.ts` points its
 * loader at `../../docs` — so an inline link written `](/querying/)` renders as
 * `href="/querying/"` and 404s, while `](/docs/querying/)` renders correctly.
 * Both forms were in use, 101 right and 98 wrong, and the wrong ones read as
 * perfectly ordinary markdown.
 *
 * Measured against the live site when this was written: `/docs/querying/` 200,
 * `/querying/` 404 — repeated across five slugs, so the rule is not inferred
 * from one sample.
 *
 * ── Why a source scan and not a link checker ──────────────────────────────
 * A crawler needs the built site and a network, and would run after the damage
 * shipped. This runs in `bun test`, offline, against the markdown itself — the
 * same trade `consent-surfaces.test.ts` makes for surface parity.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const DOCS = resolve(ROOT, "docs");

const files = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
const slugs = new Set(files.map((f) => f.slice(0, -3)));
const read = (f: string) => readFileSync(resolve(DOCS, f), "utf8");

/**
 * Every markdown link whose target is an absolute site path.
 *
 * The tail is captured separately from the first segment because a link may
 * carry a fragment (`/docs/tag-manager/#where-it-goes`), and the fragment is
 * what the anchor test below needs.
 */
const LINK = /\]\(\/([a-z0-9-]+)([^)]*)\)/g;

const linksIn = (f: string) =>
  [...read(f).matchAll(LINK)].map(([, head, tail]) => ({
    file: f,
    head: head!,
    tail: tail ?? "",
  }));

const all = files.flatMap(linksIn);

/**
 * Starlight's heading slugification, which is `github-slugger`.
 *
 * The one rule worth writing down, because getting it wrong made this guard
 * report two CORRECT links as broken on its first run: spaces are replaced
 * ONE FOR ONE and never collapsed. `## Batch & transactional writes` drops the
 * `&` and leaves the two spaces around it, so the anchor is
 * `batch--transactional-writes` with a DOUBLE hyphen. Confirmed against the
 * deployed page rather than reasoned about — `id="batch--transactional-writes"`
 * is what the live HTML carries.
 *
 * A `\s+` collapse here fails on correct content, which is the shape of guard
 * that teaches people to ignore red.
 */
const slugify = (heading: string) =>
  heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/ /g, "-");

const anchorsIn = (f: string) =>
  new Set(
    [...read(f).matchAll(/^#{2,6}\s+(.+?)\s*$/gm)].map(([, h]) => slugify(h!)),
  );

describe("cross-document links", () => {
  test("a link to another docs page carries the /docs prefix", () => {
    // The whole defect, in one assertion. `](/querying/)` is not a typo a
    // reviewer catches — it is what the link looks like when you forget the
    // site serves these under a base path.
    const bare = all
      .filter((l) => l.head !== "docs" && slugs.has(l.head))
      .map((l) => `${l.file} -> /${l.head}${l.tail}`);
    expect(bare).toEqual([]);
  });

  test("every /docs/ link names a page that exists", () => {
    // The other direction: a correct-looking prefix in front of a file that was
    // renamed or never existed. Reported with the file so a failure is
    // actionable rather than a count.
    const missing = all
      .filter((l) => l.head === "docs")
      .map((l) => ({ file: l.file, slug: l.tail.replace(/^\//, "").split(/[/#)]/)[0] ?? "" }))
      .filter((x) => x.slug !== "" && !slugs.has(x.slug))
      .map((x) => `${x.file} -> /docs/${x.slug}`);
    expect(missing).toEqual([]);
  });

  test("a #fragment on a cross-document link matches a real heading", () => {
    // The half that rots silently. A renamed heading leaves the link a 200 that
    // lands at the top of the page, which no status-code check can see — and
    // `cookie-consent.md` and `tag-manager.md` deep-link into each other by
    // anchor, so this is load-bearing rather than hypothetical.
    const anchors = new Map<string, Set<string>>();
    const bad: string[] = [];
    for (const l of all) {
      if (l.head !== "docs") continue;
      const [, slug, frag] = l.tail.match(/^\/([a-z0-9-]+)\/?#(.+)$/) ?? [];
      if (!slug || !frag) continue;
      const target = `${slug}.md`;
      if (!slugs.has(slug)) continue; // covered by the test above
      if (!anchors.has(target)) anchors.set(target, anchorsIn(target));
      if (!anchors.get(target)!.has(frag)) bad.push(`${l.file} -> /docs/${slug}/#${frag}`);
    }
    expect(bad).toEqual([]);
  });

  test("the scan sees a realistic number of links, so an empty match cannot pass", () => {
    // A regex that matched nothing would make all three tests above green while
    // measuring nothing — the failure mode this repo has shipped twice. This is
    // the loaded-state check: a floor, not an exact count, so ordinary editing
    // does not trip it.
    expect(all.length).toBeGreaterThan(150);
    expect(files.length).toBeGreaterThan(50);
  });
});
