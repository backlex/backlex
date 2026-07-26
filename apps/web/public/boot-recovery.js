// Self-heal a white screen caused by a stale index.html.
//
// Every build rotates the `/assets/<name>-<hash>.js` filenames. A browser that
// still holds an older index.html (Safari in particular will keep serving a
// cached document to a restored tab) asks for a chunk that no longer exists.
// CF Static Assets is configured with `not_found_handling =
// "single-page-application"`, so that miss answers **200 + text/html** — the
// SPA shell — instead of 404. The browser then refuses to execute HTML as a
// module script (`nosniff`), nothing mounts, and the page is blank. Reloading
// does not necessarily help: the stale document can come straight back out of
// cache.
//
// So: watch for a failed `/assets/*` script or stylesheet and force ONE
// cache-busting reload, which revalidates index.html and picks up the current
// hashes. Guarded by sessionStorage + a timestamp so a genuinely broken deploy
// can never turn this into a reload loop.
//
// Kept as an EXTERNAL file on a stable (unhashed) path for two reasons: the
// strict `script-src 'self'` CSP blocks inline scripts, and an unhashed path
// stays valid across deploys.
(function () {
  var KEY = "backlex-boot-recovery";
  var COOLDOWN_MS = 30000;
  var here;

  // Drop the cache-bust marker IMMEDIATELY — its only job was to make the
  // document request miss the HTTP cache. Left in place it gets swept into
  // whatever the router does next (an auth redirect captures it as
  // `?next=%2F%3F_r%3D…`) and ends up in history and bookmarks.
  try {
    here = new URL(location.href);
    if (here.searchParams.has("_r")) {
      here.searchParams.delete("_r");
      history.replaceState(history.state, "", here.pathname + here.search + here.hash);
    }
  } catch (_e) {}

  function isAssetUrl(url) {
    if (!url) return false;
    try {
      return new URL(url, location.href).pathname.indexOf("/assets/") === 0;
    } catch (_e) {
      return false;
    }
  }

  function recover(url) {
    var now = Date.now();
    var last = 0;
    try {
      last = parseInt(sessionStorage.getItem(KEY) || "0", 10) || 0;
    } catch (_e) {
      // Private mode / storage disabled — one reload is still better than a
      // permanent white screen, so fall through with last = 0.
    }
    // Already tried recently: the assets really are missing (bad deploy), not
    // a stale document. Reloading again would just spin.
    if (now - last < COOLDOWN_MS) return;
    try {
      sessionStorage.setItem(KEY, String(now));
    } catch (_e) {}
    console.warn("[backlex] stale asset " + url + " — reloading to pick up the current build");
    // Cache-bust the DOCUMENT (not the asset): the stale index.html is what
    // has to be re-fetched. Strip any previous marker so the URL can't grow.
    var u = new URL(location.href);
    u.searchParams.set("_r", String(now));
    location.replace(u.toString());
  }

  window.addEventListener(
    "error",
    function (e) {
      var el = e.target;
      if (!el || el === window) return;
      var tag = el.tagName;
      if (tag !== "SCRIPT" && tag !== "LINK") return;
      var url = tag === "SCRIPT" ? el.src : el.href;
      if (isAssetUrl(url)) recover(url);
    },
    // Capture phase — resource load errors do not bubble.
    true,
  );

  // The app mounted, so this document is healthy — clear the marker so a
  // stale document days from now still gets its one recovery reload.
  window.addEventListener("load", function () {
    setTimeout(function () {
      var root = document.getElementById("root");
      if (!root || !root.children.length) return;
      try {
        sessionStorage.removeItem(KEY);
      } catch (_e) {}
    }, 1500);
  });
})();
