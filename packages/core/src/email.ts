/** The placeholder grammar — exported so a scan for the variables a template
 *  uses cannot disagree with the renderer about what a placeholder is. It is
 *  global and so stateful: copy it from `.source`, never `.exec`/`.test` it. */
export const TEMPLATE_PLACEHOLDER = /\{\{\s*([\w$.]+)\s*\}\}/g;

/** Walk a dotted path through `vars` exactly as {@link renderTemplate} does;
 *  `found: false` is what it prints as an empty string. */
export const templatePathValue = (
  vars: Record<string, unknown>,
  path: string,
): { found: boolean; value: unknown } => {
  let cur: unknown = vars;
  for (const p of path.split(".")) {
    if (cur && typeof cur === "object" && p in (cur as object)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
};

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
  body.replace(TEMPLATE_PLACEHOLDER, (_match, path: string) => {
    const { found, value } = templatePathValue(vars, path);
    if (!found || value === null || value === undefined) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });

/** An email template key: what a sender resolves by exact match. The `.` is
 *  load-bearing — the booking emails are `booking.confirmed` and friends. */
export const EMAIL_TEMPLATE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,39}$/;

export const htmlToText = (html: string): string =>
  html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
