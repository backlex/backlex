/**
 * Tag manager — the vendor template registry.
 *
 * A template is the safe half of the feature. An operator picks one and fills
 * in parameters; they never supply a script URL. That is what keeps a tag from
 * being "run this arbitrary origin on my customers' pages" — the origin is a
 * literal in this file, reviewed like any other code.
 *
 * ── Two halves, and a test that keeps them together ───────────────────────
 * Each template exists twice: here (parameters, origins, consent) and as an
 * init branch inside the browser runtime. A template with no runtime branch
 * would be an option the admin offers and nothing honours, so a spec asserts
 * the two lists agree.
 *
 * ── Why the patterns are deliberately loose ───────────────────────────────
 * The obvious design is a strict regex per vendor id. It is the wrong one, and
 * verification is what proved it: of the vendors checked against their own
 * documentation so far, **most publish no id format at all**. Reddit's docs use
 * a `{{Your pixel ID}}` placeholder everywhere and the shipped pixel library
 * carries no id validation; Yandex documents only "integer" and its own
 * placeholders disagree on the digit count. Two regexes written from memory
 * turned out to be wrong.
 *
 * So `pattern` here is a **sanity bound** — enough to keep a newline or a URL
 * out of a value that ends up in a script tag — and `formatDocumented` records
 * whether the vendor actually publishes a format. Rejecting a valid pixel id is
 * the worse failure of the two: it is indistinguishable, from the operator's
 * side, from a backlex bug.
 *
 * ── The container is public ───────────────────────────────────────────────
 * Every value here is served to anonymous visitors, because that is what a tag
 * manager IS. No parameter may be a secret, and none of the ones below are:
 * pixel ids and measurement ids are already visible in the page source of any
 * site that runs them.
 */
import { AppError } from "@backlex/core";

/**
 * Consent categories a tag can declare.
 *
 * Gated against the signals the analytics tracker already reads — gtag's
 * `dataLayer.analytics_storage`, GPC, DNT, and an explicit `backlex.consent()`.
 * `none` means the tag runs regardless, which is only defensible for something
 * genuinely essential; the default on a new tag is `marketing`.
 */
export const CONSENT_CATEGORIES = ["none", "functional", "analytics", "marketing"] as const;
export type ConsentCategory = (typeof CONSENT_CATEGORIES)[number];

export interface TagTemplateParam {
  key: string;
  label: string;
  required: boolean;
  /** Drives the admin form control. A finite value set must be selectable. */
  kind: "text" | "select" | "boolean";
  options?: { value: string; label: string }[];
  /**
   * Anchored sanity bound, NOT a vendor specification unless
   * `formatDocumented` is true. See the file header for why these are loose.
   */
  pattern?: string;
  /**
   * Does the vendor publish an exact format for this value?
   *
   * The admin renders the difference honestly: "format per <vendor> docs"
   * versus "this vendor publishes no format — paste the value exactly as it
   * appears in their dashboard".
   */
  formatDocumented: boolean;
  placeholder?: string;
  help?: string;
}

export interface TagTemplate {
  id: string;
  label: string;
  vendor: string;
  /** The vendor's own documentation for this tag. Shown in the admin. */
  docUrl: string;
  /**
   * One or more. Plural because at least one vendor genuinely is both, by its
   * own documentation — see `yandex_metrica`.
   */
  consentCategories: ConsentCategory[];
  /**
   * What a site owner must add to their OWN Content-Security-Policy for this
   * tag to run. Their page, their policy — we cannot relax it for them, so the
   * Install tab prints these instead of letting them find out in production.
   *
   * `frameSchemes` is separate because at least one vendor needs URL *schemes*
   * rather than hosts: TikTok's own CSP doc asks for `bytedance:` and
   * `sslocal:` in `frame-src`, which are app-handoff schemes, not origins.
   * Folding them into the host list would produce a policy line that does not
   * parse.
   */
  csp: {
    script?: string[];
    img?: string[];
    connect?: string[];
    frame?: string[];
    frameSchemes?: string[];
  };
  /**
   * Did the vendor publish this CSP guidance, or did we derive it from their
   * snippet and endpoints?
   *
   * Meta publishes none at all — every CSP article for the Meta Pixel is
   * third-party. The Install tab says which, because an operator hardening a
   * policy deserves to know whether they are following a vendor instruction or
   * our reading of one.
   */
  cspSource: "vendor" | "inferred";
  params: TagTemplateParam[];
}

/**
 * A permissive bound for an id whose format the vendor does not publish.
 *
 * Wide enough to accept anything a vendor dashboard might hand out, narrow
 * enough that the value cannot carry a quote, a newline, an angle bracket or a
 * scheme into the markup that consumes it.
 */
const OPAQUE_ID = "^[A-Za-z0-9._~-]{1,64}$";

export const TAG_TEMPLATES: TagTemplate[] = [
  {
    id: "reddit_pixel",
    label: "Reddit Pixel",
    vendor: "Reddit",
    docUrl:
      "https://business.reddithelp.com/s/article/manual-conversion-events-with-the-reddit-pixel",
    consentCategories: ["marketing"],
    csp: {
      script: ["https://www.redditstatic.com"],
      connect: ["https://alb.reddit.com", "https://pixel-config.reddit.com"],
    },
    cspSource: "inferred",
    params: [
      {
        key: "pixelId",
        label: "Pixel ID",
        required: true,
        kind: "text",
        // Reddit's loader takes the id BOTH in the script URL's `pixel_id`
        // query parameter and in the `rdt('init', …)` call. Verified against
        // the live library, which branches on the query parameter's presence.
        pattern: OPAQUE_ID,
        formatDocumented: false,
        help: "Reddit publishes no id format — copy it exactly from Events Manager.",
      },
    ],
  },
  {
    id: "snap_pixel",
    label: "Snap Pixel",
    vendor: "Snapchat",
    docUrl: "https://developers.snap.com/marketing-api/Ads-API/snap-pixel",
    consentCategories: ["marketing"],
    csp: { script: ["https://sc-static.net"], connect: ["https://tr.snapchat.com"] },
    cspSource: "inferred",
    params: [
      {
        key: "pixelId",
        label: "Pixel ID",
        required: true,
        kind: "text",
        // Snap's docs show a UUID by example rather than stating the
        // constraint, so the bound stays permissive: enforcing a UUID would
        // reject a valid id the day Snap changes shape.
        pattern: OPAQUE_ID,
        formatDocumented: false,
        placeholder: "6abc82ca-4a3a-4391-98ba-0317a8471234",
        help: "Snap documents a UUID by example; the constraint itself is not stated.",
      },
    ],
  },
  {
    id: "yandex_metrica",
    label: "Yandex Metrica",
    vendor: "Yandex",
    docUrl: "https://yandex.com/support/metrica/en/code/counter-initialize",
    // Both, by Yandex's own documentation: any Metrica goal can be used as a
    // Yandex Direct retargeting criterion, so declaring this analytics-only
    // would under-declare it to a consent tool that is working correctly.
    consentCategories: ["analytics", "marketing"],
    csp: {
      script: ["https://mc.yandex.ru", "https://mc.yandex.com", "https://mc.yandex.com.tr"],
      img: ["https://mc.yandex.ru", "https://mc.yandex.com"],
      connect: ["https://mc.yandex.ru", "https://mc.yandex.com", "https://mc.webvisor.org"],
    },
    cspSource: "vendor",
    params: [
      {
        key: "counterId",
        label: "Tag number",
        required: true,
        kind: "text",
        // Documented as an integer; the digit COUNT is not documented, and
        // Yandex's own placeholders disagree (XXXXXXXX on one page, XXXXXX on
        // another). So: digits only, no length opinion.
        pattern: "^[0-9]{1,12}$",
        formatDocumented: false,
        help: "Yandex documents the type (an integer) but not its length.",
      },
      {
        key: "webvisor",
        label: "Session Replay (Webvisor)",
        required: false,
        kind: "boolean",
        formatDocumented: true,
        help: "Records session replays. Raises the privacy stakes — declare it to your visitors.",
      },
      {
        key: "domain",
        label: "Library domain",
        required: false,
        kind: "select",
        options: [
          { value: "mc.yandex.ru", label: "mc.yandex.ru (default)" },
          { value: "mc.yandex.com", label: "mc.yandex.com (alternative)" },
        ],
        formatDocumented: true,
        help: "Yandex documents both. Only these two — the tag_ww.js variant seen in the wild is undocumented.",
      },
    ],
  },
  {
    id: "google_tag",
    label: "Google tag (GA4)",
    vendor: "Google",
    docUrl: "https://developers.google.com/tag-platform/gtagjs/install",
    consentCategories: ["analytics"],
    // Google publishes these itself, and publishes them against
    // `script-src-elem` rather than `script-src`. We emit `script-src`, which
    // covers script elements UNLESS the site sets `script-src-elem`
    // explicitly — the Install tab says so, because a site that already has
    // `script-src-elem` will not inherit our line.
    //
    // Google's list also includes per-country `https://www.google.<TLD>`
    // entries and says each TLD must be named individually because CSP allows
    // no wildcard on the right of a host. Google publishes no list of which
    // TLDs, so we do not invent one.
    csp: {
      script: ["https://www.googletagmanager.com"],
      img: ["https://*.google-analytics.com", "https://www.googletagmanager.com"],
      connect: [
        "https://*.google-analytics.com",
        "https://*.analytics.google.com",
        "https://www.googletagmanager.com",
      ],
      frame: ["https://www.googletagmanager.com"],
    },
    cspSource: "vendor",
    params: [
      {
        key: "measurementId",
        label: "Measurement ID",
        required: true,
        kind: "text",
        // The `G-` PREFIX is documented; the length and character class after
        // it are not. Enforcing the prefix is still worth it — it catches the
        // common paste of an `AW-` or `GT-` id into the wrong template, which
        // would otherwise fail silently in the browser.
        pattern: "^G-[A-Za-z0-9]{1,24}$",
        formatDocumented: false,
        placeholder: "G-PSW1MY7HB4",
        help: "Google documents the G- prefix but not what follows it.",
      },
    ],
  },
  {
    id: "google_ads_conversion",
    label: "Google Ads conversion",
    vendor: "Google",
    docUrl: "https://support.google.com/google-ads/answer/7548399?hl=en",
    consentCategories: ["marketing"],
    csp: {
      script: [
        "https://www.googleadservices.com",
        "https://www.google.com",
        "https://www.googletagmanager.com",
        "https://pagead2.googlesyndication.com",
        "https://googleads.g.doubleclick.net",
      ],
      img: [
        "https://www.googletagmanager.com",
        "https://googleads.g.doubleclick.net",
        "https://www.google.com",
        "https://pagead2.googlesyndication.com",
        "https://www.googleadservices.com",
      ],
      connect: [
        "https://pagead2.googlesyndication.com",
        "https://www.googleadservices.com",
        "https://googleads.g.doubleclick.net",
        "https://ad.doubleclick.net",
        "https://www.google.com",
      ],
      frame: ["https://www.googletagmanager.com"],
    },
    cspSource: "vendor",
    params: [
      {
        key: "conversionId",
        label: "Conversion ID",
        required: true,
        kind: "text",
        // `AW-` prefix documented; digit count is not.
        pattern: "^AW-[0-9]{1,20}$",
        formatDocumented: false,
        placeholder: "AW-123456789",
        help: "Google documents the AW- prefix but not how many digits follow.",
      },
      {
        key: "conversionLabel",
        label: "Conversion label",
        required: true,
        kind: "text",
        // Google shows only examples (`AbC-D_efG-h12_34-567`) and states no
        // character class or length. The pair is sent as
        // `send_to: 'AW-<id>/<label>'`, so the label must not carry a slash.
        pattern: OPAQUE_ID,
        formatDocumented: false,
        help: "Google publishes no label format — copy it from the conversion action.",
      },
    ],
  },
  {
    id: "meta_pixel",
    label: "Meta Pixel",
    vendor: "Meta",
    docUrl: "https://developers.facebook.com/docs/meta-pixel/get-started",
    consentCategories: ["marketing"],
    // Meta publishes NO Content-Security-Policy guidance for the pixel — every
    // article on the subject is third-party. These origins are read off Meta's
    // own snippet and its noscript pixel, which is the best available source,
    // and the Install tab labels them as ours rather than Meta's.
    //
    // `graph.facebook.com` is deliberately absent: it is the server-to-server
    // Conversions API endpoint and has no business in a browser policy.
    csp: {
      script: ["https://connect.facebook.net"],
      img: ["https://www.facebook.com"],
      connect: ["https://www.facebook.com"],
    },
    cspSource: "inferred",
    params: [
      {
        key: "pixelId",
        label: "Pixel ID",
        required: true,
        kind: "text",
        // Meta documents NO format whatsoever. Its get-started page shows only
        // `{your-pixel-id-goes-here}`, and the "find your pixel ID" article
        // describes where to look, never what it looks like. The widely-cited
        // 15/16-digit rule is folklore, and shipping it would reject valid ids.
        pattern: OPAQUE_ID,
        formatDocumented: false,
        help: "Meta publishes no id format — copy it exactly from Events Manager.",
      },
    ],
  },
  {
    id: "tiktok_pixel",
    label: "TikTok Pixel",
    vendor: "TikTok",
    docUrl: "https://business-api.tiktok.com/portal/docs?id=1739585702922241",
    // TikTok publishes no consent-management category for the pixel at all, so
    // `marketing` is our classification rather than theirs. It is the only
    // defensible one for an advertising pixel, but it is not vendor-stated.
    consentCategories: ["marketing"],
    // TikTok DOES publish a first-party CSP doc, and it is worth following
    // exactly: `analytics-ipv6.tiktokw.us` is a different registrable domain,
    // so the tempting `*.tiktok.com` shortcut both is undocumented and misses
    // a host the tag actually uses.
    csp: {
      script: [
        "https://analytics.tiktok.com",
        "https://analytics-ipv6.tiktokw.us",
        "https://ads.tiktok.com",
      ],
      img: [
        "https://analytics.tiktok.com",
        "https://analytics-ipv6.tiktokw.us",
        "https://ads.tiktok.com",
      ],
      connect: [
        "https://analytics.tiktok.com",
        "https://analytics-ipv6.tiktokw.us",
        "https://ads.tiktok.com",
      ],
      // Not hosts — app-handoff URL schemes, straight from TikTok's own
      // example policy line.
      frameSchemes: ["bytedance:", "sslocal:"],
    },
    cspSource: "vendor",
    params: [
      {
        key: "pixelId",
        label: "Pixel ID",
        required: true,
        kind: "text",
        // Four 20-character examples exist across TikTok's docs, but every API
        // reference types the field as a bare `string` with no pattern, and
        // TikTok's own examples elsewhere use free-form placeholders like
        // `my_pixel_code`. Four examples are not a specification.
        //
        // Two runtime facts for whoever writes the init branch:
        //   - the id goes in the loader URL as `?sdkid=<id>&lib=ttq`.
        //   - `ttq.track()` fans out to EVERY loaded pixel, so a page with two
        //     TikTok tags double-counts. Use `ttq.instance(<id>).track(...)`.
        pattern: OPAQUE_ID,
        formatDocumented: false,
        help: "TikTok publishes no id format — copy it exactly from Events Manager.",
      },
    ],
  },
];

const BY_ID = new Map(TAG_TEMPLATES.map((t) => [t.id, t]));

export const getTagTemplate = (id: string): TagTemplate | null => BY_ID.get(id) ?? null;

export const TAG_TEMPLATE_IDS = TAG_TEMPLATES.map((t) => t.id);

/**
 * Validate operator-supplied parameters against a template.
 *
 * Runs on write AND on read. A stored tag whose parameters no longer validate —
 * because a template tightened, or a row was edited around the API — is
 * dropped from the published artifact rather than emitted in a shape the
 * runtime does not expect. Failing closed here means one tag stops firing;
 * failing open means a malformed value reaches a script tag.
 */
export const parseTemplateParams = (
  templateId: string,
  input: unknown,
): Record<string, string | boolean> => {
  const template = getTagTemplate(templateId);
  if (!template) {
    throw new AppError("VALIDATION", `Unknown tag template. Allowed: ${TAG_TEMPLATE_IDS.join(", ")}.`);
  }
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

  const out: Record<string, string | boolean> = {};

  for (const param of template.params) {
    const value = raw[param.key];

    if (value === undefined || value === null || value === "") {
      if (param.required) {
        throw new AppError("VALIDATION", `${template.label}: "${param.label}" is required.`);
      }
      continue;
    }

    if (param.kind === "boolean") {
      out[param.key] = value === true || value === "true";
      continue;
    }

    if (typeof value !== "string") {
      throw new AppError("VALIDATION", `${template.label}: "${param.label}" must be text.`);
    }
    const text = value.trim();

    if (param.kind === "select") {
      const allowed = (param.options ?? []).map((o) => o.value);
      if (!allowed.includes(text)) {
        // Names the allowed set rather than echoing the input — an error body
        // is not a place to reflect an arbitrary caller string.
        throw new AppError(
          "VALIDATION",
          `${template.label}: "${param.label}" must be one of ${allowed.join(", ")}.`,
        );
      }
      out[param.key] = text;
      continue;
    }

    if (param.pattern && !new RegExp(param.pattern).test(text)) {
      throw new AppError("VALIDATION", `${template.label}: "${param.label}" is not in a usable format.`);
    }
    out[param.key] = text;
  }

  return out;
};

/**
 * The CSP additions a site owner needs for a given set of templates.
 *
 * Generated rather than documented per-vendor, because the answer depends on
 * which tags a particular container actually holds. A site running one pixel
 * should not be told to allow four origins.
 */
export const cspAdditionsForTemplates = (
  templateIds: string[],
): {
  script: string[];
  img: string[];
  connect: string[];
  /** Hosts and schemes together — `frame-src` accepts both in one list. */
  frame: string[];
  /** True when any contributing template's guidance is ours, not the vendor's. */
  hasInferred: boolean;
} => {
  const acc = {
    script: new Set<string>(),
    img: new Set<string>(),
    connect: new Set<string>(),
    frame: new Set<string>(),
  };
  let hasInferred = false;

  for (const id of templateIds) {
    const t = getTagTemplate(id);
    if (!t) continue;
    if (t.cspSource === "inferred") hasInferred = true;
    for (const key of ["script", "img", "connect", "frame"] as const) {
      for (const origin of t.csp[key] ?? []) acc[key].add(origin);
    }
    // Schemes join the frame list because that is where they belong in the
    // emitted policy line; they are modelled apart only so a host-shaped
    // assertion can tell them from origins.
    for (const scheme of t.csp.frameSchemes ?? []) acc.frame.add(scheme);
  }

  return {
    script: [...acc.script].sort(),
    img: [...acc.img].sort(),
    connect: [...acc.connect].sort(),
    frame: [...acc.frame].sort(),
    hasInferred,
  };
};
