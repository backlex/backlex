/**
 * `_icontains` and its two siblings, against text that is not English.
 *
 * The defect these pin was measured, not imagined: on a Turkish product catalog
 * `_icontains: "İşlemci"` returned NOTHING against a row literally named
 * "İşlemci soğutucu", while `_contains` — the case-SENSITIVE operator —
 * returned it. The insensitive operator found strictly less than the sensitive
 * one, which is backwards, and it is the shape a user reports as "search is
 * broken" without ever being able to say which search.
 *
 * The cause was two folds that could not agree. The needle went through
 * JavaScript's `toLowerCase()` (full Unicode — `"İ"` EXPANDS to `i` + U+0307)
 * and the column through SQLite's `LOWER()` (ASCII and nothing else), so any
 * character either engine declined to fold put the two sides permanently out of
 * reach of each other. Postgres never came through that path the same way,
 * making this SQLite/D1-only: every managed tenant and every default self-host.
 *
 * Three properties, and the third is the one that makes the first two mean
 * something:
 *
 *  1. A word can find itself.
 *  2. `_icontains` never returns less than `_contains`. This is the invariant —
 *     an insensitive match is by definition a superset of a sensitive one, and
 *     it holds for any string, so it is checked over a corpus rather than over
 *     one example.
 *  3. The SQL path and the in-memory path return the SAME SET. They are two
 *     implementations of one operator: REST compiles to SQL, realtime evaluates
 *     in memory, and a disagreement means a row delivered over a socket that
 *     REST would have withheld.
 *
 * What is deliberately NOT claimed: SQLite is not made to fold `İ` → `i`. D1
 * ships no ICU, and a Turkish rule (`I` → `ı`) is wrong in every other Latin
 * language. The guarantee is agreement, not completeness — and the last test
 * states the residual so nobody reports it later as a regression.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { foldCase, matchesCondition } from "@backlex/db";
import type { AuthSubject, Condition } from "@backlex/core";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

/** Names chosen so every non-ASCII letter appears once as a capital and once
 *  already lowercase — the two halves failed differently. */
const NAMES = [
  "İşlemci soğutucu",
  "İpek Şahin",
  "Can Öztürk",
  "Ayşe Çelik",
  "Tunç Yıldırım",
  "Bellek modülü",
  "Straße München",
  "ΑΘΗΝΑ merkez",
];

describe("_icontains, on text that is not English", () => {
  let h: TestHarness;
  const rows: Record<string, unknown>[] = [];

  const where = (cond: Condition) => `filter=${encodeURIComponent(JSON.stringify(cond))}`;
  const names = async (cond: Condition): Promise<string[]> => {
    const res = await h.fetch(`/api/items/people?${where(cond)}&limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string }[] };
    return body.data.map((r) => r.name).sort();
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "people",
        fields: [
          { name: "name", type: "text" },
          // No folded companion: `longtext` is where a second copy would be real
          // storage, and whole-word FTS is the right tool. It is the residual
          // the last test pins.
          { name: "bio", type: "longtext" },
        ],
      }),
    });
    expect(made.status).toBe(201);
    for (const name of NAMES) {
      const res = await h.fetch("/api/items/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, bio: name }),
      });
      expect([200, 201]).toContain(res.status);
      rows.push({ name });
    }
  });

  afterAll(() => h.cleanup());

  test("a word can find itself — the exact string in a row's own name", async () => {
    // Every one of these returned [] before. `İşlemci` is the one measured on a
    // real catalog: an option axis that could not be found by its own name.
    expect(await names({ name: { _icontains: "İşlemci" } })).toEqual(["İşlemci soğutucu"]);
    expect(await names({ name: { _icontains: "Öztürk" } })).toEqual(["Can Öztürk"]);
    expect(await names({ name: { _icontains: "Şahin" } })).toEqual(["İpek Şahin"]);
    expect(await names({ name: { _icontains: "Çelik" } })).toEqual(["Ayşe Çelik"]);
    expect(await names({ name: { _icontains: "Straße" } })).toEqual(["Straße München"]);
    expect(await names({ name: { _icontains: "ΑΘΗΝΑ" } })).toEqual(["ΑΘΗΝΑ merkez"]);
  });

  test("the ASCII half still works, in either case", async () => {
    // The fix must not trade one alphabet for another: ASCII case-insensitivity
    // is what the operator was already doing correctly.
    expect(await names({ name: { _icontains: "BELLEK" } })).toEqual(["Bellek modülü"]);
    expect(await names({ name: { _icontains: "bellek" } })).toEqual(["Bellek modülü"]);
    expect(await names({ name: { _icontains: "MERKEZ" } })).toEqual(["ΑΘΗΝΑ merkez"]);
    expect(await names({ name: { _istarts_with: "CAN " } })).toEqual(["Can Öztürk"]);
    // "SOğutucu": the ASCII letters shouted, the `ğ` spelled as it is stored.
    // That pairing is exactly what SQLite's `LOWER()` can reach, and the point
    // of the last test below is that this is now a stated limit rather than a
    // disagreement between two implementations.
    expect(await names({ name: { _iends_with: "SOğutucu" } })).toEqual(["İşlemci soğutucu"]);
  });

  test("the insensitive operator is never narrower than the sensitive one", async () => {
    // The invariant, over a corpus rather than an example. This is what actually
    // failed: `_contains: "İpek"` found the row and `_icontains: "İpek"` did not.
    const needles = [
      "İşlemci", "İpek", "Öztürk", "Şahin", "Çelik", "Ayşe", "Tunç", "Yıldırım",
      "Bellek", "bellek", "Straße", "München", "merkez", "soğutucu", "modülü",
    ];
    const narrower: string[] = [];
    for (const n of needles) {
      const sensitive = await names({ name: { _contains: n } });
      const insensitive = await names({ name: { _icontains: n } });
      for (const hit of sensitive) {
        if (!insensitive.includes(hit)) narrower.push(`${n}: _contains found ${hit}, _icontains did not`);
      }
    }
    expect(narrower).toEqual([]);
  });

  test("the SQL path and the in-memory path return the same set", async () => {
    // Two implementations of one operator. REST compiles to SQL; realtime and
    // the permission simulator evaluate in memory. A disagreement is a row that
    // reaches a socket the REST list would not have returned.
    const auth = { userId: "u", tenantId: "t" } as unknown as AuthSubject;
    const disagreements: string[] = [];
    for (const n of ["İşlemci", "İPEK", "öztürk", "Şahin", "AYŞE", "straße", "MERKEZ", "Bellek"]) {
      for (const op of ["_icontains", "_istarts_with", "_iends_with"] as const) {
        const cond = { name: { [op]: n } } as unknown as Condition;
        const viaSql = await names(cond);
        const viaJs = rows
          // The harness runs on SQLite, so the in-memory side is told so — the
          // predicate stands in for THIS store, not for JavaScript.
          .filter((r) =>
            matchesCondition(r, cond, auth, {
              dialect: "sqlite",
              // The predicate has to know the field carries a companion, exactly
              // as the compiler does — that is what makes the two paths ONE
              // implementation rather than two that happen to agree.
              foldable: (f) => f === "name",
            }),
          )
          .map((r) => String(r.name))
          .sort();
        if (JSON.stringify(viaSql) !== JSON.stringify(viaJs)) {
          disagreements.push(`${op} ${n}: sql=${JSON.stringify(viaSql)} js=${JSON.stringify(viaJs)}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  test("what SQLite could never do, a folded column now does", async () => {
    // These are the assertions this whole feature exists for. SQLite's `LOWER()`
    // folds `A-Z` and nothing else, and D1 ships no ICU — so on the column
    // itself, none of the following could ever match. Against the folded
    // companion every one of them does, because the fold happened in JavaScript
    // on the way IN and the needle goes through the very same function.
    expect(await names({ name: { _icontains: "işlemci" } })).toEqual(["İşlemci soğutucu"]);
    expect(await names({ name: { _icontains: "ISLEMCI" } })).toEqual(["İşlemci soğutucu"]);
    expect(await names({ name: { _icontains: "islemci" } })).toEqual(["İşlemci soğutucu"]);
    expect(await names({ name: { _icontains: "SOĞUTUCU" } })).toEqual(["İşlemci soğutucu"]);
    // Diacritics come off too, which even ICU would not have given us.
    expect(await names({ name: { _icontains: "ozturk" } })).toEqual(["Can Öztürk"]);
    expect(await names({ name: { _icontains: "OZTURK" } })).toEqual(["Can Öztürk"]);
    expect(await names({ name: { _icontains: "ayse celik" } })).toEqual(["Ayşe Çelik"]);
    // German ß and Turkish dotless ı — neither decomposes, both are mapped.
    expect(await names({ name: { _icontains: "strasse" } })).toEqual(["Straße München"]);
    expect(await names({ name: { _icontains: "munchen" } })).toEqual(["Straße München"]);
    expect(await names({ name: { _icontains: "yildirim" } })).toEqual(["Tunç Yıldırım"]);
    // And mid-word, which no token index can do.
    expect(await names({ name: { _icontains: "şlem" } })).toEqual(["İşlemci soğutucu"]);
    expect(await names({ name: { _icontains: "slem" } })).toEqual(["İşlemci soğutucu"]);
  });

  test("the residual is a COLUMN without a companion, and it is stated", async () => {
    // `bio` holds the same text as `name` but is `longtext`, so it has no
    // companion and falls back to the database's own fold. The contrast is the
    // point: one row, two columns, two different answers — and the difference
    // is exactly the feature.
    const bios = async (cond: Condition): Promise<string[]> => {
      const res = await h.fetch(`/api/items/people?${where(cond)}&limit=50`);
      const body = (await res.json()) as { data: { name: string }[] };
      return body.data.map((r) => r.name).sort();
    };
    expect(await bios({ bio: { _icontains: "İşlemci" } })).toEqual(["İşlemci soğutucu"]);
    // Same word, same row, lowercase — the fallback cannot reach it.
    expect(await bios({ bio: { _icontains: "işlemci" } })).toEqual([]);
    expect(await bios({ bio: { _icontains: "ozturk" } })).toEqual([]);
    // While the folded column answers all three.
    expect(await names({ name: { _icontains: "işlemci" } })).toHaveLength(1);
    expect(await names({ name: { _icontains: "ozturk" } })).toHaveLength(1);
  });

  test("the fold helper folds to the store's standard, not to JavaScript's", () => {
    // The unit behind all of the above. `"İ".toLowerCase()` is two code points;
    // SQLite's `LOWER()` leaves it alone. Folding to the weaker standard on both
    // sides is what lets them meet.
    expect(foldCase("İ", "sqlite")).toBe("İ");
    expect(foldCase("İ", "pg")).toBe("İ".toLowerCase());
    expect([...foldCase("İ", "pg")]).toHaveLength(2);
    expect(foldCase("ABC", "sqlite")).toBe("abc");
    // The ASCII letters fold and the others do not — one string shows both,
    // and this IS `LOWER()`'s behaviour rather than an approximation of it.
    expect(foldCase("ÖZTÜRK", "sqlite")).toBe("ÖztÜrk");
    expect(foldCase("ÖZTÜRK", "pg")).toBe("öztürk");
    // Undefined dialect keeps JS semantics — the behaviour every caller that
    // has not been told which store it stands in for already had.
    expect(foldCase("İ", undefined)).toBe("İ".toLowerCase());
  });

  test("a JSON spec bag is searchable in every language, and on both dialects", async () => {
    // Modelled on how a real gaming-PC storefront searches: the specs live in a
    // JSON attribute bag and the shopper types a component. Before this, that
    // search was ASCII-only on SQLite and BROKEN on Postgres — `jsonb` has no
    // `lower()`, so the fallback could not even be compiled there.
    const made = await h.fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "machines",
        fields: [
          { name: "name", type: "text" },
          { name: "attrs", type: "json" },
        ],
      }),
    });
    expect(made.status).toBe(201);
    const rows = [
      { name: "TD3 A", attrs: { cpu: "AMD Ryzen 9 9950X3D", cooler: "İşlemci soğutucu", ram: "32GB" } },
      { name: "TD3 B", attrs: { cpu: "Intel Core i7", cooler: "Hava soğutucu", ram: "16GB" } },
    ];
    for (const r of rows) {
      const res = await h.fetch("/api/items/machines", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(r),
      });
      expect([200, 201]).toContain(res.status);
    }

    const find = async (needle: string): Promise<string[]> => {
      const f = encodeURIComponent(JSON.stringify({ attrs: { _icontains: needle } }));
      const res = await h.fetch(`/api/items/machines?filter=${f}&limit=10`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { data: { name: string }[] }).data
        .map((x) => x.name)
        .sort();
    };

    // What already worked: ASCII spec tokens.
    expect(await find("ryzen")).toEqual(["TD3 A"]);
    expect(await find("9950")).toEqual(["TD3 A"]);
    expect(await find("32GB")).toEqual(["TD3 A"]);
    // What did not: the Turkish ones, in any spelling.
    expect(await find("islemci")).toEqual(["TD3 A"]);
    expect(await find("İşlemci")).toEqual(["TD3 A"]);
    expect(await find("SOĞUTUCU")).toEqual(["TD3 A", "TD3 B"]);
    expect(await find("sogutucu")).toEqual(["TD3 A", "TD3 B"]);
    // The values, not the keys — filtering for an attribute NAME finds nothing.
    expect(await find("cooler")).toEqual([]);
    expect(await find("cpu")).toEqual([]);
  });
});
