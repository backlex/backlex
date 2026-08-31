/**
 * A row has to be findable by the string it is named with.
 *
 * That sounds too obvious to test, and it was false for two years. The query
 * builder folded case in JavaScript before handing the tokens to FTS5, and
 * `"İ".toLowerCase()` is not `"i"` — it is `i` + U+0307 COMBINING DOT ABOVE,
 * two code points. The tokenizer regex counts letters and numbers, a combining
 * mark is neither, so U+0307 read as a separator and `"İSTANBUL"` became the
 * two tokens `i` and `stanbul`, ANDed. A product literally called "İstanbul
 * Filtre Kahve" returned NOTHING for `İstanbul`, while the misspelled ASCII
 * `ISTANBUL` found it — the right spelling failed and the wrong one worked.
 *
 * The fix is to stop folding in JS at all: FTS5's `unicode61` tokenizer already
 * case-folds and strips diacritics on both sides of the MATCH, so a second fold
 * could only ever disagree with it.
 *
 * These are written as behaviour ("search the name, get the row") rather than
 * against `toFtsMatchExpr`'s output, because the token shape is an
 * implementation detail and the promise is not.
 */
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";
import { toFtsMatchExpr } from "../src/server/services/fts";

const json = { "content-type": "application/json" };

describe("full-text search folds case the way the index does", () => {
  let h: TestHarness;
  const slug = `fts_tr_${Date.now()}`;

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/collections", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        slug,
        fts: true,
        fields: [
          { name: "title", type: "text", searchable: true },
          { name: "body", type: "longtext", searchable: true },
        ],
      }),
    });
    expect(res.status).toBe(201);

    for (const [title, body] of [
      ["İstanbul Filtre Kahve", "İzmir ve İstanbul için ışıl ışıl bir kahve"],
      ["Ankara Şube Deposu", "Çankaya bölgesindeki güneş koruyucu stoğu"],
      ["Athens depot", "Ο ΚΟΣΜΟΣ και ένα σχόλιο"],
    ] as const) {
      const r = await h.fetch(`/api/items/${slug}`, {
        method: "POST",
        headers: json,
        body: JSON.stringify({ title, body }),
      });
      expect(r.status).toBe(201);
    }
  });
  afterAll(() => h.cleanup());

  const titlesFor = async (q: string): Promise<string[]> => {
    const res = await h.fetch(`/api/items/${slug}/search`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ q, mode: "fts", limit: 10 }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as { data: Array<{ title: string }> };
    return data.map((r) => r.title);
  };

  // The headline case. Every one of these is the SAME word; a search box has no
  // way to know which of them the operator's keyboard produced.
  test.each([
    ["İstanbul", "as written — dotted capital İ"],
    ["istanbul", "all lower, ASCII i"],
    ["İSTANBUL", "Turkish caps — dotted İ"],
    ["ISTANBUL", "ASCII caps — dotless I"],
    ["İstAnBuL", "mixed"],
  ])("finds the row named 'İstanbul …' when asked for %p (%s)", async (q) => {
    expect(await titlesFor(q)).toContain("İstanbul Filtre Kahve");
  });

  // The same expansion happens mid-word, where it is even easier to miss.
  test.each(["FİLTRE", "filtre", "Filtre", "FILTRE"])("finds 'Filtre' for %p", async (q) => {
    expect(await titlesFor(q)).toContain("İstanbul Filtre Kahve");
  });

  test("the other five Turkish letters still fold both ways", async () => {
    for (const q of ["ÇANKAYA", "çankaya", "GÜNEŞ", "güneş", "ŞUBE", "şube"]) {
      expect(await titlesFor(q)).toContain("Ankara Şube Deposu");
    }
  });

  // Not Turkish-specific: any capital whose lowercase is longer than itself hit
  // the same splitter. Greek capitals carry no tonos, so the fold is one-way.
  test("a Greek capital word finds its row", async () => {
    expect(await titlesFor("ΚΟΣΜΟΣ")).toContain("Athens depot");
  });

  test("diacritic-insensitive matching still works (it is the tokenizer's, not ours)", async () => {
    expect(await titlesFor("cankaya")).toContain("Ankara Şube Deposu");
    expect(await titlesFor("gunes")).toContain("Ankara Şube Deposu");
  });

  test("an unrelated query still matches nothing", async () => {
    expect(await titlesFor("makarna")).toEqual([]);
  });

  /**
   * The unit half, kept because it names the exact mechanism: one word must
   * produce ONE token. This is the assertion that fails the moment somebody
   * reintroduces a `.toLowerCase()` — the behavioural tests above would fail
   * too, but this one says why in a single line.
   */
  test("a word containing İ tokenizes as one token, not two", () => {
    expect(toFtsMatchExpr("İSTANBUL")).toBe('"İSTANBUL"');
    expect(toFtsMatchExpr("İstanbul Filtre")).toBe('"İstanbul" "Filtre"');
    // The shape of the old bug, spelled out: this is what a JS fold produced.
    expect("İSTANBUL".toLowerCase().match(/[\p{L}\p{N}]+/gu)).toEqual(["i", "stanbul"]);
  });

  test("FTS5 operator characters are still neutralized", () => {
    expect(toFtsMatchExpr('a* b: c-d "e" (f)')).toBe('"a" "b" "c" "d" "e" "f"');
    expect(toFtsMatchExpr("   ")).toBeNull();
    expect(toFtsMatchExpr("***")).toBeNull();
  });
});

/**
 * The one case this does NOT fix, recorded so nobody reports it as a
 * regression: Turkish's DOTLESS pair. `ı` (U+0131) folds to itself and `I`
 * (U+0049) folds to `i`, so `IŞIL` does not match a stored `ışıl`. Resolving
 * that needs to know the text is Turkish — folding `I → ı` for everyone would
 * break every other language that uses the Latin alphabet. It is also the
 * rarer direction: it needs an all-caps query over a word containing ı.
 */
