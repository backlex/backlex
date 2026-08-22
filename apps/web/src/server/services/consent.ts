/**
 * Cookie consent — the policy half.
 *
 * This module owns what a site DECIDED to ask its visitors. It does not render
 * the banner, does not store a visitor's answer, and does not gate anything;
 * those are separate surfaces built on top of this one. Keeping them apart
 * matters because they have different lifetimes: a policy is edited, a
 * visitor's answer is evidence and must never change under it.
 *
 * ## The vocabulary is shared, not invented here
 *
 * `CONSENT_CATEGORIES` deliberately mirrors the tag manager's list of the same
 * name, value for value. Two modules naming the same four strings is a seam,
 * and it is the cheaper of the two bad options: the alternative is a runtime
 * import across a feature boundary that would make the consent surface
 * unusable on a deploy that has no tags. `consent-policy.test.ts` pins the
 * literal values so a rename on either side fails loudly rather than producing
 * a category nothing gates on.
 *
 * ## Two fields have no default and the service refuses to invent one
 *
 * `undecidedBehaviour` and `trackerCategory` encode compliance postures where
 * neither answer is safe to choose on an operator's behalf. `captcha.ts` makes
 * the same call for `onError` and writes the consequence next to the choice;
 * this goes one step further and rejects the write, because a captcha that
 * fails the wrong way is an outage and a consent posture that defaults the
 * wrong way is a regulator's finding.
 *
 * The column carries no DEFAULT either, so the refusal holds even for a writer
 * that bypasses this module.
 */
import { AppError } from "@backlex/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { invalidateConsentConfig } from "./consent-config-cache";
// The per-site FILE bakes the artifact and the tag settings into its body,
// so a policy write invalidates that memo too. Without it a wording edit —
// or a change to what GPC governs — waits out the container TTL before any
// visitor sees it, which reads to an operator exactly like a save that did
// not take.
import { invalidateContainer } from "./tag-container-cache";
import { hashToken } from "./shared-links";

export interface ConsentDbCtx {
  db: unknown;
  dialect: "pg" | "sqlite";
}

const policiesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.consentPolicies : sqlite.schema.consentPolicies;

const versionsTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.consentVersions : sqlite.schema.consentVersions;

const sitesTable = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.analyticsSites : sqlite.schema.analyticsSites;

/**
 * Every category a tag can be filed under.
 *
 * `none` means strictly necessary: it is never offered to a visitor and never
 * gated, because a site cannot function without it and asking implies a choice
 * that does not exist. The other three are the ones a banner actually asks
 * about.
 */
export const CONSENT_CATEGORIES = ["none", "functional", "analytics", "marketing"] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

/** The categories a banner may offer. `none` is excluded by definition. */
export const OPTIONAL_CATEGORIES = ["functional", "analytics", "marketing"] as const;
export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number];

/** What happens between page load and the visitor's first answer. */
export const UNDECIDED_BEHAVIOURS = ["block", "allow"] as const;
export type UndecidedBehaviour = (typeof UNDECIDED_BEHAVIOURS)[number];

/** Which category backlex's own cookieless tag is filed under. */
export const TRACKER_CATEGORIES = ["none", "analytics"] as const;
export type TrackerCategory = (typeof TRACKER_CATEGORIES)[number];

export const BANNER_POSITIONS = ["bottom", "top", "corner"] as const;
export type BannerPosition = (typeof BANNER_POSITIONS)[number];

/**
 * What Global Privacy Control and Do Not Track are allowed to govern.
 *
 * Until this existed they stopped backlex's OWN tag and nothing else:
 * `optedOut()` reads them, `consentGranted()` deliberately does not, and the
 * tracker source says so in a comment. Widening them is not a deploy-time
 * decision, because every `tag_definitions.consent_category` is `NOT NULL
 * DEFAULT 'marketing'` — flipping the seam would switch off live pixels on
 * every customer site at once, for visitors whose operator chose nothing.
 *
 *   `tracker`  what every site does today, and the default.
 *   `all`      the signals additionally deny every optional category, so the
 *              tag manager's own gate refuses third-party tags. The CCPA
 *              reading, where GPC is a legal opt-out and not a preference.
 *   `off`      neither signal is read. DNT is a standard the W3C retired, and
 *              an operator who does not want it deciding anything should be
 *              able to say so rather than have a site quietly ignore it.
 *
 * **This one HAS a default**, unlike `undecidedBehaviour` and
 * `trackerCategory`. Those two are refused on a first save because neither
 * answer is safe to pick for an operator. Here one answer plainly is: it is the
 * behaviour that is already live everywhere, and the alternative takes working
 * measurement away from a site that never asked.
 */
export const SIGNAL_HANDLING = ["tracker", "all", "off"] as const;
export type SignalHandling = (typeof SIGNAL_HANDLING)[number];

/**
 * The strings the banner renders, and the only ones it will read.
 *
 * A closed list rather than a free-form blob, so a policy cannot smuggle
 * arbitrary keys into the artifact the browser parses, and so the admin form
 * can be generated from it instead of drifting from it.
 */
export const WORDING_KEYS = [
  "title",
  "body",
  "acceptAll",
  "rejectAll",
  "manage",
  "save",
  "policyLink",
  "functionalLabel",
  "functionalBody",
  "analyticsLabel",
  "analyticsBody",
  "marketingLabel",
  "marketingBody",
  "necessaryLabel",
  "necessaryBody",
  // Withdrawal. Added by the preference-centre phase: a decided visitor can
  // reopen the banner, so it needs a way OUT that is not a decision, a control
  // that revokes everything, and a name for the id they quote to ask for
  // erasure. `docs/erasure.md` reaches an anonymous visitor's consent record by
  // that id alone, so a banner that never shows it makes the right
  // unexercisable.
  "close",
  "withdraw",
  "idLabel",
] as const;
export type WordingKey = (typeof WORDING_KEYS)[number];

/** Theme tokens the banner inlines. Closed for the same reason as the wording. */
export const THEME_KEYS = [
  "background",
  "foreground",
  "accent",
  "accentForeground",
  "border",
  "radius",
] as const;

/** Bounds on operator-supplied text. Generous enough for a real cookie notice,
 *  bounded because it is served to every visitor of the site. */
const MAX_WORDING_CHARS = 2_000;
/** BCP-47 shaped: letters, digits and hyphens. `en`, `tr`, `pt-BR`. */
const LOCALE_TAG = /^[A-Za-z0-9-]+$/;
const MAX_LOCALES = 20;

export interface ConsentPolicy {
  siteId: string;
  categoriesOffered: OptionalCategory[];
  undecidedBehaviour: UndecidedBehaviour;
  trackerCategory: TrackerCategory;
  wording: Record<string, Partial<Record<WordingKey, string>>>;
  defaultLocale: string;
  policyUrl: string | null;
  position: BannerPosition;
  theme: Record<string, string>;
  cookieMaxAgeDays: number;
  /** See `SIGNAL_HANDLING`. Not part of the artifact — it rides the container. */
  signalHandling: SignalHandling;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConsentPolicyInput {
  categoriesOffered?: unknown;
  undecidedBehaviour?: unknown;
  trackerCategory?: unknown;
  wording?: unknown;
  defaultLocale?: unknown;
  policyUrl?: unknown;
  position?: unknown;
  theme?: unknown;
  cookieMaxAgeDays?: unknown;
  signalHandling?: unknown;
  enabled?: unknown;
}

const tenantEq = (col: any, tenantId: string | null) =>
  tenantId === null ? isNull(col) : eq(col, tenantId);

/** Read an epoch-ms instant back out of either dialect's row shape. */
const tsValue = (v: unknown): number =>
  v instanceof Date ? v.getTime() : typeof v === "string" ? Date.parse(v) : Number(v ?? 0);

const tsParam = (dialect: "pg" | "sqlite", ms: number): Date | number =>
  dialect === "pg" ? new Date(ms) : ms;

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
};

const oneOf = <T extends string>(v: unknown, allowed: readonly T[]): T | null =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : null;

/**
 * A URL an operator wants linked from the banner.
 *
 * Restricted to http(s) because the value is written into an `href` served onto
 * a third-party page: `javascript:` there is stored XSS on somebody else's
 * site, and this string travels from an admin form into every visitor's
 * browser without passing through a framework that would escape it.
 */
const httpUrl = (v: unknown): string | null => {
  const raw = str(v, 500);
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new AppError("VALIDATION", "The policy link must be a full URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new AppError("VALIDATION", "The policy link must be an http(s) URL.");
  }
  return parsed.toString();
};

const localeTag = (v: unknown): string | null => {
  const tag = str(v, 20);
  return tag && LOCALE_TAG.test(tag) ? tag : null;
};

const parseCategories = (v: unknown): OptionalCategory[] => {
  if (!Array.isArray(v)) return [];
  const out: OptionalCategory[] = [];
  for (const raw of v) {
    const c = oneOf(raw, OPTIONAL_CATEGORIES);
    if (c && !out.includes(c)) out.push(c);
  }
  // Stable order, so the artifact hash in the next phase is a function of the
  // content and not of the order an admin happened to tick the boxes in.
  return OPTIONAL_CATEGORIES.filter((c) => out.includes(c));
};

/**
 * Reduce operator wording to `{ locale: { knownKey: string } }`.
 *
 * Unknown keys are dropped rather than rejected: the admin sends a whole form
 * back, and a key added in a later version of the UI should not 422 an
 * otherwise valid save from an older client.
 *
 * **The values are NOT escaped here, and the renderer must not use innerHTML.**
 * They are free text by necessity — a cookie notice contains punctuation and
 * quotes — and they are served onto a page backlex does not own. Escaping at
 * this boundary would mean storing `&amp;` in what a lawyer reviews, so the
 * obligation lands on the banner instead: every one of these strings is
 * inserted with `textContent`. That is a load-bearing constraint of the banner
 * phase, not a preference.
 */
const parseWording = (v: unknown): Record<string, Partial<Record<WordingKey, string>>> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, Partial<Record<WordingKey, string>>> = {};
  let locales = 0;
  for (const [locale, block] of Object.entries(v as Record<string, unknown>)) {
    // Counted per ITERATION, not per accepted locale. Counting acceptances
    // means a body of a million empty blocks never increments and the loop
    // walks the whole thing at fifteen property lookups an entry — which on a
    // Worker's CPU budget is a self-DoS an admin credential can trigger.
    if (locales >= MAX_LOCALES) break;
    locales += 1;
    // BCP-47-shaped, so a locale cannot be arbitrary text. These become object
    // keys in an artifact served to every visitor of the site, and nothing
    // legitimate here needs a character outside this set.
    const tag = localeTag(locale);
    if (!tag) continue;
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const entry: Partial<Record<WordingKey, string>> = {};
    for (const key of WORDING_KEYS) {
      const text = str((block as Record<string, unknown>)[key], MAX_WORDING_CHARS);
      if (text) entry[key] = text;
    }
    if (Object.keys(entry).length) out[tag] = entry;
  }
  return out;
};

/**
 * A CSS value safe to inline into a rule on somebody else's page.
 *
 * Positive allowlist, not a blocklist: these strings end up inside a stylesheet
 * the banner writes onto the customer's site, so a value carrying `;` or `}`
 * closes the declaration and everything after it is attacker-authored CSS —
 * which is enough to overlay the page, restyle a login form, or hide the
 * banner's own reject button while leaving accept visible.
 *
 * Colours (`#abc`, `rgb(…)`, `oklch(…)`, named) and lengths (`8px`, `.5rem`,
 * `50%`) all fit; `url(`, comments and braces do not, because nothing legitimate
 * in this six-key palette needs them. A rejected value is dropped rather than
 * 422'd — a theme is decoration, and refusing the whole save over one colour
 * would block a compliance change on a cosmetic one.
 */
const SAFE_CSS_VALUE = /^[#a-zA-Z0-9 ,.%()/-]+$/;

const parseTheme = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const key of THEME_KEYS) {
    const val = str((v as Record<string, unknown>)[key], 60);
    if (!val || !SAFE_CSS_VALUE.test(val)) continue;
    // `url(` passes the character test — every one of its characters is
    // otherwise legitimate — and is the one function worth naming, since it
    // fetches from a third party and leaks the visitor's referrer.
    if (val.toLowerCase().includes("url(")) continue;
    out[key] = val;
  }
  return out;
};

/**
 * Map a stored row to the shape every surface returns.
 *
 * The `??` fallbacks on the two postures are the SAFE reading, not a default.
 * A row can only reach them if it was written around this module — the column
 * is NOT NULL with no DEFAULT — so the only question is which way to fail on
 * data that should not exist. `block` withholds measurement and `analytics`
 * gates our own tag: both err toward asking rather than assuming. That is also
 * deliberately NOT the direction an operator would pick for convenience, so a
 * row landing here shows up as reduced traffic rather than hiding as
 * over-collection.
 */
const toPolicy = (r: any): ConsentPolicy => ({
  siteId: r.siteId,
  categoriesOffered: Array.isArray(r.categoriesOffered)
    ? parseCategories(r.categoriesOffered)
    : [],
  undecidedBehaviour: (oneOf(r.undecidedBehaviour, UNDECIDED_BEHAVIOURS) ??
    "block") as UndecidedBehaviour,
  trackerCategory: (oneOf(r.trackerCategory, TRACKER_CATEGORIES) ??
    "analytics") as TrackerCategory,
  wording: parseWording(r.wording),
  defaultLocale: r.defaultLocale ?? "en",
  policyUrl: r.policyUrl ?? null,
  position: (oneOf(r.position, BANNER_POSITIONS) ?? "bottom") as BannerPosition,
  theme: parseTheme(r.theme),
  cookieMaxAgeDays: Number(r.cookieMaxAgeDays ?? 180),
  // Unlike the two above, this `??` IS a default rather than a safe reading —
  // the column carries one, and `tracker` is what every site already does.
  signalHandling: (oneOf(r.signalHandling, SIGNAL_HANDLING) ?? "tracker") as SignalHandling,
  enabled: Boolean(r.enabled),
  createdAt: tsValue(r.createdAt),
  updatedAt: tsValue(r.updatedAt),
});

/**
 * ── The artifact ──────────────────────────────────────────────────────────
 *
 * What a browser is actually served, and the thing a consent record points at.
 * A record that pointed at `consent_policies` would point at mutable state: the
 * operator edits the wording, and every past visitor's evidence silently
 * becomes a claim about text they were never shown.
 *
 * The hash is the identity. It is computed from THIS document and nothing else,
 * which is why the fields below are chosen by what a visitor agreed to rather
 * than by what the row happens to hold.
 */
export interface ConsentConfig {
  /** Artifact schema version. A shape change becomes a deliberate, greppable
   *  hash break instead of a silent one. */
  v: 1;
  site: string;
  categories: OptionalCategory[];
  undecided: UndecidedBehaviour;
  tracker: TrackerCategory;
  locale: string;
  wording: Record<string, Partial<Record<WordingKey, string>>>;
  policyUrl: string | null;
  position: BannerPosition;
  theme: Record<string, string>;
  cookieDays: number;
}

/**
 * Compile a policy into the document the config route serves.
 *
 * ── Built from a fixed literal, never a spread ────────────────────────────
 * Key order is then a property of this function rather than of the row shape,
 * so a column added to `consent_policies` later cannot silently enter the
 * artifact and invalidate every cached ETag at once.
 *
 * ── Four fields are excluded, each for its own reason ─────────────────────
 * `createdAt` / `updatedAt` — an empty-patch save moves `updatedAt`, so
 * including it would make the hash a clock reading: every no-op save would mint
 * a version row and bust every visitor's cache.
 * `tenantId` — this body is served with `ACAO: *` to every visitor of a
 * customer domain. A workspace id has no business travelling there.
 * `enabled` — whether to show a banner is not part of what a visitor agreed
 * to, and folding it in would give "live" two meanings that can disagree.
 * It stays on the row and is read fresh at serve time, so switching the banner
 * off is instant and toggling it never mints a version.
 *
 * ── The locale keys are SORTED, and that is not tidiness ──────────────────
 * `parseWording` iterates `Object.entries`, which preserves the order the
 * caller sent — so two byte-identical policies saved with their locales in a
 * different order hashed differently (measured: `e80b8cb3…` against
 * `ddb2be55…`). Worse, the two dialects disagree with each other: Postgres
 * `jsonb` re-sorts object keys by (length, bytes) while SQLite stores the text
 * as written, so the same policy would hash one way on D1 and another on
 * Postgres. One level of sorting fixes both, because the inner blocks are
 * already canonical — `toPolicy` re-runs `parseWording`, which rebuilds each
 * block in `WORDING_KEYS` order — as are `categories` (rebuilt through
 * `OPTIONAL_CATEGORIES`) and `theme` (rebuilt through `THEME_KEYS`).
 *
 * Pure: no clock, no db, no request. That is what lets a test assert the hash
 * directly and what makes the sqlite and Postgres twins comparable.
 */
export const compileConsentConfig = (
  siteId: string,
  p: Pick<
    ConsentPolicy,
    | "categoriesOffered"
    | "undecidedBehaviour"
    | "trackerCategory"
    | "wording"
    | "defaultLocale"
    | "policyUrl"
    | "position"
    | "theme"
    | "cookieMaxAgeDays"
  >,
): ConsentConfig => {
  const wording: Record<string, Partial<Record<WordingKey, string>>> = {};
  for (const locale of Object.keys(p.wording).sort()) {
    const block = p.wording[locale];
    if (block) wording[locale] = block;
  }
  return {
    v: 1,
    site: siteId,
    categories: p.categoriesOffered,
    undecided: p.undecidedBehaviour,
    tracker: p.trackerCategory,
    locale: p.defaultLocale,
    wording,
    policyUrl: p.policyUrl,
    position: p.position,
    theme: p.theme,
    cookieDays: p.cookieMaxAgeDays,
  };
};

/** The canonical bytes. `JSON.stringify` over a document whose every key order
 *  is fixed by construction, so this is deterministic without a sorting
 *  serializer. */
export const consentConfigBody = (cfg: ConsentConfig): string => JSON.stringify(cfg);

/** SHA-256 hex of the canonical bytes, via the digest this repo already has —
 *  rather than adding a second implementation, which is the same call
 *  `tag-manager.ts` made for its container hash. */
export const hashConsentConfig = (cfg: ConsentConfig): Promise<string> =>
  hashToken(consentConfigBody(cfg));

/**
 * What the config route answers for a site that has no policy, has one that is
 * switched off, or does not exist at all.
 *
 * Byte-identical in all three cases, and never a 404: a status that differs by
 * whether an id exists is an enumeration oracle, and site ids are public. The
 * banner's rule is `if (cfg.enabled === false) return;` — a live artifact
 * carries no `enabled` key at all, because that field is not part of what a
 * visitor agreed to.
 */
export const CONSENT_CONFIG_OFF = '{"v":1,"enabled":false}';

export const listPolicies = async (
  ctx: ConsentDbCtx,
  tenantId: string | null,
): Promise<ConsentPolicy[]> => {
  const t = policiesTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(tenantEq(t.tenantId, tenantId))
    .orderBy(t.siteId)) as any[];
  return rows.map(toPolicy);
};

export const getPolicy = async (
  ctx: ConsentDbCtx,
  tenantId: string | null,
  siteId: string,
): Promise<ConsentPolicy | null> => {
  if (!siteId) return null;
  const t = policiesTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.siteId, siteId), tenantEq(t.tenantId, tenantId)))
    .limit(1)) as any[];
  return row ? toPolicy(row) : null;
};

/**
 * Resolve a policy for the public config route, which has no session.
 *
 * **This is the only read here that is NOT tenant-scoped, deliberately.** The
 * banner carries a public site id and no credential — the same position the
 * collect route is in — so the tenant is derived FROM the site rather than
 * checked against a caller. Every other export in this module is tenant-scoped;
 * do not reach for this one from an admin surface because the name reads
 * conveniently.
 *
 * @internal Public-banner path only.
 *
 * It joins `analytics_sites` rather than reading the policy alone. There is no
 * foreign key (D1 has FKs off, so a constraint that exists only on Postgres is
 * a dialect difference pretending to be an invariant), which means deleting a
 * site leaves its policy behind. Without the join, deleting a site would not
 * stop its banner: the customer's page still carries the snippet, and an
 * orphaned `enabled: true` policy would keep being served to their visitors.
 */
export const getPolicyForSite = async (
  ctx: ConsentDbCtx,
  siteId: string,
): Promise<(ConsentPolicy & { tenantId: string | null }) | null> => {
  if (!siteId) return null;
  const t = policiesTable(ctx.dialect);
  const st = sitesTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select()
    .from(t)
    .innerJoin(st, eq(st.id, t.siteId))
    .where(eq(t.siteId, siteId))
    .limit(1)) as any[];
  // A join returns `{ consent_policies: {...}, analytics_sites: {...} }`.
  const policy = row?.consent_policies ?? row?.consentPolicies ?? null;
  return policy ? { ...toPolicy(policy), tenantId: policy.tenantId ?? null } : null;
};

/**
 * Compile the artifact for the public config route.
 *
 * Not a wrapper around {@link getPolicyForSite}, deliberately. That one selects
 * every column of both joined tables, which drags `analytics_sites`' operator
 * settings — `ignored_ips`, `excluded_paths`, the site's internal name — into a
 * function whose result is one `JSON.stringify` away from a body served to the
 * whole internet. An explicit projection is the guard: a column added to either
 * table cannot leak here by default, it has to be named.
 *
 * `enabled` is read LIVE and gated here rather than folded into the artifact,
 * so switching the banner off takes effect without minting a version.
 *
 * The `innerJoin` is load-bearing for the same reason it is on
 * {@link getPolicyForSite}: there is no foreign key, so deleting a site leaves
 * its policy behind, and the customer's page still carries the snippet. Without
 * the join a deleted site's banner would keep being served to its visitors.
 *
 * @internal Public-banner path only. NOT tenant-scoped — the site id is public
 * by design and this can write nothing. The tenant comes back out so the caller
 * can meter the request against the workspace that actually owns the traffic.
 */
export const getPublishedConsentConfig = async (
  ctx: ConsentDbCtx,
  siteId: string,
): Promise<{ body: string; hash: string; tenantId: string | null } | null> => {
  if (!siteId) return null;
  const t = policiesTable(ctx.dialect);
  const st = sitesTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select({
      tenantId: t.tenantId,
      enabled: t.enabled,
      categoriesOffered: t.categoriesOffered,
      undecidedBehaviour: t.undecidedBehaviour,
      trackerCategory: t.trackerCategory,
      wording: t.wording,
      defaultLocale: t.defaultLocale,
      policyUrl: t.policyUrl,
      position: t.position,
      theme: t.theme,
      cookieMaxAgeDays: t.cookieMaxAgeDays,
    })
    .from(t)
    .innerJoin(st, eq(st.id, t.siteId))
    .where(eq(t.siteId, siteId))
    .limit(1)) as any[];
  if (!row || !row.enabled) return null;

  // `wording` and `theme` are json columns and the two dialects hand them back
  // differently — Postgres parses, SQLite returns the raw TEXT. `toPolicy`'s
  // parsers absorb both, but a blob that is malformed at rest would throw out
  // of the driver's row mapper before any of this runs, and on a public route
  // that is a 500 for every visitor of the site over one bad row. Answering
  // "off" is the safe read: it withholds a banner rather than serving a broken
  // one, and it is visible to the operator as a banner that stopped appearing.
  let cfg: ConsentConfig;
  try {
    cfg = compileConsentConfig(siteId, toPolicy({ ...row, siteId }));
  } catch {
    return null;
  }
  return {
    body: consentConfigBody(cfg),
    hash: await hashConsentConfig(cfg),
    tenantId: row.tenantId ?? null,
  };
};

/**
 * The two policy fields the TAG needs, whether or not a banner is served.
 *
 * Separate from `getPublishedConsentConfig` because that one answers `null` for
 * a disabled policy — correctly, since `enabled` decides whether a banner is
 * shown. But `trackerCategory` and `signalHandling` are not about the banner:
 * an operator can legitimately run no banner and still have filed backlex's own
 * tag as strictly necessary, or still want GPC to stop every tag. Reading them
 * through the banner's switch would make both silently inert in exactly that
 * configuration, which is the shape a compliance bug takes here — a setting
 * that exists, reads back correctly, and does nothing.
 *
 * Called once per container-cache MISS (fifteen minutes per site per origin),
 * beside the artifact read that is already there.
 */
export const getTagConsentSettings = async (
  ctx: ConsentDbCtx,
  siteId: string,
): Promise<{
  tracker: TrackerCategory;
  signals: SignalHandling;
  tenantId: string | null;
} | null> => {
  if (!siteId) return null;
  const t = policiesTable(ctx.dialect);
  const st = sitesTable(ctx.dialect);
  const [row] = (await (ctx.db as any)
    .select({
      trackerCategory: t.trackerCategory,
      signalHandling: t.signalHandling,
      // Returned so the container route can meter a request it now answers for
      // a site whose ONLY consent state is a disabled policy. Without it that
      // fetch bills whichever workspace the tenant middleware resolved, which
      // is the DEFAULT one — the exact defect the route's own comment says is
      // pinned as a regression.
      tenantId: t.tenantId,
    })
    .from(t)
    // Joined to the site for the same reason the artifact read is: a policy
    // whose site was deleted must not keep answering for that id.
    .innerJoin(st, eq(st.id, t.siteId))
    .where(eq(t.siteId, siteId))
    .limit(1)) as any[];
  if (!row) return null;
  return {
    tracker: (oneOf(row.trackerCategory, TRACKER_CATEGORIES) ?? "analytics") as TrackerCategory,
    signals: (oneOf(row.signalHandling, SIGNAL_HANDLING) ?? "tracker") as SignalHandling,
    tenantId: row.tenantId ?? null,
  };
};

export interface ConsentVersion {
  id: string;
  hash: string;
  createdAt: number;
}

/**
 * The artifacts a site's policy has compiled to, newest first.
 *
 * Ordered by `created_at` rather than by a version number, because there is no
 * version number — see the table's own note. Two saves inside one millisecond
 * would tie; that is acceptable for a history list and is not load-bearing
 * anywhere, since a record resolves an artifact by HASH, never by position.
 *
 * The snapshot itself is not returned. A caller listing history wants to know
 * which artifacts exist and when; the bodies are large (operator wording, up to
 * twenty locales) and nothing an admin surface does needs twenty of them at
 * once.
 */
export const listConsentVersions = async (
  ctx: ConsentDbCtx,
  tenantId: string | null,
  siteId: string,
  limit = 20,
): Promise<ConsentVersion[]> => {
  if (!siteId) return [];
  const v = versionsTable(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select({ id: v.id, hash: v.hash, createdAt: v.createdAt })
    .from(v)
    .where(and(eq(v.siteId, siteId), tenantEq(v.tenantId, tenantId)))
    .orderBy(desc(v.createdAt))
    .limit(Math.min(100, Math.max(1, Math.floor(limit) || 20)))) as any[];
  return rows.map((r) => ({
    id: r.id,
    hash: r.hash,
    createdAt: tsValue(r.createdAt),
  }));
};

/**
 * Remove a site's policy without a tenant scope — the cascade `deleteSite`
 * runs, since the site row it would scope against is the thing being deleted.
 *
 * Kept separate from {@link deletePolicy} so the tenant-scoped call an operator
 * makes and the lifecycle call the analytics service makes cannot be confused
 * for each other.
 *
 * @internal Called from `services/analytics.ts::deleteSite`.
 */
export const deletePolicyForDeletedSite = async (
  ctx: ConsentDbCtx,
  siteId: string,
): Promise<void> => {
  if (!siteId) return;
  const t = policiesTable(ctx.dialect);
  const v = versionsTable(ctx.dialect);
  await (ctx.db as any).delete(t).where(eq(t.siteId, siteId));
  // The archive goes with it, and here that IS right: deleting a site removes
  // the subject the evidence is about, not merely its configuration. There is
  // no foreign key to do this — see the table's note — so leaving it out would
  // strand every version row for a site that no longer exists, invisibly and
  // forever. The visitor decisions themselves are removed by the caller, which
  // owns both tables' lifecycle; see `services/analytics.ts::deleteSite`.
  await (ctx.db as any).delete(v).where(eq(v.siteId, siteId));
  invalidateConsentConfig(siteId);
  invalidateContainer(siteId);
};

/**
 * Create or replace a site's policy in one atomic statement.
 *
 * The read below decides which fields are REQUIRED, not whether to insert —
 * the write is an upsert either way. A concurrent create therefore cannot
 * produce the check-then-insert unique violation this repo has shipped before;
 * both racers pass validation and the second one updates.
 */
export const savePolicy = async (
  ctx: ConsentDbCtx,
  tenantId: string | null,
  siteId: string,
  input: ConsentPolicyInput,
  now = Date.now(),
): Promise<ConsentPolicy> => {
  if (!siteId) throw new AppError("VALIDATION", "A consent policy needs a site.");

  // The site must exist AND belong to the caller, checked before anything is
  // written.
  //
  // This is not defensive tidiness — without it the primary key is a
  // cross-tenant squatting primitive. A site id is PUBLIC by design: it ships
  // in the `<script>` snippet on the customer's own page, so anyone can read
  // one. `site_id` is the policy's primary key, and the upsert's `setWhere`
  // only protects a row that already exists. So a caller in tenant B could
  // INSERT the first policy for tenant A's site, take ownership of the key,
  // and leave tenant A unable to configure consent for their own site.
  //
  // NOT_FOUND rather than FORBIDDEN, and the same answer either way, so the
  // response never confirms that somebody else's site id is real.
  const st = sitesTable(ctx.dialect);
  const [site] = (await (ctx.db as any)
    .select({ id: st.id })
    .from(st)
    .where(and(eq(st.id, siteId), tenantEq(st.tenantId, tenantId)))
    .limit(1)) as any[];
  if (!site) throw new AppError("NOT_FOUND", "Site not found.");

  const existing = await getPolicy(ctx, tenantId, siteId);

  // The two decisions nobody may make for the operator. Required on create;
  // on update, omitting them keeps what they already chose — an admin editing
  // the wording is not silently re-deciding the compliance posture.
  const undecidedBehaviour =
    oneOf(input.undecidedBehaviour, UNDECIDED_BEHAVIOURS) ?? existing?.undecidedBehaviour;
  if (!undecidedBehaviour) {
    throw new AppError(
      "VALIDATION",
      "Choose what happens before a visitor decides: \"block\" withholds every optional tag until they answer (required under GDPR/ePrivacy), \"allow\" fires them until the visitor declines (the CCPA/CPRA model, and not lawful in the EU). There is no default.",
    );
  }

  const trackerCategory =
    oneOf(input.trackerCategory, TRACKER_CATEGORIES) ?? existing?.trackerCategory;
  if (!trackerCategory) {
    throw new AppError(
      "VALIDATION",
      "Choose how backlex's own analytics tag is classified: \"none\" treats it as strictly necessary and measures every visitor, \"analytics\" gates it behind consent like any other tag. The tag stores nothing on the device, which is what makes the first defensible — but that is a legal position, not a fact, so there is no default.",
    );
  }

  const days = Number(input.cookieMaxAgeDays);
  const cookieMaxAgeDays =
    Number.isFinite(days) && days > 0
      ? Math.min(730, Math.floor(days))
      : (existing?.cookieMaxAgeDays ?? 180);

  const t = policiesTable(ctx.dialect);
  const resolved = {
    categoriesOffered:
      input.categoriesOffered !== undefined
        ? parseCategories(input.categoriesOffered)
        : (existing?.categoriesOffered ?? []),
    undecidedBehaviour,
    trackerCategory,
    wording:
      input.wording !== undefined ? parseWording(input.wording) : (existing?.wording ?? {}),
    // Validated the same way a wording key is: it names one of them, and it
    // lands in the same artifact served to every visitor.
    defaultLocale: localeTag(input.defaultLocale) ?? existing?.defaultLocale ?? "en",
    policyUrl:
      input.policyUrl !== undefined ? httpUrl(input.policyUrl) : (existing?.policyUrl ?? null),
    position: oneOf(input.position, BANNER_POSITIONS) ?? existing?.position ?? "bottom",
    theme: input.theme !== undefined ? parseTheme(input.theme) : (existing?.theme ?? {}),
    cookieMaxAgeDays,
    // Rides `resolved` into the ROW but never into the artifact:
    // `compileConsentConfig` builds from a fixed literal rather than a spread,
    // which is precisely so an extra key here cannot enter the hashed document
    // and invalidate every visitor's decision at once.
    signalHandling:
      oneOf(input.signalHandling, SIGNAL_HANDLING) ?? existing?.signalHandling ?? "tracker",
  };

  // Hashed from the RESOLVED values, not from `input` and not from `existing`:
  // a partial patch merges with what is already stored, so hashing either side
  // alone would identify an artifact that was never served.
  const cfg = compileConsentConfig(siteId, resolved);
  const artifactHash = await hashConsentConfig(cfg);

  const row = {
    siteId,
    tenantId,
    artifactHash,
    ...resolved,
    enabled: input.enabled !== undefined ? input.enabled === true : (existing?.enabled ?? false),
    createdAt: tsParam(ctx.dialect, existing ? existing.createdAt : now),
    updatedAt: tsParam(ctx.dialect, now),
  };

  await (ctx.db as any)
    .insert(t)
    .values(row)
    .onConflictDoUpdate({
      target: t.siteId,
      set: {
        // `tenant_id` is NOT in the update set. A site belongs to the tenant
        // that registered it; letting an upsert move it would make the primary
        // key a cross-tenant write primitive.
        categoriesOffered: row.categoriesOffered,
        undecidedBehaviour: row.undecidedBehaviour,
        trackerCategory: row.trackerCategory,
        wording: row.wording,
        defaultLocale: row.defaultLocale,
        policyUrl: row.policyUrl,
        position: row.position,
        theme: row.theme,
        cookieMaxAgeDays: row.cookieMaxAgeDays,
        signalHandling: row.signalHandling,
        enabled: row.enabled,
        // Derived from the fields above, so last-writer-wins is correct for it
        // in a way it would not be for an operator-moved pointer. It has to be
        // named here regardless: this `set` is an explicit list, so a column
        // left out of it updates on insert and then never again.
        artifactHash: row.artifactHash,
        updatedAt: row.updatedAt,
      },
      // Scoped so a site registered by another tenant cannot be overwritten by
      // a caller who merely guessed its id — the id is public by design.
      setWhere: tenantEq(t.tenantId, tenantId),
    });

  const saved = await getPolicy(ctx, tenantId, siteId);
  if (!saved) {
    // The upsert's `setWhere` matched nothing, so a row exists for this site
    // under a DIFFERENT tenant — and the caller has already proven they own the
    // site, so saying so leaks nothing.
    //
    // Reported as CONFLICT rather than the NOT_FOUND used above, because the
    // two are not the same situation and conflating them is a trap: the owner
    // would be told their own site does not exist, forever, with no action to
    // take. The reachable trigger is a single-tenant → multi-tenant backfill
    // that stamps `analytics_sites.tenant_id` without touching
    // `consent_policies.tenant_id`; `site_id` is the primary key, so there is
    // no second row to fall back to.
    //
    // The anti-enumeration property is untouched: an unknown site and someone
    // else's site both still answer NOT_FOUND at the ownership check above,
    // before this line is reachable.
    throw new AppError(
      "CONFLICT",
      "A consent policy already exists for this site under a different workspace. It has to be removed before this one can be saved.",
    );
  }

  // Archive the artifact this save produced.
  //
  // AFTER the CONFLICT branch, deliberately: a caller who owns the site but
  // whose policy row is held by another workspace must not leave a version row
  // behind for a policy they were refused.
  //
  // `onConflictDoNothing` on `(site_id, hash)` is what makes the archive
  // content-addressed rather than an audit log. Saving the same content twice —
  // an empty patch, a form re-submit, or an operator reverting to last week's
  // wording — adds nothing, so the table holds distinct artifacts rather than a
  // row per click. It is also why there is no version counter to race on.
  const v = versionsTable(ctx.dialect);
  await (ctx.db as any)
    .insert(v)
    .values({
      id: crypto.randomUUID(),
      tenantId,
      siteId,
      hash: artifactHash,
      snapshot: cfg,
      createdAt: tsParam(ctx.dialect, now),
    })
    .onConflictDoNothing({ target: [v.siteId, v.hash] });

  // The operator's next request must see what they just saved. Without this
  // they save, reload their own site, and read the previous wording — which
  // looks like a failed save rather than a one-minute memo.
  invalidateConsentConfig(siteId);
  invalidateContainer(siteId);
  return saved;
};

export const deletePolicy = async (
  ctx: ConsentDbCtx,
  tenantId: string | null,
  siteId: string,
): Promise<void> => {
  const t = policiesTable(ctx.dialect);
  await (ctx.db as any)
    .delete(t)
    .where(and(eq(t.siteId, siteId), tenantEq(t.tenantId, tenantId)));
  // **The archive deliberately SURVIVES.** An earlier version of this function
  // cascaded into `consent_versions`, which quietly gutted the promise this
  // endpoint already ships — "consent already recorded is evidence and is left
  // alone; it is removed through the erasure surface, never as a side effect of
  // reconfiguring a site." A record points at an artifact by hash, so deleting
  // the artifacts leaves the record naming a document nobody can produce, which
  // is the failure the archive exists to prevent. The policy row is config; the
  // archive is evidence, and they do not share a lifetime.
  //
  // Removing a site is different — see `deletePolicyForDeletedSite`.
  invalidateConsentConfig(siteId);
  invalidateContainer(siteId);
};

/**
 * Default copy, offered by the admin as a starting point.
 *
 * Exported rather than inlined in the client so the wording an operator
 * publishes and the wording we suggest come from one place — and so the
 * server, which owns the published text, is the thing that knows it.
 *
 * It is a SUGGESTION, not a fallback: nothing reads this at serve time. A
 * policy with no wording renders the banner's own built-in strings, because
 * silently substituting text an operator never reviewed is the same mistake as
 * defaulting the posture.
 */
export const suggestedWording = (): Record<string, Record<WordingKey, string>> => ({
  en: {
    title: "Cookies on this site",
    body: "We use cookies to run this site and, with your permission, to understand how it is used and to show you relevant ads. You can change your mind at any time.",
    acceptAll: "Accept all",
    rejectAll: "Reject all",
    manage: "Manage preferences",
    save: "Save choices",
    policyLink: "Privacy policy",
    necessaryLabel: "Strictly necessary",
    necessaryBody: "Required for the site to work. These cannot be switched off.",
    functionalLabel: "Functional",
    functionalBody: "Remembers your preferences, such as language or region.",
    analyticsLabel: "Analytics",
    analyticsBody: "Helps us understand which pages are used, in aggregate.",
    marketingLabel: "Marketing",
    marketingBody: "Used to show you ads that are relevant to you.",
    close: "Close",
    withdraw: "Withdraw my consent and delete my record",
    idLabel: "Your consent id",
  },
  tr: {
    title: "Bu sitede çerezler",
    body: "Bu siteyi çalıştırmak için ve izin verirseniz sitenin nasıl kullanıldığını anlamak ve size uygun reklamlar göstermek için çerez kullanıyoruz. Kararınızı istediğiniz zaman değiştirebilirsiniz.",
    acceptAll: "Tümünü kabul et",
    rejectAll: "Tümünü reddet",
    manage: "Tercihleri yönet",
    save: "Seçimleri kaydet",
    policyLink: "Gizlilik politikası",
    necessaryLabel: "Zorunlu",
    necessaryBody: "Sitenin çalışması için gerekli. Bunlar kapatılamaz.",
    functionalLabel: "İşlevsel",
    functionalBody: "Dil veya bölge gibi tercihlerinizi hatırlar.",
    analyticsLabel: "Analitik",
    analyticsBody: "Hangi sayfaların kullanıldığını toplu olarak anlamamıza yardımcı olur.",
    marketingLabel: "Pazarlama",
    marketingBody: "Size uygun reklamlar göstermek için kullanılır.",
    close: "Kapat",
    withdraw: "Onayımı geri çek ve kaydımı sil",
    idLabel: "Onay kimliğiniz",
  },
});
