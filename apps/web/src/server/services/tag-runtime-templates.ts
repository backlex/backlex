/**
 * Tag manager — the browser half of the vendor template registry.
 *
 * Every template exists twice: as data in `tag-templates.ts` (parameters,
 * origins, consent) and as an init branch here. `tag-runtime.test.ts` asserts
 * the two lists agree, because a template with no branch would be an option the
 * admin offers and nothing honours.
 *
 * ── Every one of these vendors needs a pre-init queue shim ────────────────
 * Verified against each vendor's own documentation: `fbq`, `ttq`, `rdt`,
 * `snaptr`, `ym`, `gtag`, `lintrk`, `uetq`, `twq`, `pintrk`, `clarity`, `hj`
 * are all queue shims that must exist BEFORE the async library lands, or the
 * calls made in the same breath are lost. So each branch below installs the
 * shim, then loads, then calls — never the other way round.
 *
 * The strings here are concatenated into `TAG_RUNTIME_JS`, so the same rule
 * applies: no backtick, no dollar-brace. Backslashes survive here, which is
 * the whole reason these modules are raw literals.
 */
export const TAG_RUNTIME_TEMPLATES_JS = String.raw`
  // Shared shim shape: most vendors want "make a global that queues until the
  // library replaces it". Written once rather than thirteen times.
  function queueShim(name, push) {
    if (window[name]) return window[name];
    var q = function () { q.queue.push(arguments); };
    q.queue = [];
    if (push) push(q);
    window[name] = q;
    return q;
  }

  function gtagShim() {
    window.dataLayer = window.dataLayer || [];
    if (!window.gtag) {
      window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag("js", new Date());
    }
    return window.gtag;
  }

  var loadedOnce = {};
  function loadOnce(key, src) {
    if (loadedOnce[key]) return;
    loadedOnce[key] = 1;
    loadScript(src);
  }

  var TEMPLATES = {
    google_tag: function (p) {
      gtagShim();
      loadOnce("gtag:" + p.measurementId, "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(p.measurementId));
      window.gtag("config", p.measurementId);
    },

    google_ads_conversion: function (p) {
      gtagShim();
      loadOnce("gtag:" + p.conversionId, "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(p.conversionId));
      window.gtag("config", p.conversionId);
      // Google Ads uses one literal event name plus send_to, and 'conversion'
      // is deliberately NOT in the gtag recommended-events list — it is its own
      // vocabulary, not a GA4 one.
      window.gtag("event", "conversion", { send_to: p.conversionId + "/" + p.conversionLabel });
    },

    meta_pixel: function (p) {
      if (!window.fbq) {
        var n = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        n.push = n;
        n.loaded = true;
        n.version = "2.0";
        n.queue = [];
        window.fbq = n;
        if (!window._fbq) window._fbq = n;
      }
      loadOnce("fbq", "https://connect.facebook.net/en_US/fbevents.js");
      window.fbq("init", p.pixelId);
      window.fbq("track", "PageView");
    },

    tiktok_pixel: function (p) {
      var ttq = window.ttq;
      if (!ttq) {
        window.TiktokAnalyticsObject = "ttq";
        ttq = window.ttq = [];
        ttq.methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
        ttq.setAndDefer = function (t, m) {
          t[m] = function () { t.push([m].concat(Array.prototype.slice.call(arguments, 0))); };
        };
        for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
        ttq.instance = function (id) {
          var e = (ttq._i && ttq._i[id]) || [];
          for (var n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]);
          return e;
        };
        ttq._i = {};
        ttq._t = {};
        ttq._o = {};
      }
      ttq._i[p.pixelId] = ttq._i[p.pixelId] || [];
      ttq._t[p.pixelId] = +new Date();
      ttq._o[p.pixelId] = {};
      loadOnce("ttq:" + p.pixelId, "https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=" + encodeURIComponent(p.pixelId) + "&lib=ttq");
      // instance(), not the bare ttq: ttq.track fans out to EVERY loaded pixel,
      // so a page carrying two TikTok tags would double-count both of them.
      ttq.instance(p.pixelId).page();
    },

    reddit_pixel: function (p) {
      if (!window.rdt) {
        var r = function () {
          r.sendEvent ? r.sendEvent.apply(r, arguments) : r.callQueue.push(arguments);
        };
        r.callQueue = [];
        window.rdt = r;
      }
      // The id goes in the loader URL as well as the init call; the shipped
      // library branches on the query parameter's presence.
      loadOnce("rdt:" + p.pixelId, "https://www.redditstatic.com/ads/pixel.js?pixel_id=" + encodeURIComponent(p.pixelId));
      window.rdt("init", p.pixelId);
      window.rdt("track", "PageVisit");
    },

    snap_pixel: function (p) {
      if (!window.snaptr) {
        var a = function () {
          a.handleRequest ? a.handleRequest.apply(a, arguments) : a.queue.push(arguments);
        };
        a.queue = [];
        window.snaptr = a;
      }
      loadOnce("snaptr", "https://sc-static.net/scevent.min.js");
      window.snaptr("init", p.pixelId);
      window.snaptr("track", "PAGE_VIEW");
    },

    yandex_metrica: function (p) {
      var host = p.domain || "mc.yandex.ru";
      if (!window.ym) {
        window.ym = function () { (window.ym.a = window.ym.a || []).push(arguments); };
        // Load timestamp, and it is load-bearing: a hand-written shim that
        // omits it silently skews Yandex's own timing data.
        window.ym.l = 1 * new Date();
      }
      loadOnce("ym:" + host, "https://" + host + "/metrika/tag.js");
      var settings = { clickmap: true };
      if (p.webvisor === true) settings.webvisor = true;
      if (p.webvisor === false) settings.webvisor = false;
      window.ym(Number(p.counterId), "init", settings);
    },

    linkedin_insight: function (p) {
      // The plural array is what the library reads; LinkedIn's own
      // troubleshooting page names the singular, which is a doc bug.
      window._linkedin_data_partner_ids = window._linkedin_data_partner_ids || [];
      window._linkedin_data_partner_ids.push(p.partnerId);
      if (!window.lintrk) {
        window.lintrk = function (a, b) { window.lintrk.q.push([a, b]); };
        window.lintrk.q = [];
      }
      loadOnce("lintrk", "https://snap.licdn.com/li.lms-analytics/insight.min.js");
    },

    microsoft_clarity: function (p) {
      queueShim("clarity", function (c) { c.q = c.queue; });
      loadOnce("clarity:" + p.projectId, "https://www.clarity.ms/tag/" + encodeURIComponent(p.projectId));
    },

    hotjar: function (p) {
      var sv = p.snippetVersion || "6";
      if (!window.hj) {
        window.hj = function () { (window.hj.q = window.hj.q || []).push(arguments); };
      }
      window._hjSettings = { hjid: Number(p.siteId), hjsv: Number(sv) };
      loadOnce("hj:" + p.siteId, "https://static.hotjar.com/c/hotjar-" + encodeURIComponent(p.siteId) + ".js?sv=" + encodeURIComponent(sv));
    },

    microsoft_uet: function (p) {
      window.uetq = window.uetq || [];
      loadOnce("uet", "https://bat.bing.com/bat.js");
      // UET replaces the array with a real object once bat.js lands, and only
      // then can pageLoad be pushed. Microsoft's own snippet does this from the
      // script's onload; we poll briefly instead, because our loader is shared.
      var tries = 0;
      var wait = setInterval(function () {
        tries++;
        if (typeof window.UET === "function") {
          clearInterval(wait);
          var o = { ti: p.tagId };
          o.q = window.uetq;
          window.uetq = new window.UET(o);
          window.uetq.push("pageLoad");
        } else if (tries > 100) {
          clearInterval(wait);
        }
      }, 100);
    },

    x_pixel: function (p) {
      if (!window.twq) {
        var s = function () {
          s.exe ? s.exe.apply(s, arguments) : s.queue.push(arguments);
        };
        s.version = "1.1";
        s.queue = [];
        window.twq = s;
      }
      loadOnce("twq", "https://static.ads-twitter.com/uwt.js");
      window.twq("config", p.pixelId);
    },

    pinterest_tag: function (p) {
      if (!window.pintrk) {
        window.pintrk = function () {
          window.pintrk.queue.push(Array.prototype.slice.call(arguments));
        };
        window.pintrk.queue = [];
        window.pintrk.version = "3.0";
      }
      loadOnce("pintrk", "https://s.pinimg.com/ct/core.js");
      window.pintrk("load", p.tagId);
      // CamelCase, from Pinterest's own "Name in Tag" column. The lowercase
      // run-together forms in its noscript examples are query-string values,
      // not the event vocabulary.
      window.pintrk("page");
    }
  };
`;
