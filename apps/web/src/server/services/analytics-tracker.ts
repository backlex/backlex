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
 * ── PRIOR_BLOCKING: why the first pageview may wait ───────────────────────
 * The server orders the per-site file tracker -> banner -> container, and that
 * ordering gates the CONTAINER because the container starts after the banner.
 * It never gated this tag, because this tag FINISHES before the banner — the
 * last line of `__backlexTrackerInit` is a pageview. Measured on production:
 * one `POST /api/analytics/collect` before the visitor had chosen anything,
 * with `__backlexConsentGranted("analytics")` answering false a moment later,
 * about the request that had already left.
 *
 * Two config fields fix it, and both are needed:
 *
 *   `d` — the undecided posture the operator configured, so the grant map is
 *         their answer rather than the pre-policy default from the very first
 *         synchronous call. Alone it is not enough: a RETURNING visitor's
 *         decision lives in a cookie this tag does not read, so an `allow`
 *         site would overrun a recorded refusal and a `block` site would drop
 *         the first pageview of everyone who had already accepted.
 *   `w` — hold the first pageview until the banner speaks. The banner reads
 *         that cookie and calls `backlex.consent()` as its first act, so this
 *         is an ordering fix, not a delay: the release is synchronous, inside
 *         the same file. The timeout is a net, not the plan — a banner that is
 *         switched off, boots twice, or throws would otherwise take the site's
 *         analytics with it, and silent data loss is the worse failure.
 *
 * The hold is not spent on a denied attempt. With the common `block` posture
 * the banner releases it into a denial, and the visitor who then presses
 * Accept must still be counted on the page they LANDED on — the one page a
 * consenting visit is certain to have. A visitor who never answers is never
 * counted, which is the point.
 *
 * One knock-on, decided rather than overlooked: the `backlex.q` pre-init queue
 * drains against the SEEDED map, so a custom event queued before this tag
 * loaded is now gated by the operator's posture instead of firing
 * unconditionally. The queue is deliberately NOT held the way the pageview is
 * — a pageview describes the page the visitor is still on, so replaying it
 * after consent is honest, while replaying a `backlex("view_product")` from
 * thirty seconds ago is reporting a moment that has passed.
 *
 * Neither field is set on a plain `/script.js` install, which is unchanged.
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

  // ...unless the server compiled in the operator's undecided posture, which
  // it does on every site with a policy. Applied with backlex.consent's TOTAL
  // rule, because the banner passes its own map through it moments later.
  if (cfg && cfg.d) {
    for (var gi = 0; gi < OPTIONAL.length; gi++) {
      grants[OPTIONAL[gi]] = cfg.d[OPTIONAL[gi]] === true;
    }
  }

  // Two per-site answers the server compiles into the file, alongside the
  // consent seam rather than below it, because consentGranted() reads one of
  // them and is exported before the boot guards run.
  //
  // Neither can arrive as a script ATTRIBUTE: document.currentScript is null
  // for a dynamically injected script, which is exactly the async snippet
  // operators paste, so self is null on the whole tag-manager path. The
  // fallbacks are what a plain /script.js install has always assumed.
  var trackerCategory = cfg && cfg.t ? cfg.t : "analytics";
  var signals = cfg && cfg.g ? cfg.g : "tracker";

  // Whether the first pageview waits for the banner to speak -- set only when
  // the server concatenated one into this same file. See PRIOR_BLOCKING above.
  var waiting = !!(cfg && cfg.w);

  // Do Not Track and Global Privacy Control, in ONE place.
  //
  // A function declaration, so consentGranted() above can call it while
  // honorDnt below is still hoisted-undefined -- it is only ever CALLED after
  // init has run to the end, and reading the attribute at call time is what
  // makes that safe.
  //
  // GPC is not gated on honorDnt: data-respect-dnt was named for Do Not
  // Track, and GPC is a different thing -- a signal with actual legal weight
  // under CCPA/CPRA rather than a retired W3C draft. Turning both off is what
  // signals === "off" is for, and unlike the attribute it reaches the
  // tag-manager install.
  function signalOptOut() {
    if (signals === "off") return false;
    try {
      if (honorDnt && (nav.doNotTrack === "1" || window.doNotTrack === "1")) return true;
      if (nav.globalPrivacyControl === true) return true;
    } catch (e) {}
    return false;
  }

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
  // yes -- the pre-policy default.
  //
  // On a site with a banner that default is barely reachable: the banner writes
  // a TOTAL grant map before the container arms, applying the per-site
  // "undecided" posture, so grants[category] is already set. It stands for the
  // plain /script.js install, where no policy is delivered at all.
  //
  // GPC and Do Not Track reach third-party tags only when the SITE says so.
  //
  // They used to be read in optedOut() alone, gating this tag and nothing else,
  // because widening them cannot be a side effect of a deploy: every tag the
  // manager compiles is filed under "marketing" by default, so a browser-side
  // flip would switch off live pixels on every customer site at once, for
  // visitors whose operator chose nothing. The switch is per site, it defaults
  // to that same behaviour, and it arrives in cfg.g -- see SIGNAL_HANDLING.
  //
  // Ordered AFTER the explicit call and BEFORE the dataLayer: an operator or a
  // banner naming this category outright is the site speaking about this
  // visitor, which beats a browser-wide preference; a two-key gtag map is a
  // weaker signal than a header the visitor's own agent set.
  function consentGranted(category) {
    if (!category || category === "none") return true;
    if (grants[category] === true) return true;
    if (grants[category] === false) return false;
    if (signals === "all" && signalOptOut()) return false;
    return stateFor(category) !== "denied";
  }

  // The seam the tag-manager runtime gates every third-party tag through, so
  // there is ONE answer to "did the visitor say no" rather than two that drift.
  window.__backlexConsentGranted = consentGranted;

  // Whether the signals amount to a refusal ON THIS SITE. Exported for the
  // banner, and it exists because of a hole real measurement found:
  //
  // consentGranted() consults the grant map FIRST, and the banner always writes
  // a TOTAL map before the container arms -- so grants[category] is never
  // undefined on a site running a banner, and the signal branch below it was
  // dead code there. With undecided = "allow" that meant a GPC visitor who had
  // not answered got every tag fired on a site whose operator had explicitly
  // asked for the opposite.
  //
  // The fix belongs in the banner, because only the banner can tell an
  // UNDECIDED posture from a decision, and the two must be treated differently:
  // a signal outranks a guess about a visitor, and does not outrank that
  // visitor's own recorded answer. The logic still lives here so there is one
  // implementation of it.
  window.__backlexSignalsRefuseAll = function () {
    return signals === "all" && signalOptOut();
  };

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
    // The site's own answer for how THIS tag is classified, delivered in the
    // per-site file. "none" means the operator filed it as strictly necessary
    // -- it stores nothing on the device and its visitor id rotates daily --
    // and consentGranted("none") is true, so only the signals below can stop
    // it. Absent (the plain /script.js install, where there is no policy to
    // read), it stays "analytics", which is what it has always assumed.
    if (!consentGranted(trackerCategory)) return true;
    if (signalOptOut()) return true;
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

  // The pageview that may have been held. NOT marked done until it actually
  // leaves: a block posture releases it into a denial, and a visitor who then
  // accepts must still be counted on the page they landed on.
  var firstDone = 0;
  function firstPageview() {
    if (firstDone || optedOut()) return;
    firstDone = 1;
    pageview();
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
    // The banner's first act is applyGrants(), and this is where a held
    // pageview is released: the map is now an answer rather than a guess.
    if (waiting) firstPageview();
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
  //
  // Held when a banner is coming; the timeout is the net for one that is
  // switched off, boots twice, or throws. See PRIOR_BLOCKING above.
  if (waiting) setTimeout(firstPageview, 0);
  else firstPageview();
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
