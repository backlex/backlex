/**
 * URL fields — the parser, the field rules, and the write/filter paths.
 *
 * The claim under test is narrow and total: **whatever a human types or pastes,
 * the column holds one canonical string.** Everything else the type does —
 * `unique` meaning one endpoint, a lookup by address matching, a fetch resolving
 * the host someone meant — follows from that one property, so these tests attack
 * it directly rather than testing the consequences.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import {
  allowedUrlHosts,
  canonicalizeUrl,
  formatUrl,
  isUrl,
  isUrlWithScheme,
  parseUrl,
  parseUrlForField,
  tryParseUrl,
  urlSchemes,
  validateUrlSpec,
} from "../../../packages/db/src/url";
import { sqlTypeFor, validateFields, validateValue } from "../../../packages/db/src/field-types";
import { makeHarness, seedAdmin, type TestHarness } from "./setup";

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("canonicalization — the one property everything else rests on", () => {
  /**
   * Each pair is a way the same address gets written and the single string the
   * column is supposed to end up holding.
   *
   * These are the differences that made `unique` meaningless on a URL column:
   * every left-hand side is a string a person or another system really produces,
   * and before this type they were all distinct rows.
   */
  const FOLDS: [string, string][] = [
    // Scheme and host are case-insensitive (RFC 3986 §3.1, §3.2.2).
    ["HTTPS://Acme.COM/Path", "https://acme.com/Path"],
    // …but the path is NOT, and folding it would break the resource.
    ["https://acme.com/Path", "https://acme.com/Path"],
    // A default port means the same endpoint as no port.
    ["https://acme.com:443/", "https://acme.com/"],
    ["http://acme.com:80/x", "http://acme.com/x"],
    // …and a non-default one is load-bearing, so it stays.
    ["https://acme.com:8443/x", "https://acme.com:8443/x"],
    // The empty path is `/` — what the URL Standard itself serializes.
    ["https://acme.com", "https://acme.com/"],
    // The scheme is supplied when a person just types the host.
    ["acme.com", "https://acme.com/"],
    ["www.acme.com/a", "https://www.acme.com/a"],
    // An internationalized host reaches the column in the form a resolver
    // answers for.
    ["https://örnek.com/a", "https://xn--rnek-4qa.com/a"],
    // The root's trailing dot names the same host.
    ["https://acme.com./x", "https://acme.com/x"],
    // Dot segments resolve.
    ["https://acme.com/a/../b", "https://acme.com/b"],
    // Surrounding whitespace is what pasting produces.
    ["  https://acme.com/x  ", "https://acme.com/x"],
    // Query and fragment are carried verbatim — order and case belong to the
    // server that defined them.
    ["https://acme.com/?b=2&a=1#Frag", "https://acme.com/?b=2&a=1#Frag"],
  ];

  test("every spelling folds to the one canonical string", () => {
    for (const [raw, canonical] of FOLDS) {
      expect(parseUrl(raw).url).toBe(canonical);
    }
  });

  test("folding is idempotent — a canonical value survives a second pass", () => {
    // The property that lets the write path run unconditionally: re-saving a row
    // must not keep rewriting it, or every update churns the column and the
    // changefeed.
    for (const [, canonical] of FOLDS) {
      expect(parseUrl(canonical).url).toBe(canonical);
    }
  });

  test("two spellings of one address become one string", () => {
    // Stated directly, because this is the whole argument for the type: on a
    // `text` column these were two rows and one site, and `unique` caught
    // neither.
    expect(canonicalizeUrl("HTTPS://Acme.com")).toBe(canonicalizeUrl("https://acme.com/"));
    expect(canonicalizeUrl("acme.com")).toBe(canonicalizeUrl("https://acme.com:443/"));
  });
});

describe("the host is folded by THIS package, and agrees with the platform", () => {
  /**
   * The one component of a URL whose folding is not literal string work is the
   * host, and IDNA is the one piece with a history of divergence between
   * implementations. The admin runs in a browser and the write path runs in
   * workerd or Bun, so if the two disagreed the value an operator was shown
   * while typing would not be the value stored.
   *
   * `parseUrl` therefore folds the host with this package's own `domainToAscii`
   * — the same function the `email` type uses, which is what makes those two
   * types unable to disagree about what a domain is. This test pins that it also
   * agrees with the platform, so a divergence shows up here rather than as a
   * mismatched cell.
   */
  const HOSTS = [
    "örnek.com",
    "münchen.de",
    "日本.jp",
    "bücher.example.co.uk",
    "café.fr",
    "xn--rnek-4qa.com",
    "ACME.com",
    "emoji💩.example",
  ];

  test("every host folds the same way the platform's URL parser folds it", () => {
    for (const h of HOSTS) {
      expect(parseUrl(`https://${h}/a`).host).toBe(new URL(`https://${h}/a`).hostname);
    }
  });

  test("a url host and an email domain fold identically", () => {
    // Both go through `domainToAscii`, so a company's website and its people's
    // addresses land on the same string for the same domain.
    for (const h of HOSTS) {
      expect(parseUrl(h, { form: "host" }).url).toBe(
        canonicalizeUrl(`https://${h}/`)?.slice("https://".length, -1) ?? "",
      );
    }
  });
});

describe("what is refused, and why", () => {
  test("a scheme nothing here can fetch or render safely", () => {
    // `new URL()` parses all of these happily, which is exactly why GraphQL's
    // scheme-less `try { new URL(x) } catch` was the loosest of the five old
    // answers — `javascript:` passed it.
    for (const raw of ["javascript:alert(1)", "mailto:a@b.com", "ftp://acme.com/", "data:,x"]) {
      expect(tryParseUrl(raw)).toBeNull();
    }
  });

  test("credentials are refused rather than stored", () => {
    // The column is exported, logged and shown in list cells. `URL` keeps these,
    // so nothing else in the pipeline would have noticed.
    expect(tryParseUrl("https://user:pass@acme.com/")).toBeNull();
    expect(tryParseUrl("https://user@acme.com/")).toBeNull();
  });

  test("the error never quotes the value", () => {
    // A URL can carry a capability in its path or its query, and these messages
    // reach activity rows and logs. Same rule geo drew about addresses.
    try {
      parseUrl("https://user:s3cr3t@acme.com/reset?token=abc123");
      throw new Error("should have refused");
    } catch (e) {
      expect((e as Error).message).not.toContain("s3cr3t");
      expect((e as Error).message).not.toContain("abc123");
    }
  });

  test("a value that is not a URL at all", () => {
    for (const raw of ["not a url", "https://", "", "   ", 42, null, undefined, {}]) {
      expect(tryParseUrl(raw)).toBeNull();
    }
  });

  test("an over-long value is rejected before any pattern runs", () => {
    // The cap bounds every pattern in the module regardless of what arrives —
    // the ReDoS lesson `phone` paid for.
    expect(tryParseUrl(`https://acme.com/${"a".repeat(5000)}`)).toBeNull();
  });

  test("an over-long HOST is refused before the IDNA encoder sees it", () => {
    // Found in this branch's own security review. Punycode is quadratic in the
    // number of DISTINCT code points in a label, so a 2000-character run of them
    // cost ~20ms of CPU — reachable from the write path AND, through the prefix
    // fold, from the read path once per filter operand. A string longer than a
    // host cannot BE a host, so the bound is the host's maximum and not the
    // URL's.
    const distinct = (n: number) =>
      Array.from({ length: n }, (_, i) => String.fromCodePoint(0x100 + i)).join("");
    expect(tryParseUrl(`https://${distinct(2000)}/`)).toBeNull();
    const started = performance.now();
    tryParseUrl(`https://${distinct(2000)}/`);
    // Generous: the point is that it is not quadratic, not that it hits a
    // particular number on a particular machine.
    expect(performance.now() - started).toBeLessThan(10);
  });
});

describe("an internal host is accepted — the deployments this product lives in", () => {
  /**
   * The single-label host is the reason `URL_HOST_RE` is laxer than `HOST_RE`.
   * A self-hosted install points its webhooks at exactly these, and the SSRF
   * guard is off by default on self-host precisely to keep them working — so a
   * URL field that refused one would break the setup it is most used in.
   */
  test("localhost, a bare service name, and an IP literal", () => {
    expect(parseUrl("http://localhost:9000/hook").url).toBe("http://localhost:9000/hook");
    expect(parseUrl("http://receiver/").url).toBe("http://receiver/");
    expect(parseUrl("http://192.168.1.5/hook").url).toBe("http://192.168.1.5/hook");
    expect(parseUrl("https://[::1]:8080/x").url).toBe("https://[::1]:8080/x");
  });

  test("`localhost:3000` reads as a host and a port, not as a scheme", () => {
    // The trap: `localhost:3000` IS a well-formed URL to the URL Standard —
    // scheme `localhost:`, opaque path `3000`. Requiring `//` after the scheme
    // is what makes it mean what the person typing it meant.
    expect(parseUrl("localhost:3000").url).toBe("https://localhost:3000/");
  });

  test("accepting an internal host is NOT the same as agreeing to fetch it", () => {
    // Storing one is a schema question; fetching one is `fetchOutbound`'s, at
    // fetch time. Keeping them separate is why this type does no network call.
    expect(isUrl("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });
});

describe("form: host — the two columns named `domain`", () => {
  const spec = { form: "host" } as const;

  test("a bare domain is what it holds", () => {
    expect(parseUrl("acme.com", spec).url).toBe("acme.com");
    expect(parseUrl("ACME.com.", spec).url).toBe("acme.com");
    expect(parseUrl("örnek.com", spec).url).toBe("xn--rnek-4qa.com");
  });

  test("a whole URL is refused — the distortion the old regex caused", () => {
    // Both templates' sample rows said `https://acme.example` in a column named
    // `domain`, because the shared `^https?://.+` demanded a scheme. That value
    // can never be compared with the right-hand side of an email address, which
    // is the entire reason the column exists.
    expect(tryParseUrl("https://acme.example", spec)).toBeNull();
    expect(tryParseUrl("acme.com/orders", spec)).toBeNull();
  });

  test("a single label and an IP address are refused", () => {
    // `localhost` is not a company's domain, and an IPv4 literal satisfies the
    // registrable pattern by accident — digits are ordinary label characters.
    expect(tryParseUrl("localhost", spec)).toBeNull();
    expect(tryParseUrl("192.168.1.5", spec)).toBeNull();
    // …but a domain that merely looks numeric is fine.
    expect(parseUrl("1.2.3.4.com", spec).url).toBe("1.2.3.4.com");
  });

  test("it pairs with the email type — the same domain, folded the same way", () => {
    // Why `host` is worth having at all: a CRM matches a company by the
    // right-hand side of its people's addresses, and both sides now fold
    // identically.
    expect(parseUrl("ÖRNEK.com", spec).url).toBe("xn--rnek-4qa.com");
  });
});

describe("the spec, and what an unreadable one means", () => {
  test("`schemes` narrows what is accepted AND what the autofill supplies", () => {
    const https = { schemes: ["https"] };
    expect(tryParseUrl("http://acme.com/", https)).toBeNull();
    expect(parseUrl("acme.com", https).url).toBe("https://acme.com/");
  });

  test("a declared-but-unreadable `schemes` refuses everything", () => {
    // The fail-open this nearly shipped as, and the same one the email type's
    // security review caught: stored field metadata is untrusted, so `"https"`
    // arriving as a STRING must not fall back to the default and quietly admit
    // the `http` the field was configured to keep out.
    for (const bad of [{ schemes: [] }, { schemes: ["ftp"] }, { schemes: "https" }, { schemes: 1 }]) {
      expect(urlSchemes(bad as never)).toEqual([]);
      expect(tryParseUrl("https://acme.com/", bad as never)).toBeNull();
    }
  });

  test("an ABSENT `schemes` is a different answer from an unreadable one", () => {
    // Three answers, not two — absent means "no restriction", and the default
    // applies.
    expect(urlSchemes(undefined)).toEqual(["https", "http"]);
    expect(urlSchemes({})).toEqual(["https", "http"]);
  });

  test("`allowedHosts` admits subdomains and refuses everything else", () => {
    const spec = { allowedHosts: ["example.com"] };
    expect(parseUrlForField("https://docs.example.com/x", spec).url).toBe(
      "https://docs.example.com/x",
    );
    expect(() => parseUrlForField("https://evil.test/x", spec)).toThrow();
    // Not a suffix match on the raw string — `notexample.com` must not pass.
    expect(() => parseUrlForField("https://notexample.com/x", spec)).toThrow();
  });

  test("a declared-but-unreadable `allowedHosts` refuses everything too", () => {
    // EVERY unreadable shape, not just the one that happens to be an array.
    // The first version of this function tested `!Array.isArray(...)` first and
    // so collapsed "not declared" and "declared as a string" into the same
    // `null`, which meant a restriction arriving from a restore or a
    // hand-written import silently stopped running. Only `undefined` is
    // unrestricted.
    for (const bad of [
      { allowedHosts: [123] },
      { allowedHosts: "partner.example" },
      { allowedHosts: [] },
      { allowedHosts: {} },
      { allowedHosts: null },
    ]) {
      expect(allowedUrlHosts(bad as never)).toEqual([]);
      expect(() => parseUrlForField("https://acme.com/", bad as never)).toThrow();
    }
    // …and absent still means "any host", which is the common case.
    expect(allowedUrlHosts(undefined)).toBeNull();
    expect(allowedUrlHosts({})).toBeNull();
    expect(() => parseUrlForField("https://acme.com/", {})).not.toThrow();
  });

  test("a rule that could never match anything fails at save time", () => {
    expect(() => validateUrlSpec({ allowedHosts: ["not a host"] })).toThrow();
    expect(() => validateUrlSpec({ schemes: ["ftp"] as never })).toThrow();
    expect(() => validateUrlSpec({ form: "host", schemes: ["https"] })).toThrow();
    expect(() => validateUrlSpec({ display: "klingon" as never })).toThrow();
    expect(() => validateUrlSpec({ allowedHosts: ["example.com"], form: "url" })).not.toThrow();
  });
});

describe("display", () => {
  test("`unicode` renders the host a person recognises", () => {
    expect(formatUrl("https://xn--rnek-4qa.com/a", "unicode")).toBe("https://örnek.com/a");
  });

  test("the FORM has to be passed, or a host renders as an address", () => {
    // A stored bare host is a string the URL parser accepts once the scheme
    // autofill has run, so guessing prints `https://acme.com/` in a cell whose
    // value is `acme.com`.
    expect(formatUrl("xn--rnek-4qa.com", "unicode", "host")).toBe("örnek.com");
    expect(formatUrl("acme.com", "ascii", "host")).toBe("acme.com");
  });

  test("`ascii` is the stored value, untouched", () => {
    expect(formatUrl("https://xn--rnek-4qa.com/a")).toBe("https://xn--rnek-4qa.com/a");
  });
});

describe("field rules", () => {
  const field = (extra: Record<string, unknown> = {}) => ({
    name: "website",
    type: "url" as const,
    ...extra,
  });

  test("the flags that would make the type meaningless are refused", () => {
    for (const extra of [
      { vectorize: true }, // an embedding of a URL matches on spelling, not content
      { localized: true },
      { computed: "1" },
      { rollup: { collection: "x", field: "y", aggregate: "sum" } },
      { sequence: { pattern: "{SEQ}" } },
    ]) {
      expect(() => validateFields([field(extra)])).toThrow();
    }
  });

  test("the flags that are the POINT of the type are allowed", () => {
    expect(() =>
      validateFields([field({ unique: true, indexed: true, searchable: true })]),
    ).not.toThrow();
  });

  test("a default IS allowed — unlike email, which would mail a stranger", () => {
    expect(() => validateFields([field({ default: "https://acme.com/" })])).not.toThrow();
    // …but it still has to be a URL the field would accept.
    expect(() => validateFields([field({ default: "javascript:alert(1)" })])).toThrow();
    expect(() =>
      validateFields([field({ default: "http://acme.com/", url: { schemes: ["https"] } })]),
    ).toThrow();
  });

  test("a url config on a non-url field is refused", () => {
    expect(() =>
      validateFields([{ name: "x", type: "text", url: { form: "host" } } as never]),
    ).toThrow();
  });

  test("validateValue enforces the whole rule, not just the shape", () => {
    // Unlike `phone`, which can only prove a value is phone-SHAPED here because
    // its region may live in a sibling column, a url field carries everything it
    // needs — so the host allow-list is enforced at validate time and a value
    // that reaches the column has been judged completely.
    const withRule = field({ url: { allowedHosts: ["example.com"] } }) as never;
    expect(() => validateValue(withRule, "https://evil.test/")).toThrow(/website/);
    expect(() => validateValue(withRule, "https://docs.example.com/x")).not.toThrow();
  });

  test("storage is TEXT on sqlite, which is what made that conversion metadata", () => {
    expect(sqlTypeFor("url", "sqlite")).toBe(sqlTypeFor("text", "sqlite"));
  });

  test("storage is `text` on pg, NOT varchar(255) — and that is deliberate", () => {
    // The one place this type breaks the phone/email pattern. A `canonical_url`
    // or a `tracking_url` with campaign parameters goes past 255 routinely, and
    // storing one in a `varchar(255)` would let a value pass the parser and then
    // be refused by Postgres — the write-time/act-time disagreement this type
    // exists to end.
    expect(sqlTypeFor("url", "pg")).toBe("text");
    expect(sqlTypeFor("url", "pg")).not.toBe(sqlTypeFor("text", "pg"));
  });
});

describe("`validation.format: \"url\"` still requires the scheme", () => {
  /**
   * The type and the rule ask the same question about everything after the
   * scheme, and deliberately different questions about the scheme itself.
   *
   * `format: "url"` is a rule on a plain `text` column where NOTHING folds, so
   * accepting the type's `acme.com` shorthand there would let a value pass a
   * check named "is this a URL" and then sit in the column as a string that is
   * not one.
   */
  test("the shorthand is for the type, not for the rule", () => {
    expect(isUrl("acme.com")).toBe(true);
    expect(isUrlWithScheme("acme.com")).toBe(false);
    expect(isUrlWithScheme("https://acme.com/")).toBe(true);
  });

  test("both refuse the things the five old patterns disagreed about", () => {
    for (const raw of ["https://user:pass@acme.com/", "javascript:alert(1)", "https:// acme.com"]) {
      expect(isUrlWithScheme(raw)).toBe(false);
    }
  });
});

describe("the write path", () => {
  let h: TestHarness;
  const slug = "url_sites";
  let table = "";

  const stored = async (id: string, col = "website"): Promise<unknown> => {
    const r = await h.fetch(
      "/api/admin/db/sql/run",
      json({ sql: `SELECT ${col} FROM ${table} WHERE id = '${id}'` }),
    );
    return ((await r.json()) as any).data?.[0]?.rows?.[0]?.[col];
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
          { name: "website", type: "url" },
          { name: "domain", type: "url", url: { form: "host" } },
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
    const r = await h.fetch(`/api/items/${slug}`, json({ name: "a", website: "  Acme.COM " }));
    const body = (await r.json()) as any;
    expect(r.status).toBe(201);
    expect(body.data.website).toBe("https://acme.com/");
    expect(await stored(body.data.id)).toBe("https://acme.com/");
  });

  test("a host column folds by its own rule", async () => {
    const r = await h.fetch(`/api/items/${slug}`, json({ name: "h", domain: "ACME.com." }));
    const body = (await r.json()) as any;
    expect(body.data.domain).toBe("acme.com");
  });

  test("a patch folds too, with no row needed to do it", async () => {
    const created = (await (await h.fetch(`/api/items/${slug}`, json({ name: "b" }))).json()) as any;
    const patched = (await (
      await h.fetch(
        `/api/items/${slug}/${created.data.id}`,
        json({ website: "HTTP://Example.COM:80/A" }, "PATCH"),
      )
    ).json()) as any;
    expect(patched.data.website).toBe("http://example.com/A");
  });

  test("an unparseable value is a 422 naming the field and not the value", async () => {
    const r = await h.fetch(
      `/api/items/${slug}`,
      json({ name: "d", website: "javascript:alert(document.cookie)" }),
    );
    expect(r.status).toBe(422);
    const body = (await r.json()) as any;
    expect(body.error.message).toContain("website");
    expect(body.error.message).not.toContain("cookie");
  });

  test("an empty value clears the column rather than failing", async () => {
    const created = (await (
      await h.fetch(`/api/items/${slug}`, json({ name: "e", website: "https://x.example/" }))
    ).json()) as any;
    await h.fetch(`/api/items/${slug}/${created.data.id}`, json({ website: "" }, "PATCH"));
    expect(await stored(created.data.id)).toBeNull();
  });

  test("a filter written the way a human types it still matches", async () => {
    // Without operand canonicalization the feature only half lands: values go in
    // folded and queries come in as typed, so this returns nothing — which is
    // indistinguishable from "no such site".
    await h.fetch(`/api/items/${slug}`, json({ name: "findme", website: "https://findme.test/" }));
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(
        JSON.stringify({ website: { _eq: "FindMe.test" } }),
      )}`,
    );
    const body = (await r.json()) as any;
    expect(body.data.map((x: any) => x.name)).toContain("findme");
  });

  test("a prefix filter folds the scheme and host it covers", async () => {
    // `_starts_with` is the only fragment operator folded, because it is the
    // only one whose characters are known to be the scheme and the host.
    const r = await h.fetch(
      `/api/items/${slug}?filter=${encodeURIComponent(
        JSON.stringify({ website: { _starts_with: "HTTPS://FindMe.TEST" } }),
      )}`,
    );
    const body = (await r.json()) as any;
    expect(body.data.map((x: any) => x.name)).toContain("findme");
  });

  test("a path fragment is NOT folded — the path is case-sensitive", async () => {
    // Stated as a test because it is a deliberate refusal, not an oversight:
    // lowercasing a `_contains` operand would silently stop `/Invoices/`
    // matching the rows it should. `_icontains` is what an operator reaches for.
    await h.fetch(`/api/items/${slug}`, json({ name: "cased", website: "https://x.test/Invoices" }));
    const hit = (await (
      await h.fetch(
        `/api/items/${slug}?filter=${encodeURIComponent(
          JSON.stringify({ website: { _contains: "/Invoices" } }),
        )}`,
      )
    ).json()) as any;
    expect(hit.data.map((x: any) => x.name)).toContain("cased");
  });

  test("`unique` finally means one endpoint", async () => {
    const uniq = "url_uniq";
    const made = await h.fetch(
      "/api/collections",
      json({
        slug: uniq,
        fields: [
          { name: "name", type: "text" },
          { name: "site", type: "url", unique: true },
        ],
      }),
    );
    expect(made.status).toBe(201);
    const first = await h.fetch(`/api/items/${uniq}`, json({ name: "1", site: "https://dup.test" }));
    expect(first.status).toBe(201);
    // The same site, written the other way. On a `text` column this was a second
    // row; the fold is what makes the constraint able to see it.
    const second = await h.fetch(`/api/items/${uniq}`, json({ name: "2", site: "DUP.test" }));
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});
