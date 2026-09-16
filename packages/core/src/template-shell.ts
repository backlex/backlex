/**
 * The themed document a template body is rendered inside.
 *
 * Why this exists. `withThemeVars` made an appearance reachable as
 * `{{ theme.* }}` placeholders, and nothing else — so a body that never wrote
 * one rendered byte-identical whatever the Appearance tab said. That was every
 * body: none of the thirteen built-in templates in `email-templates.ts`
 * mentions `theme.`, so out of the box, picking dark or a new accent changed
 * nothing an admin could see. Meanwhile the panel shows two theme cards, an
 * accent row and a font row, which reads as a promise that it styles the mail.
 *
 * So the renderer now keeps that promise: a FRAGMENT body is wrapped in a
 * document built from the same {@link ThemeVars} the placeholders resolve
 * against. Placeholders still work and still win — this only supplies the
 * chrome a fragment never had.
 *
 * Two escapes, both deliberate:
 *   - a body that is already a complete document is returned untouched. An
 *     author who wrote `<html>` owns the whole page, and wrapping it would
 *     produce a document inside a document.
 *   - `appearance.shell === false` turns it off for one template, for the
 *     author who wants a bare fragment on the wire.
 *
 * On safety: every value interpolated below comes from `themeVars()`, which
 * normalizes first — `safeAccent` forces `#rrggbb`, the palette entries are
 * module constants, and `fontStack` returns one of four literals. Nothing from
 * a template body or a caller's vars reaches a CSS declaration here.
 */
import { themeVars, type Appearance, type ThemeVars } from "./appearance";

/**
 * The body brings its own `<html>` / `<!doctype>`.
 *
 * The admin's preview has asked this question since before the shell existed
 * (`email-template-model.ts`); it lives here now because the renderer has to
 * ask it too, and the two answers must be the same one.
 */
export const isCompleteDocument = (html: string): boolean =>
  /^\s*<(?:!doctype|html)\b/i.test(html);

/** Wrap this body, or leave it alone? */
export const shouldWrap = (
  html: string,
  appearance: Appearance | null | undefined,
): boolean => appearance?.shell !== false && !isCompleteDocument(html);

/**
 * Wrap a rendered email body in the themed shell.
 *
 * Table-based with inline styles, because that is what mail clients agree on:
 * Outlook's Word engine drops `flex`, `grid` and most positioning, and several
 * clients strip a `<head>` stylesheet. What cannot be inlined is descendant
 * styling — a link inside the author's markup — so `a` keeps a `<style>` rule
 * AND the container carries the colour it inherits from, which is the pair
 * that degrades correctly in the clients that strip one of them.
 *
 * No webfont `<link>`: `fontsHref` is a stylesheet most mail clients ignore,
 * and `theme.font` is a stack precisely so the fallback is the real answer
 * there. The PDF shell loads it, where it works.
 */
export const wrapEmailBody = (html: string, theme: ThemeVars): string =>
  `<!doctype html><html><head>` +
  `<meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="color-scheme" content="${theme.mode}">` +
  `<style>` +
  `a{color:${theme.accent}}` +
  `h1,h2,h3,h4,h5,h6{margin:0.6em 0 0.35em;line-height:1.25;color:${theme.text}}` +
  `p{margin:0 0 0.8em}` +
  `img{max-width:100%;height:auto;border:0}` +
  `hr{border:0;border-top:1px solid ${theme.border};margin:1.2em 0}` +
  `blockquote{margin:0 0 0.8em;padding-left:12px;border-left:2px solid ${theme.border};color:${theme.muted}}` +
  `code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}` +
  `</style></head>` +
  `<body style="margin:0;padding:0;background:${theme.bg};">` +
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
  `style="background:${theme.bg};width:100%;">` +
  `<tr><td align="center" style="padding:24px 12px;">` +
  `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" ` +
  `style="width:600px;max-width:100%;background:${theme.card};` +
  `border:1px solid ${theme.border};border-radius:12px;">` +
  `<tr><td style="padding:28px 32px;font-family:${theme.font};font-size:15px;` +
  `line-height:1.6;color:${theme.text};word-break:break-word;">` +
  html +
  `</td></tr></table>` +
  `</td></tr></table>` +
  `</body></html>`;

/**
 * Wrap a rendered document body in the themed shell.
 *
 * A PDF is rendered by a real browser engine, so this one is plain CSS and can
 * load the webfont the admin picked. `@page { margin: 0 }` is deliberately NOT
 * set: the renderer owns the sheet margins, and a shell that took them over
 * would silently overrule the Page tab.
 */
export const wrapDocumentBody = (html: string, theme: ThemeVars): string =>
  `<!doctype html><html><head>` +
  `<meta charset="utf-8">` +
  `<link rel="stylesheet" href="${theme.fontsHref}">` +
  `<style>` +
  `:root{color-scheme:${theme.mode}}` +
  `html,body{margin:0;background:${theme.bg};color:${theme.text};` +
  `font-family:${theme.font};font-size:11.5pt;line-height:1.55}` +
  `a{color:${theme.accent}}` +
  `h1,h2,h3,h4,h5,h6{line-height:1.25;color:${theme.text}}` +
  `hr{border:0;border-top:1px solid ${theme.border}}` +
  `table{border-collapse:collapse}` +
  `th,td{border-color:${theme.border}}` +
  `code,pre{font-family:'JetBrains Mono',ui-monospace,monospace}` +
  `</style></head>` +
  `<body>${html}</body></html>`;

/**
 * Apply the shell an already-rendered body should have.
 *
 * Takes the appearance rather than the resolved theme so the two escapes and
 * the `themeVars` default (light, `#8B6CFF`, Manrope) are decided in one place
 * — every call site would otherwise have to remember both.
 */
export const applyShell = (
  html: string,
  appearance: Appearance | null | undefined,
  kind: "email" | "document",
): string => {
  if (!shouldWrap(html, appearance)) return html;
  const theme = themeVars(appearance);
  return kind === "email" ? wrapEmailBody(html, theme) : wrapDocumentBody(html, theme);
};
