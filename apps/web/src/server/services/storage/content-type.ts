/**
 * Content-type handling for objects served back out of `/api/storage`.
 *
 * The Worker serves the admin SPA and the API on ONE origin, so anything
 * `/api/storage/*` streams inline is same-origin with the admin session cookie.
 * The upload path stores the client's `content-type` header verbatim (there is
 * no MIME allow-list, and the key guard only rejects traversal), which means a
 * principal holding `files:create` — or an anonymous submitter of a public form
 * whose file block has no `accept` list — can plant a `text/html` object. Opened
 * top-level by an admin, it used to execute with their session; the global CSP
 * blocks inline script but explicitly permits same-origin `<script src>`, and
 * uploaded objects are same-origin.
 */

/** Types a browser will run as a document (scripts, event handlers, embedded
 *  `<script>` inside SVG/XML). Served inline these are an XSS sink. */
const EXECUTABLE_DOCUMENT_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "application/xml",
  "text/xml",
]);

/** Strip parameters (`; charset=…`, `; boundary=…`) and normalize case so the
 *  checks below can't be side-stepped with `text/html ;x=1` or `TEXT/HTML`. */
export const baseContentType = (ct: string | null | undefined): string =>
  (ct ?? "").split(";")[0]!.trim().toLowerCase();

/**
 * Response headers that make a stored object safe to hand back on the app
 * origin, whatever its declared type:
 *
 * - `sandbox` (with no `allow-scripts`) drops the response into an opaque
 *   origin with scripting disabled, so a top-level navigation to an uploaded
 *   HTML/SVG document cannot run script or touch the session cookie. It has no
 *   effect on subresource use, so `<img src>` / `<video src>` keep working.
 * - `nosniff` stops a mislabelled object from being sniffed into something
 *   executable.
 * - `attachment` on document-ish types means a click downloads instead of
 *   rendering. Browsers ignore it for subresource loads, so inline `<img>`
 *   embedding of an SVG is unaffected.
 */
export const safeServeHeaders = (
  contentType: string | null | undefined,
): Record<string, string> => {
  const headers: Record<string, string> = {
    "content-security-policy": "default-src 'none'; sandbox",
    "x-content-type-options": "nosniff",
  };
  if (EXECUTABLE_DOCUMENT_TYPES.has(baseContentType(contentType))) {
    headers["content-disposition"] = "attachment";
  }
  return headers;
};
