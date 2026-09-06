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

/**
 * Types that are not documents but ARE executable as a SUBRESOURCE.
 *
 * `sandbox` and `content-disposition` both govern a response as a DOCUMENT.
 * Neither restricts it as a subresource, and `nosniff` is satisfied when the
 * declared type genuinely is JavaScript. So an object stored as
 * `text/javascript` was served same-origin, executable, under the admin app's
 * own `script-src 'self'` — `<script src="/api/storage/x.js">` injected
 * anywhere on the admin origin loads and runs with the viewing admin's cookies.
 *
 * That is a gadget rather than a vulnerability on its own, but the whole
 * storage-serving design is written on the premise that uploaded bytes can
 * never execute on the app origin, and this is the one type CSP explicitly
 * re-admits. Rewritten to `application/octet-stream` on serve: a `<script src>`
 * whose response is not a JavaScript MIME is refused by the browser, and no
 * legitimate consumer of `/api/storage` needs the original label — the download
 * still carries the filename, and `?download` still works.
 *
 * The upload is NOT rejected: what a workspace stores is its business, and
 * refusing at the door would break every legitimate `.js` asset an operator
 * keeps in storage. What changes is only how it is handed back on this origin.
 * Serving user bytes from a separate origin is the durable fix, and would make
 * this list unnecessary.
 */
const EXECUTABLE_SUBRESOURCE_TYPES = new Set([
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/ecmascript",
  "application/ecmascript",
  "text/jscript",
  "application/wasm",
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

/**
 * The `content-type` to actually SEND for a stored object.
 *
 * Everything except the executable-subresource family is echoed back as stored.
 * See {@link EXECUTABLE_SUBRESOURCE_TYPES} for why that family is not.
 */
export const safeServeContentType = (
  contentType: string | null | undefined,
): string => {
  const base = baseContentType(contentType);
  if (!base) return "application/octet-stream";
  return EXECUTABLE_SUBRESOURCE_TYPES.has(base) ? "application/octet-stream" : (contentType ?? base);
};
