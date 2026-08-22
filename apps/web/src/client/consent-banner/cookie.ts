/**
 * The visitor's decision, on their own device.
 *
 * ── Why this is written from JavaScript and not `Set-Cookie` ──────────────
 * The banner runs on the CUSTOMER's origin. backlex is cross-origin to it, so
 * a `Set-Cookie` from any backlex response is a third-party cookie: blocked
 * outright in Safari and Firefox, partitioned in Chrome. The server already
 * assumes this — `routes/consent-public.ts` reads the subject id out of the
 * request BODY rather than a cookie, and sets no cookie at all.
 *
 * Two things follow that read like design choices and are not:
 *   - **`HttpOnly` is impossible here.** `document.cookie` cannot set it. The
 *     banner also has to read this value on the next page load, so even if it
 *     were possible it would be wrong.
 *   - **`SameSite=Lax` is inert.** It governs whether a cookie is ATTACHED to
 *     a request, and this cookie is never sent anywhere — the decision travels
 *     in the beacon body instead. It is set because a cookie with no SameSite
 *     draws a console warning in Chrome, not because it is buying anything.
 *
 * `Secure` IS conditional, and that one matters: an unconditional `Secure`
 * makes the browser drop the whole cookie on any http page, so local dev and
 * any customer still on plain http would silently store nothing and re-ask
 * every visitor on every page. The repo has written this down twice already
 * (`routes/forms-public.ts`, `middleware/tenant.ts`); this follows the SDK's
 * token store, which gets it right in code.
 */
export interface Decision {
  /** Durable opaque subject id. Random, derived from nothing personal. */
  id: string;
  /** category -> granted. Only the categories the policy offered. */
  g: Record<string, boolean>;
  /** The artifact hash the visitor was actually shown. */
  v: string;
  /** When they decided, epoch ms. */
  t: number;
}

/**
 * Not `__blx_consent`.
 *
 * A leading double underscore reads as one of the browser-reserved prefixes
 * (`__Secure-`, `__Host-`) while getting none of their guarantees, and this
 * cookie cannot satisfy `__Host-` anyway — that requires `Secure`, which is
 * conditional here. The repo's existing first-party names are `blx_fa_*` and
 * `blx_fp_*`; this joins them.
 */
export const COOKIE_NAME = "blx_consent";

/** Read one cookie by name. Kept tiny and regex-free — this runs on somebody
 *  else's page, where `document.cookie` may be long and may be malformed. */
export const readRaw = (name: string): string | null => {
  try {
    const parts = String(document.cookie || "").split(";");
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] || "";
      const eq = p.indexOf("=");
      if (eq === -1) continue;
      if (p.slice(0, eq).trim() !== name) continue;
      return decodeURIComponent(p.slice(eq + 1).trim());
    }
  } catch {
    // A page can define a hostile `document.cookie` getter. Not measuring is
    // an acceptable outcome; throwing on their page is not.
  }
  return null;
};

export const readDecision = (): Decision | null => {
  const raw = readRaw(COOKIE_NAME);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<Decision>;
    if (!d || typeof d !== "object") return null;
    if (typeof d.id !== "string" || !d.id) return null;
    if (!d.g || typeof d.g !== "object") return null;
    return { id: d.id, g: d.g as Record<string, boolean>, v: String(d.v || ""), t: Number(d.t) || 0 };
  } catch {
    // A cookie we cannot parse is a cookie we did not write, or one a later
    // version wrote differently. Ask again rather than guessing a decision.
    return null;
  }
};

export const writeDecision = (d: Decision, maxAgeDays: number): void => {
  try {
    const secure = location.protocol === "https:" ? "; Secure" : "";
    const days = maxAgeDays > 0 ? maxAgeDays : 180;
    document.cookie =
      COOKIE_NAME +
      "=" +
      encodeURIComponent(JSON.stringify(d)) +
      "; Path=/; Max-Age=" +
      Math.floor(days * 86400) +
      "; SameSite=Lax" +
      secure;
  } catch {
    // Storage disabled. The decision still reaches the server for this page
    // view; it simply will not survive the visitor navigating away.
  }
};

export const clearDecision = (): void => {
  try {
    document.cookie = COOKIE_NAME + "=; Path=/; Max-Age=0; SameSite=Lax";
  } catch {
    /* nothing to undo */
  }
};

/**
 * A durable, opaque subject id.
 *
 * Must satisfy the server's `SUBJECT_ID_RE` — `^[A-Za-z0-9_-]{16,64}$` — or the
 * record is silently dropped as accepted. `crypto.randomUUID()` contains
 * hyphens only, which is inside that class, but `getRandomValues` is available
 * further back and produces a shorter token, so it is preferred and the UUID
 * is the fallback.
 *
 * Random, and derived from nothing about the visitor. It exists so a decision
 * can outlive the analytics visitor id, which rotates at UTC midnight by
 * design and therefore cannot key consent.
 */
export const mintSubjectId = (): string => {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  try {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
      out += ALPHABET.charAt((bytes[i] as number) % ALPHABET.length);
    }
    return out;
  } catch {
    try {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 32);
    } catch {
      // Last resort. Weaker, but a colliding id costs one mis-attributed
      // consent record, not a security boundary — it authenticates nothing.
      let out = "";
      while (out.length < 24) out += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
      return out;
    }
  }
};
