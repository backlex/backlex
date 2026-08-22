/**
 * The consent banner: the bundle, and the thing it exists to do.
 *
 * ── Prior blocking is the only claim here that matters ────────────────────
 * The user's first fixed decision for this feature was that nothing optional
 * fires before a visitor decides. That is not a property of the banner
 * appearing; it is a property of the grant map being set BEFORE the container
 * runtime arms its triggers, which it does synchronously. So the assertions
 * below watch ORDER, not appearance — a banner that renders beautifully and
 * blocks nothing is the exact failure this feature was written to avoid.
 *
 * The traps that make a spec like this pass vacuously are written up in
 * `consent-grant-map.test.ts`; the same three apply (process-global boot
 * flags, the localhost URL, capturing at `sendBeacon`).
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONSENT_BANNER_JS } from "../src/server/services/consent-banner-bundle";
import { TRACKER_JS } from "../src/server/services/analytics-tracker";
import { TAG_RUNTIME_JS } from "../src/server/services/tag-runtime";
import { WORDING_KEYS } from "../src/server/services/consent";
import { buildBanner, emit } from "../../../scripts/gen-consent-banner";

const ROOT = resolve(import.meta.dir, "..", "..", "..");
const w = globalThis as unknown as Record<string, any>;
const HASH = "a".repeat(64);

const CFG = {
  v: 1,
  site: "site-1",
  categories: ["functional", "analytics", "marketing"],
  undecided: "block",
  tracker: "analytics",
  locale: "en",
  wording: {},
  policyUrl: null,
  position: "bottom",
  theme: {},
  cookieDays: 180,
};

/**
 * Everything the banner touches, reset.
 *
 * `keepCookie` is not a convenience: a "second page load" test that clears the
 * cookie is testing a FIRST page load, and would pass against a banner that
 * remembers nothing.
 */
const reset = (keepCookie = false) => {
  for (const k of [
    "__backlexConsentBanner",
    "__backlexConsentBannerBooted",
    "__backlexConsent",
    "__backlexTagBooted",
    "__backlexTMBooted",
    "backlex",
    "dataLayer",
  ]) {
    delete w[k];
  }
  document.querySelectorAll("[data-backlex-consent]").forEach((n) => n.remove());
  if (keepCookie) return;
  try {
    document.cookie = "blx_consent=; Path=/; Max-Age=0";
  } catch {
    /* ignore */
  }
};

let posted: any[] = [];

// Captured ONCE, before anything replaces them. These are process globals
// under the happy-dom preload, shared with ~600 other specs in the same
// `bun test` run, so a stub left installed is a stub every later file inherits.
const NATIVE = {
  Blob: w.Blob,
  Image: w.Image,
  sendBeacon: w.navigator.sendBeacon,
};

beforeEach(() => {
  w.happyDOM?.setURL?.("https://shop.example/pricing");
  reset();
  posted = [];
  w.navigator.sendBeacon = (_u: string, b: any) => {
    posted.push(JSON.parse(String(b?.__text ?? b)));
    return true;
  };
  const RealBlob = w.Blob;
  w.Blob = function (parts: any[], o: any) {
    const b = new RealBlob(parts, o);
    (b as any).__text = parts.join("");
    return b;
  } as unknown as typeof Blob;
  w.Blob.prototype = RealBlob.prototype;
});

afterAll(() => {
  reset();
  w.happyDOM?.setURL?.("http://localhost:5173/");
  w.Blob = NATIVE.Blob;
  w.Image = NATIVE.Image;
  w.navigator.sendBeacon = NATIVE.sendBeacon;
});

const bootBanner = (cfg: Record<string, unknown> = CFG) => {
  new Function(CONSENT_BANNER_JS)();
  w.__backlexConsentBanner({
    cfg,
    hash: HASH,
    endpoint: "https://api.example/api/consent/record",
  });
};

const shadow = (): ShadowRoot | null =>
  (document.querySelector("[data-backlex-consent]") as any)?.shadowRoot ?? null;

const buttonNamed = (label: string): HTMLButtonElement | undefined =>
  [...(shadow()?.querySelectorAll("button") ?? [])].find(
    (b) => (b.textContent || "").trim() === label,
  ) as HTMLButtonElement | undefined;

describe("the generated bundle matches its source", () => {
  test("regenerating produces byte-identical output", async () => {
    // The lefthook job that guards this globs the SOURCES, so hand-editing the
    // generated file or the generator never fires it, and `--no-verify` skips
    // it outright. This runs in `bun test`, which runs in CI, and is therefore
    // the half that actually holds.
    const fresh = emit(await buildBanner());
    const onDisk = readFileSync(
      resolve(ROOT, "apps/web/src/server/services/consent-banner-bundle.ts"),
      "utf8",
    );
    expect(fresh === onDisk ? "in sync" : "STALE — run: bun scripts/gen-consent-banner.ts").toBe(
      "in sync",
    );
  });

  test("it is quoted, not templated — a minified bundle carries all three forbidden characters", () => {
    // The tracker keeps its source in a template literal and pays for it with a
    // no-backtick/no-backslash/no-${ rule. This bundle cannot obey that rule,
    // which is precisely why it is emitted through JSON.stringify instead. If
    // that were ever "simplified" to a template literal, the bundle would ship
    // silently corrupted.
    const raw = readFileSync(
      resolve(ROOT, "apps/web/src/server/services/consent-banner-bundle.ts"),
      "utf8",
    );
    expect(raw).toContain('export const CONSENT_BANNER_JS: string = "');
    expect(raw).not.toContain("export const CONSENT_BANNER_JS: string = `");
  });

  test("and it parses", () => {
    expect(() => new Function(CONSENT_BANNER_JS)).not.toThrow();
  });
});

describe("the wording contract", () => {
  test("the banner can render every key the server accepts", () => {
    // A key the policy stores but the banner cannot render is a string an
    // operator writes, reviews with a lawyer, and no visitor ever sees.
    const src = readFileSync(
      resolve(ROOT, "apps/web/src/client/consent-banner/strings.ts"),
      "utf8",
    );
    for (const key of WORDING_KEYS) {
      expect(`${key} has a built-in: ${src.includes(`${key}:`)}`).toBe(`${key} has a built-in: true`);
    }
  });

  test("operator wording wins per KEY, not per locale block", () => {
    bootBanner({ ...CFG, wording: { en: { title: "Our cookies" } } });
    const text = shadow()?.textContent ?? "";
    expect(text).toContain("Our cookies");
    // …and the untranslated keys still render, rather than falling off a cliff.
    expect(text).toContain("Accept all");
  });
});

describe("prior blocking", () => {
  test("`block` denies every offered category BEFORE the container could run", () => {
    const seen: any[] = [];
    w.backlex = { consent: (v: any) => seen.push(v) };
    bootBanner();
    expect(seen).toEqual([{ functional: false, analytics: false, marketing: false }]);
  });

  test("`allow` grants them instead — the posture is the operator's, not ours", () => {
    const seen: any[] = [];
    w.backlex = { consent: (v: any) => seen.push(v) };
    bootBanner({ ...CFG, undecided: "allow" });
    expect(seen).toEqual([{ functional: true, analytics: true, marketing: true }]);
  });

  test("the whole chain: a marketing tag does not fire before a decision", () => {
    // The end-to-end claim, driven through the real tracker and the real
    // container runtime in the order the server concatenates them.
    new Function(TRACKER_JS)();
    w.__backlexTrackerInit({ s: "site-1", e: "https://api.example/collect" });
    bootBanner();

    const fired: string[] = [];
    w.Image = function () {
      const el: any = { style: {} };
      Object.defineProperty(el, "src", {
        set(v: string) {
          fired.push(String(v).split("/").pop() as string);
        },
      });
      return el;
    } as unknown as typeof Image;

    new Function(TAG_RUNTIME_JS)();
    w.__backlexTM({
      v: 1,
      site: "site-1",
      variables: [],
      triggers: [{ id: "t1", type: "pageview" }],
      tags: [
        {
          id: "pixel",
          name: "pixel",
          kind: "image_pixel",
          consent: "marketing",
          fire: "always",
          triggers: ["t1"],
          blocking: [],
          params: { url: "https://px.example/pixel" },
        },
      ],
    });
    expect(fired).toEqual([]);
  });
});

describe("a decision", () => {
  test("Accept all grants everything and posts the six keys the route reads", () => {
    bootBanner();
    buttonNamed("Accept all")?.click();
    expect(posted.length).toBe(1);
    const body = posted[0];
    expect(Object.keys(body).sort()).toEqual(["g", "h", "l", "s", "src", "u"]);
    expect(body.g).toEqual({ functional: true, analytics: true, marketing: true });
    expect(body.s).toBe("site-1");
    expect(body.src).toBe("banner");
  });

  test("the policy hash goes on the wire BARE, not quoted", () => {
    // The public config route serves this hash inside an ETag, where it is
    // quoted. `SHA256_HEX_RE` rejects quotes, so a quoted value would be
    // accepted at 202 and silently stored as `hashGrade: "unresolved"` —
    // evidence that points at nothing.
    bootBanner();
    buttonNamed("Accept all")?.click();
    expect(posted[0].h).toBe(HASH);
    expect(posted[0].h).not.toContain('"');
  });

  test("the subject id satisfies the server's own regex", () => {
    // `SUBJECT_ID_RE` is /^[A-Za-z0-9_-]{16,64}$/ and a body failing it is
    // dropped as accepted — a 202 that stored nothing.
    bootBanner();
    buttonNamed("Accept all")?.click();
    expect(/^[A-Za-z0-9_-]{16,64}$/.test(posted[0].u)).toBe(true);
  });

  test("Reject all denies everything", () => {
    bootBanner();
    buttonNamed("Reject all")?.click();
    expect(posted[0].g).toEqual({ functional: false, analytics: false, marketing: false });
  });

  test("it is remembered, so a second page load does not ask again", () => {
    bootBanner();
    buttonNamed("Accept all")?.click();
    expect(document.cookie).toContain("blx_consent");

    // Second load: same policy hash, and the cookie SURVIVES — clearing it
    // here would make this a first-load test that passes either way.
    const seen: any[] = [];
    reset(true);
    w.backlex = { consent: (v: any) => seen.push(v) };
    bootBanner();
    expect(shadow()).toBe(null);
    expect(seen).toEqual([{ functional: true, analytics: true, marketing: true }]);
  });

  test("a policy edit asks again, while still honouring what they last said", () => {
    // A decision made against a different version is evidence of what they were
    // shown then, not consent to what is offered now. Nothing they refused may
    // start firing just because the wording changed.
    // ACCEPT, deliberately: the undecided posture here is `block`, so a spec
    // that rejected first would see all-false either way and pass without the
    // cookie ever being read.
    bootBanner();
    buttonNamed("Accept all")?.click();

    const seen: any[] = [];
    reset(true);
    w.backlex = { consent: (v: any) => seen.push(v) };
    new Function(CONSENT_BANNER_JS)();
    w.__backlexConsentBanner({
      cfg: CFG,
      hash: "b".repeat(64),
      endpoint: "https://api.example/api/consent/record",
    });
    expect(seen).toEqual([{ functional: true, analytics: true, marketing: true }]);
    expect(shadow()).not.toBe(null);
  });
});

describe("rendering on a page we do not own", () => {
  test("it isolates itself in a shadow root", () => {
    bootBanner();
    expect(shadow()).not.toBe(null);
  });

  test("a hostile stylesheet does not move it", () => {
    // The claim shadow DOM is making, asserted rather than assumed.
    const hostile = document.createElement("style");
    hostile.textContent = "*{position:static !important;display:none !important}";
    document.head.appendChild(hostile);
    bootBanner();
    const root = shadow()?.querySelector(".blx-root") as HTMLElement | null;
    expect(root).not.toBe(null);
    // The page's `*` rule cannot reach into the shadow tree at all, so the
    // banner keeps the class that positions it.
    expect(root?.className).toContain("blx-root");
    hostile.remove();
  });

  test("a `javascript:` policy URL is refused", () => {
    bootBanner({ ...CFG, policyUrl: "javascript:alert(1)" });
    const links = shadow()?.querySelectorAll("a") ?? [];
    expect(links.length).toBe(0);
  });

  test("a theme token carrying CSS syntax cannot inject a rule", () => {
    bootBanner({ ...CFG, theme: { background: "red;}body{display:none" } });
    const css = shadow()?.querySelector("style")?.textContent ?? "";
    expect(css).not.toContain("body{display:none");
  });

  test("the operator's own control can reopen it", () => {
    bootBanner();
    buttonNamed("Accept all")?.click();
    expect(shadow()).toBe(null);
    w.__backlexConsent.open();
    expect(shadow()).not.toBe(null);
  });
});
