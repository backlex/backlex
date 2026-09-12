import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { slugify, resolveSlug, slugCandidates, SLUG_RE } from "@backlex/db/slug";
import { makeHarness, seedAdmin, type TestHarness } from "../setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

/**
 * Slug fields — the URL handle a row is addressed by.
 *
 * The shape under test is the one 24 collections across 11 schema templates
 * carry: a `text` column, `unique: true`, `required: false`, that nothing
 * server-side ever generated.
 */
describe("slug fold", () => {
  /**
   * The corpus that broke the implementations this replaces.
   *
   * Seven separate slugifiers existed in this repo — for tenants, app
   * organizations, SAML providers (twice), agent handles, and two in the admin
   * item form — and they disagreed with each other on most of these strings.
   * Pinning them here is what stops the consolidation from being undone one
   * "small fix" at a time. Every expectation below is a value at least one of
   * the old implementations got wrong.
   */
  test.each([
    // Turkish. `ğ`, `ü`, `ş`, `ç` and `ö` decompose under NFKD; `ı` does not,
    // which is the single character that justifies the fallback map.
    ["Ürün Kataloğu", "urun-katalogu"],
    ["Çankaya İlçesi", "cankaya-ilcesi"],
    ["Kırmızı Işık", "kirmizi-isik"],
    ["Sağlık Sigortası", "saglik-sigortasi"],
    // Accents — folded, not stripped. The admin's derivation made this
    // `caf-m-nch`, having filtered to ASCII before normalizing.
    ["Café Münch", "cafe-munch"],
    // Latin letters with no combining decomposition.
    ["Smørrebrød", "smorrebrod"],
    ["Straße", "strasse"],
    ["Æther & Œuvre", "aether-oeuvre"],
    ["Łódź", "lodz"],
    // Punctuation collapses to a single separator and never survives at an end.
    ["C++ & C#", "c-c"],
    ["Hello   World", "hello-world"],
    ["  Trailing space  ", "trailing-space"],
    ["...dots...", "dots"],
    ["already-a-slug", "already-a-slug"],
    // Scripts with no single romanization are refused, not guessed at.
    ["北京", ""],
    ["Пример", ""],
    ["مرحبا", ""],
  ])("slugify(%p) === %p", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  test("every non-empty fold satisfies the shape the column validates with", () => {
    const corpus = [
      "Ürün Kataloğu",
      "Café Münch",
      "C++ & C#",
      "  Trailing space  ",
      "Straße",
      "-leading-and-trailing-",
      "a".repeat(500),
      "x  --  y",
    ];
    for (const s of corpus) {
      const out = slugify(s);
      if (out === "") continue;
      expect(SLUG_RE.test(out)).toBe(true);
    }
  });

  test("truncation never leaves a trailing hyphen", () => {
    // Slicing mid-word is what produced a value the column's own regex refused.
    // The cap lands exactly on the hyphen in "one-two-three".
    expect(slugify("one two three", 8)).toBe("one-two");
    expect(SLUG_RE.test(slugify("one two three", 8))).toBe(true);
    expect(slugify("one two three", 4)).toBe("one");
  });

  test("a supplied value is FOLDED, not rejected", () => {
    // The whole argument for a field type over a validation rule: a regex can
    // refuse `My Post!` but it cannot turn it into `my-post`.
    expect(resolveSlug("My Post!", {}, {})).toEqual({ value: "my-post", source: "stated" });
  });

  test("an empty slug derives from the first source that has text", () => {
    const spec = { from: ["display_name", "legal_name"] };
    expect(resolveSlug("", { display_name: "", legal_name: "Acme Ltd" }, spec)).toEqual({
      value: "acme-ltd",
      source: "derived",
    });
    expect(resolveSlug(null, { display_name: "Acme", legal_name: "Acme Ltd" }, spec)).toEqual({
      value: "acme",
      source: "derived",
    });
  });

  test("nothing foldable anywhere resolves to none, never to an invented token", () => {
    expect(resolveSlug("", { title: "北京" }, { from: ["title"] })).toEqual({
      value: "",
      source: "none",
    });
  });

  test("collision candidates truncate the BASE to make room for the suffix", () => {
    const c = slugCandidates("abcdefgh", 8);
    expect(c[0]).toBe("abcdefgh");
    expect(c[1]).toBe("abcdef-2");
    for (const s of c) expect(s.length).toBeLessThanOrEqual(8);
  });

  test("input is capped before the fold, so a huge title costs constant work", () => {
    // The fold runs on the write path over a value a client controls, and every
    // step of it is linear. Before the cap, folding a five-megabyte longtext
    // spent ~230ms of CPU to produce eighty characters.
    //
    // A RATIO, not a millisecond ceiling, and the difference is the whole point
    // of this rewrite. "Constant work" is a claim about how cost scales with
    // input — which is exactly what a ratio measures and what an absolute bound
    // does not. The old `< 50ms` measured the HOST: it failed at 131ms on a
    // loaded machine where every other gate job also inflated 5-7x, twice in
    // one day, each time costing a full re-run of a ~4 minute suite for a
    // regression that was not there (#316).
    //
    // Both halves are timed the same way in the same process microseconds
    // apart, so contention scales them together and cancels. Without the cap
    // the ratio is ~30,000x — three orders of magnitude past the bound below —
    // so nothing about the detection is weakened by dropping the clock.
    const small = "Ürün Kataloğu! ".repeat(10);
    const huge = "Ürün Kataloğu! ".repeat(300_000);

    // Warm both paths first: the very first call pays JIT and allocation costs
    // that belong to neither input, and on a fast baseline that alone can
    // dominate the ratio.
    slugify(small);
    slugify(huge);

    const cost = (input: string): number => {
      const t0 = performance.now();
      slugify(input);
      return performance.now() - t0;
    };
    // Best-of-three on each: a single sample can catch a GC pause, and the
    // minimum is the closest thing to the work actually done.
    const timeOf = (input: string) => Math.min(cost(input), cost(input), cost(input));
    const smallMs = timeOf(small);
    const hugeMs = timeOf(huge);

    expect(slugify(huge).length).toBeLessThanOrEqual(80);
    // `+ 2` is a floor, not slack: `smallMs` can legitimately round to ~0 on a
    // fast machine, and a pure ratio against zero is unsatisfiable however
    // correct the code is.
    expect(
      hugeMs,
      `folding 4.5 MB took ${hugeMs.toFixed(2)}ms against ${smallMs.toFixed(2)}ms for 150 bytes — ` +
        "that is not constant work, so the input cap in `slugify` is gone",
    ).toBeLessThan(smallMs * 25 + 2);
  });

  test("SLUG_RE does not backtrack on an adversarial near-match", () => {
    // `^[a-z0-9]+(?:-[a-z0-9]+)*$` has nested quantifiers; the mandatory `-`
    // between groups is what keeps it linear. Pinned so a "simplification" that
    // makes the separator optional is caught here rather than in production.
    //
    // The bound is deliberately loose. What this catches is CATASTROPHIC
    // backtracking, which on 20,000 groups does not take 60ms instead of 40 —
    // it takes longer than anyone waits. So any ceiling far below "hangs"
    // detects it equally well, and a tight one only adds false reds on a busy
    // host (#316). Raised from 50ms for that reason, not because anything got
    // slower.
    const evil = `${"a-".repeat(20_000)}!`;
    const t0 = performance.now();
    expect(SLUG_RE.test(evil)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  test("a base already ending in digits is not mistaken for a suffix", () => {
    // `top-10` is a real title; treating its digits as a collision suffix would
    // rename a row nobody duplicated.
    expect(slugCandidates("top-10")[0]).toBe("top-10");
    expect(slugCandidates("top-10")[1]).toBe("top-10-2");
  });
});

describe("slug fields", () => {
  let h: TestHarness;

  const posts = "slug_posts";
  const cats = "slug_cats";

  const create = async (slug: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}`, json(body));
    return { status: r.status, body: (await r.json()) as any };
  };
  const patch = async (slug: string, id: string, body: unknown) => {
    const r = await h.fetch(`/api/items/${slug}/${id}`, json(body, "PATCH"));
    return { status: r.status, body: (await r.json()) as any };
  };
  const get = async (slug: string, id: string) =>
    (await (await h.fetch(`/api/items/${slug}/${id}`)).json()).data as Record<string, any>;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    // `posts` mirrors blog.posts: a title and a unique slug folded from it.
    await h.fetch(
      "/api/collections",
      json({
        slug: posts,
        fields: [
          { name: "title", type: "text" },
          { name: "slug", type: "text", unique: true, interface: "slug", slug: { from: ["title"] } },
        ],
      }),
    );
    // `cats` mirrors the THIRTEEN collections whose readable column is `name`,
    // not `title` — the ones the old admin-only derivation silently skipped.
    await h.fetch(
      "/api/collections",
      json({
        slug: cats,
        fields: [
          { name: "name", type: "text" },
          { name: "slug", type: "text", unique: true, interface: "slug", slug: { from: ["name"] } },
        ],
      }),
    );
  });

  afterAll(() => h?.cleanup());

  test("the spec is refused when `from` names something that is not readable text", async () => {
    // A slug is a PUBLIC URL folded out of another column, so which columns may
    // feed it is a security question, not a typing convenience. A `hash` field
    // holds a scrypt digest; a number folds to itself and makes `1` a URL; a
    // relation folds to somebody else's primary key.
    const bad = async (fields: unknown[]) =>
      (await h.fetch("/api/collections", json({ slug: `slug_bad_${Math.random().toString(36).slice(2, 8)}`, fields })))
        .status;
    expect(
      await bad([
        { name: "password", type: "hash" },
        { name: "slug", type: "text", slug: { from: ["password"] } },
      ]),
    ).toBeGreaterThanOrEqual(400);
    expect(
      await bad([
        { name: "rank", type: "integer" },
        { name: "slug", type: "text", slug: { from: ["rank"] } },
      ]),
    ).toBeGreaterThanOrEqual(400);
    // …and a source that does not exist at all, whose only other symptom is a
    // slug that is silently never generated.
    expect(
      await bad([{ name: "slug", type: "text", slug: { from: ["nope"] } }]),
    ).toBeGreaterThanOrEqual(400);
    // A `private` column is never returned by any read surface; a slug is a
    // public URL. Folding one out of the other would publish the very text the
    // schema marked unreadable.
    expect(
      await bad([
        { name: "internal_note", type: "text", private: true },
        { name: "slug", type: "text", slug: { from: ["internal_note"] } },
      ]),
    ).toBeGreaterThanOrEqual(400);
    // A slug must be text itself, too.
    expect(
      await bad([
        { name: "title", type: "text" },
        { name: "slug", type: "integer", slug: { from: ["title"] } },
      ]),
    ).toBeGreaterThanOrEqual(400);
  });

  test("a create that omits the slug folds one from the title", async () => {
    const r = await create(posts, { title: "My First Post" });
    expect(r.status).toBe(201);
    expect(r.body.data.slug).toBe("my-first-post");
    // On the PAYLOAD, not merely in the column — the 201 body, the realtime
    // event and the activity row are all built from it.
    expect((await get(posts, r.body.data.id)).slug).toBe("my-first-post");
  });

  test("it fires for a `name` source too, which is the case that never worked", async () => {
    const r = await create(cats, { name: "Kadın Giyim" });
    expect(r.status).toBe(201);
    expect(r.body.data.slug).toBe("kadin-giyim");
  });

  test("a supplied slug is folded rather than 422'd", async () => {
    const r = await create(posts, { title: "Anything", slug: "My Custom Slug!" });
    expect(r.status).toBe(201);
    expect(r.body.data.slug).toBe("my-custom-slug");
  });

  test("a second row with the same title takes the next free suffix", async () => {
    const a = await create(posts, { title: "Summer Sale" });
    const b = await create(posts, { title: "Summer Sale" });
    const c = await create(posts, { title: "Summer Sale" });
    expect(a.body.data.slug).toBe("summer-sale");
    expect(b.body.data.slug).toBe("summer-sale-2");
    expect(c.body.data.slug).toBe("summer-sale-3");
  });

  test("a STATED slug that collides is reported, not silently suffixed", async () => {
    // The server fills blanks; it does not overrule a decision. Same line
    // `performCreate` already draws for a stated position.
    await create(posts, { title: "Taken One", slug: "taken-one" });
    const r = await create(posts, { title: "Other", slug: "taken-one" });
    expect(r.status).toBe(409);
  });

  test("a title with nothing foldable leaves the slug unset rather than inventing one", async () => {
    const r = await create(posts, { title: "北京" });
    expect(r.status).toBe(201);
    expect(r.body.data.slug ?? null).toBeNull();
  });

  test("editing the title does NOT move a published slug", async () => {
    // The breakage the `redirects` collections exist to paper over.
    const r = await create(posts, { title: "Original Headline" });
    expect(r.body.data.slug).toBe("original-headline");
    await patch(posts, r.body.data.id, { title: "Corrected Headline" });
    expect((await get(posts, r.body.data.id)).slug).toBe("original-headline");
  });

  test("clearing the slug re-derives it from the title the row now has", async () => {
    const r = await create(posts, { title: "First Title" });
    await patch(posts, r.body.data.id, { title: "Second Title" });
    const done = await patch(posts, r.body.data.id, { slug: "" });
    expect(done.status).toBe(200);
    expect((await get(posts, r.body.data.id)).slug).toBe("second-title");
  });

  test("a patch that restates the same slug does not suffix the row against itself", async () => {
    const r = await create(posts, { title: "Stable Post" });
    await patch(posts, r.body.data.id, { slug: "stable-post" });
    await patch(posts, r.body.data.id, { slug: "stable-post" });
    expect((await get(posts, r.body.data.id)).slug).toBe("stable-post");
  });

  test("a batch create numbers its own collisions rather than all landing on one", async () => {
    // The batch path builds its own statements; a slug folded only in the
    // single-row route would leave every batched row sharing one URL.
    const r = await h.fetch(
      `/api/items/${cats}/batch`,
      json({
        operations: [
          { op: "create", data: { name: "Shoes" } },
          { op: "create", data: { name: "Shoes" } },
          { op: "create", data: { name: "Shoes" } },
        ],
      }),
    );
    expect(r.status).toBeLessThan(300);
    const listed = (await (await h.fetch(`/api/items/${cats}?limit=100`)).json()) as any;
    const slugs = (listed.data as any[]).map((x) => x.slug);
    expect(slugs).toContain("shoes");
    expect(slugs).toContain("shoes-2");
    expect(slugs).toContain("shoes-3");
  });
});
