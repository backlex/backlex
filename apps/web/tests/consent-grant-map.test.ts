/**
 * The consent grant map, exercised by RUNNING the tag rather than reading it.
 *
 * Everything the suite knew about consent until now was a substring check on
 * `TRACKER_JS`. That is what let the two halves of this feature disagree for as
 * long as they did: `analytics-collect.test.ts` posts the literal string
 * `"denied"` by hand, so it pins the ROUTE and would keep passing while the tag
 * sent a shape the route cannot read. A source scan also cannot see precedence,
 * cannot see which globals exist, and cannot see that a consent-denied tag was
 * writing a key into the visitor's localStorage on its way to not firing.
 *
 * So these specs boot the real strings in a DOM and watch what leaves.
 *
 * ── Three things this file has to do before it can measure anything ────────
 *  1. `window.__backlexTagBooted` is a PROCESS global under the happy-dom
 *     preload and survives between tests and between spec files. Left alone,
 *     the second boot returns at the guard and every later assertion passes
 *     vacuously.
 *  2. happy-dom registers at `http://localhost:5173`, and `localhost` is in the
 *     tag's own `LOCAL_HOSTS` opt-out — so on the default URL the tag sends
 *     NOTHING and every "it sent the right thing" test is green for the wrong
 *     reason. The URL moves, and is put back in `afterAll` because other specs
 *     read `window.location.origin` at import time.
 *  3. The capture point is `navigator.sendBeacon`, not `fetch`. The preload
 *     restores Bun-native `fetch` and `Blob` (its `NATIVE_KEYS` list), so a
 *     spec that stubs only `fetch` captures nothing and a spec that stubs
 *     neither makes real outbound requests whose failure the tag swallows.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
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
 * Boot the tag exactly as a browser would, from a clean slate.
 *
 * `cfg` mirrors what the tag-manager path passes; `null` is the legacy
 * `/script.js` start, which sniffs the script element instead — and there is no
 * script element here, which is itself the realistic case for an injected tag.
 */
const bootTracker = (cfg: unknown = { s: "site-1", e: "https://api.example/collect" }) => {
  delete w.__backlexTagBooted;
  delete w.backlex;
  delete w.__backlexConsentGranted;
  delete w.__backlexConsentDenied;
  delete w.dataLayer;
  sent = [];
  new Function(TRACKER_JS)();
  w.__backlexTrackerInit(cfg);
};

beforeEach(() => {
  setUrl("https://shop.example/pricing");
  w.navigator.sendBeacon = (_url: string, body: unknown) => {
    // The tag wraps the body in a Blob for an explicit content-type. Blob is
    // Bun-native here and `.text()` is async, so read the buffer it was built
    // from instead — this stub never has to be asynchronous.
    sent.push(JSON.parse(String((body as any)?.__text ?? body)));
    return true;
  };
  // A Blob whose text is readable synchronously, so the stub above stays simple.
  const RealBlob = w.Blob;
  w.Blob = function (parts: any[], opts: any) {
    const b = new RealBlob(parts, opts);
    (b as any).__text = parts.join("");
    return b;
  } as unknown as typeof Blob;
  w.Blob.prototype = RealBlob.prototype;

  // Which tags actually fired, by the pixel URL they requested.
  w.__fired = [];
  w.Image = function () {
    // `style` is not optional here: loadPixel sets `img.style.display` BEFORE
    // `.src`, and every tag fires inside a try/catch that swallows anything it
    // throws -- so a stub without it reports "nothing fired" for a tag that
    // fired perfectly well.
    const el: any = { style: {} };
    Object.defineProperty(el, "src", {
      set(v: string) {
        w.__fired.push(String(v).split("/").pop());
      },
    });
    return el;
  } as unknown as typeof Image;
});

afterEach(() => {
  delete w.navigator.globalPrivacyControl;
  delete w.doNotTrack;
});

afterAll(() => {
  setUrl(ORIGINAL_URL);
  delete w.__backlexTagBooted;
  delete w.backlex;
  delete w.__backlexConsentGranted;
  delete w.__backlexConsentDenied;
});

/** The tag reads `navigator.doNotTrack` through a getter-only accessor under
 *  happy-dom, so assigning it throws. `window.doNotTrack` is the other source
 *  the tag reads and is writable. */
const setDnt = () => {
  w.doNotTrack = "1";
};

describe("the tag boots before it is configured", () => {
  test("the consent seam exists even when the tag has no site to send to", () => {
    // The container runtime gates EVERY third-party tag through this seam. A
    // tracker that bailed for want of its own configuration used to take the
    // seam down with it, silently ungating every marketing pixel on the page —
    // and the bail is not hypothetical: an injected script has no element to
    // read `data-site` from.
    bootTracker(null);
    expect(typeof w.__backlexConsentGranted).toBe("function");
    expect(typeof w.__backlexConsentDenied).toBe("function");
  });

  test("a snippet with no site id does not claim the boot flag", () => {
    // Two installs on one page is a case the tag's own comment calls normal.
    // The flag used to be claimed before the site was checked, so one leftover
    // script tag with a typo'd data-site stopped the WORKING install from ever
    // booting — no tracking at all, and nothing on the page to say why.
    bootTracker(null);
    expect(w.__backlexTagBooted).toBeUndefined();

    w.__backlexTrackerInit({ s: "site-1", e: "https://api.example/collect" });
    expect(w.__backlexTagBooted).toBe(1);
  });
});

describe("the string form, which is live on real sites", () => {
  test('"denied" stops the tag, exactly as before', () => {
    bootTracker();
    expect(sent.length).toBe(1);
    w.backlex.consent("denied");
    w.backlex("signup", null);
    expect(sent.length).toBe(1);
  });

  test('"granted" keeps the tag sending and is the only thing that claims consent on the wire', () => {
    bootTracker();
    w.backlex.consent("granted");
    w.backlex("signup", null);
    expect(sent.length).toBe(2);
    expect(sent[1].c).toBe("granted");
  });

  test("an undecided visitor claims nothing on the wire", () => {
    // `c` is the field an operator points at in an audit. Reaching the server
    // at all already proves the tag did not consider itself denied, so a
    // "granted" here would be a claim nobody made.
    bootTracker();
    expect(sent[0].c).toBe(null);
  });

  test("an unrecognised value resets to undecided rather than throwing", () => {
    bootTracker();
    w.backlex.consent("denied");
    w.backlex.consent(null);
    w.backlex("after-reset", null);
    expect(sent.length).toBe(2);

    // typeof null is "object" — an object branch written without a guard takes
    // null down the key-iteration path and throws on the customer's page.
    expect(() => w.backlex.consent()).not.toThrow();
    expect(() => w.backlex.consent([])).not.toThrow();
    expect(() => w.backlex.consent(7)).not.toThrow();
  });
});

describe("the object form is a decision, not a patch", () => {
  test("a category the caller leaves out is denied, not left alone", () => {
    // The server clamps a stored record the same way — absence is not consent
    // — and a banner calls both with the same object. If these disagreed the
    // durable evidence would say the visitor refused marketing while the page
    // fired the marketing pixel.
    bootTracker();
    w.backlex.consent({ analytics: true });
    expect(w.__backlexConsentGranted("analytics")).toBe(true);
    expect(w.__backlexConsentGranted("marketing")).toBe(false);
    expect(w.__backlexConsentGranted("functional")).toBe(false);
  });

  test("only a real boolean grants", () => {
    bootTracker();
    w.backlex.consent({ analytics: "true", marketing: 1 });
    expect(w.__backlexConsentGranted("analytics")).toBe(false);
    expect(w.__backlexConsentGranted("marketing")).toBe(false);
  });

  test("denying analytics stops the tag; denying only marketing does not", () => {
    bootTracker();
    w.backlex.consent({ analytics: false, marketing: true });
    w.backlex("blocked", null);
    expect(sent.length).toBe(1);

    w.backlex.consent({ analytics: true, marketing: false });
    w.backlex("allowed", null);
    expect(sent.length).toBe(2);
    expect(sent[1].n).toBe("allowed");
  });

  test("`none` is never gated, whatever the map says", () => {
    bootTracker();
    w.backlex.consent("denied");
    expect(w.__backlexConsentGranted("none")).toBe(true);
    expect(w.__backlexConsentGranted("")).toBe(true);
  });
});

describe("Google Consent Mode, and who beats whom", () => {
  test("a dataLayer denial gates the matching category", () => {
    bootTracker();
    w.dataLayer = [["consent", "update", { ad_storage: "denied", analytics_storage: "granted" }]];
    expect(w.__backlexConsentGranted("marketing")).toBe(false);
    expect(w.__backlexConsentGranted("analytics")).toBe(true);
  });

  test("an explicit call beats the dataLayer, because that is the site owner speaking", () => {
    bootTracker();
    w.dataLayer = [["consent", "default", { ad_storage: "denied" }]];
    w.backlex.consent({ marketing: true, analytics: true });
    expect(w.__backlexConsentGranted("marketing")).toBe(true);
  });

  test("functional reads its own key, and falls back to analytics_storage", () => {
    bootTracker();
    w.dataLayer = [["consent", "update", { functionality_storage: "denied", analytics_storage: "granted" }]];
    expect(w.__backlexConsentGranted("functional")).toBe(false);

    bootTracker();
    w.dataLayer = [["consent", "update", { analytics_storage: "denied" }]];
    expect(w.__backlexConsentGranted("functional")).toBe(false);
  });

  test("a malformed dataLayer is not a reason to stop measuring", () => {
    bootTracker();
    w.dataLayer = [null, "nonsense", 7];
    expect(w.__backlexConsentGranted("analytics")).toBe(true);
  });
});

describe("browser-level signals gate THIS tag and not third-party tags", () => {
  test("Global Privacy Control stops the tag", () => {
    bootTracker();
    w.navigator.globalPrivacyControl = true;
    w.backlex("after-gpc", null);
    expect(sent.length).toBe(1);
  });

  test("Do Not Track stops the tag", () => {
    bootTracker();
    setDnt();
    w.backlex("after-dnt", null);
    expect(sent.length).toBe(1);
  });

  test("but neither reaches the seam the container gates tags on", () => {
    // Deliberate, and the single most consequential line in this phase.
    // Widening the seam to GPC/DNT stops tags that fire today on every customer
    // site at once — every tag ever created from the admin is filed `marketing`
    // — and it must arrive with an operator-facing switch and a published
    // category, not as a side effect of a rename. It belongs to the gating
    // phase. `docs/tag-manager.md` says so rather than claiming otherwise.
    bootTracker();
    w.navigator.globalPrivacyControl = true;
    setDnt();
    expect(w.__backlexConsentGranted("marketing")).toBe(true);
    expect(w.__backlexConsentDenied()).toBe(false);
  });
});

describe("the arity-0 alias a container compiled before this still calls", () => {
  test("it is callable with no argument and answers a strict boolean", () => {
    // The old call site is `window.__backlexConsentDenied() === true`, so a
    // truthy non-`true` — an object, a string — reads as NOT denied and every
    // gated marketing tag fires. Nothing in the suite pinned this before.
    bootTracker();
    const v = w.__backlexConsentDenied();
    expect(typeof v).toBe("boolean");
    expect(v).toBe(false);
  });

  test("both string forms answer exactly as they did before the map existed", () => {
    bootTracker();
    w.backlex.consent("denied");
    expect(w.__backlexConsentDenied()).toBe(true);
    w.backlex.consent("granted");
    expect(w.__backlexConsentDenied()).toBe(false);
  });

  test("a partial decision reads as denied, because one answer cannot describe three", () => {
    // Over-blocking is the only error worth making: an old container cannot ask
    // per category, and it is live for at most the fifteen minutes its cache
    // holds. Under-blocking would fire a pixel the visitor declined.
    bootTracker();
    w.backlex.consent({ analytics: true, marketing: false });
    expect(w.__backlexConsentDenied()).toBe(true);
  });
});

// ---------------------------------------------------------------------------

/** Boot the container runtime over a freshly booted tracker. */
const bootContainer = (tags: unknown[], trigger: unknown = { id: "t1", type: "pageview" }) => {
  delete w.__backlexTMBooted;
  new Function(TAG_RUNTIME_JS)();
  w.__backlexTM({
    v: 1,
    site: "site-1",
    tags,
    triggers: [trigger],
    variables: [],
  });
};

/**
 * A tag whose firing is observable.
 *
 * `image_pixel` rather than `custom_js` on purpose: happy-dom does not execute
 * a script element appended to the document (measured), so an inline-JS tag
 * would look identical whether it fired or not — the vacuous-green shape this
 * whole file exists to avoid. A pixel is a synchronous `new Image()` plus a
 * `.src`, and it is also what most real marketing tags actually are.
 */
const pixelTag = (id: string, consent: string, fire = "always") => ({
  id,
  name: id,
  kind: "image_pixel",
  consent,
  fire,
  triggers: ["t1"],
  blocking: [],
  params: { url: "https://px.example/" + id },
});

describe("the container gates on the tracker's answer", () => {
  test("an explicit call gates a marketing tag even when the dataLayer disagrees", () => {
    // The precedence used to be inverted between the two halves: the tracker
    // let an explicit call win, the container let the dataLayer win. A site
    // whose CMP called backlex.consent() while a stale gtag entry sat in the
    // page got two different answers on one page.
    bootTracker();
    w.dataLayer = [["consent", "update", { ad_storage: "granted" }]];
    w.backlex.consent({ analytics: true, marketing: false });
    bootContainer([pixelTag("pixel", "marketing")]);
    expect(w.__fired).toEqual([]);
  });

  test("a `none` tag fires regardless", () => {
    bootTracker();
    w.backlex.consent("denied");
    bootContainer([pixelTag("essential", "none")]);
    expect(w.__fired).toEqual(["essential"]);
  });

  test("it falls back to the old seam when the tracker is older than the runtime", () => {
    // A page can hold a /script.js cached for an hour beside a fifteen-minute
    // container, so an old tracker beside a new runtime is a live combination.
    // Dropping the fallback would fire a pixel for a visitor who said no.
    bootTracker();
    delete w.__backlexConsentGranted;
    w.backlex.consent("denied");
    bootContainer([pixelTag("pixel", "marketing")]);
    expect(w.__fired).toEqual([]);
  });
});

describe("a denied tag spends nothing on its way to not firing", () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* happy-dom always has one; the tag guards anyway */
    }
  });

  test("a once_per_page tag denied now still fires when consent arrives", () => {
    // The consent check used to run AFTER the fire budget, and both budgets are
    // WRITES. A denied tag burned its single chance on a fire that never
    // happened, so a visitor who accepted a moment later got nothing.
    //
    // The trigger is history_change rather than pageview so both raises happen
    // inside ONE container boot. Re-booting would prove nothing: `firedThisPage`
    // lives in the runtime closure, so a fresh boot hands the tag a fresh budget
    // and the test would pass against the bug it is here to catch.
    bootTracker();
    w.backlex.consent("denied");
    bootContainer([pixelTag("pixel", "marketing", "once_per_page")], {
      id: "t1",
      type: "history_change",
    });

    w.dispatchEvent(new Event("hashchange"));
    expect(w.__fired).toEqual([]);

    w.backlex.consent("granted");
    w.dispatchEvent(new Event("hashchange"));
    expect(w.__fired).toEqual(["pixel"]);
  });

  test("a once_per_visitor_day tag writes nothing to the device while denied", () => {
    // Not only a measurement bug. Writing a localStorage key on behalf of a tag
    // the visitor just declined is the act ePrivacy Art. 5(3) is about — storing
    // information on their terminal equipment — performed for a tag that was
    // never allowed to run.
    bootTracker();
    w.backlex.consent("denied");
    bootContainer([pixelTag("daily", "marketing", "once_per_visitor_day")]);
    expect(w.__fired).toEqual([]);
    expect(localStorage.getItem("backlex.tm.daily")).toBe(null);
  });
});
