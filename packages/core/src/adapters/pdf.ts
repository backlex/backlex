/**
 * HTML → PDF rendering.
 *
 * Fourteen of the twenty-six schema templates carry documents: contracts,
 * agreements, quotes, invoices, offers. Producing one is the piece backlex has
 * never had, and it is behind an adapter for the usual reason — none of the
 * four runtimes can do it in-process.
 *
 * **Why there is no bundled pure-JS renderer.** The obvious move is a library
 * that draws a PDF directly, and it was rejected on one concrete ground: the
 * PDF standard-14 fonts are WinAnsi, which has no `ş`, `ğ`, `ı` or `İ`. This
 * codebase's users write Turkish. A fallback that silently drops or mangles a
 * customer's name in a contract is worse than a renderer that is honestly
 * absent, so an unconfigured deployment gets a clear refusal instead. Embedding
 * a Unicode font would fix the glyphs and still leave the layout engine —
 * tables, page breaks, headers — to hand-roll, which is a browser's job.
 *
 * So both implementations drive a real browser somewhere else, and the contract
 * below is the smallest thing that describes them both.
 */

/** Page setup. Defaults are A4 portrait with a 20mm margin all round. */
export interface PdfPageOptions {
  /** `A4` (default), `Letter`, `Legal`, `A3`, `A5`. */
  format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
  landscape?: boolean;
  /** CSS lengths (`20mm`, `1in`). A single value applies to all four sides. */
  margin?: string | { top?: string; right?: string; bottom?: string; left?: string };
  /**
   * Print the page's own background colours and images.
   *
   * Off in every browser's print path by default, which is why an invoice with
   * a coloured header renders as a white rectangle. Defaulted ON here: someone
   * who wrote a background into a document template meant it.
   */
  printBackground?: boolean;
  /** HTML for a running header/footer. Supports the usual `pageNumber` /
   *  `totalPages` spans that Chromium substitutes. */
  headerHtml?: string;
  footerHtml?: string;
}

export interface PdfAdapter {
  /** Stable name for diagnostics (`cf-browser`, `gotenberg`). */
  readonly name: string;
  /**
   * Render a complete HTML document to PDF bytes.
   *
   * `html` is a whole document, not a fragment — the renderer does not wrap it,
   * because a template that sets its own `<style>`, page size or fonts must be
   * able to. Throwing is a failed render; the caller decides whether that fails
   * a flow run or is reported to an operator.
   */
  render(html: string, opts?: PdfPageOptions): Promise<Uint8Array>;
}
