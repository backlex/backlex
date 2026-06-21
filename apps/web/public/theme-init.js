// Anti-FOUC theme bootstrap. Kept as an EXTERNAL file (not inline) so the
// admin SPA can ship a strict `script-src 'self'` CSP without an inline-script
// exception. Runs synchronously before the React bundle so the correct theme
// class is on <html> before first paint.
(function () {
  try {
    const stored = localStorage.getItem("backlex-theme");
    const theme =
      stored === "dark" || stored === "light" || stored === "system"
        ? stored
        : "system";
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)",
    ).matches;
    const resolved = theme === "system" ? (prefersDark ? "dark" : "light") : theme;
    document.documentElement.classList.add(resolved);
  } catch (_) {
    /* localStorage blocked (private mode) — fall back to CSS default */
  }
})();
