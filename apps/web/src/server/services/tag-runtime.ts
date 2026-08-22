/**
 * Tag manager — the browser runtime.
 *
 * A fixed interpreter over a JSON container. Operator input is DATA here, never
 * code: the container names a template id, and the branch that runs is a
 * function written in this repo. The two exceptions are the custom-code tag
 * kinds, which exist precisely to run operator JavaScript and are gated
 * per-site for exactly that reason.
 *
 * ── Why this file may use backslashes and `analytics-tracker.ts` may not ──
 * That one is a plain template literal, where a backslash is eaten before the
 * browser ever sees it — so the tag avoids regexes entirely. These runtime
 * modules are raw literals, which preserve backslashes, so real regexes are
 * available. Backtick and dollar-brace are still forbidden: they would
 * terminate the literal rather than merely corrupt it, and
 * `tag-runtime.test.ts` asserts both absences AND that a known regex survives
 * intact. The positive half matters — "no backslash" was the old guard, and it
 * is precisely what is being relaxed.
 *
 * The alternative — a real `.js` file imported with a raw-text query — was
 * rejected: that syntax is Vite-only, six of the eight build targets go through
 * `Bun.build`, and `bun test` imports this module with no bundler at all.
 *
 * ── Injection, not eval ───────────────────────────────────────────────────
 * Every script this runtime adds is an injected `<script>` element carrying the
 * loader's own nonce, never `new Function` or `eval`. `new Function` needs
 * `unsafe-eval` in the CUSTOMER's Content-Security-Policy, which nothing can
 * grant selectively; a nonce-carrying element works under a strict policy.
 * `document.write` is never used — after load it destroys the page.
 */
import { TAG_RUNTIME_TEMPLATES_JS } from "./tag-runtime-templates";

const HEAD = String.raw`
// container is the compiled document. There is deliberately no second
// argument: everything the runtime needs travels inside the container, so a
// caller cannot configure behaviour the published version does not describe.
window.__backlexTM = function (container) {
  if (!container || container.v !== 1) return;
  if (window.__backlexTMBooted) return;
  window.__backlexTMBooted = 1;

  var doc = document;

  // The loader's own nonce, propagated to every script this runtime injects.
  // A strict nonce-based policy blocks anything without it, and the browser
  // hides the value from getAttribute while still exposing the property --
  // which is why this reads .nonce first.
  var NONCE = "";
  try {
    var me = doc.currentScript;
    NONCE = (me && (me.nonce || me.getAttribute("nonce"))) || "";
  } catch (e) {}

  // -- Consent -------------------------------------------------------------
  // The tracker owns the answer; this is the chain that finds it. When the two
  // ship together -- the normal case, one file -- consentDenied() below asks
  // the tracker's per-category seam and stops there, so a site gets ONE verdict
  // rather than two that can drift apart on the same page.
  //
  // The dataLayer read kept below is the fallback for the case that is not
  // normal but is real: a page whose tracker is older than this runtime, or
  // never booted at all. It reads a marketing tag off ad_storage and everything
  // else off analytics_storage, which is all a two-key map can say.
  function gtagState(key) {
    try {
      var dl = window.dataLayer;
      if (!dl || !dl.length) return null;
      for (var i = dl.length - 1; i >= 0; i--) {
        var e = dl[i];
        if (!e) continue;
        var state = e[2] || e;
        if (state && typeof state === "object" && state[key]) return state[key];
      }
    } catch (e) {}
    return null;
  }

  function consentDenied(category) {
    if (!category || category === "none") return false;

    // The tracker's per-category answer first. It already folds the dataLayer
    // in, so when it speaks there is nothing left to ask -- and it is the only
    // source that can distinguish "functional" from "analytics", which the
    // two-key gtag map below cannot.
    //
    // Read strictly in BOTH directions. A global that answered undefined would
    // otherwise either block every tag on the page or none of them, depending
    // on which way the comparison was written.
    try {
      var granted = window.__backlexConsentGranted;
      if (typeof granted === "function") {
        var v = granted(category);
        if (v === true) return false;
        if (v === false) return true;
      }
    } catch (e) {}

    var key = category === "marketing" ? "ad_storage" : "analytics_storage";
    var explicit = gtagState(key);
    if (explicit) return explicit === "denied";

    // Last: the arity-0 seam a tracker older than the per-category one still
    // exports. A page can hold a /script.js cached for an hour beside a
    // fifteen-minute container, and whichever booted first is the one that
    // installed the globals -- so this is a live combination, not a legacy one.
    try {
      if (typeof window.__backlexConsentDenied === "function") {
        return window.__backlexConsentDenied() === true;
      }
    } catch (e) {}
    return false;
  }

  // -- Loading -------------------------------------------------------------
  function loadScript(src) {
    var s = doc.createElement("script");
    s.async = true;
    s.src = src;
    if (NONCE) s.setAttribute("nonce", NONCE);
    var first = doc.getElementsByTagName("script")[0];
    // insertBefore needs a script already in the document. A page whose only
    // script was itself injected has none, so fall back rather than throwing
    // on somebody's marketing site.
    if (first && first.parentNode) first.parentNode.insertBefore(s, first);
    else (doc.head || doc.documentElement).appendChild(s);
    return s;
  }

  function runInline(code) {
    var s = doc.createElement("script");
    if (NONCE) s.setAttribute("nonce", NONCE);
    s.text = code;
    (doc.head || doc.documentElement).appendChild(s);
  }

  // A custom-HTML tag is markup, not a script body. Assigning HTML to a
  // script element's .text would have produced a syntax error and fired
  // nothing -- the tag would simply never have worked.
  //
  // Markup inserted with innerHTML does not execute its scripts, which is the
  // whole reason GTM's own custom-HTML tag re-creates them. So: parse the
  // markup into a detached holder, attach it, then rebuild each script as a
  // fresh element carrying our nonce so a strict policy still admits it.
  function injectHtml(html) {
    var holder = doc.createElement("div");
    holder.style.display = "none";
    holder.innerHTML = html;

    var scripts = holder.getElementsByTagName("script");
    var pending = [];
    for (var i = 0; i < scripts.length; i++) pending.push(scripts[i]);

    (doc.body || doc.documentElement).appendChild(holder);

    for (var k = 0; k < pending.length; k++) {
      var old = pending[k];
      var fresh = doc.createElement("script");
      for (var a = 0; a < old.attributes.length; a++) {
        fresh.setAttribute(old.attributes[a].name, old.attributes[a].value);
      }
      if (NONCE) fresh.setAttribute("nonce", NONCE);
      if (!old.src) fresh.text = old.text;
      if (old.parentNode) old.parentNode.replaceChild(fresh, old);
    }
  }

  function loadPixel(url) {
    var img = new Image(1, 1);
    img.style.display = "none";
    img.src = url;
  }
`;

const TAIL = String.raw`
  // -- Variables -----------------------------------------------------------
  var VARS = {};
  for (var vi = 0; vi < (container.variables || []).length; vi++) {
    VARS[container.variables[vi].key] = container.variables[vi];
  }

  function queryParam(name) {
    try {
      return new URL(location.href).searchParams.get(name);
    } catch (e) {
      return null;
    }
  }

  function cookie(name) {
    var all = String(doc.cookie || "").split(";");
    for (var i = 0; i < all.length; i++) {
      var part = all[i].replace(/^\s+/, "");
      if (part.indexOf(name + "=") === 0) {
        try {
          return decodeURIComponent(part.slice(name.length + 1));
        } catch (e) {
          return part.slice(name.length + 1);
        }
      }
    }
    return null;
  }

  function dataLayerValue(name) {
    try {
      var dl = window.dataLayer;
      if (!dl || !dl.length) return null;
      for (var i = dl.length - 1; i >= 0; i--) {
        var e = dl[i];
        if (e && typeof e === "object" && e[name] != null) return String(e[name]);
      }
    } catch (e) {}
    return null;
  }

  function resolveVariable(key) {
    var v = VARS[key];
    if (!v) return null;
    var c = v.config || {};
    if (v.kind === "constant") return c.value == null ? null : String(c.value);
    if (v.kind === "query_param") return queryParam(c.name);
    if (v.kind === "cookie") return cookie(c.name);
    if (v.kind === "data_layer") return dataLayerValue(c.name);
    if (v.kind === "js_expression") {
      // Operator-authored, and it only reaches here because the site's
      // allow_custom_code gate let the compiler emit it. Injected rather than
      // evaluated, so this path needs no unsafe-eval either; the result comes
      // back through a well-known global.
      try {
        window.__backlexTMExpr = undefined;
        runInline("try{window.__backlexTMExpr=(" + c.code + ");}catch(e){}");
        var out = window.__backlexTMExpr;
        return out == null ? null : String(out);
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function builtin(field, ev) {
    ev = ev || {};
    var loc = location;
    if (field === "pageUrl") return loc.href;
    if (field === "pagePath") return loc.pathname;
    if (field === "pageHostname") return loc.hostname;
    if (field === "pageQuery") return loc.search;
    if (field === "referrer") return doc.referrer || null;
    if (field === "eventName") return ev.name || null;
    if (field === "clickId") return ev.clickId || null;
    if (field === "clickClasses") return ev.clickClasses || null;
    if (field === "clickText") return ev.clickText || null;
    if (field === "clickUrl") return ev.clickUrl || null;
    if (field === "formId") return ev.formId || null;
    if (field === "formAction") return ev.formAction || null;
    return null;
  }

  function numericBuiltin(field, ev) {
    if (field === "scrollPercent") {
      return ev && ev.scrollPercent != null ? Number(ev.scrollPercent) : null;
    }
    return null;
  }

  // -- Conditions ----------------------------------------------------------
  function textMatches(op, actual, value) {
    if (op === "isSet") return actual != null && actual !== "";
    if (op === "isNotSet") return actual == null || actual === "";
    if (actual == null) return false;
    var a = String(actual);
    if (op === "in") {
      for (var i = 0; i < value.length; i++) if (a === value[i]) return true;
      return false;
    }
    var b = String(value);
    if (op === "eq") return a === b;
    if (op === "neq") return a !== b;
    if (op === "contains") return a.indexOf(b) !== -1;
    if (op === "startsWith") return a.lastIndexOf(b, 0) === 0;
    if (op === "endsWith") return a.length >= b.length && a.indexOf(b, a.length - b.length) !== -1;
    if (op === "matchesRegex") {
      // Compiled here and nowhere else. A pathological pattern costs THIS
      // visitor's tab and never a Worker isolate, which is the whole reason a
      // regex operator is allowed at all.
      try {
        return new RegExp(b).test(a);
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  function numberMatches(op, actual, value) {
    if (actual == null || isNaN(actual)) return false;
    if (op === "eq") return actual === value;
    if (op === "neq") return actual !== value;
    if (op === "gt") return actual > value;
    if (op === "gte") return actual >= value;
    if (op === "lt") return actual < value;
    if (op === "lte") return actual <= value;
    return false;
  }

  function evaluate(node, ev) {
    if (!node) return true;
    if (node.all) {
      for (var i = 0; i < node.all.length; i++) if (!evaluate(node.all[i], ev)) return false;
      return true;
    }
    if (node.any) {
      for (var j = 0; j < node.any.length; j++) if (evaluate(node.any[j], ev)) return true;
      return false;
    }
    if (node.not) return !evaluate(node.not, ev);
    if (node.number) return numberMatches(node.op, numericBuiltin(node.number, ev), node.value);
    if (node.variable) return textMatches(node.op, resolveVariable(node.variable), node.value);
    return textMatches(node.op, builtin(node.field, ev), node.value);
  }

  // -- Firing --------------------------------------------------------------
  var TAGS = container.tags || [];
  var TRIGGERS = container.triggers || [];
  var firedThisPage = {};

  function alreadyFiredToday(id) {
    // Only reached when an operator chose once_per_visitor_day, and that choice
    // is what opts their site into a single localStorage key. The analytics tag
    // itself still stores nothing on the device.
    try {
      var key = "backlex.tm." + id;
      var day = new Date().toISOString().slice(0, 10);
      if (localStorage.getItem(key) === day) return true;
      localStorage.setItem(key, day);
      return false;
    } catch (e) {
      return false;
    }
  }

  function triggerById(id) {
    for (var i = 0; i < TRIGGERS.length; i++) if (TRIGGERS[i].id === id) return TRIGGERS[i];
    return null;
  }

  function fire(tag, ev) {
    // Consent is checked BEFORE the fire budget, not after it. Both budgets are
    // WRITES -- once_per_page marks the tag and once_per_visitor_day puts the
    // day into localStorage -- so checking second spent the tag's single chance
    // on a fire that never happened. A visitor who accepted a moment later got
    // nothing at all for the rest of the page, or the rest of the day.
    if (consentDenied(tag.consent)) return;
    if (tag.fire === "once_per_page") {
      if (firedThisPage[tag.id]) return;
      firedThisPage[tag.id] = 1;
    } else if (tag.fire === "once_per_visitor_day") {
      if (alreadyFiredToday(tag.id)) return;
    }

    try {
      if (tag.kind === "template") {
        var init = TEMPLATES[tag.template];
        if (init) init(tag.params || {}, ev);
        return;
      }
      if (tag.kind === "image_pixel") return loadPixel(tag.params.url);
      if (tag.kind === "backlex_event") {
        if (typeof window.backlex === "function") window.backlex(tag.params.name, null);
        return;
      }
      if (tag.kind === "custom_js") return runInline(tag.params.code);
      if (tag.kind === "custom_html") return injectHtml(tag.params.code);
    } catch (e) {
      // One misbehaving tag must never take the rest of the container down, and
      // must never surface as an error on somebody's marketing site.
    }
  }

  function firedBy(triggerId, ev) {
    for (var i = 0; i < TAGS.length; i++) {
      var tag = TAGS[i];
      // Read defensively even though today's compiler always emits both. A
      // published artifact outlives the code that wrote it -- that is why it
      // carries a version at all -- and this loop is OUTSIDE the per-tag
      // try/catch, so one missing field here would stop the whole container
      // rather than one tag.
      var fires = tag.triggers || [];
      var blocking = tag.blocking || [];
      if (fires.indexOf(triggerId) === -1) continue;
      var blocked = false;
      for (var b = 0; b < blocking.length; b++) {
        var bt = triggerById(blocking[b]);
        if (bt && evaluate(bt.condition, ev)) blocked = true;
      }
      if (blocked) continue;
      fire(tag, ev);
    }
  }

  function maybeFire(trigger, ev) {
    if (!evaluate(trigger.condition, ev)) return;
    firedBy(trigger.id, ev);
  }

  // -- Trigger arming ------------------------------------------------------
  function matches(el, selector) {
    if (!selector) return el;
    var node = el;
    while (node && node.nodeType === 1) {
      try {
        if (node.matches && node.matches(selector)) return node;
      } catch (e) {
        return null;
      }
      node = node.parentNode;
    }
    return null;
  }

  function clickInfo(el) {
    var anchor = el;
    while (anchor && anchor.nodeType === 1 && anchor.tagName !== "A") anchor = anchor.parentNode;
    return {
      clickId: el.id || null,
      clickClasses: el.className ? String(el.className) : null,
      clickText: (el.textContent || "").replace(/\s+/g, " ").replace(/^ | $/g, "").slice(0, 200) || null,
      clickUrl: anchor && anchor.href ? String(anchor.href) : null
    };
  }

  var clickTriggers = [];
  var submitTriggers = [];
  var scrollTriggers = [];
  var customTriggers = [];
  var scrollSeen = {};

  function onScroll() {
    var h = doc.documentElement;
    var full = Math.max(h.scrollHeight, doc.body ? doc.body.scrollHeight : 0);
    var seen = full <= 0 ? 100 : ((window.pageYOffset + window.innerHeight) / full) * 100;
    for (var i = 0; i < scrollTriggers.length; i++) {
      var t = scrollTriggers[i];
      for (var k = 0; k < t.config.thresholds.length; k++) {
        var pct = t.config.thresholds[k];
        var key = t.id + ":" + pct;
        if (!scrollSeen[key] && seen >= pct) {
          scrollSeen[key] = 1;
          maybeFire(t, { scrollPercent: pct });
        }
      }
    }
  }

  function arm(t) {
    var kind = t.type;
    if (kind === "pageview") return maybeFire(t, {});
    if (kind === "dom_ready") {
      if (doc.readyState !== "loading") return maybeFire(t, {});
      return doc.addEventListener("DOMContentLoaded", function () { maybeFire(t, {}); });
    }
    if (kind === "window_load") {
      if (doc.readyState === "complete") return maybeFire(t, {});
      return window.addEventListener("load", function () { maybeFire(t, {}); });
    }
    if (kind === "history_change") {
      // Listens rather than wrapping history a second time -- the tracker
      // already wrapped pushState/replaceState, and two wrappers on one page is
      // how one navigation becomes two.
      window.addEventListener("popstate", function () { maybeFire(t, {}); });
      window.addEventListener("hashchange", function () { maybeFire(t, {}); });
      return;
    }
    if (kind === "click" || kind === "link_click") return clickTriggers.push(t);
    if (kind === "form_submit") return submitTriggers.push(t);
    if (kind === "scroll") return scrollTriggers.push(t);
    if (kind === "custom_event") return customTriggers.push(t);
    if (kind === "element_visible") {
      if (typeof IntersectionObserver !== "function") return;
      var els = doc.querySelectorAll(t.config.selector);
      var io = new IntersectionObserver(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].intersectionRatio * 100 >= t.config.minPercent) {
            io.unobserve(entries[i].target);
            maybeFire(t, {});
          }
        }
      }, { threshold: Math.min(1, t.config.minPercent / 100) });
      for (var ei = 0; ei < els.length; ei++) io.observe(els[ei]);
      return;
    }
    if (kind === "timer") {
      var fires = 0;
      var handle = setInterval(function () {
        fires++;
        maybeFire(t, {});
        if (fires >= t.config.maxFires) clearInterval(handle);
      }, t.config.intervalMs);
      return;
    }
  }

  // ONE delegated listener per event type, capture phase, however many triggers
  // ask for clicks. A listener per trigger would multiply the work every click
  // does on a customer's page.
  doc.addEventListener("click", function (e) {
    if (!clickTriggers.length) return;
    var target = e.target;
    if (!target || target.nodeType !== 1) return;
    for (var i = 0; i < clickTriggers.length; i++) {
      var t = clickTriggers[i];
      var hit = matches(target, t.config.selector);
      if (!hit) continue;
      if (t.type === "link_click") {
        var a = hit;
        while (a && a.nodeType === 1 && a.tagName !== "A") a = a.parentNode;
        if (!a || a.nodeType !== 1) continue;
      }
      maybeFire(t, clickInfo(hit));
    }
  }, true);

  doc.addEventListener("submit", function (e) {
    if (!submitTriggers.length) return;
    var form = e.target;
    if (!form || form.nodeType !== 1) return;
    for (var i = 0; i < submitTriggers.length; i++) {
      var t = submitTriggers[i];
      if (!matches(form, t.config.selector)) continue;
      maybeFire(t, {
        formId: form.id || null,
        formAction: form.action ? String(form.action) : null
      });
    }
  }, true);

  // Custom events arrive through the handle the tracker already installs, so a
  // site that already calls backlex("signup") needs no second call to also fire
  // a tag. The prior handle is kept and still invoked -- wrapping it rather
  // than replacing it is what keeps the analytics event flowing.
  var priorHandle = window.backlex;
  window.backlex = function (name, props) {
    try {
      for (var i = 0; i < customTriggers.length; i++) {
        var t = customTriggers[i];
        if (t.config.eventName === name) maybeFire(t, { name: name, props: props });
      }
    } catch (e) {}
    if (typeof priorHandle === "function") return priorHandle.apply(this, arguments);
  };
  if (priorHandle) {
    for (var pk in priorHandle) {
      if (Object.prototype.hasOwnProperty.call(priorHandle, pk)) {
        window.backlex[pk] = priorHandle[pk];
      }
    }
  }

  for (var ti = 0; ti < TRIGGERS.length; ti++) arm(TRIGGERS[ti]);
  if (scrollTriggers.length) {
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }
};
`;

/**
 * The whole runtime, with the vendor branches spliced in.
 *
 * Assembled from three pieces rather than written as one literal because the
 * template branches need `loadScript` (defined above them) and `fire` needs
 * `TEMPLATES` (defined by them) — one function scope, so the ordering is the
 * only constraint, and splitting keeps the vendor table in its own file.
 */
export const TAG_RUNTIME_JS = HEAD + TAG_RUNTIME_TEMPLATES_JS + TAIL;

/**
 * Serialize the container for embedding in a JavaScript response.
 *
 * Three escapes, and each closes a different hole:
 *
 * - `</script` would end the enclosing element if this document is ever
 *   inlined into HTML. It is inert in an `application/javascript` response,
 *   which is what we serve today — but a debug surface that renders the
 *   container inline is a plausible next step, and this is cheap now and
 *   invisible later.
 * - `<` is escaped for the same reason, one layer earlier.
 * - **U+2028 and U+2029 are the ones that matter today.** They are valid
 *   inside a JSON string and are LINE TERMINATORS in JavaScript before ES2019,
 *   so an operator pasting one into a tag name would break the file for any
 *   older parser — a syntax error on somebody's marketing site, from a
 *   character they cannot see.
 */
export const safeJson = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
