/**
 * What the banner says when the operator has not said it themselves.
 *
 * The policy's `wording` is authoritative and is resolved per key, not per
 * locale block: an operator who translated the title and nothing else gets
 * their title and our everything-else, rather than falling off a cliff into
 * English. `consent.ts` refuses to fill these gaps server-side on purpose —
 * "It is a SUGGESTION, not a fallback: nothing reads this at serve time" —
 * so the fallback has to live here, in the thing that renders.
 *
 * ── Deliberately not lingui ───────────────────────────────────────────────
 * `apps/web/lingui.config.ts` scans `<rootDir>/src/client` with NO exclusions,
 * so a `t` macro in this directory would extract into the admin's own `.po`
 * catalogs — strings the admin never renders, shipped in the admin bundle, and
 * a permanent source of "missing translation" noise. This file is a plain
 * object for that reason, and because the banner is a standalone browser
 * bundle that must not drag `@lingui/core` onto a customer's page.
 *
 * The keys are `WORDING_KEYS` from `services/consent.ts`, and a test pins that
 * the two lists stay identical — a key the server accepts but the banner
 * cannot render is a string an operator writes and no visitor ever sees.
 */
export type Strings = Record<string, string>;

export const BUILTIN_STRINGS: Record<string, Strings> = {
  en: {
    title: "Cookies",
    body: "We use cookies to run this site and, with your permission, to measure how it is used.",
    acceptAll: "Accept all",
    rejectAll: "Reject all",
    manage: "Manage",
    save: "Save choices",
    policyLink: "Cookie policy",
    functionalLabel: "Functional",
    functionalBody: "Remembers preferences such as your language.",
    analyticsLabel: "Analytics",
    analyticsBody: "Helps us understand how this site is used.",
    marketingLabel: "Marketing",
    marketingBody: "Used to show you relevant advertising elsewhere.",
    necessaryLabel: "Strictly necessary",
    necessaryBody: "Required for the site to work, so it is always on.",
    close: "Close",
    withdraw: "Withdraw and delete my record",
    idLabel: "Your consent id",
  },
  tr: {
    title: "Çerezler",
    body: "Bu siteyi çalıştırmak ve izniniz varsa nasıl kullanıldığını ölçmek için çerez kullanıyoruz.",
    acceptAll: "Tümünü kabul et",
    rejectAll: "Tümünü reddet",
    manage: "Yönet",
    save: "Seçimleri kaydet",
    policyLink: "Çerez politikası",
    functionalLabel: "İşlevsel",
    functionalBody: "Diliniz gibi tercihlerinizi hatırlar.",
    analyticsLabel: "Analitik",
    analyticsBody: "Bu sitenin nasıl kullanıldığını anlamamıza yardımcı olur.",
    marketingLabel: "Pazarlama",
    marketingBody: "Başka yerlerde size ilgili reklamları göstermek için kullanılır.",
    necessaryLabel: "Zorunlu",
    necessaryBody: "Sitenin çalışması için gereklidir, bu yüzden her zaman açıktır.",
    close: "Kapat",
    withdraw: "Onayımı geri çek ve kaydımı sil",
    idLabel: "Onay kimliğiniz",
  },
};

/**
 * Which built-in block to start from.
 *
 * Matches the base tag before the region subtag, so `tr-TR` finds `tr` and
 * `pt-BR` finds neither and lands on English. Nothing here validates that the
 * policy's `defaultLocale` appears in its own `wording` — `consent.ts` does not
 * cross-check the two either — so this must answer for a locale that has no
 * block at all.
 */
export const builtinFor = (locale: string | undefined): Strings => {
  const tag = (locale || "en").toLowerCase();
  const base = tag.split("-")[0] || "en";
  return BUILTIN_STRINGS[tag] || BUILTIN_STRINGS[base] || BUILTIN_STRINGS.en || {};
};

/**
 * Which locale to render, given what the visitor asked their browser for.
 *
 * ── Only ever a block the OPERATOR authored ───────────────────────────────
 * This picks between `wording` blocks and nothing else. It will not select a
 * language that exists only as a built-in, because `services/consent.ts` says
 * the rule for that case plainly: silently substituting text an operator never
 * reviewed "is the same mistake as defaulting the posture". A visitor whose
 * browser asks for German on a site with English and Turkish blocks therefore
 * gets the operator's chosen default, not our German.
 *
 * ── This is language, NOT a posture, and the difference is the whole point ─
 * The banner deliberately infers nothing about WHERE a visitor is: geo is an IP
 * guess, `navigator.language` is a device setting, and neither may decide
 * whether a tag fires. `Accept-Language` deciding which of two texts the
 * operator already wrote gets shown is a different kind of claim — it changes
 * no grant, no category and no hash. See `suggestedPostures()` for why the
 * posture half cannot work at all.
 */
export const pickLocale = (
  wording: Record<string, Record<string, string>> | undefined,
  fallback: string,
  langs: readonly string[] | undefined,
): string => {
  const blocks = wording || {};
  // `hasOwnProperty`, not a bare lookup: `langs` comes from the VISITOR, and a
  // browser reporting `constructor` or `toString` would otherwise reach a
  // prototype member and have it read as a locale the operator authored. Both
  // happen to have no own enumerable keys today, so the length check below
  // catches them by accident — this makes it on purpose.
  const own = Object.prototype.hasOwnProperty;
  const authored = (tag: string): boolean => {
    if (!own.call(blocks, tag)) return false;
    const b = blocks[tag];
    return !!b && typeof b === "object" && Object.keys(b).length > 0;
  };
  const list = Array.isArray(langs) ? langs : [];
  for (let i = 0; i < list.length; i++) {
    const tag = String(list[i] || "").toLowerCase();
    if (!tag) continue;
    // Exact tag first (`pt-br` before `pt`), so an operator who wrote both is
    // not collapsed into the broader one.
    if (authored(tag)) return tag;
    const base = tag.split("-")[0] || "";
    if (base && authored(base)) return base;
  }
  return fallback;
};

/**
 * Operator wording over built-ins, one key at a time.
 *
 * `wording` may legitimately be `{}` — the policy saves without it — and a
 * locale block may be partial, so this merges rather than choosing a winner.
 */
export const resolveStrings = (
  wording: Record<string, Record<string, string>> | undefined,
  locale: string | undefined,
): Strings => {
  const out: Strings = { ...builtinFor(locale) };
  const blocks = wording || {};
  const tag = (locale || "en").toLowerCase();
  const base = tag.split("-")[0] || "en";
  // Least specific first, so an exact-tag block wins over its base language.
  for (const key of [base, tag]) {
    const block = blocks[key];
    if (!block) continue;
    for (const k of Object.keys(block)) {
      const v = block[k];
      if (typeof v === "string" && v) out[k] = v;
    }
  }
  return out;
};
