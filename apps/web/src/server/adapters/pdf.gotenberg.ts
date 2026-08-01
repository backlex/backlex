import type { PdfAdapter } from "@backlex/core";
import { looksLikePdf } from "./pdf.cf-browser";
import {
  assertMargins,
  marginsOf,
  printBackgroundOf,
  sizeInches,
  toInches,
} from "./pdf.shared";

/**
 * Gotenberg — the self-hostable half.
 *
 * Chromium behind an HTTP API, Apache-2.0, one container. It is the answer for
 * a deployment that will not send its contracts to a third party, which for a
 * document feature is most of them.
 *
 * Two things about its wire format are easy to get wrong and both fail
 * confusingly:
 *
 * - The HTML must arrive as a FILE PART NAMED `index.html`. Any other name is
 *   accepted by the multipart parser and then rejected by Chromium with "no
 *   index.html found", which reads like a bug in Gotenberg.
 * - Every dimension is an INCH, as a bare number. `20mm` in `marginTop` is not
 *   a unit error — it is parsed as the number 20, and the render comes back
 *   with twenty-inch margins on an A4 page, i.e. blank.
 */

const PATH = "/forms/chromium/convert/html";

export const gotenbergPdf = (baseUrl: string, credentials?: { user: string; pass: string }): PdfAdapter => ({
  name: "gotenberg",
  async render(html, opts) {
    const margin = marginsOf(opts?.margin);
    assertMargins(margin);
    const size = sizeInches(opts);

    const form = new FormData();
    // The name is load-bearing, not a label — see the note above.
    form.append("files", new Blob([html], { type: "text/html" }), "index.html");
    form.append("paperWidth", String(round(size.w)));
    form.append("paperHeight", String(round(size.h)));
    form.append("marginTop", String(round(toInches(margin.top))));
    form.append("marginRight", String(round(toInches(margin.right))));
    form.append("marginBottom", String(round(toInches(margin.bottom))));
    form.append("marginLeft", String(round(toInches(margin.left))));
    form.append("printBackground", String(printBackgroundOf(opts)));
    // `landscape` is already folded into the page dimensions, so it must NOT
    // also be sent — Gotenberg would rotate the rotated page back.
    if (opts?.headerHtml) {
      form.append("files", new Blob([opts.headerHtml], { type: "text/html" }), "header.html");
    }
    if (opts?.footerHtml) {
      form.append("files", new Blob([opts.footerHtml], { type: "text/html" }), "footer.html");
    }

    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}${PATH}`, {
      method: "POST",
      headers: credentials
        ? { authorization: `Basic ${btoa(`${credentials.user}:${credentials.pass}`)}` }
        : {},
      body: form,
    });

    if (!res.ok) {
      // Gotenberg answers text/plain on failure. Truncated, and never echoing
      // the document — it is a tenant's customer data.
      const detail = await res.text().catch(() => "");
      throw new Error(`Gotenberg responded ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!looksLikePdf(bytes)) throw new Error("Gotenberg returned a non-PDF response");
    return bytes;
  },
});

/** Gotenberg rejects an over-precise float on some fields; 2dp is plenty for a
 *  page dimension in inches. */
const round = (n: number): number => Math.round(n * 100) / 100;
