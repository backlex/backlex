/**
 * Tag manager — the browser runtime, as source.
 *
 * The runtime is a string until a visitor's browser gets it, which means the
 * usual safety net is gone: a syntax error ships silently and breaks a
 * customer's marketing site rather than our build. So this spec compiles it,
 * checks the escaping rules that make a JS-as-string module survivable, and
 * pins the properties that cannot be allowed to drift.
 */
import { describe, expect, test } from "bun:test";
import { TAG_RUNTIME_JS } from "../src/server/services/tag-runtime";
import { TRACKER_JS } from "../src/server/services/analytics-tracker";
import { CONSENT_BANNER_JS } from "../src/server/services/consent-banner-bundle";
import { TAG_TEMPLATE_IDS } from "../src/server/services/tag-templates";

describe("it is real JavaScript", () => {
  test("the emitted runtime parses", () => {
    // The one check that cannot be skipped. A stray brace in a 600-line string
    // is invisible to typecheck and to lint, and the first thing that would
    // notice is a customer's browser.
    expect(() => new Function(TAG_RUNTIME_JS)).not.toThrow();
  });

  test("it installs exactly one global entry point", () => {
    expect(TAG_RUNTIME_JS).toContain("window.__backlexTM = function");
  });
});

describe("the escaping rules that keep a JS-as-string module survivable", () => {
  test("no backtick and no dollar-brace, which would terminate the literal", () => {
    expect(TAG_RUNTIME_JS).not.toInclude("`");
    expect(TAG_RUNTIME_JS).not.toInclude("${");
  });

  test("a regex survives with its backslash intact", () => {
    // The POSITIVE half, and the one that matters. `analytics-tracker.ts` bans
    // backslashes because a plain template literal eats them, so a regex there
    // ships subtly wrong. These modules are raw literals precisely to lift that
    // ban — asserting the ban is lifted is what proves the lift worked.
    expect(TAG_RUNTIME_JS).toContain("replace(/\\s+/g");
    expect(TAG_RUNTIME_JS).not.toContain("replace(/s+/g");
  });
});

describe("what the runtime must never do", () => {
  test("it never uses eval or new Function", () => {
    // Both need unsafe-eval in the CUSTOMER's Content-Security-Policy, which
    // nothing can grant selectively. Every script this runtime adds is an
    // injected element carrying the loader's nonce instead.
    expect(TAG_RUNTIME_JS).not.toContain("new Function(");
    expect(TAG_RUNTIME_JS).not.toMatch(/[^.\w]eval\(/);
  });

  test("it never uses document.write", () => {
    // After load, document.write destroys the page it is called on.
    expect(TAG_RUNTIME_JS).not.toContain("document.write");
    expect(TAG_RUNTIME_JS).not.toContain("doc.write");
  });

  test("it propagates the loader's nonce to every script it injects", () => {
    expect(TAG_RUNTIME_JS).toContain('setAttribute("nonce", NONCE)');
    // `.nonce` first: a strict policy hides the value from getAttribute while
    // still exposing the property.
    expect(TAG_RUNTIME_JS).toContain("me.nonce");
  });

  test("it boots once", () => {
    expect(TAG_RUNTIME_JS).toContain("__backlexTMBooted");
  });

  test("it refuses an artifact from a future compiler", () => {
    // A rollback can serve a document written by a much older build, and a
    // future one could arrive after a deploy races a cached page. Reading a
    // shape it does not understand is worse than doing nothing.
    expect(TAG_RUNTIME_JS).toContain("container.v !== 1");
  });
});

describe("custom code", () => {
  test("custom HTML is inserted as markup, not run as a script body", () => {
    // Assigning HTML to a script element's .text is a syntax error, so the tag
    // would have fired nothing at all. The two kinds need two different
    // mechanisms and this is the assertion that keeps them apart.
    expect(TAG_RUNTIME_JS).toContain("function injectHtml(html)");
    expect(TAG_RUNTIME_JS).toContain('if (tag.kind === "custom_js") return runInline');
    expect(TAG_RUNTIME_JS).toContain('if (tag.kind === "custom_html") return injectHtml');
  });

  test("scripts inside custom HTML are rebuilt, because innerHTML will not run them", () => {
    // Markup assigned through innerHTML never executes its scripts. Rebuilding
    // each one is what GTM's own custom-HTML tag does, and forgetting it makes
    // a tag that looks installed and does nothing.
    expect(TAG_RUNTIME_JS).toContain("doc.createElement(\"script\")");
    expect(TAG_RUNTIME_JS).toContain("replaceChild(fresh, old)");
  });
});

describe("the vendor table matches the registry", () => {
  test("every server template has a runtime branch", () => {
    // A template with no branch is an option the admin offers and nothing
    // honours — the operator configures a pixel, publishes, and nothing fires.
    for (const id of TAG_TEMPLATE_IDS) {
      expect(TAG_RUNTIME_JS).toContain(`${id}: function`);
    }
  });

  test("TikTok fires through instance(), not the bare queue", () => {
    // ttq.track fans out to EVERY loaded pixel, so a page carrying two TikTok
    // tags double-counts both. Verified against TikTok's own docs, and easy to
    // "simplify" away.
    expect(TAG_RUNTIME_JS).toContain("ttq.instance(p.pixelId)");
  });

  test("Yandex keeps its load timestamp", () => {
    // `ym.l` is load-bearing: a hand-written shim that omits it silently skews
    // Yandex's own timing data.
    expect(TAG_RUNTIME_JS).toContain("window.ym.l = 1 * new Date()");
  });

  test("Reddit carries its id in the loader URL as well as the init call", () => {
    // The shipped library branches on the query parameter's presence.
    expect(TAG_RUNTIME_JS).toContain("pixel.js?pixel_id=");
  });
});

describe("size", () => {
  test("the whole per-site file stays inside its budget", () => {
    // Every visitor downloads this. The budget is deliberately a hard number in
    // a test rather than a note in a doc, because the vendor table is the part
    // that grows and nothing else would notice.
    //
    // ── This assertion used to be worth less than its own title ────────────
    // It summed TAG_RUNTIME_JS + TRACKER_JS and called the result "the whole
    // per-site file". It was not: `/api/site/<id>.js` also carries
    // CONSENT_BANNER_JS on every site running a banner, so the largest body
    // actually served was 60,241 bytes while this measured 47,468 of it — 21%
    // of the file invisible to the only size gate in the suite. A budget that
    // does not see the part that is growing is a budget in name.
    //
    // ── Bytes, not `.length` ───────────────────────────────────────────────
    // CONSENT_BANNER_JS is 12,713 CHARS but 12,773 BYTES: its default wording
    // ships Turkish, and `Çerezler` costs more on the wire than it does in a
    // string. `.length` is what a visitor's connection pays only while every
    // constant stays ASCII, and one of them stopped being ASCII.
    //
    // ── The max over REACHABLE compositions, not a sum ─────────────────────
    // The parts are chosen per site by the same two booleans `bodyFingerprint`
    // keys its four constants on (routes/analytics-collect.ts). Summing every
    // constant would bound a body no visitor is ever served, which is the same
    // class of error as the one above — a number that is not a measurement of
    // anything.
    const size = (s: string) => new TextEncoder().encode(s).byteLength;
    const compositions: [string, string[]][] = [
      ["tracker only", [TRACKER_JS]],
      ["tracker + banner", [TRACKER_JS, CONSENT_BANNER_JS]],
      ["tracker + container", [TRACKER_JS, TAG_RUNTIME_JS]],
      ["tracker + banner + container", [TRACKER_JS, CONSENT_BANNER_JS, TAG_RUNTIME_JS]],
    ];

    // Named in the failure rather than asserted as a bare number, so a red run
    // says WHICH body blew the budget instead of only that one did.
    const measured = compositions.map(
      ([name, parts]) => [name, parts.reduce((n, p) => n + size(p), 0)] as const,
    );
    const worst = measured.reduce((a, b) => (b[1] > a[1] ? b : a));

    // 1,259 bytes of headroom against today's 60,241. Sized so it BITES: the
    // vendor table grows at roughly 600 bytes per template, so two more
    // templates trip this and the raise becomes a decision somebody makes on
    // purpose. That is the whole point of the number being here.
    const CAP = 61_500;
    expect(`${worst[0]} is ${worst[1]} bytes, under ${CAP}: ${worst[1] < CAP}`).toBe(
      `${worst[0]} is ${worst[1]} bytes, under ${CAP}: true`,
    );
  });
});
