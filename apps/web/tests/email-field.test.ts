/**
 * Email fields — the codec, the parser, the field rules, and the write/filter
 * paths.
 *
 * The claim under test is narrow and total: **whatever a human types or pastes,
 * the column holds one canonical string.** Everything else the type does —
 * `unique` meaning one mailbox, a lookup by address matching, a mail server
 * accepting the value — follows from that one property, so these tests attack it
 * directly rather than testing the consequences.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  allowedEmailDomains,
  canonicalizeEmail,
  domainToAscii,
  domainToUnicode,
  EMAIL_RE,
  formatEmail,
  isEmail,
  parseEmail,
  parseEmailForField,
  punycodeDecode,
  punycodeEncode,
  tryParseEmail,
  validateEmailSpec,
} from "../../../packages/db/src/email";
import {
  sqlTypeFor,
  validateFields,
  validateValue,
} from "../../../packages/db/src/field-types";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("punycode — RFC 3492", () => {
  /**
   * Verbatim test vectors from RFC 3492 §7.1.
   *
   * Fixed strings rather than a comparison against the platform's `URL`
   * parser, on purpose: the runtime's IDNA is a dependency, and pinning to it
   * would mean this suite agrees with whatever Bun links today rather than with
   * the standard. (The two WERE cross-checked while this was written, over
   * twenty domains spanning Arabic, Cyrillic, Korean, Hebrew and the Turkish
   * dotted capital İ, and agreed on all of them.)
   */
  const VECTORS: [string, string][] = [
    ["ليهمابتكلموشعربي؟", "egbpdaj6bu4bxfgehfvwxn"],
    ["他们为什么不说中文", "ihqwcrb4cv8a8dqg056pqjye"],
    ["こんにちは", "28j2a3ar1p"],
    ["bücher", "bcher-kva"],
    ["örnek", "rnek-4qa"],
    ["münchen", "mnchen-3ya"],
    ["مثال", "mgbh0fb"],
    // All-basic input still gets the delimiter, which is the case an
    // implementation that short-circuits on "no non-ASCII" gets wrong.
    ["hello-world", "hello-world-"],
  ];

  test("encodes every vector exactly", () => {
    for (const [unicode, puny] of VECTORS) {
      expect(punycodeEncode(unicode)).toBe(puny);
    }
  });

  test("decodes every vector back", () => {
    for (const [unicode, puny] of VECTORS) {
      expect(punycodeDecode(puny)).toBe(unicode);
    }
  });

  test("round-trips a corpus, including outside the BMP", () => {
    // Code points, not UTF-16 units — an emoji label encoded as two lone
    // surrogates round-trips to mojibake, and some registries really do sell
    // these.
    for (const s of ["日本語", "ÅÄÖ", "ñ", "中文域名", "emoji😀", "a-b-ç"]) {
      expect(punycodeDecode(punycodeEncode(s))).toBe(s);
    }
  });

  test("a label that merely starts with xn-- is not a promise", () => {
    // `domainToUnicode` runs on stored values in list cells and CSV exports, so
    // a throw there would blank a whole row. It hands back what it was given.
    expect(domainToUnicode("xn--zzzzzzzz$.com")).toBe("xn--zzzzzzzz$.com");
    expect(() => punycodeDecode("zzzz$")).toThrow();
  });

  test("NFC first — the same domain typed two ways folds to one A-label", () => {
    // `é` as U+00E9 and as `e` + U+0301 are the same domain and only one of them
    // resolves. Without the normalize they encode to different A-labels and land
    // in the column as two different addresses.
    const composed = domainToAscii("caf\u00E9.com"); // é as one code point
    const decomposed = domainToAscii("cafe\u0301.com"); // e + combining acute
    expect(decomposed).toBe(composed);
    expect(composed).toBe("xn--caf-dma.com");
  });
});

describe("parseEmail — canonicalization", () => {
  test("the same address written five ways lands on one string", () => {
    for (const written of [
      "ada@example.com",
      "Ada@Example.com",
      "  ADA@EXAMPLE.COM  ",
      "<ada@example.com>",
      " <Ada@Example.COM> ",
    ]) {
      expect(parseEmail(written).email).toBe("ada@example.com");
    }
  });

  test("an internationalized domain is stored in the form a mail server resolves", () => {
    const p = parseEmail("ada@örnek.com");
    expect(p.email).toBe("ada@xn--rnek-4qa.com");
    expect(p.unicodeDomain).toBe("örnek.com");
    // …and reads back as the domain a person recognises, for display only.
    expect(formatEmail(p.email, "unicode")).toBe("ada@örnek.com");
    expect(formatEmail(p.email)).toBe("ada@xn--rnek-4qa.com");
  });

  test("the local part folds by default and is preserved on request", () => {
    expect(parseEmail("Ada.Lovelace@Example.com").email).toBe("ada.lovelace@example.com");
    // RFC 5321 reserves the local part to the receiving server, so the fold is a
    // policy — one a workspace can turn off. The DOMAIN still folds, because
    // that half is a fact (DNS is case-insensitive).
    expect(parseEmail("Ada.Lovelace@Example.com", { caseSensitiveLocal: true }).email).toBe(
      "Ada.Lovelace@example.com",
    );
  });

  test("a subaddress is kept — it is a working, distinct address", () => {
    // Stripping `+tag` is a per-provider convention. Applying it to a provider
    // that does not share it destroys deliverability.
    expect(parseEmail("ada+news@example.com").email).toBe("ada+news@example.com");
  });

  test("refuses the shapes that are legal but are where the escaping bugs live", () => {
    for (const bad of [
      '"ada bell"@example.com', // quoted local part
      "ada@[192.0.2.1]", // address literal — bypasses DNS entirely
      "ada@localhost", // one label; deliverable only inside one machine
      "ada@@example.com",
      "@example.com",
      "ada@",
      "ada example@x.com",
      "a,b@example.com",
      "a;b@example.com",
      "a<b@example.com",
      'a"b@example.com',
      "ada@-example.com",
      "ada@example-.com",
    ]) {
      expect(tryParseEmail(bad)).toBeNull();
    }
  });

  test("length caps are enforced, and BEFORE any pattern runs", () => {
    expect(tryParseEmail(`${"a".repeat(65)}@example.com`)).toBeNull();
    expect(tryParseEmail(`ada@${"a".repeat(64)}.com`)).toBeNull();
    expect(tryParseEmail(`${"a".repeat(60)}@${"b".repeat(200)}.com`)).toBeNull();
    // The guard that matters is that an unbounded string never reaches a regex.
    // A megabyte of text returns promptly rather than being matched against.
    const started = performance.now();
    expect(tryParseEmail(`${"a".repeat(1_000_000)}@example.com`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });

  test("a canonical value satisfies the strict pattern; an unfolded one does not", () => {
    // The point of keeping EMAIL_RE lowercase-only: "this value is canonical" is
    // a property worth being able to assert.
    expect(EMAIL_RE.test("ada@example.com")).toBe(true);
    expect(EMAIL_RE.test("Ada@Example.com")).toBe(false);
    expect(canonicalizeEmail("Ada@Example.com")).toBe("ada@example.com");
    expect(canonicalizeEmail("not an address")).toBeNull();
    expect(isEmail("ada@example.com")).toBe(true);
    expect(isEmail("ada@localhost")).toBe(false);
  });

  test("a message never quotes the address", () => {
    // These reach activity rows and logs, and the value identifies a real person.
    try {
      parseEmail("ada@localhost");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("ada");
    }
  });
});

describe("the domain allow-list", () => {
  test("admits a subdomain of a listed domain", () => {
    const spec = { allowedDomains: ["example.com"] };
    expect(parseEmailForField("ada@example.com", spec).email).toBe("ada@example.com");
    expect(parseEmailForField("ada@mail.example.com", spec).email).toBe("ada@mail.example.com");
    expect(() => parseEmailForField("ada@notexample.com", spec)).toThrow();
    // …and does NOT admit a domain that merely ends with the same letters.
    expect(() => parseEmailForField("ada@myexample.com", spec)).toThrow();
  });

  test("the rule and the values it judges are compared in the same alphabet", () => {
    // Written readably, folded to A-labels on use — otherwise a rule naming
    // `örnek.com` would refuse every address at `örnek.com`.
    const spec = { allowedDomains: ["örnek.com"] };
    expect(allowedEmailDomains(spec)).toEqual(["xn--rnek-4qa.com"]);
    expect(parseEmailForField("ada@örnek.com", spec).email).toBe("ada@xn--rnek-4qa.com");
  });

  test("the refusal names the domains and not the address", () => {
    try {
      parseEmailForField("ada@elsewhere.com", { allowedDomains: ["example.com"] });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("example.com");
      expect((e as Error).message).not.toContain("elsewhere.com");
    }
  });

  test("an unreadable rule refuses every address instead of admitting them", () => {
    // `validateEmailSpec` refuses these at save time, so metadata shaped like
    // this only reaches the parser another way — a restore, an import, a direct
    // write. A domain restriction gates who gets mailed, so the safe reading of
    // one nobody can parse is "nothing passes", not "everything does".
    const unreadable = { allowedDomains: ["not a domain"] };
    expect(allowedEmailDomains(unreadable)).toEqual([]);
    expect(() => parseEmailForField("ada@example.com", unreadable)).toThrow(/allowedDomains/);

    // Non-strings are skipped rather than handed to `.trim()`, which would throw
    // a TypeError out of a validator and 500 the write instead of refusing it.
    const mixed = { allowedDomains: [42 as never, "example.com"] };
    expect(allowedEmailDomains(mixed)).toEqual(["example.com"]);
    expect(parseEmailForField("ada@example.com", mixed).email).toBe("ada@example.com");
    expect(() => parseEmailForField("ada@elsewhere.com", mixed)).toThrow();

    // Non-vacuous: a spec with no `allowedDomains` at all still admits anything.
    expect(allowedEmailDomains({})).toBeNull();
    expect(parseEmailForField("ada@anywhere.com", {}).email).toBe("ada@anywhere.com");
  });

  test("a rule that could never match anything is refused at save time", () => {
    expect(() => validateEmailSpec({ allowedDomains: ["not a domain"] })).toThrow();
    expect(() => validateEmailSpec({ allowedDomains: [] })).toThrow();
    expect(() => validateEmailSpec({ display: "utf8" as never })).toThrow();
    expect(() => validateEmailSpec({ allowedDomains: ["example.com"] })).not.toThrow();
  });
});

describe("field rules", () => {
  const field = (extra: Record<string, unknown> = {}) => ({
    name: "email",
    type: "email" as const,
    ...extra,
  });

  test("validateValue refuses a non-address and accepts an address", () => {
    expect(() => validateValue(field(), "ada@example.com")).not.toThrow();
    expect(() => validateValue(field(), "ada@localhost")).toThrow();
  });

  test("the domain allow-list is enforced by validateValue itself", () => {
    // Unlike `phone`, nothing an email field needs lives in a sibling column —
    // there is no per-row region to defer — so a value that reaches the column
    // has already been judged completely.
    const f = field({ email: { allowedDomains: ["example.com"] } });
    expect(() => validateValue(f, "ada@example.com")).not.toThrow();
    expect(() => validateValue(f, "ada@elsewhere.com")).toThrow();
  });

  test("the flags that would make the type meaningless are refused", () => {
    for (const extra of [
      { vectorize: true }, // an embedding of an address is noise, and it puts a
      // real mailbox into a vector store
      { localized: true }, // an address is not different in French
      { computed: "1" },
      { rollup: { collection: "x", field: "y", aggregate: "sum" } },
      { sequence: { pattern: "{SEQ}" } },
      { default: "ada@example.com" }, // would mail every unfilled row the same person
    ]) {
      expect(() => validateFields([field(extra)])).toThrow();
    }
  });

  test("the flags that are the POINT of the type are allowed", () => {
    expect(() =>
      validateFields([field({ unique: true, indexed: true, searchable: true })]),
    ).not.toThrow();
  });

  test("an email config on a non-email field is refused", () => {
    expect(() =>
      validateFields([{ name: "x", type: "text", email: { caseSensitiveLocal: true } } as never]),
    ).toThrow();
  });

  test("storage is identical to text, which is what made the conversion metadata", () => {
    // Fifty-eight template columns converted at once because of this. If the
    // column type ever diverges, `applyCollection` — which is additive by
    // design — would need an ALTER it will never emit.
    expect(sqlTypeFor("email", "sqlite")).toBe(sqlTypeFor("text", "sqlite"));
    expect(sqlTypeFor("email", "pg")).toBe(sqlTypeFor("text", "pg"));
  });
});

describe("the write path", () => {
  let h: TestHarness;
  const slug = "em_contacts";
  let table = "";

  const stored = async (id: string): Promise<unknown> => {
    const r = await h.fetch(
      "/api/admin/db/sql/run",
      json({ sql: `SELECT email FROM ${table} WHERE id = '${id}'` }),
    );
    return ((await r.json()) as any).data?.[0]?.rows?.[0]?.email;
  };

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    const created = await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "email", type: "email" },
        ],
      }),
    );
    table = ((await created.json()) as any).data.physicalTable;
    expect(table.length).toBeGreaterThan(0);
  });

  test("the 201 body carries the canonical value, not what was sent", async () => {
    // The `geo` lesson: `performCreate` builds its response, its realtime event
    // and its activity row from the PAYLOAD. Canonicalizing only in `serialize`
    // would hand the caller a string that does not equal the row just made.
    const r = await h.fetch(`/api/items/${slug}`, json({ name: "a", email: "  Ada@Example.COM " }));
    const body = (await r.json()) as any;
    expect(r.status).toBe(201);
    expect(body.data.email).toBe("ada@example.com");
    expect(await stored(body.data.id)).toBe("ada@example.com");
  });

  test("a patch folds too, with no row needed to do it", async () => {
    const created = (await (
      await h.fetch(`/api/items/${slug}`, json({ name: "b" }))
    ).json()) as any;
    const patched = (await (
      await h.fetch(
        `/api/items/${slug}/${created.data.id}`,
        json({ email: "BOB@Example.com" }, "PATCH"),
      )
    ).json()) as any;
    expect(patched.data.email).toBe("bob@example.com");
  });

  test("an unparseable address is a 422 naming the field and not the value", async () => {
    const r = await h.fetch(`/api/items/${slug}`, json({ name: "d", email: "carol@localhost" }));
    expect(r.status).toBe(422);
    const body = (await r.json()) as any;
    expect(body.error.message).toContain("email");
    expect(body.error.message).not.toContain("carol");
  });

  test("an empty value clears the column rather than failing", async () => {
    const created = (await (
      await h.fetch(`/api/items/${slug}`, json({ name: "e", email: "eve@example.com" }))
    ).json()) as any;
    await h.fetch(`/api/items/${slug}/${created.data.id}`, json({ email: "" }, "PATCH"));
    expect(await stored(created.data.id)).toBeNull();
  });

  test("a filter written the way a human types it still matches", async () => {
    // Without operand canonicalization the feature only half lands: values go in
    // folded and queries come in as typed, so this returns nothing — which is
    // indistinguishable from "no such customer". It is also the exact bug every
    // consumer in this repo was already working around by hand.
    await h.fetch(`/api/items/${slug}`, json({ name: "findme", email: "Findme@Example.com" }));
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(
        JSON.stringify({ email: { _eq: "FINDME@example.COM" } }),
      )}`,
    );
    const body = (await r.json()) as any;
    expect(body.data.map((x: any) => x.name)).toContain("findme");
  });

  test("`everyone at this company` is folded too — the query anyone actually writes", async () => {
    // Where email parts company with phone, which passes substring operators
    // through untouched. A canonical E.164 has no case; a canonical address is
    // folded text, so `_ends_with: "@Example.com"` would match nothing at all.
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(
        JSON.stringify({ email: { _ends_with: "@Example.com" } }),
      )}`,
    );
    const body = (await r.json()) as any;
    expect(body.data.map((x: any) => x.name)).toContain("findme");
  });

  test("…including when the domain is written in its own alphabet", async () => {
    // The column holds the A-label, but `display: "unicode"` shows the operator
    // `ada@örnek.com` — and searching the string the admin just printed has to
    // find the row. A fragment anchored at the `@` is a WHOLE domain, so it can
    // be encoded the same way the column was.
    await h.fetch(`/api/items/${slug}`, json({ name: "intl", email: "Ada@ÖRNEK.com" }));
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(
        JSON.stringify({ email: { _ends_with: "@örnek.com" } }),
      )}`,
    );
    const body = (await r.json()) as any;
    expect(body.data.map((x: any) => x.email)).toEqual(["ada@xn--rnek-4qa.com"]);

    // Non-vacuous: the un-encoded fragment is what used to be sent, and it
    // matches nothing — which is the bug this pins.
    const raw = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(
        JSON.stringify({ email: { _contains: "örnek.com" } }),
      )}`,
    );
    expect(((await raw.json()) as any).data).toEqual([]);
  });

  test("an operand that is not an address is compared literally", async () => {
    // So an operator can still find the rows a normalization pass has not
    // reached yet, by searching for the raw string still sitting in them.
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(
        JSON.stringify({ email: { _eq: "still raw" } }),
      )}`,
    );
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).data).toEqual([]);
  });
});

describe("unique finally means one mailbox", () => {
  let h: TestHarness;
  const slug = "em_members";

  beforeAll(async () => {
    h = makeHarness();
    await seedAdmin(h);
    await h.fetch(
      "/api/collections",
      json({
        slug,
        fields: [
          { name: "name", type: "text", required: true },
          { name: "email", type: "email", unique: true },
        ],
      }),
    );
  });

  test("the same person written two ways is refused the second time", async () => {
    // The whole point. Fourteen template columns declare `unique` on an email
    // and, while the column was plain text, every one of them let this through.
    const first = await h.fetch(`/api/items/${slug}`, json({ name: "a", email: "ada@example.com" }));
    expect(first.status).toBe(201);
    const second = await h.fetch(
      `/api/items/${slug}`,
      json({ name: "b", email: "Ada@Example.COM" }),
    );
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});
