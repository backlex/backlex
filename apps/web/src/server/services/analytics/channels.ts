/**
 * Channel classification — turning a referrer and a set of UTM tags into one
 * of GA4's Default Channel Groups.
 *
 * Pure functions, no database. That is deliberate on two counts: the rules are
 * the part most likely to need adjusting (a new social network appears roughly
 * every year), and they are the part most worth testing without a harness.
 *
 * **Classification is derived at query time, never stored.** Writing a
 * `channel` column would freeze today's rules into yesterday's rows: add
 * Threads to the social list and every historical Threads visit would still
 * read as Referral, forever. Deriving it means the whole history reclassifies
 * the moment the table below changes — which is the behaviour anyone comparing
 * this quarter to last quarter actually wants.
 */

/** GA4's Default Channel Group names, as reported. */
export type Channel =
  | "Direct"
  | "Organic Search"
  | "Paid Search"
  | "Organic Social"
  | "Paid Social"
  | "Email"
  | "Affiliate"
  | "Display"
  | "Referral";

/**
 * Referrer hosts we recognise, matched on the registrable-ish suffix so
 * `www.google.co.uk` and `news.google.com` both land.
 *
 * Kept short and boring. A long list is a maintenance surface that silently
 * rots, and anything unmatched falls through to `Referral`, which is a correct
 * answer rather than a wrong one.
 */
const SEARCH_HOSTS = [
  "google.",
  "bing.com",
  "duckduckgo.com",
  "yahoo.",
  "yandex.",
  "baidu.com",
  "ecosia.org",
  "brave.com",
  "startpage.com",
  "qwant.com",
];

const SOCIAL_HOSTS = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "t.co",
  "linkedin.com",
  "lnkd.in",
  "reddit.com",
  "news.ycombinator.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.",
  "threads.net",
  "bsky.app",
  "mastodon.",
  "t.me",
  "whatsapp.com",
  "discord.com",
  "medium.com",
];

const EMAIL_HOSTS = ["mail.google.com", "outlook.", "mail.yahoo.com", "mail.proton.me"];

/** Paid-search mediums, as GA4 defines them. */
const PAID_MEDIUMS = new Set(["cpc", "ppc", "paidsearch", "paid_search", "sem"]);
const PAID_SOCIAL_MEDIUMS = new Set(["paidsocial", "paid_social", "cpm-social"]);
const EMAIL_MEDIUMS = new Set(["email", "e-mail", "e_mail", "newsletter", "mail"]);
const SOCIAL_MEDIUMS = new Set(["social", "social-network", "social_network", "sm"]);
const DISPLAY_MEDIUMS = new Set(["display", "banner", "cpm", "expandable", "interstitial"]);
const AFFILIATE_MEDIUMS = new Set(["affiliate", "affiliates", "partner"]);

/** Bare lowercase host, or null when the referrer is unusable. */
export const referrerHost = (referrer: string | null | undefined): string | null => {
  if (!referrer) return null;
  const raw = referrer.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
};

const hostMatches = (host: string, needles: readonly string[]): boolean =>
  needles.some((n) => host === n || host.endsWith(n) || host.includes(`.${n}`));

export interface ChannelInput {
  referrer?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
}

/**
 * Classify one touch.
 *
 * Order matters and follows GA4's own precedence: an explicit paid medium wins
 * over whatever the referrer looks like, because a Google Ads click and an
 * organic Google result share a referrer host and differ only in the tag. Get
 * this backwards and every paid campaign reads as free traffic — the single
 * most expensive mistake this function can make.
 */
export const classifyChannel = (input: ChannelInput): Channel => {
  const medium = (input.utmMedium ?? "").trim().toLowerCase();
  const source = (input.utmSource ?? "").trim().toLowerCase();
  const host = referrerHost(input.referrer);

  // 1. Explicit paid intent, whatever the referrer says.
  if (PAID_MEDIUMS.has(medium)) return "Paid Search";
  if (PAID_SOCIAL_MEDIUMS.has(medium)) return "Paid Social";
  if (DISPLAY_MEDIUMS.has(medium)) return "Display";
  if (AFFILIATE_MEDIUMS.has(medium)) return "Affiliate";
  if (EMAIL_MEDIUMS.has(medium)) return "Email";
  if (SOCIAL_MEDIUMS.has(medium)) return "Organic Social";

  // 2. A tagged source with no medium still tells us something.
  if (!medium && source) {
    if (hostMatches(source, SEARCH_HOSTS)) return "Organic Search";
    if (hostMatches(source, SOCIAL_HOSTS)) return "Organic Social";
    if (source === "newsletter" || source === "email") return "Email";
  }

  // 3. Fall back to the referrer.
  if (host) {
    if (hostMatches(host, SEARCH_HOSTS)) return "Organic Search";
    if (hostMatches(host, SOCIAL_HOSTS)) return "Organic Social";
    if (hostMatches(host, EMAIL_HOSTS)) return "Email";
    return "Referral";
  }

  // 4. No referrer and no usable tag. A tagged campaign with an unrecognised
  //    medium is NOT direct — someone told us it came from somewhere.
  if (source || medium) return "Referral";
  return "Direct";
};

/**
 * The label a source/medium report shows for one touch.
 *
 * GA4 writes this as `source / medium`, and the `(direct) / (none)` spelling
 * for untagged direct traffic is its convention rather than ours — matching it
 * means a report can be read by someone arriving from GA without a glossary.
 */
export const sourceMediumLabel = (input: ChannelInput): string => {
  const source =
    (input.utmSource ?? "").trim().toLowerCase() ||
    referrerHost(input.referrer) ||
    "(direct)";
  const medium = (input.utmMedium ?? "").trim().toLowerCase() || "(none)";
  return `${source} / ${medium}`;
};
