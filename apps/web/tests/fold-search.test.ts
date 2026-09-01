/**
 * The fold every case-insensitive filter is compared in.
 *
 * This is a pure function with one job, and the whole feature rests on it: if
 * the fold is wrong, a search is wrong in a way no integration test can explain
 * afterwards. So it is tested as a specification — what it promises, in the
 * languages it promises it for — rather than by a handful of examples.
 *
 * The comparison the tests are written against is not arbitrary. It is what
 * SQLite's own FTS5 `unicode61` tokenizer already does for whole-word search,
 * measured on the same corpus, so the two search surfaces this product ships
 * agree about what "the same word" means. Where the fold goes FURTHER —
 * mid-word substrings, `ß`, `æ`, `ø`, Turkish dotless `ı` — that is stated as
 * its own test rather than left as a happy accident.
 */
import { describe, expect, test } from "bun:test";
import {
  FOLD_SUFFIX,
  foldColumn,
  foldSearch,
  foldStored,
  isFoldColumn,
  jsonSearchText,
} from "@backlex/db";

const fold = foldSearch;

describe("foldSearch", () => {
  test("Turkish: every spelling of a word reaches the same form", () => {
    // The dotted capital is the one that breaks naive implementations —
    // `"İ".toLowerCase()` is TWO code points, not one.
    for (const spelling of ["İşlemci", "işlemci", "İŞLEMCİ", "ISLEMCI", "islemci"]) {
      expect(fold(spelling)).toBe("islemci");
    }
    // And the dotless pair, which even FTS5's tokenizer does not merge.
    for (const spelling of ["Işıl", "ışıl", "IŞIL", "isil", "Isil"]) {
      expect(fold(spelling)).toBe("isil");
    }
    expect(fold("Yıldırım")).toBe(fold("yildirim"));
    expect(fold("Öztürk")).toBe(fold("ozturk"));
    expect(fold("Ayşe Çelik")).toBe(fold("ayse celik"));
    expect(fold("Tunç")).toBe(fold("TUNC"));
  });

  test("German, Nordic, Polish, Icelandic: the letters that do not decompose", () => {
    // NFKD leaves every one of these exactly as it found them, so without the
    // map `strasse` could never find `Straße`. This is the half a
    // decompose-and-strip implementation silently misses.
    expect(fold("Straße")).toBe("strasse");
    expect(fold("STRASSE")).toBe("strasse");
    expect(fold("Ærø")).toBe("aero");
    expect(fold("Køge")).toBe("koge");
    expect(fold("Łódź")).toBe("lodz");
    expect(fold("Þór")).toBe("thor");
    expect(fold("Reykjavík")).toBe("reykjavik");
    expect(fold("Đukić")).toBe("dukic");
    expect(fold("Bakı")).toBe("baki"); // Azerbaijani dotless ı
    expect(fold("Əli")).toBe("eli"); // Azerbaijani schwa
  });

  test("Greek, Cyrillic, Vietnamese: scripts beyond Latin", () => {
    expect(fold("ΑΘΗΝΑ")).toBe(fold("αθηνα"));
    expect(fold("Ελλάδα")).toBe(fold("ελλαδα"));
    expect(fold("Блины")).toBe(fold("блины"));
    expect(fold("МОСКВА")).toBe(fold("москва"));
    // Vietnamese stacks two marks on one letter; both come off.
    expect(fold("Nguyễn")).toBe("nguyen");
    expect(fold("Đà Nẵng")).toBe("da nang");
  });

  test("ligatures and compatibility forms, because a paste carries them", () => {
    // NFKD's compatibility half. Text pasted out of a PDF or a word processor
    // routinely carries these, and nobody types them.
    expect(fold("ﬁnans")).toBe("finans");
    expect(fold("m²")).toBe("m2");
    expect(fold("Ⅻ")).toBe("xii");
    expect(fold("ｆｕｌｌｗｉｄｔｈ")).toBe("fullwidth");
  });

  test("idempotent, total, and it leaves ordinary text alone", () => {
    // Idempotence matters operationally: a backfill that runs twice, or a value
    // that is re-saved, must not drift.
    for (const s of ["İstanbul", "Straße", "", "plain ascii", "ΑΘΗΝΑ", "Nguyễn"]) {
      expect(fold(fold(s))).toBe(fold(s));
    }
    expect(fold("")).toBe("");
    expect(fold("hello world 123")).toBe("hello world 123");
    // Punctuation and spacing survive — this is a substring fold, not a
    // tokenizer, and `SKU-001` has to stay findable as `sku-001`.
    expect(fold("SKU-001/A")).toBe("sku-001/a");
  });

  test("mid-word substrings work — the thing a token index cannot do", () => {
    const haystack = fold("İşlemci soğutucu");
    expect(haystack).toBe("islemci sogutucu");
    // Every one of these is a real substring of the folded form, and NONE of
    // them is a token, so FTS5 returns nothing for any of them.
    for (const needle of ["şlem", "slem", "emci so", "ĞUTU", "gutu"]) {
      expect(haystack.includes(fold(needle))).toBe(true);
    }
  });

  test("every entry in the non-decomposing map earns its place", () => {
    // An unreachable entry is a line that reads as if it were doing work. NFKD
    // already handles `å`, `ç`, `ş`, `ğ`, `ü`, `ö` and the long `ſ`; if one of
    // those were added here, this fails.
    const decomposes = (c: string) =>
      c.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase() !== c;
    // Reach into the fold by behaviour rather than by exporting the table: a
    // character the map handles folds to something OTHER than itself while
    // NFKD alone would have left it untouched.
    const mapped = ["ß", "æ", "œ", "ø", "đ", "ð", "ħ", "ł", "ŋ", "þ", "ı", "ə"];
    for (const c of mapped) {
      expect(`${c} decomposes=${decomposes(c)}`).toBe(`${c} decomposes=false`);
      expect(fold(c)).not.toBe(c);
    }
    // And the ones deliberately left out are handled anyway.
    for (const c of ["å", "ç", "ş", "ğ", "ü", "ö", "ż", "ų", "ſ"]) {
      expect(`${c} → ${fold(c)}`).not.toBe(`${c} → ${c}`);
    }
  });

  test("the companion column name is reserved and recognisable", () => {
    expect(foldColumn("name")).toBe(`name${FOLD_SUFFIX}`);
    expect(isFoldColumn(foldColumn("name"))).toBe(true);
    expect(isFoldColumn("name")).toBe(false);
    // A user field cannot be mistaken for one — the suffix is double-underscore
    // prefixed, which the field-name rule already keeps out of user columns.
    expect(isFoldColumn("fold")).toBe(false);
  });

  test("a JSON attribute bag folds its VALUES, not its keys or punctuation", () => {
    // The shape a spec filter actually searches. Folding `JSON.stringify(v)`
    // would put the key names and the braces into the haystack, so filtering
    // for "cpu" would match a row because its attribute is CALLED cpu.
    const attrs = {
      cpu: "AMD Ryzen 9 9950X3D",
      ram: "32GB 6000MHz CL36",
      os: "Windows 11 Pro",
      inStock: true,
      warranty: null,
      tags: ["oyun", "İşlemci soğutucu"],
      nested: { gpu: "RX 9060 XT", bench: 240 },
    };
    const hay = fold(jsonSearchText(attrs));

    // Values are there — including nested ones, array members and numbers.
    for (const needle of ["ryzen", "9950x3d", "32gb", "windows 11", "rx 9060", "240"]) {
      expect(hay.includes(fold(needle))).toBe(true);
    }
    // Turkish inside a JSON value folds like anywhere else.
    expect(hay.includes(fold("islemci"))).toBe(true);
    expect(hay.includes(fold("SOĞUTUCU"))).toBe(true);

    // Keys are NOT — this is the whole reason it is not `JSON.stringify`.
    for (const key of ["cpu", "inStock", "warranty", "nested", "bench"]) {
      expect(`${key}: ${hay.includes(fold(key))}`).toBe(`${key}: false`);
    }
    // Nor are booleans, nulls or JSON punctuation.
    expect(hay).not.toContain("true");
    expect(hay).not.toContain("null");
    expect(hay).not.toContain("{");
  });

  test("the JSON walk is bounded, so one write cannot become a traversal", () => {
    // Depth and breadth caps. A hostile — or merely enormous — document must
    // not turn a single insert into unbounded work on the write path.
    let deep: unknown = "needle";
    for (let i = 0; i < 40; i++) deep = { next: deep };
    expect(jsonSearchText(deep)).toBe("");

    const wide = Array.from({ length: 5000 }, (_, i) => `v${i}`);
    const out = jsonSearchText(wide).split(" ");
    expect(out.length).toBeLessThan(2_100);
    expect(out.length).toBeGreaterThan(100);
  });

  test("foldStored takes a column as the dialect keeps it, on either dialect", () => {
    // SQLite hands back JSON as TEXT, Postgres as an object. One answer.
    const v = { cpu: "İşlemci Öztürk", ram: "32GB" };
    expect(foldStored("json", JSON.stringify(v))).toBe(foldStored("json", v));
    expect(foldStored("json", v)).toContain("islemci ozturk");
    // Plain text is unchanged by the JSON branch.
    expect(foldStored("text", "Straße")).toBe("strasse");
    // Absent stays absent — a NULL companion is how "not folded" is recorded.
    expect(foldStored("json", null)).toBeNull();
    expect(foldStored("text", undefined)).toBeNull();
    // An adopted column holding unparseable text is folded as text, not dropped.
    expect(foldStored("json", "not json İ")).toBe(fold("not json İ"));
  });
});
