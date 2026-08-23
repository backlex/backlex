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
import { BUILTIN_STRINGS } from "../src/client/consent-banner/strings";
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
    "__backlexSignalsRefuseAll",
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
  fetch: w.fetch,
};

/** Every `fetch` the banner makes. Withdrawal cannot use `sendBeacon` — a
 *  DELETE is never a simple request — so this is the only place it shows up. */
let fetched: Array<{ url: string; method: string }> = [];

beforeEach(() => {
  w.happyDOM?.setURL?.("https://shop.example/pricing");
  reset();
  posted = [];
  fetched = [];
  w.fetch = ((url: any, init: any) => {
    fetched.push({ url: String(url), method: String(init?.method ?? "GET") });
    return Promise.resolve({ ok: true, status: 200 });
  }) as unknown as typeof fetch;
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
  w.fetch = NATIVE.fetch;
});

const bootBanner = (cfg: Record<string, unknown> = CFG) => {
  new Function(CONSENT_BANNER_JS)();
  w.__backlexConsentBanner({
    cfg,
    hash: HASH,
    endpoint: "https://api.example/api/consent/record",
  });
};

/** Let one macrotask run, which is where the tracker's timeout net lives. */
const await0 = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * Event names the TRACKER put on the wire, split from the record the BANNER
 * posts through the same `sendBeacon`.
 *
 * Splitting by URL rather than by body shape is the whole point: a stub that
 * counted both would report a HELD pageview as sent the instant the visitor
 * pressed a button, which is the one thing these specs exist to distinguish.
 */
const captureCollect = (): string[] => {
  const sent: string[] = [];
  w.navigator.sendBeacon = (u: string, b: any) => {
    const body = JSON.parse(String(b?.__text ?? b));
    if (String(u).endsWith("/collect")) sent.push(String(body.n));
    else posted.push(body);
    return true;
  };
  return sent;
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

  test("…and every key actually reaches the DOM", () => {
    // The check above passes on a built-in that nothing renders, and TWO keys
    // were in exactly that state: `necessaryLabel` and `necessaryBody` shipped
    // with the policy and were never drawn, because "necessary" is not one of
    // `OPTIONAL_CATEGORIES` and so never appears in the offered list.
    // Assert against the rendered tree instead of the source file.
    const cfg = { ...CFG, policyUrl: "https://shop.example/cookies" };
    bootBanner(cfg);
    buttonNamed("Accept all")?.click();
    // Reopened, and therefore DECIDED: `close` and `withdraw` only exist for a
    // visitor who has something to close on and something to withdraw.
    w.__backlexConsent.open();

    const root = shadow();
    const labels = [...(root?.querySelectorAll("[aria-label]") ?? [])].map(
      (n) => n.getAttribute("aria-label") ?? "",
    );
    const rendered = `${root?.textContent ?? ""}\n${labels.join("\n")}`;
    const en = BUILTIN_STRINGS.en as Record<string, string>;
    for (const key of WORDING_KEYS) {
      const text = en[key] ?? "";
      expect(`${key} is on screen: ${rendered.includes(text)}`).toBe(
        `${key} is on screen: true`,
      );
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

  test("backlex's OWN tag does not send before a decision either", () => {
    // The half the ordering never covered, found by watching production on the
    // wire rather than by reading this file: the container is gated because it
    // STARTS after the banner, but the tracker FINISHES before it, and its last
    // line is a pageview. So on every site running a banner, one collect POST
    // went out before the visitor had chosen anything — and
    // `__backlexConsentGranted("analytics")` answered false a moment later,
    // about the very request that had already left.
    //
    // `w` holds that pageview and `d` seeds the map; the server sets both only
    // when it concatenates a banner into the same file.
    const sent = captureCollect();

    new Function(TRACKER_JS)();
    w.__backlexTrackerInit({
      s: "site-1",
      e: "https://api.example/collect",
      w: 1,
      d: { functional: false, analytics: false, marketing: false },
    });
    expect(sent).toEqual([]);

    // The banner releases it — and with `undecided: "block"` the answer is
    // still no, so nothing is sent at all until the visitor says otherwise.
    bootBanner();
    expect(sent).toEqual([]);

    // Released by the decision, not spent on the denial before it: the page
    // they LANDED on is the one page a consenting visit is certain to have.
    buttonNamed("Accept all")?.click();
    expect(sent).toEqual(["page_view"]);
    expect(posted.length).toBe(1);

    // And exactly once. Every later consent call reaches the same release.
    w.backlex.consent("granted");
    w.backlex.consent("denied");
    w.backlex.consent("granted");
    expect(sent).toEqual(["page_view"]);
  });

  test("a returning visitor's first pageview is not the price of the fix", () => {
    // Seeding the map alone would have been the cheaper change and the wrong
    // one. A visitor who accepted last week carries that answer in a cookie
    // this tracker does not read, so a seeded "block" would silently drop the
    // first pageview of every returning visitor — one wrong silence traded for
    // one wrong send. The hold is what makes the banner's cookie read the thing
    // that decides.
    const sent = captureCollect();

    // Their answer, as the cookie the previous visit wrote.
    bootBanner();
    buttonNamed("Accept all")?.click();
    reset(true);
    posted = [];

    new Function(TRACKER_JS)();
    w.__backlexTrackerInit({
      s: "site-1",
      e: "https://api.example/collect",
      w: 1,
      d: { functional: false, analytics: false, marketing: false },
    });
    expect(sent).toEqual([]);

    bootBanner();
    expect(sent).toEqual(["page_view"]);
    // And it claims the consent they actually gave, which is the field an
    // operator points at in an audit.
    expect(w.__backlexConsentGranted("analytics")).toBe(true);
  });

  test("an allow posture does not overrun a returning visitor's refusal", () => {
    // The case that makes the HOLD load-bearing rather than decorative.
    //
    // With `undecided: "allow"` the seeded map grants everything, so a tracker
    // that sent immediately would send for a visitor whose cookie says they
    // refused analytics last week — the seed being a guess about someone who
    // has already answered. Only the banner reads that cookie, so only the
    // banner can be the thing that decides, and the pageview has to wait for
    // it. Seeding without holding would have fixed the undecided case and left
    // this one, which is the worse of the two: overriding a recorded refusal.
    const sent = captureCollect();

    const ALLOW = { ...CFG, undecided: "allow" };

    // Last week: they opened the banner and turned everything off.
    bootBanner(ALLOW);
    buttonNamed("Reject all")?.click();
    reset(true);

    new Function(TRACKER_JS)();
    w.__backlexTrackerInit({
      s: "site-1",
      e: "https://api.example/collect",
      w: 1,
      d: { functional: true, analytics: true, marketing: true },
    });
    expect(sent).toEqual([]);

    bootBanner(ALLOW);
    expect(sent).toEqual([]);
    expect(w.__backlexConsentGranted("analytics")).toBe(false);
  });

  test("nothing holds a pageview that no banner is coming to release", async () => {
    // Two ways this fix could have broken every site that does not run a
    // banner: holding unconditionally, or holding on a banner that is switched
    // off, boots twice, or throws. The first is what `w` guards; the second is
    // what the timeout net catches, and a held pageview that is never released
    // is silent data loss — a worse failure than the one being fixed.
    const sent = captureCollect();

    // The plain /script.js install: no policy in the file, nothing to wait for.
    new Function(TRACKER_JS)();
    w.__backlexTrackerInit({ s: "site-1", e: "https://api.example/collect" });
    expect(sent).toEqual(["page_view"]);

    // A banner promised and never delivered.
    reset();
    sent.length = 0;
    new Function(TRACKER_JS)();
    w.__backlexTrackerInit({
      s: "site-1",
      e: "https://api.example/collect",
      w: 1,
      d: { functional: false, analytics: false, marketing: false },
    });
    expect(sent).toEqual([]);
    // `d` says block, so the net releases it into a denial rather than into a
    // send — the operator's own posture, applied without anyone to ask.
    await await0();
    expect(sent).toEqual([]);

    reset();
    sent.length = 0;
    new Function(TRACKER_JS)();
    w.__backlexTrackerInit({
      s: "site-1",
      e: "https://api.example/collect",
      w: 1,
      d: { functional: true, analytics: true, marketing: true },
    });
    expect(sent).toEqual([]);
    await await0();
    expect(sent).toEqual(["page_view"]);
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

/**
 * Withdrawal — GDPR Art. 7(3): as easy to take back as it was to give.
 *
 * The seam these drive was published in `docs/cookie-consent.md` one phase
 * before it worked. `boot()` installed `window.__backlexConsent` AFTER the
 * early return it takes for a visitor whose decision is current — so the one
 * population that needs a "Cookie settings" link was the one population for
 * which the handle was `undefined`. The reopen test that existed passed
 * because it reopened within the FIRST page load, where the handle is set.
 */
describe("withdrawal", () => {
  const secondLoad = () => {
    reset(true); // the cookie survives; this is a navigation, not a new visitor
    w.backlex = { consent: () => {} };
    bootBanner();
  };

  test("the handle exists on the SECOND page load, which is the only one that matters", () => {
    bootBanner();
    buttonNamed("Accept all")?.click();
    secondLoad();

    expect(shadow()).toBe(null); // still does not re-ask
    expect(typeof w.__backlexConsent?.open).toBe("function");
    w.__backlexConsent.open();
    expect(shadow()).not.toBe(null);
  });

  test("reopening shows what they chose, not what they had before choosing", () => {
    // `undecided` is `block`, so a stale read shows every box UNCHECKED — the
    // visitor accepted and is then shown a panel claiming they refused.
    bootBanner();
    buttonNamed("Accept all")?.click();
    w.__backlexConsent.open();

    const boxes = [...(shadow()?.querySelectorAll("input[type=checkbox]") ?? [])] as HTMLInputElement[];
    // The first row is "strictly necessary": checked and disabled, and it must
    // never reach a saved grant map.
    expect(boxes[0]?.disabled).toBe(true);
    expect(boxes.slice(1).map((b) => b.checked)).toEqual([true, true, true]);
  });

  test("withdrawing denies everything, drops the cookie, and erases the record", () => {
    const seen: any[] = [];
    bootBanner();
    buttonNamed("Accept all")?.click();
    const id = w.__backlexConsent.decision()?.id;
    expect(id).toBeTruthy();

    w.backlex = { consent: (v: any) => seen.push(v) };
    w.__backlexConsent.open();
    buttonNamed("Withdraw and delete my record")?.click();

    expect(seen).toEqual([{ functional: false, analytics: false, marketing: false }]);
    // The VALUE, not the name: `Max-Age=0` evicts the entry in a browser, and
    // happy-dom leaves a valueless `blx_consent=` behind. Both are forgotten —
    // `readDecision()` answers null for either — so assert what is actually
    // load-bearing, which is that no decision survives.
    expect(document.cookie).not.toContain("blx_consent=%7B");
    expect(w.__backlexConsent.decision()).toBe(null);
    expect(shadow()).toBe(null);

    // `sendBeacon` cannot carry a DELETE, so this is the one banner call that
    // has to be a real preflighted request.
    const del = fetched.find((f) => f.method === "DELETE");
    expect(del).toBeTruthy();
    expect(del!.url).toContain(`u=${id}`);
    expect(del!.url).toContain("s=site-1");

    // A later decision must not be joinable to the record just erased.
    w.__backlexConsent.open();
    expect(w.__backlexConsent.decision()).toBe(null);
    buttonNamed("Reject all")?.click();
    expect(posted[posted.length - 1].u).not.toBe(id);
  });

  test("a marked-up element opens it, with no JavaScript from the operator", () => {
    // The realistic install: a hosted CMS where a footer link is all you get.
    bootBanner();
    buttonNamed("Accept all")?.click();
    secondLoad();

    const link = document.createElement("a");
    link.setAttribute("data-backlex-consent-open", "");
    link.textContent = "Cookie settings";
    document.body.appendChild(link);
    link.click();

    expect(shadow()).not.toBe(null);
    link.remove();
  });

  test("an undecided visitor is offered no exit that is not a decision", () => {
    bootBanner();
    const root = shadow();
    expect(root?.querySelector(".blx-close")).toBe(null);
    expect(buttonNamed("Withdraw and delete my record")).toBeUndefined();
    // …and pays nothing for it: refusing is one click, on the first layer.
    expect(buttonNamed("Reject all")).toBeTruthy();
  });

  test("a reopened banner closes on Escape, and unbinds when it goes", () => {
    bootBanner();
    buttonNamed("Accept all")?.click();
    w.__backlexConsent.open();
    expect(shadow()).not.toBe(null);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(shadow()).toBe(null);

    // A listener that outlived its banner would throw on the next Escape.
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(shadow()).toBe(null);
  });
});

/**
 * A browser signal outranks the operator's GUESS, and not the visitor's answer.
 *
 * Found by driving a real browser rather than by reading: `consentGranted()`
 * consults the grant map first, and the banner always writes a TOTAL map before
 * the container arms — so on any site running a banner the tracker's own signal
 * branch was unreachable. With `undecided: "allow"` that meant a visitor
 * sending Global Privacy Control, on a site whose operator had explicitly asked
 * for GPC to stop everything, got every tag fired at them.
 *
 * The distinction can only be made here: the tracker receives a flat map and
 * cannot tell "nobody has answered, so the operator said allow" from "this
 * visitor pressed Accept all".
 */
describe("a browser signal against an undecided posture", () => {
  const ALLOW = { ...CFG, undecided: "allow" };

  test("`allow` grants nothing when the site made the signals a refusal", () => {
    const seen: any[] = [];
    w.backlex = { consent: (v: any) => seen.push(v) };
    w.__backlexSignalsRefuseAll = () => true;
    bootBanner(ALLOW);
    expect(seen).toEqual([{ functional: false, analytics: false, marketing: false }]);
  });

  test("…and still grants everything when they are not", () => {
    // The other direction, which is what makes the assertion above about the
    // signal rather than about `allow` being broken.
    const seen: any[] = [];
    w.backlex = { consent: (v: any) => seen.push(v) };
    w.__backlexSignalsRefuseAll = () => false;
    bootBanner(ALLOW);
    expect(seen).toEqual([{ functional: true, analytics: true, marketing: true }]);
  });

  test("a recorded decision outranks the signal, because it is an answer", () => {
    // Accept all, then return with the signal raised. The visitor said yes to
    // this site; a browser-wide preference does not overrule that, and a CMP
    // whose stored consent were silently ignored would be recording decisions
    // it does not honour.
    w.__backlexSignalsRefuseAll = () => false;
    bootBanner(ALLOW);
    buttonNamed("Accept all")?.click();

    const seen: any[] = [];
    reset(true);
    w.backlex = { consent: (v: any) => seen.push(v) };
    w.__backlexSignalsRefuseAll = () => true;
    bootBanner(ALLOW);
    expect(seen).toEqual([{ functional: true, analytics: true, marketing: true }]);
  });

  test("a missing tracker does not take the banner down with it", () => {
    // The seam is exported by the tracker, which is concatenated ahead of this
    // file — but a page that broke it must still get a banner.
    w.__backlexSignalsRefuseAll = () => {
      throw new Error("no tracker");
    };
    const seen: any[] = [];
    w.backlex = { consent: (v: any) => seen.push(v) };
    bootBanner(ALLOW);
    expect(seen).toEqual([{ functional: true, analytics: true, marketing: true }]);
    expect(shadow()).not.toBe(null);
  });
});

/**
 * Which language the visitor is shown — and it is the ONE thing the banner
 * infers about them.
 *
 * Deliberately narrow. The regional-presets phase established that geo cannot
 * decide a posture (the file that carries this bundle is cached and identical
 * for everyone), and `Intl`/`navigator` are device settings rather than
 * location. Language is a different claim: it changes no grant, no category and
 * no hash, and it only ever selects between texts the OPERATOR wrote.
 */
describe("the locale a visitor is actually shown", () => {
  const NAV = Object.getOwnPropertyDescriptor(w.navigator, "languages");
  const speak = (...langs: string[]) => {
    Object.defineProperty(w.navigator, "languages", {
      get: () => langs,
      configurable: true,
    });
  };
  afterAll(() => {
    if (NAV) Object.defineProperty(w.navigator, "languages", NAV);
    else delete (w.navigator as any).languages;
  });

  const withTr = {
    ...CFG,
    locale: "en",
    wording: { en: { title: "Cookies" }, tr: { title: "Çerezler", acceptAll: "Kabul et" } },
  };

  test("an operator-authored block wins over the policy default", () => {
    speak("tr-TR", "tr", "en");
    bootBanner(withTr);
    expect(shadow()?.textContent ?? "").toContain("Çerezler");
    expect(buttonNamed("Kabul et")).toBeTruthy();
  });

  test("…and the decision records the locale that was RENDERED", () => {
    // A record naming a language the visitor never saw is evidence about the
    // wrong text — the artifact carries every locale, so only this says which.
    speak("tr-TR", "tr");
    bootBanner(withTr);
    buttonNamed("Kabul et")?.click();
    expect(posted[0].l).toBe("tr");
  });

  test("a language nobody authored falls back to the operator's default", () => {
    // NOT to our built-in German. `services/consent.ts` calls substituting text
    // an operator never reviewed "the same mistake as defaulting the posture".
    speak("de-DE", "de");
    bootBanner(withTr);
    expect(shadow()?.textContent ?? "").toContain("Cookies");
    buttonNamed("Accept all")?.click();
    expect(posted[0].l).toBe("en");
  });

  test("an empty block does not count as authored", () => {
    speak("tr", "en");
    bootBanner({ ...CFG, locale: "en", wording: { en: { title: "Cookies" }, tr: {} } });
    buttonNamed("Accept all")?.click();
    expect(posted[0].l).toBe("en");
  });

  test("a prototype key is not a locale the operator authored", () => {
    // `navigator.languages` is the VISITOR's. A bare `wording[tag]` lookup
    // would reach `Object.prototype` for these and read it as an authored
    // block; the posted locale is the observable consequence, since it is what
    // a regulator would be shown as the text this visitor agreed to.
    speak("constructor", "__proto__", "tostring");
    bootBanner(withTr);
    buttonNamed("Accept all")?.click();
    expect(posted[0].l).toBe("en");
  });

  test("a hostile navigator does not take the banner down", () => {
    Object.defineProperty(w.navigator, "languages", {
      get() {
        throw new Error("nope");
      },
      configurable: true,
    });
    bootBanner(withTr);
    expect(shadow()).not.toBe(null);
    expect(shadow()?.textContent ?? "").toContain("Cookies");
  });
});
