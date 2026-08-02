import type { PdfAdapter, PdfPageOptions } from "@backlex/core";
import {
  assertMargins,
  formatOf,
  marginsOf,
  printBackgroundOf,
} from "./pdf.shared";

/**
 * Cloudflare Browser Rendering, over its REST API.
 *
 * The REST endpoint rather than the `BROWSER` Worker binding, deliberately. The
 * binding needs `@cloudflare/puppeteer` in the bundle and only exists on
 * Workers; this is one authenticated `fetch` and therefore works from all four
 * runtimes — a Vercel or Netlify deployment can render through a Cloudflare
 * account it already has. That symmetry is worth more here than shaving a hop.
 *
 * Returns `application/pdf` bytes directly on success.
 */

const ENDPOINT = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/browser-rendering/pdf`;

/** Cloudflare's `format` enum is LOWERCASE (`a4`, `letter`). Sending the
 *  capitalised names this codebase uses elsewhere is a 400 that reads like a
 *  malformed request rather than a wrong case. */
const cfFormat = (opts: PdfPageOptions | undefined): string => formatOf(opts).toLowerCase();

export const cfBrowserPdf = (accountId: string, apiToken: string): PdfAdapter => ({
  name: "cf-browser",
  async render(html, opts) {
    const margin = marginsOf(opts?.margin);
    assertMargins(margin);
    const wantsRunningHeader = Boolean(opts?.headerHtml || opts?.footerHtml);

    const res = await fetch(ENDPOINT(accountId), {
      method: "POST",
      headers: { authorization: `Bearer ${apiToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        html,
        // A template interpolates ROW DATA into HTML, and on most of the
        // schema templates a row is filled in by an end user (a form
        // submission, a customer portal). Scripts are not needed to lay out an
        // invoice, and leaving them enabled would let a value in a row run code
        // inside the renderer. Off by default; this is the moment to set it,
        // before any template depends on it.
        setJavaScriptEnabled: false,
        pdfOptions: {
          format: cfFormat(opts),
          landscape: Boolean(opts?.landscape),
          margin,
          printBackground: printBackgroundOf(opts),
          // Chromium ignores the templates entirely unless this is on, so a
          // template that supplied a footer would silently render without one.
          ...(wantsRunningHeader
            ? {
                displayHeaderFooter: true,
                headerTemplate: opts?.headerHtml ?? "<span></span>",
                footerTemplate: opts?.footerHtml ?? "<span></span>",
              }
            : {}),
        },
      }),
    });

    if (!res.ok) {
      // The error body is JSON even though success is a PDF. Only the message
      // is surfaced: the request echo would carry the document's contents,
      // which are a tenant's customer data and end up on an activity row.
      let detail = "";
      try {
        const body = (await res.json()) as { errors?: { message?: string }[] };
        detail = body.errors?.[0]?.message ?? "";
      } catch {
        // keep the status-only message
      }
      throw new Error(
        `Cloudflare Browser Rendering responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
      );
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    // A 200 carrying something other than a PDF means the account is not
    // entitled and the gateway answered with a page. Better to say so than to
    // store an HTML file under a `.pdf` name.
    if (!looksLikePdf(bytes)) {
      throw new Error("Cloudflare Browser Rendering returned a non-PDF response");
    }
    return bytes;
  },
});

/** `%PDF-` — every PDF starts with it. */
export const looksLikePdf = (bytes: Uint8Array): boolean =>
  bytes.length > 4 &&
  bytes[0] === 0x25 &&
  bytes[1] === 0x50 &&
  bytes[2] === 0x44 &&
  bytes[3] === 0x46 &&
  bytes[4] === 0x2d;
