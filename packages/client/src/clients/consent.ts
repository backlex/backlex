import type { ClientCore } from "../core";

/**
 * Cookie consent — the policy a site publishes to its visitors.
 *
 * This is an OPERATOR surface, not an end-user one. It configures what a
 * website asks the people who visit it; it does not record anyone's answer.
 * A visitor's decision is evidence, arrives from the banner on the visitor's
 * own device, and is not something an application posts on their behalf.
 *
 * It lives on the SDK rather than being admin-console-only because the thing
 * an application genuinely automates here is provisioning: register a site,
 * attach its consent policy, done — the same reason `analytics.sites` is on
 * the SDK.
 */

/** The categories a banner may offer. Strictly-necessary is never one of them:
 *  a site cannot run without it, so presenting it implies a choice that does
 *  not exist. */
export type ConsentCategory = "functional" | "analytics" | "marketing";

/**
 * What happens between page load and the visitor's first answer.
 *
 * - `block` — nothing optional fires until they decide. Required under GDPR
 *   and ePrivacy; it costs measurement on every visitor who ignores the banner.
 * - `allow` — optional tags fire until the visitor declines. The CCPA/CPRA
 *   opt-out model, and **not lawful in the EU**.
 *
 * There is no default, here or on the server. Both answers are correct
 * somewhere and wrong somewhere else, so the choice belongs to the operator and
 * a first save without it is refused.
 */
export type UndecidedBehaviour = "block" | "allow";

/**
 * How backlex's own cookieless analytics tag is classified.
 *
 * - `none` — strictly necessary; it measures every visitor. Defensible because
 *   the tag stores nothing on the device and its visitor id is server-derived
 *   and rotates daily, so ePrivacy Art. 5(3) is arguably not triggered. That is
 *   a legal position, not a fact, and it varies by member state.
 * - `analytics` — gated behind consent like any other analytics tag.
 *
 * Also has no default, for the same reason.
 */
export type TrackerCategory = "none" | "analytics";

export type BannerPosition = "bottom" | "top" | "corner";

export interface ConsentPolicy {
  /** The site this policy governs. There is exactly one policy per site. */
  siteId: string;
  categoriesOffered: ConsentCategory[];
  undecidedBehaviour: UndecidedBehaviour;
  trackerCategory: TrackerCategory;
  /** Per-locale banner copy, `{ en: { title, body, … } }`. Server-owned: the
   *  page never supplies it, so the text a visitor was held to is the text the
   *  workspace published. */
  wording: Record<string, Record<string, string>>;
  defaultLocale: string;
  policyUrl: string | null;
  position: BannerPosition;
  theme: Record<string, string>;
  /** How long a decision stands before the visitor is asked again. */
  cookieMaxAgeDays: number;
  /** Whether the banner is served at all. */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * A policy to save.
 *
 * `undecidedBehaviour` and `trackerCategory` are optional in the type and
 * required by the server on a FIRST save. That asymmetry is deliberate: a
 * caller editing the wording must not be made to restate a compliance decision
 * it is not changing, and on an update the stored choice is carried forward.
 * A first save that omits either is rejected with a message naming what each
 * value does.
 */
export interface ConsentPolicyInput {
  categoriesOffered?: ConsentCategory[];
  undecidedBehaviour?: UndecidedBehaviour;
  trackerCategory?: TrackerCategory;
  wording?: Record<string, Record<string, string>>;
  defaultLocale?: string;
  policyUrl?: string | null;
  position?: BannerPosition;
  theme?: Record<string, string>;
  cookieMaxAgeDays?: number;
  enabled?: boolean;
}

/**
 * One artifact a site's consent policy compiled to.
 *
 * Immutable. A recorded consent points at {@link ConsentVersion.hash}, so the
 * text a visitor agreed to cannot be edited out from under the evidence.
 */
export interface ConsentVersion {
  id: string;
  /** SHA-256 of the canonical artifact, and the ETag the public config
   *  endpoint serves. */
  hash: string;
  createdAt: number;
}

export interface ConsentClient {
  /** Every site that has a policy. Sites without one are absent, not empty. */
  policies(): Promise<{ data: ConsentPolicy[] }>;
  /** One site's policy, or `null` when it has never been configured. */
  policy(siteId: string): Promise<{ data: ConsentPolicy | null }>;
  /** Create or replace. See {@link ConsentPolicyInput} on what is required. */
  savePolicy(siteId: string, input: ConsentPolicyInput): Promise<{ data: ConsentPolicy }>;
  /** Stop serving the banner. Consent already recorded is evidence and is left
   *  alone — it is removed through the erasure surface, never as a side effect
   *  of reconfiguring a site. */
  deletePolicy(siteId: string): Promise<{ ok: boolean }>;
  /**
   * Suggested banner copy, as a starting point.
   *
   * Never applied automatically: a policy with no wording renders the banner's
   * own built-in strings rather than a legal statement nobody reviewed.
   */
  suggestedWording(): Promise<{ data: Record<string, Record<string, string>> }>;
  /**
   * Artifacts this site's policy has compiled to, newest first.
   *
   * A history of distinct CONTENT, not a log of saves: there is no publish step
   * and no version number — the live policy is the one row — and saving the
   * same content twice reuses the existing artifact, so a revert adds nothing.
   */
  versions(siteId: string, opts?: { limit?: number }): Promise<{ data: ConsentVersion[] }>;
}

export const makeConsent = (core: ClientCore): ConsentClient => {
  const at = (siteId: string) =>
    `/api/admin/consent/policies/${encodeURIComponent(siteId)}`;
  return {
    policies: () =>
      core.request<{ data: ConsentPolicy[] }>("GET", "/api/admin/consent/policies"),
    policy: (siteId: string) =>
      core.request<{ data: ConsentPolicy | null }>("GET", at(siteId)),
    savePolicy: (siteId: string, input: ConsentPolicyInput) =>
      core.request<{ data: ConsentPolicy }>("PUT", at(siteId), input),
    deletePolicy: (siteId: string) => core.request<{ ok: boolean }>("DELETE", at(siteId)),
    suggestedWording: () =>
      core.request<{ data: Record<string, Record<string, string>> }>(
        "GET",
        "/api/admin/consent/wording/suggested",
      ),
    versions: (siteId: string, opts?: { limit?: number }) =>
      core.request<{ data: ConsentVersion[] }>(
        "GET",
        `${at(siteId)}/versions${
          opts?.limit === undefined
            ? ""
            : `?limit=${encodeURIComponent(String(opts.limit))}`
        }`,
      ),
  };
};
