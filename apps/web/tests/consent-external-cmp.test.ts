/**
 * What happens when the operator already runs someone else's consent manager.
 *
 * This file exists because Phase 9 set out to BUILD this integration and
 * measurement found it already shipped — by accident, as a consequence of two
 * decisions taken for other reasons:
 *
 *  1. `analytics-collect.ts` seeds the grant map (`w` / `d`) ONLY when a banner
 *     is compiled into the same file. Its own comment says so. A site with no
 *     backlex policy therefore starts with `grants` EMPTY.
 *  2. `consentGranted()` falls past both grant-map rungs when the map is empty
 *     and lands on `stateFor(category)` — which reads Google Consent Mode v2
 *     off the `dataLayer` (`ad_storage` / `analytics_storage` /
 *     `functionality_storage`).
 *
 * So a third-party CMP that emits Consent Mode — which is the near-universal
 * behaviour, because Google requires it of anyone buying its inventory —
 * already gates backlex's own tag AND every tag the tag manager compiles, with
 * nothing pasted and no setting turned on.
 *
 * That was an OBSERVATION. Nothing in the suite pinned it, so it could have
 * been deleted by any refactor of the consent rungs without a single test going
 * red. These specs make it a GUARANTEE, because `docs/cookie-consent.md` now
 * promises it to operators.
 *
 * ── The boundary is the point, not a footnote ─────────────────────────────
 * The last describe block pins the other half: once a backlex banner IS in the
 * file, its TOTAL grant map shadows Consent Mode completely and the external
 * manager stops being consulted. That is not a defect — a visitor's recorded
 * answer must outrank an inference — but it is exactly why the documented
 * instruction is "turn the backlex banner off", and an operator who runs both
 * gets whichever one backlex compiled, silently.
 *
 * ── Harness ───────────────────────────────────────────────────────────────
 * See `consent-grant-map.test.ts` for the four traps that make a naive spec
 * here pass while measuring nothing. The three that bite hardest: the boot flag
 * is a PROCESS global shared with every other spec file, happy-dom registers at
 * `localhost` which is in the tag's own opt-out list, and the capture point is
 * `navigator.sendBeacon` rather than `fetch`.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { TRACKER_JS } from "../src/server/services/analytics-tracker";
import { TAG_RUNTIME_JS } from "../src/server/services/tag-runtime";

const w = globalThis as unknown as Record<string, any>;
const ORIGINAL_URL = "http://localhost:5173/";

/** Beacon bodies captured since the last boot, already JSON-parsed. */
let sent: any[] = [];

const setUrl = (url: string) => {
  w.happyDOM?.setURL?.(url);
};

/**
 * A gtag `consent` push, in the shape gtag.js actually produces.
 *
 * `dataLayer.push(arguments)` means the entry is an arguments-like whose index
 * 2 is the state object — which is why the tag reads `e[2] || e` rather than
 * assuming a plain object. Building it the real way is the difference between
 * pinning the reader and pinning a convenient fiction.
 */
const consentPush = (mode: "default" | "update", state: Record<string, string>) =>
  ["consent", mode, state];

/**
 * Boot the tag with a dataLayer already on the page.
 *
 * Order matters and is the realistic one: a Consent Mode `default` call is an
 * inline head script, so it has run long before backlex's deferred file. The
 * pageview at the end of `__backlexTrackerInit` is what we are measuring, so
 * the dataLayer has to exist BEFORE init, not after.
 */
const bootTracker = (dataLayer: unknown[] | null, cfg?: Record<string, unknown>) => {
  delete w.__backlexTagBooted;
  delete w.__backlexTMBooted;
  delete w.backlex;
  delete w.__backlexConsentGranted;
  delete w.__backlexConsentDenied;
  delete w.__backlexSignalsRefuseAll;
  delete w.dataLayer;
  if (dataLayer) w.dataLayer = dataLayer;
  sent = [];
  w.__fired = [];
  new Function(TRACKER_JS)();
  w.__backlexTrackerInit({
    s: "site-1",
    e: "https://api.example/collect",
    ...(cfg ?? {}),
  });
};

/**
 * Boot the container on top of the tracker, as the per-site file does.
 *
 * The tracker must already own `window.backlex` when this runs: the container
 * REPLACES it with a wrapper that chains to whatever was there. Booting them
 * the other way round is a page state that does not occur, and it would hide
 * the chaining.
 */
const bootContainer = (tags: unknown[], triggers: unknown[]) => {
  delete w.__backlexTMBooted;
  new Function(TAG_RUNTIME_JS)();
  w.__backlexTM({ v: 1, site: "site-1", tags, triggers, variables: [] });
};

/**
 * A tag whose firing is observable.
 *
 * `image_pixel`, never `custom_js`: happy-dom does not execute an injected
 * script element, so an inline-JS tag looks identical whether it fired or not.
 */
const pixelTag = (id: string, consent: string, triggers = ["t1"]) => ({
  id,
  name: id,
  kind: "image_pixel",
  consent,
  fire: "always",
  triggers,
  blocking: [],
  params: { url: "https://px.example/" + id },
});

const NATIVE = {
  Blob: w.Blob,
  Image: w.Image,
  sendBeacon: w.navigator.sendBeacon,
};

beforeEach(() => {
  setUrl("https://shop.example/pricing");
  w.navigator.sendBeacon = (_url: string, body: unknown) => {
    sent.push(JSON.parse(String((body as any)?.__text ?? body)));
    return true;
  };
  const RealBlob = w.Blob;
  w.Blob = function (parts: any[], opts: any) {
    const b = new RealBlob(parts, opts);
    (b as any).__text = parts.join("");
    return b;
  } as unknown as typeof Blob;
  w.Blob.prototype = RealBlob.prototype;

  w.__fired = [];
  w.Image = function () {
    // `style` is not optional: loadPixel sets `img.style.display` BEFORE `.src`
    // and every tag fires inside a try/catch, so a stub without it reports
    // "nothing fired" for a tag that fired perfectly well.
    const el: any = { style: {} };
    Object.defineProperty(el, "src", {
      set(v: string) {
        w.__fired.push(String(v).split("/").pop());
      },
    });
    return el;
  } as unknown as typeof Image;
});

afterAll(() => {
  setUrl(ORIGINAL_URL);
  w.Blob = NATIVE.Blob;
  w.Image = NATIVE.Image;
  w.navigator.sendBeacon = NATIVE.sendBeacon;
  delete w.__backlexTagBooted;
  delete w.__backlexTMBooted;
  delete w.backlex;
  delete w.dataLayer;
  delete w.__backlexConsentGranted;
  delete w.__backlexConsentDenied;
  delete w.__backlexSignalsRefuseAll;
});

describe("an external consent manager gates backlex, with nothing installed", () => {
  test("its pre-decision denial stops backlex's own tag from sending anything", () => {
    // The prior-blocking claim, delivered by someone else's CMP. A conforming
    // Consent Mode install denies everything in an inline head script before
    // the visitor has answered; this asserts backlex honours that default
    // rather than measuring the visitor anyway.
    bootTracker([
      consentPush("default", { analytics_storage: "denied", ad_storage: "denied" }),
    ]);
    expect(sent).toEqual([]);
  });

  test("with no signal at all it measures, which is the pre-policy behaviour", () => {
    // The control. Without this the test above passes for a site that sends
    // nothing under any circumstances, and proves nothing about consent.
    bootTracker(null);
    expect(sent.length).toBe(1);
  });

  test("the visitor's acceptance releases it inside the same page", () => {
    bootTracker([
      consentPush("default", { analytics_storage: "denied", ad_storage: "denied" }),
    ]);
    expect(sent).toEqual([]);

    // What the CMP does when the visitor presses Accept.
    w.dataLayer.push(consentPush("update", { analytics_storage: "granted" }));
    w.backlex("signup", null);
    expect(sent.length).toBe(1);

    // And it claims nothing on the wire it cannot support. `c` is the tag's own
    // consent field and it is sent as an explicit `null` here — a Consent Mode
    // grant is the site's inference about the visitor, not the visitor naming
    // backlex, and only `backlex.consent("granted")` may say otherwise. The
    // consent record this site does not have is the other half of that story.
    expect(sent[0].c).toBe(null);
  });

  test("a later denial stops it again — the signal is read per send, not at boot", () => {
    bootTracker([consentPush("default", { analytics_storage: "granted" })]);
    expect(sent.length).toBe(1);

    w.dataLayer.push(consentPush("update", { analytics_storage: "denied" }));
    w.backlex("signup", null);
    expect(sent.length).toBe(1);
  });
});

describe("the same signal reaches every tag the tag manager compiles", () => {
  test("a marketing tag does not fire while ad_storage is denied", () => {
    bootTracker([consentPush("default", { ad_storage: "denied" })]);
    bootContainer([pixelTag("meta", "marketing")], [{ id: "t1", type: "pageview" }]);
    expect(w.__fired).toEqual([]);
  });

  test("the same tag fires when the visitor's CMP granted it", () => {
    // The counterpart the negative above needs. Without it, a container that
    // never fires anything would satisfy the assertion.
    bootTracker([consentPush("default", { ad_storage: "granted" })]);
    bootContainer([pixelTag("meta", "marketing")], [{ id: "t1", type: "pageview" }]);
    expect(w.__fired).toEqual(["meta"]);
  });

  test("a tag the operator filed as strictly necessary is not gated by it", () => {
    bootTracker([consentPush("default", { ad_storage: "denied" })]);
    bootContainer([pixelTag("essential", "none")], [{ id: "t1", type: "pageview" }]);
    expect(w.__fired).toEqual(["essential"]);
  });

  test("a mid-page acceptance releases a LATER fire, but does not replay an earlier one", () => {
    // The honest limitation, pinned rather than discovered by a customer.
    // Tags are gated at the moment their trigger raises. Nothing re-runs a
    // pageview tag that was refused before the visitor pressed Accept, so a
    // pageview-triggered pixel is lost for that page view even though the
    // visitor consented on it.
    //
    // Raised twice inside ONE container boot, deliberately: `firedThisPage`
    // lives in the runtime's closure, so re-booting to "try again" hands every
    // tag a fresh budget and passes against the very thing being measured.
    bootTracker([consentPush("default", { ad_storage: "denied" })]);
    bootContainer(
      [pixelTag("meta", "marketing", ["t1"])],
      [{ id: "t1", type: "custom_event", config: { eventName: "checkout" } }],
    );

    w.backlex("checkout", null);
    expect(w.__fired).toEqual([]);

    w.dataLayer.push(consentPush("update", { ad_storage: "granted" }));
    w.backlex("checkout", null);
    expect(w.__fired).toEqual(["meta"]);
  });
});

describe("the boundary: a backlex banner shadows the external manager", () => {
  test("a seeded grant map wins over Consent Mode, which is why both must not run", () => {
    // `d` is what `analytics-collect.ts` compiles in when a banner is present:
    // the operator's undecided posture, as a TOTAL map. `consentGranted` reads
    // it at rung 2 and returns before `stateFor` is ever called.
    //
    // So on a site running the backlex banner, an external CMP's verdict is
    // NOT consulted — in either direction. This asserts the direction that
    // surprises: the external manager said GRANTED and backlex still refuses,
    // because its own banner has not been answered.
    bootTracker([consentPush("default", { analytics_storage: "granted" })], {
      w: 1,
      d: { functional: false, analytics: false, marketing: false },
    });
    expect(sent).toEqual([]);

    // And the shadowing is total: a marketing tag stays blocked too, on a
    // signal the external manager explicitly allowed.
    bootContainer([pixelTag("meta", "marketing")], [{ id: "t1", type: "pageview" }]);
    expect(w.__fired).toEqual([]);
  });

  test("without the seed the identical page is measured — the seed is the cause", () => {
    // Break-verification, inlined. The assertion above is a negative, and a
    // negative is worth exactly as much as the positive that isolates its
    // cause. Same dataLayer, same tag, seed removed.
    bootTracker([consentPush("default", { analytics_storage: "granted" })]);
    expect(sent.length).toBe(1);
  });
});
