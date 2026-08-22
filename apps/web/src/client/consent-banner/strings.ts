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
