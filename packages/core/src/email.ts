/**
 * Render a Liquid-ish template with `{{ dotted.path }}` placeholders.
 * Resolves nested keys against `vars`; missing/null lookups become "".
 *
 * Used by both the email-templates "send test" endpoint and the flow
 * email operation so the wire format stays identical between the two.
 */
export const renderTemplate = (
  body: string,
  vars: Record<string, unknown>,
): string =>
  body.replace(/\{\{\s*([\w$.]+)\s*\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    let cur: unknown = vars;
    for (const p of parts) {
      if (cur && typeof cur === "object" && p in (cur as object)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return "";
      }
    }
    if (cur === null || cur === undefined) return "";
    if (typeof cur === "object") return JSON.stringify(cur);
    return String(cur);
  });

export const htmlToText = (html: string): string =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
