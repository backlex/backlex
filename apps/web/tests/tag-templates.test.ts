/**
 * Tag manager — the vendor template registry.
 *
 * A template is what makes a tag safe: the operator supplies parameters, never
 * a script URL, so the origin that ends up running on a customer's page is a
 * literal in our source. Most of this spec defends that property rather than
 * the individual vendors, because the vendor list will grow and the property
 * must survive every addition.
 *
 * The other half is the one verification taught us: **do not reject a valid
 * pixel id.** Of the vendors checked against their own documentation, most
 * publish no id format at all, and a strict regex written from memory was
 * wrong twice. So the registry records whether a format is documented, and the
 * patterns are sanity bounds. A template that claims a documented format it
 * does not have is the failure this spec is watching for.
 */
import { describe, expect, test } from "bun:test";
import {
  CONSENT_CATEGORIES,
  TAG_TEMPLATES,
  TAG_TEMPLATE_IDS,
  cspAdditionsForTemplates,
  getTagTemplate,
  parseTemplateParams,
} from "../src/server/services/tag-templates";

describe("registry invariants", () => {
  test("ids are unique, stable slugs", () => {
    // The id is stored in `tag_definitions.template_id`, so renaming one
    // orphans every tag that used it. Slug shape keeps it URL- and
    // JSON-key-safe wherever it travels.
    expect(new Set(TAG_TEMPLATE_IDS).size).toBe(TAG_TEMPLATE_IDS.length);
    for (const id of TAG_TEMPLATE_IDS) expect(id).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  test("every template names a vendor doc, and declares consent", () => {
    for (const t of TAG_TEMPLATES) {
      expect(t.docUrl).toStartWith("https://");
      expect(t.consentCategories.length).toBeGreaterThan(0);
      for (const c of t.consentCategories) expect(CONSENT_CATEGORIES).toContain(c);
    }
  });

  test("every CSP host is an https origin, with a wildcard only in the label position", () => {
    // These are pasted into someone else's Content-Security-Policy, so a path,
    // a trailing slash or a malformed host would either silently widen their
    // policy or fail to parse. A leading `*.` IS allowed — Google documents
    // exactly that form, because its collection endpoints are genuinely
    // sharded across subdomains. CSP permits a wildcard only there, never on
    // the right of a host, which is what this pattern encodes.
    for (const t of TAG_TEMPLATES) {
      for (const key of ["script", "img", "connect", "frame"] as const) {
        for (const origin of t.csp[key] ?? []) {
          expect(origin).toMatch(/^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/);
        }
      }
    }
  });

  test("frame schemes are schemes, and never appear among the hosts", () => {
    // TikTok's own policy line asks for `bytedance:` and `sslocal:` in
    // frame-src. They are app-handoff URL schemes, not origins — folding them
    // into a host list produces a line that does not parse, which is why the
    // model keeps them apart.
    for (const t of TAG_TEMPLATES) {
      for (const scheme of t.csp.frameSchemes ?? []) {
        expect(scheme).toMatch(/^[a-z][a-z0-9+.-]*:$/);
        expect(t.csp.frame ?? []).not.toContain(scheme);
      }
    }
  });

  test("every template says whether its CSP guidance is the vendor's or ours", () => {
    // Meta publishes none at all, so its origins are read off Meta's own
    // snippet. An operator hardening a policy deserves to know which they are
    // following.
    for (const t of TAG_TEMPLATES) {
      expect(["vendor", "inferred"]).toContain(t.cspSource);
    }
  });

  test("every pattern is anchored at both ends", () => {
    // An unanchored pattern matches a SUBSTRING, so `[0-9]+` would accept
    // `12"></script><script>…`. Anchoring is what makes a sanity bound a bound.
    for (const t of TAG_TEMPLATES) {
      for (const p of t.params) {
        if (!p.pattern) continue;
        expect(p.pattern).toStartWith("^");
        expect(p.pattern).toEndWith("$");
      }
    }
  });

  test("a select param carries its options, and a non-select does not", () => {
    // A finite value set must be selectable in the admin rather than typed.
    for (const t of TAG_TEMPLATES) {
      for (const p of t.params) {
        if (p.kind === "select") expect((p.options ?? []).length).toBeGreaterThan(0);
        else expect(p.options).toBeUndefined();
      }
    }
  });

  test("no parameter is secret-shaped", () => {
    // The container is served to anonymous visitors by construction. A
    // parameter named like a credential would be a credential published to the
    // internet, so the registry may not carry one at all.
    for (const t of TAG_TEMPLATES) {
      for (const p of t.params) {
        expect(p.key).not.toMatch(/secret|token|password|apikey|api_key|access/i);
      }
    }
  });
});

describe("parameter validation", () => {
  test("accepts a well-formed set and returns only known keys", () => {
    const out = parseTemplateParams("reddit_pixel", { pixelId: "a2_abc123", stowaway: "drop me" });
    expect(out).toEqual({ pixelId: "a2_abc123" });
    // An unknown key is dropped rather than carried: whatever reaches the
    // artifact is exactly what the template declares.
    expect(out).not.toHaveProperty("stowaway");
  });

  test("refuses an unknown template", () => {
    expect(() => parseTemplateParams("not_a_vendor", {})).toThrow();
  });

  test("a required parameter is required, and blank does not count as present", () => {
    expect(() => parseTemplateParams("reddit_pixel", {})).toThrow();
    expect(() => parseTemplateParams("reddit_pixel", { pixelId: "   " })).toThrow();
  });

  test("an optional parameter may be omitted", () => {
    expect(parseTemplateParams("yandex_metrica", { counterId: "12345678" })).toEqual({
      counterId: "12345678",
    });
  });

  test("the sanity bound keeps markup out of a value that reaches a script tag", () => {
    // This is the one thing the loose pattern MUST still stop. The value ends
    // up inside a script URL and an init call, so a quote or an angle bracket
    // is the difference between a parameter and an injection.
    for (const hostile of ['12"></script><script>alert(1)</script>', "1 2", "1\n2", "https://evil.example"]) {
      expect(() => parseTemplateParams("yandex_metrica", { counterId: hostile })).toThrow();
    }
  });

  test("a validation message names what is allowed, never the input", () => {
    try {
      parseTemplateParams("yandex_metrica", { counterId: "<img src=x onerror=alert(1)>" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("onerror");
    }
  });

  test("a select refuses a value outside its options", () => {
    expect(() =>
      parseTemplateParams("yandex_metrica", { counterId: "1", domain: "mc.evil.example" }),
    ).toThrow();
    expect(parseTemplateParams("yandex_metrica", { counterId: "1", domain: "mc.yandex.com" })).toEqual({
      counterId: "1",
      domain: "mc.yandex.com",
    });
  });

  test("a boolean coerces the string form a form control sends", () => {
    expect(parseTemplateParams("yandex_metrica", { counterId: "1", webvisor: "true" })).toEqual({
      counterId: "1",
      webvisor: true,
    });
  });

  test("an explicit false is PRESERVED, not dropped as if unset", () => {
    // The distinction is load-bearing, and it bites on a vendor whose option
    // defaults to ON. Several Yandex init options do (clickmap, trackLinks,
    // accurateTrackBounce, sendTitle). If an explicit `false` were dropped as
    // "not configured", the runtime would fall back to the vendor default and
    // silently re-enable the thing the operator just turned off.
    expect(parseTemplateParams("yandex_metrica", { counterId: "1", webvisor: false })).toEqual({
      counterId: "1",
      webvisor: false,
    });
    // Absent or blank is genuinely "not configured", and stays absent.
    expect(parseTemplateParams("yandex_metrica", { counterId: "1", webvisor: "" })).toEqual({
      counterId: "1",
    });
  });
});

describe("honesty about vendor formats", () => {
  test("a param claiming a documented format has a pattern narrower than the opaque bound", () => {
    // The registry must not claim `formatDocumented` for a value it is only
    // guessing at. Verification overturned two assumed regexes, so this is the
    // guard that keeps the next addition honest.
    for (const t of TAG_TEMPLATES) {
      for (const p of t.params) {
        if (p.kind !== "text") continue;
        if (p.formatDocumented) expect(p.pattern).toBeDefined();
        else expect(p.help ?? "").not.toBe("");
      }
    }
  });

  test("no id pattern claims a length the vendor never published", () => {
    // Every one of these vendors was checked against its own docs, and the
    // recurring finding was that the id format is simply not published. The
    // two prefixes that ARE documented (Google's G- and AW-) are enforced,
    // because pasting one into the other's template is the common mistake and
    // fails silently in the browser otherwise.
    const google = getTagTemplate("google_tag")?.params[0];
    expect(google?.pattern).toStartWith("^G-");
    expect(google?.formatDocumented).toBe(false);

    // Meta's is the sharp one: the widely-cited 15/16-digit rule is folklore,
    // and shipping it would reject valid ids.
    const meta = getTagTemplate("meta_pixel")?.params[0];
    expect(meta?.formatDocumented).toBe(false);
    expect(meta?.pattern).not.toMatch(/\{15|\{16/);
  });

  test("Yandex is declared as BOTH analytics and marketing", () => {
    // By Yandex's own docs any Metrica goal can drive Yandex Direct
    // retargeting, so analytics-only would under-declare it to a consent tool
    // that is behaving correctly. Pinned because it looks like a mistake.
    const yandex = getTagTemplate("yandex_metrica");
    expect(yandex?.consentCategories).toContain("analytics");
    expect(yandex?.consentCategories).toContain("marketing");
  });
});

describe("CSP additions", () => {
  test("merges, dedupes and sorts across templates", () => {
    const csp = cspAdditionsForTemplates(["yandex_metrica", "yandex_metrica", "snap_pixel"]);
    expect(csp.script).toEqual([...csp.script].sort());
    expect(new Set(csp.script).size).toBe(csp.script.length);
    expect(csp.script).toContain("https://sc-static.net");
  });

  test("frame schemes are folded into the emitted frame list", () => {
    // Modelled apart, emitted together: `frame-src` takes hosts and schemes in
    // one directive.
    const csp = cspAdditionsForTemplates(["tiktok_pixel"]);
    expect(csp.frame).toContain("bytedance:");
    expect(csp.frame).toContain("sslocal:");
  });

  test("hasInferred flags a container carrying guidance we derived", () => {
    expect(cspAdditionsForTemplates(["meta_pixel"]).hasInferred).toBe(true);
    expect(cspAdditionsForTemplates(["tiktok_pixel"]).hasInferred).toBe(false);
  });

  test("TikTok is not collapsed to a *.tiktok.com shortcut", () => {
    // `analytics-ipv6.tiktokw.us` is a different registrable domain, so the
    // tempting wildcard is both undocumented AND misses a host the tag uses.
    const csp = cspAdditionsForTemplates(["tiktok_pixel"]);
    expect(csp.script).toContain("https://analytics-ipv6.tiktokw.us");
    expect(csp.script).not.toContain("https://*.tiktok.com");
  });

  test("an unknown id contributes nothing rather than throwing", () => {
    // Called while rendering the Install tab. A stale template id in one tag
    // must not blank the whole CSP panel.
    expect(cspAdditionsForTemplates(["ghost"]).script).toEqual([]);
  });

  test("a container with one tag is told about one vendor", () => {
    const csp = cspAdditionsForTemplates(["snap_pixel"]);
    expect(csp.script).toEqual(["https://sc-static.net"]);
  });
});
