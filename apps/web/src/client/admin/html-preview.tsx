// Preview of HTML the admin does not control, rendered where it cannot reach
// the admin session.
//
// The rule this file exists to hold: **no stored value is ever handed to
// `dangerouslySetInnerHTML`.** There is no HTML sanitizer in this repo, and
// adding one would mean getting an allow-list of elements, attributes and URL
// schemes right — and staying right — against a decade of mutation-XSS
// bypasses. `sandbox=""` is a browser-enforced boundary instead of a parser I
// have to be perfect at: no scripts, no forms, no plugins, no top-level
// navigation, and an opaque origin, so the document cannot read cookies, the
// admin DOM, or `localStorage` no matter what it contains.
//
// `pages/settings/documents.tsx` already reached this conclusion on its own for
// document templates; this is that shape, factored out so the three previews
// that show somebody else's markup share one answer rather than three.
//
// Why it matters here and not only for admin-authored templates: a `longtext`
// field with `interface: "richtext"` is the default in nine bundled schema
// templates, and a public form over such a collection is writable by an
// ANONYMOUS submitter. The operator who later opens the row and clicks Preview
// is doing a normal review action, with a full admin session.
import { cn } from "@backlex/ui/lib/utils";

/**
 * Minimal document wrapper for a FRAGMENT of HTML.
 *
 * Rendered on white with dark text rather than the admin's theme tokens, which
 * the iframe cannot inherit anyway — and which would be the wrong answer even
 * if it could: richtext, markdown and email bodies are authored for a light
 * document (a web page, a PDF, a mail client), so that is what the author needs
 * to see. The two previews that predate this component both already chose
 * white for the same reason.
 */
const wrapFragment = (html: string): string =>
  `<!doctype html><html><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<style>` +
  `:root{color-scheme:light}` +
  `html,body{margin:0;background:#fff;color:#1a1a1a}` +
  `body{padding:12px 14px;font:13px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;` +
  `overflow-wrap:anywhere}` +
  `img,video,table{max-width:100%}` +
  `h1,h2,h3,h4,h5,h6{margin:0.6em 0 0.3em;line-height:1.25}` +
  `p{margin:0 0 0.7em}` +
  `pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}` +
  `pre{overflow-x:auto}` +
  `a{color:#0b5bd3}` +
  `</style></head><body>${html}</body></html>`;

export interface HtmlPreviewProps {
  /** The markup to show. Treated as hostile regardless of who wrote it. */
  html: string;
  /**
   * The value is already a complete HTML document (a document template, an
   * email body) rather than a fragment. Complete documents are passed through
   * untouched — injecting one into a `div` would have discarded its own
   * `<html>`/`<head>`, so the preview would not have been showing what the
   * renderer sees.
   */
  complete?: boolean;
  /** Accessible name for the frame. Required: an iframe without one is
   *  announced as "frame" and nothing else. */
  title: string;
  className?: string;
}

/**
 * Note on sizing: `sandbox=""` means no scripts, so the document cannot report
 * its own height and the frame cannot auto-fit. Callers give it a height and
 * the content scrolls inside — the alternative is granting `allow-scripts` for
 * a resize message, which would hand the untrusted document exactly the
 * capability this component exists to withhold.
 */
export function HtmlPreview({ html, complete = false, title, className }: HtmlPreviewProps) {
  return (
    <iframe
      title={title}
      // No `allow-scripts`, no `allow-same-origin`, no `allow-forms`. An empty
      // value is the most restrictive there is, and every capability added back
      // has to be argued for against a document an anonymous submitter may have
      // written. `allow-scripts` together with `allow-same-origin` would be
      // equivalent to no sandbox at all.
      sandbox=""
      srcDoc={complete ? html : wrapFragment(html)}
      className={cn("block w-full border-0 bg-white", className)}
    />
  );
}
