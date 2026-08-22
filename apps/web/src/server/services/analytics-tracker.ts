/**
 * The web analytics tag, as source.
 *
 * Held as a string in a TS module rather than a file under `public/` so the
 * route serves it identically on every runtime. The static-asset layer would
 * have covered Cloudflare, Vercel and Netlify, but the Bun target serves no
 * static assets at all — and a workspace self-hosted on Bun should not be the
 * one deploy that cannot measure a website.
 *
 * The content below is plain ES5-ish JavaScript; that property is about what
 * the BROWSER receives and is unchanged by living here.
 *
 * **It contains no backtick, no `${`, and no backslash — deliberately.** All
 * three would need escaping inside this template literal, and the backslash is
 * the dangerous one: `\.` inside a template literal silently becomes `.`, so a
 * regex written naturally here would ship subtly wrong (`[::1]` would turn
 * into a character class rather than a literal). The tag therefore uses string
 * operations where a regex would be the obvious choice, and
 * `analytics-collect.test.ts` fails if any of the three ever appears. (That
 * pointer used to name a file that does not exist.)
 *
 * ── Why this is a function rather than an IIFE ────────────────────────────
 * The tag manager serves ONE per-site file carrying both this tracker and the
 * container runtime, so the tracker has to be startable with configuration
 * passed in rather than sniffed from the page. `__backlexTrackerInit(cfg)`
 * takes `{s, e}` — site id and collect endpoint — and falls back to the
 * original attribute/URL sniffing when called with `null`, which is exactly
 * what `/script.js` does. Its behaviour on the legacy snippet is unchanged.
 */
export const TRACKER_JS = `// backlex web analytics tag.
//
//   <script defer src="https://<your-workspace>/api/analytics/script.js"
//           data-site="<site-id>"></script>
//
// Plain JavaScript, no build step, on the same reasoning as
// 'boot-recovery.js': it has to be servable from a stable unhashed path and
// executable by whatever a customer's site runs.
//
// -- Why sendBeacon with a text/plain body --------------------------------
// A JSON content-type makes the request "not simple", so the browser sends a
// CORS preflight -- and the collect route deliberately sits OUTSIDE the app's
// credentialed CORS middleware, where an OPTIONS round-trip is exactly what we
// are avoiding. text/plain keeps the request simple: no preflight, one hop.
// sendBeacon additionally survives the page being closed, which is the whole
// reason a pageview fired on unload ever arrives.
//
// -- What this does NOT do ------------------------------------------------
// It stores nothing on the device: no cookie, no localStorage, no
// sessionStorage. The visitor id is derived server-side and rotates every UTC
// midnight, so there is nothing here to persist and nothing to consent to. It
// never reads page content -- only the URL, the referrer, and the event name
// the caller passes.
//
// NOTE: this file intentionally avoids regular expressions. It is embedded in
// a TypeScript template literal, where a backslash would be eaten before it
// ever reached a browser.
window.__backlexTrackerInit = function (cfg) {
  var doc = document;
  var nav = navigator;

  // One tracker per page, whichever snippet started it. Both the legacy
  // /script.js snippet and the tag-manager file call in here, and a site
  // migrating from one to the other will briefly have both installed. Without
  // this guard that page reports every visit twice, silently, and the numbers
  // simply look like growth.
  if (window.__backlexTagBooted) return;

  // document.currentScript is only valid while this file is executing, so it
  // is captured immediately rather than looked up later from a callback. It is
  // also null for a dynamically injected script, which is why the configured
  // path below never consults it.
  var self = doc.currentScript;

  // -- Consent --------------------------------------------------------------
  //
  // A grant map, not a switch. "none" is never gated -- that is what the value
  // means -- and the other three are the categories a banner actually asks
  // about. The map starts EMPTY: "nobody has answered yet" has to stay
  // distinguishable from "they said no", because a visitor who has not chosen
  // is not a visitor who declined.
  //
  // This is Consent Mode's MECHANICAL half and nothing more: if a consent tool
  // says no, we do not collect. GA4's other half is behavioural modeling --
  // statistically inferring the conversions it was not allowed to observe --
  // and that is not something to imitate quietly.
  //
  // Deliberately ABOVE the site and endpoint guards below. The tag-manager
  // runtime gates every third-party tag through this seam, so a tracker that
  // bails for want of its own configuration must still be able to answer; it
  // needs neither value to do so. Still BELOW the boot guard, though: two
  // installed snippets must not end up with the site calling one closure's
  // consent while the other closure is the one sending.
  var OPTIONAL = ["functional", "analytics", "marketing"];
  var grants = {};

  // Which Consent Mode key speaks for a category.
  function storageKey(category) {
    if (category === "marketing") return "ad_storage";
    if (category === "functional") return "functionality_storage";
    return "analytics_storage";
  }

  // Google Consent Mode, as a gtag dataLayer entry. Read defensively: this is
  // another vendor's array on someone else's page.
  function gtagState(key) {
    try {
      var dl = window.dataLayer;
      if (dl && dl.length) {
        for (var i = dl.length - 1; i >= 0; i--) {
          var e = dl[i];
          if (!e) continue;
          var state = e[2] || e;
          if (state && typeof state === "object" && state[key]) return state[key];
        }
      }
    } catch (e) {
      // A malformed dataLayer is not a reason to stop measuring; it is a
      // reason to fall through to the explicit signals.
    }
    return null;
  }

  function stateFor(category) {
    var s = gtagState(storageKey(category));
    // A functional tag has always been read off analytics_storage here, so
    // keep answering that way when the more specific key is absent -- a site
    // already running Consent Mode should not change behaviour.
    if (!s && category === "functional") s = gtagState("analytics_storage");
    return s;
  }

  // May this category run?
  //
  // An explicit call beats the dataLayer, because that is the site owner
  // speaking directly rather than us inferring. With neither, the answer is
  // yes -- the pre-policy default. The per-site "undecided" posture that can
  // change that answer is published in the consent artifact already, but
  // nothing delivers the artifact to a browser yet.
  //
  // GPC and Do Not Track are deliberately NOT read here. They gate THIS tag,
  // in optedOut() below, exactly as they always have. Extending them to
  // third-party tags stops tags that fire today, on sites whose operator took
  // no action, and belongs with the gating work that can also hand that
  // operator a switch.
  function consentGranted(category) {
    if (!category || category === "none") return true;
    if (grants[category] === true) return true;
    if (grants[category] === false) return false;
    return stateFor(category) !== "denied";
  }

  // The seam the tag-manager runtime gates every third-party tag through, so
  // there is ONE answer to "did the visitor say no" rather than two that drift.
  window.__backlexConsentGranted = consentGranted;

  // The name a container compiled before this existed still calls. A browser
  // can hold a container for fifteen minutes and a /script.js for an hour, so
  // both halves of a deploy are live at once. Arity-0 and strictly boolean,
  // because the old call site is "window.__backlexConsentDenied() === true".
  //
  // It answers for the map as a whole, and it answers CONSERVATIVELY: one
  // denied category is enough. An old container cannot ask per category, so
  // over-blocking is the only error worth making -- and it changes nothing for
  // either string form, which is every caller that exists today.
  window.__backlexConsentDenied = function () {
    for (var i = 0; i < OPTIONAL.length; i++) {
      if (!consentGranted(OPTIONAL[i])) return true;
    }
    return false;
  };

  var site = cfg && cfg.s ? cfg.s : self ? self.getAttribute("data-site") : null;
  if (!site) return;

  // Claimed only once this snippet is known to be usable. Set any earlier and
  // one leftover script tag with a missing or typo'd data-site would poison the
  // flag and silently stop the WORKING install on the same page from booting.
  window.__backlexTagBooted = 1;

  // The collect endpoint lives next to the script that served us, so a
  // workspace on a custom domain needs no second attribute to configure.
  //
  // Derived from the LAST slash rather than by searching for a filename. The
  // old form looked for "/script.js" and fell back to a RELATIVE path when it
  // was not found -- which resolves against the customer page, so every beacon
  // would have gone to their own server and 404ed, invisibly: sendBeacon
  // returns before a response and the fetch fallback swallows errors.
  var endpoint = cfg && cfg.e ? cfg.e : "";
  if (!endpoint) {
    var src = String((self && self.src) || "");
    var cut = src.lastIndexOf("/");
    endpoint = cut === -1 ? "" : src.slice(0, cut) + "/collect";
  }
  if (!endpoint) return;

  // Opt-outs a site owner can set without touching this file.
  //
  // Read through a guard because self is legitimately null now: on the
  // tag-manager path there is no script element to read attributes from, and
  // on any dynamically injected script currentScript is null regardless. An
  // unguarded read here would throw before the first pageview -- on the exact
  // path the tag manager depends on.
  function attr(name) {
    return self ? self.getAttribute(name) : null;
  }
  var honorDnt = attr("data-respect-dnt") !== "false";
  var localhostOk = attr("data-allow-localhost") === "true";
  var LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"];

  function optedOut() {
    // The tag files itself under "analytics". The per-site posture that could
    // file it under "none" instead -- strictly necessary, measures everyone --
    // already ships in the consent artifact, but nothing delivers that
    // artifact to a browser yet, so this is the assumption until it does.
    if (!consentGranted("analytics")) return true;
    if (honorDnt && (nav.doNotTrack === "1" || window.doNotTrack === "1")) return true;
    if (nav.globalPrivacyControl === true) return true;
    // A dev machine's traffic is noise in a production report, and forgetting
    // to strip the tag before running locally is the normal case, not the
    // exception. Opt in with data-allow-localhost="true".
    if (!localhostOk && LOCAL_HOSTS.indexOf(location.hostname) !== -1) return true;
    return false;
  }

  function send(name, props) {
    if (optedOut()) return;

    var body;
    try {
      body = JSON.stringify({
        s: site,
        n: name,
        // Path WITH its query string: campaign tags live there, and the server
        // is what parses them out.
        p: location.pathname + location.search,
        // Same-origin referrers are self-navigation, not acquisition -- they
        // would otherwise dominate the referrer report with your own pages.
        r: doc.referrer && doc.referrer.indexOf(location.origin) !== 0 ? doc.referrer : "",
        h: location.hostname,
        // Reported so the server can enforce as well. A client-side check is
        // advice; the route drops a denied event regardless of what a modified
        // tag chooses to send.
        //
        // Only an EXPLICIT grant is claimed. Reaching this line already proves
        // the tag did not consider itself denied, so stamping "granted" on a
        // visitor who never answered would put on the wire a claim nobody made
        // -- and this is the field an operator points at in an audit.
        c: grants.analytics === true ? "granted" : null,
        v: props || null
      });
    } catch (e) {
      return;
    }

    // A Blob so the content-type is explicit. Some browsers default a string
    // beacon to text/plain anyway, but being explicit is what keeps the
    // request "simple" everywhere.
    try {
      if (nav.sendBeacon) {
        var blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
        if (nav.sendBeacon(endpoint, blob)) return;
      }
    } catch (e) {
      // fall through to fetch
    }

    try {
      fetch(endpoint, {
        method: "POST",
        body: body,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        keepalive: true,
        mode: "cors",
        // Explicitly NOT "include": the collect route answers ACAO * , and a
        // credentialed request against a wildcard origin is rejected outright
        // by the browser.
        credentials: "omit"
      }).catch(function () {});
    } catch (e) {
      // a dropped event is not worth an exception on someone's site
    }
  }

  var lastUrl = location.pathname + location.search + location.hash;
  function pageview() {
    lastUrl = location.pathname + location.search + location.hash;
    send("page_view", null);
  }
  function maybePageview() {
    var now = location.pathname + location.search + location.hash;
    if (now !== lastUrl) pageview();
  }

  // -- SPA route changes ----------------------------------------------------
  // pushState and replaceState fire no event, so a single-page app would
  // otherwise report exactly one pageview per full load. Wrapping them is the
  // only way to see the other navigations; popstate covers back/forward and
  // hashchange covers hash routing.
  function wrap(fnName) {
    var orig = history[fnName];
    if (typeof orig !== "function") return;
    history[fnName] = function () {
      var out = orig.apply(this, arguments);
      // Let the framework finish its own render before reading location, and
      // ignore a state push that did not actually change the URL.
      setTimeout(maybePageview, 0);
      return out;
    };
  }
  wrap("pushState");
  wrap("replaceState");
  addEventListener("popstate", maybePageview);
  addEventListener("hashchange", maybePageview);

  // Public handle for custom events: backlex("signup", {plan: "pro"}).
  // Assigned before the first pageview so a snippet placed above this one can
  // queue calls without a race.
  var queued = window.backlex && window.backlex.q;
  window.backlex = function (name, props) {
    if (name) send(String(name), props);
  };
  // Explicit control for a site whose consent tool is not gtag-shaped:
  //
  //   backlex.consent("denied")             grants nothing
  //   backlex.consent("granted")            grants every optional category
  //   backlex.consent({analytics: true})    a decision, stated in full
  //   backlex.consent(null)                 back to undecided
  //
  // An explicit call wins over the dataLayer, because it is the site owner
  // speaking directly rather than us inferring.
  //
  // The object form is TOTAL, not a patch: a category the caller leaves out is
  // DENIED, not left alone. That is the same rule the server applies when it
  // stores a consent record -- absence is not consent -- and the two have to
  // agree, because a banner calls both with the same object. A patch would let
  // the stored evidence say "they refused marketing" while the page fired the
  // marketing pixel.
  window.backlex.consent = function (state) {
    var next = {};
    var i;
    if (state === "granted" || state === "denied") {
      for (i = 0; i < OPTIONAL.length; i++) next[OPTIONAL[i]] = state === "granted";
    } else if (state && typeof state === "object" && !Array.isArray(state)) {
      for (i = 0; i < OPTIONAL.length; i++) next[OPTIONAL[i]] = state[OPTIONAL[i]] === true;
    }
    // Anything else -- null, undefined, an array, a number -- resets to
    // undecided, which is what the tri-state this replaced did with a value it
    // did not recognise. typeof null is "object", so the guard above is what
    // keeps backlex.consent() from throwing on a customer's page.
    grants = next;
  };
  if (queued && queued.length) {
    for (var i = 0; i < queued.length; i++) {
      try {
        window.backlex.apply(null, queued[i]);
      } catch (e) {
        // one bad queued call must not stop the rest
      }
    }
  }

  // The container runtime raises custom events through the same public handle,
  // so a backlex_event tag needs no second transport.
  pageview();
};
`;

/**
 * What `/script.js` actually serves: the tracker plus the call that starts it
 * in legacy mode.
 *
 * Kept separate so the tag-manager file can concatenate `TRACKER_JS` and start
 * it with configuration instead. Splitting here rather than at the route means
 * there is exactly one place that knows the legacy start is `(null)`.
 */
export const TRACKER_BOOT_JS = TRACKER_JS + ";__backlexTrackerInit(null);";
