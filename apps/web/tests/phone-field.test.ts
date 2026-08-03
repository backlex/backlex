/**
 * Phone fields — the parser, the field rules, and the write/filter paths.
 *
 * The claim under test is narrow and total: **whatever a human types, the
 * column holds one canonical E.164 string.** Everything else the type does —
 * `unique` meaning something, a lookup by number matching, an SMS provider
 * accepting the value — follows from that one property, so these tests attack
 * it directly rather than testing the consequences.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { E164_PATTERN } from "@backlex/core/adapters";
import {
  assertPhoneShaped,
  callingCodeFor,
  formatPhone,
  parsePhone,
  parsePhoneForField,
  splitCallingCode,
  trunkPrefixFor,
  validatePhoneSpec,
} from "../../../packages/db/src/phone";
import { validateFields, validateValue } from "../../../packages/db/src/field-types";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("parsePhone — canonicalization", () => {
  test("the same Turkish number written six ways lands on one string", () => {
    for (const written of [
      "+905321112233",
      "+90 532 111 22 33",
      "+90 (532) 111-22-33",
      "0532 111 22 33",
      "0532-111-2233",
      "00905321112233",
    ]) {
      expect(parsePhone(written, "TR").e164).toBe("+905321112233");
    }
  });

  test("a NANP number keeps all ten digits — there is no trunk prefix to strip", () => {
    // The case a blanket "drop the leading zero" rule cannot get wrong, but a
    // blanket "the first digit is a trunk code" rule can.
    expect(parsePhone("(415) 555-2671", "US").e164).toBe("+14155552671");
    expect(parsePhone("4155552671", "US").e164).toBe("+14155552671");
    expect(trunkPrefixFor("US")).toBeNull();
  });

  test("Italy KEEPS its leading zero, which is the case a naive rule breaks", () => {
    // `06 …` in Rome is `+39 06 …`. Stripping the 0 produces a number that does
    // not connect, and nothing downstream would ever flag it.
    expect(parsePhone("06 1234567", "IT").e164).toBe("+39061234567");
    expect(trunkPrefixFor("IT")).toBeNull();
  });

  test("the post-Soviet trunk code is 8, not 0", () => {
    expect(parsePhone("8 (495) 123-45-67", "RU").e164).toBe("+74951234567");
    expect(trunkPrefixFor("RU")).toBe("8");
  });

  test("a national number that already carries its own country code is not doubled", () => {
    // The shape a spreadsheet export produces: the `+` is gone but the country
    // code is still there. Taking it as national would give `+9090532…`.
    expect(parsePhone("905321112233", "TR").e164).toBe("+905321112233");
  });

  test("`011` is an IDD prefix only where it is actually dialled", () => {
    // From the NANP, `011 90 532…` is an international call to Turkey.
    expect(parsePhone("011905321112233", "US").e164).toBe("+905321112233");
    // Elsewhere `011…` is an ordinary national number — an Algiers landline —
    // and treating it as an access prefix would route it to another country.
    expect(parsePhone("011 23 45 67", "DZ").e164).toBe("+213112345 67".replace(/\s/g, ""));
  });

  test("a leading zero in a plan that has no trunk prefix is refused", () => {
    // Found on a real screen: a Turkish national number read as American became
    // `+105329998877` — twelve digits, leading `1`, satisfies E.164's envelope,
    // dials nothing. The bundled table already knows NANP numbers never start
    // with 0, so this is a check, not a guess.
    expect(() => parsePhone("0532 999 88 77", "US")).toThrow(/do not start with 0/);
    expect(() => parsePhone("0612345678", "ES")).toThrow(/do not start with 0/);
    // …and Italy is exempt, because there the 0 IS the number.
    expect(parsePhone("06 1234567", "IT").e164).toBe("+39061234567");
  });

  test("a national number with no region is refused rather than guessed at", () => {
    expect(() => parsePhone("0532 111 22 33")).toThrow(/no default region/);
  });

  test("an international number ignores the region entirely", () => {
    // The region says Turkey; the value says Germany. The value wins, because
    // the caller stated it.
    expect(parsePhone("+4915112345678", "TR").e164).toBe("+4915112345678");
  });

  test("an extension is refused, never silently dropped", () => {
    // Dropping it changes who the number reaches.
    for (const written of ["+1 415 555 2671 x123", "+14155552671 ext. 9", "+14155552671 ext 9"]) {
      expect(() => parsePhone(written, "US")).toThrow(/extension/);
    }
  });

  test("too many digits is refused, and says how many", () => {
    expect(() => parsePhone("+9051234567890123456", "TR")).toThrow(/at most 15/);
  });

  test("a country code nothing recognises is a typo, not a country", () => {
    expect(() => parsePhone("+9995551234567")).toThrow(/known country calling code/);
  });

  test("an absurdly long value is refused before any regex sees it", () => {
    // Found in the security review of this branch's own code: the extension
    // pattern ends `\s*\d+\s*$` behind an alternation that can start at every
    // whitespace character, so a megabyte of spaces POSTed to a phone field
    // would backtrack quadratically. Nothing upstream caps a JSON string's
    // length, so the cap is at the door.
    // Whitespace in the MIDDLE — leading/trailing runs are collapsed by `trim`
    // before any pattern runs, so they were never the dangerous shape.
    const bomb = `+90${" ".repeat(200_000)}1`;
    const started = performance.now();
    expect(() => parsePhone(bomb, "TR")).toThrow(/too long/);
    expect(() => assertPhoneShaped(bomb)).toThrow(/too long/);
    // Generous, but orders of magnitude below what the unguarded pattern costs.
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("letters and empty values are refused", () => {
    expect(() => parsePhone("call me", "TR")).toThrow();
    expect(() => parsePhone("", "TR")).toThrow();
    expect(() => parsePhone(null, "TR")).toThrow();
  });

  test("a number from a JSON/CSV import (where the + was eaten) still parses", () => {
    expect(parsePhone(905321112233, "TR").e164).toBe("+905321112233");
  });

  test("an unknown default region is reported as a CONFIG error, not a bad value", () => {
    // Otherwise an admin's typo presents as every operator's number being
    // malformed, which sends them looking in exactly the wrong place.
    expect(() => parsePhone("0532 111 22 33", "ZZ")).toThrow(/not a known country code/);
  });

  test("no error message ever quotes the number", () => {
    // These messages reach activity rows, flow-run logs and the response body.
    const secret = "5321112233";
    for (const bad of [`${secret} x99`, `+999${secret}`, `${secret}${secret}`]) {
      let msg = "";
      try {
        parsePhone(bad, "TR");
      } catch (e) {
        msg = (e as Error).message;
      }
      // Proven non-vacuous: each input really did throw.
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain(secret);
    }
  });
});

describe("parsePhone — agreement with the SMS adapters", () => {
  test("everything it produces satisfies the envelope the adapters enforce", () => {
    // `E164_PATTERN` lives in @backlex/core (the adapters' package) and `E164_RE`
    // in @backlex/db (which core may not depend on), so the two cannot be merged
    // into one constant. Instead of trusting that two hand-written regexes stay
    // in step, this asserts it over a corpus — the same move as any other twin
    // that spans a dependency boundary.
    const corpus: [string, string][] = [
      ["0532 111 22 33", "TR"],
      ["(415) 555-2671", "US"],
      ["06 1234567", "IT"],
      ["8 (495) 123-45-67", "RU"],
      ["020 7946 0958", "GB"],
      ["06 12345678", "HU"],
      ["612345678", "ES"],
      ["+49 151 12345678", "DE"],
      ["030 12345678", "DE"],
      ["+81 3 1234 5678", "JP"],
    ];
    for (const [written, region] of corpus) {
      const out = parsePhone(written, region).e164;
      expect(E164_PATTERN.test(out)).toBe(true);
    }
  });
});

describe("formatting and the calling-code table", () => {
  test("`spaced` splits only where the bundled table justifies a split", () => {
    expect(formatPhone("+905321112233", "e164")).toBe("+905321112233");
    expect(formatPhone("+905321112233", "spaced")).toBe("+90 5321112233");
    expect(formatPhone("+14155552671", "spaced")).toBe("+1 4155552671");
  });

  test("a value that is not canonical is returned untouched, never mangled", () => {
    // An adopted column can hold anything; a display helper must not take the
    // page down or invent a shape for it.
    expect(formatPhone("call reception", "spaced")).toBe("call reception");
    expect(formatPhone(null)).toBe("");
  });

  test("longer calling codes win over the shorter ones they start with", () => {
    // +35 does not exist, but +350 (Gibraltar) and +351 (Portugal) do, and +1
    // must not swallow +1242.
    expect(splitCallingCode("+35012345678")?.code).toBe("350");
    expect(splitCallingCode("+351912345678")?.code).toBe("351");
    expect(callingCodeFor("tr")).toBe("90");
  });
});

describe("field rules", () => {
  const phoneField = (extra: Record<string, unknown> = {}) => ({
    name: "phone",
    type: "phone" as const,
    ...extra,
  });

  test("a phone field with no config is valid — it just insists on `+`", () => {
    expect(() => validateFields([phoneField()])).not.toThrow();
  });

  test("flags that would take the column away from the parser are refused", () => {
    for (const bad of [
      { vectorize: true },
      { localized: true },
      { default: "+905321112233" },
    ]) {
      expect(() => validateFields([phoneField(bad)])).toThrow(/not allowed on a phone field/);
    }
    // `rollup` and `sequence` are refused too, but by their OWN validators,
    // which run first and give a more specific message ("a rollup field must be
    // type integer, number or money"). Asserting the phone-worded message here
    // would be asserting the order the checks happen to run in.
    for (const bad of [
      { rollup: { from: "x", via: "y", fn: "count" } },
      { sequence: { pattern: "{SEQ}" } },
    ]) {
      expect(() => validateFields([phoneField(bad)])).toThrow();
    }
  });

  test("`unique` and `indexed` are deliberately allowed — they are the point", () => {
    // On a text phone column `unique` enforced nothing, because the same person
    // written two ways never collided.
    expect(() => validateFields([phoneField({ unique: true, indexed: true })])).not.toThrow();
  });

  test("a phone config on a non-phone field is refused", () => {
    expect(() =>
      validateFields([{ name: "x", type: "text", phone: { region: "TR" } } as never]),
    ).toThrow(/requires a phone field/);
  });

  test("an unknown region or region column fails at SAVE time", () => {
    expect(() => validatePhoneSpec({ region: "ZZ" }, [])).toThrow(/alpha-2/);
    expect(() => validatePhoneSpec({ allowedRegions: ["TR", "ZZ"] }, [])).toThrow(/unknown/);
    expect(() => validatePhoneSpec({ regionField: "nope" }, ["country"])).toThrow(/unknown field/);
    expect(() => validatePhoneSpec({ regionField: "country" }, ["country"])).not.toThrow();
  });

  test("`allowedRegions` refuses a number from outside, without quoting it", () => {
    const spec = { region: "TR", allowedRegions: ["TR"] };
    expect(parsePhoneForField("0532 111 22 33", spec).e164).toBe("+905321112233");
    let msg = "";
    try {
      parsePhoneForField("+4915112345678", spec);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/allowed country/);
    expect(msg).not.toContain("15112345678");
  });

  test("allowing one NANP territory allows the shared code, and says so by behaving", () => {
    // E.164 does not distinguish them either; pretending otherwise would reject
    // valid numbers.
    expect(parsePhoneForField("+14165551234", { allowedRegions: ["US"] }).e164).toBe(
      "+14165551234",
    );
  });

  test("validateValue is lenient exactly when the region is one column over", () => {
    // With a static region it can parse for real…
    expect(() => validateValue(phoneField({ phone: { region: "TR" } }), "0532 111 22 33")).not.toThrow();
    expect(() => validateValue(phoneField({ phone: { region: "TR" } }), "hello")).toThrow();
    // …but with `regionField` and no default it must NOT, or a perfectly good
    // national number 422s purely because its region is in a sibling column.
    const deferred = phoneField({ phone: { regionField: "country" } });
    expect(() => validateValue(deferred, "0532 111 22 33")).not.toThrow();
    // Junk is still junk in every country.
    expect(() => validateValue(deferred, "call me")).toThrow();
    expect(() => assertPhoneShaped("+1 415 555 2671 x2")).toThrow(/extension/);
  });
});

describe("the write path", () => {
  let h: TestHarness;
  const slug = "ph_contacts";
  let table = "";

  const stored = async (id: string): Promise<unknown> => {
    const r = await h.fetch(
      "/api/admin/db/sql/run",
      json({ sql: `SELECT phone FROM ${table} WHERE id = '${id}'` }),
    );
    return ((await r.json()) as any).data?.[0]?.rows?.[0]?.phone;
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
          { name: "country", type: "text" },
          { name: "phone", type: "phone", phone: { region: "TR", regionField: "country" } },
        ],
      }),
    );
    table = ((await created.json()) as any).data.physicalTable;
    expect(table.length).toBeGreaterThan(0);
  });

  test("the 201 body carries the canonical value, not what was sent", () => {
    // The `geo` lesson: `performCreate` builds its response, its realtime event
    // and its activity row from the PAYLOAD. Canonicalizing only in `serialize`
    // would echo back a number no SMS provider accepts while the column held
    // something else.
    return h
      .fetch(`/api/items/${slug}`, json({ name: "a", phone: "0532 111 22 33" }))
      .then(async (r) => {
        const body = (await r.json()) as any;
        expect(r.status).toBe(201);
        expect(body.data.phone).toBe("+905321112233");
        expect(await stored(body.data.id)).toBe("+905321112233");
      });
  });

  test("the row's own country column beats the field default", async () => {
    const r = await h.fetch(
      `/api/items/${slug}`,
      json({ name: "b", country: "DE", phone: "030 12345678" }),
    );
    const body = (await r.json()) as any;
    expect(body.data.phone).toBe("+493012345678");
  });

  test("a patch that sets only the number reads the region off the stored row", async () => {
    const created = (await (
      await h.fetch(`/api/items/${slug}`, json({ name: "c", country: "DE" }))
    ).json()) as any;
    const patched = (await (
      await h.fetch(`/api/items/${slug}/${created.data.id}`, json({ phone: "030 12345678" }, "PATCH"))
    ).json()) as any;
    expect(patched.data.phone).toBe("+493012345678");
  });

  test("an unparseable number is a 422 naming the field and not the value", async () => {
    const r = await h.fetch(`/api/items/${slug}`, json({ name: "d", phone: "5551234 ext 9" }));
    expect(r.status).toBe(422);
    const body = (await r.json()) as any;
    expect(body.error.message).toContain("phone");
    expect(body.error.message).not.toContain("5551234");
  });

  test("an empty value clears the column rather than failing", async () => {
    const created = (await (
      await h.fetch(`/api/items/${slug}`, json({ name: "e", phone: "0532 111 22 33" }))
    ).json()) as any;
    await h.fetch(`/api/items/${slug}/${created.data.id}`, json({ phone: "" }, "PATCH"));
    expect(await stored(created.data.id)).toBeNull();
  });

  test("a filter written the way a human says the number still matches", async () => {
    // Without operand canonicalization the feature only half lands: values go in
    // canonical and queries come in as typed, so this returns nothing — which is
    // indistinguishable from "no such customer".
    await h.fetch(`/api/items/${slug}`, json({ name: "findme", phone: "+905329998877" }));
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ phone: { _eq: "0532 999 88 77" } }))}`,
    );
    const body = (await r.json()) as any;
    expect(body.data.map((x: any) => x.name)).toContain("findme");
  });

  test("a substring filter is left alone, because a fragment is not a number", async () => {
    // `_contains` is the query an operator actually types when they only
    // remember the last digits; canonicalizing the operand would fail on it.
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(JSON.stringify({ phone: { _contains: "9998877" } }))}`,
    );
    const body = (await r.json()) as any;
    expect(body.data.map((x: any) => x.name)).toContain("findme");
  });

  test("`unique` on a phone column finally means one number is one row", async () => {
    const uniq = "ph_uniq";
    await h.fetch(
      "/api/collections",
      json({
        slug: uniq,
        fields: [{ name: "phone", type: "phone", phone: { region: "TR" }, unique: true }],
      }),
    );
    const first = await h.fetch(`/api/items/${uniq}`, json({ phone: "+905321112233" }));
    expect(first.status).toBe(201);
    // Written completely differently, and on a text column this would have been
    // a second row.
    const second = await h.fetch(`/api/items/${uniq}`, json({ phone: "0532 111 22 33" }));
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});
