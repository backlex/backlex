/**
 * The consent banner: what a visitor is asked, and what runs before they answer.
 *
 * ── Prior blocking is the whole design, and it is why there is no fetch here ─
 * The container runtime arms its triggers SYNCHRONOUSLY inside `__backlexTM`,
 * and a pageview trigger fires immediately. So anything that has to decide
 * whether a tag may run must have decided BEFORE that call — which rules out
 * fetching `/api/consent/config`, because a network round trip cannot finish
 * first. A banner that fetches its own config appears, records evidence, and
 * blocks nothing on first paint: exactly the failure mode where an operator
 * believes they are compliant because a banner appeared.
 *
 * The config is therefore compiled into the per-site file the page already
 * loads, and the server orders that file tracker -> banner -> container. By the
 * time `__backlexTM` runs, `applyPosture` has already told the tracker what is
 * granted, and the container gates on it.
 *
 * ── The posture before a decision is the operator's, not ours ─────────────
 * `undecided: "block"` denies every optional category until the visitor
 * chooses. `"allow"` grants them. `consent.ts` refuses to default that field
 * for exactly this reason, and this is the code that finally honours it.
 *
 * ── What this stores, and what that costs ─────────────────────────────────
 * A first-party cookie on the customer's own origin. That makes the banner the
 * third device-storage mechanism in the tag family, not the first — the
 * container runtime already writes `localStorage` for `once_per_visitor_day`,
 * and the SDK writes a durable `distinctId`. The analytics TRACKER still
 * stores nothing, which is the claim `trackerCategory: "none"` rests on, and
 * it stays true.
 */
import { readDecision, writeDecision, mintSubjectId, type Decision } from "./cookie";
import { resolveStrings } from "./strings";
import { mount } from "./render";

interface ConsentConfig {
  v: number;
  site: string;
  enabled?: boolean;
  categories?: string[];
  undecided?: string;
  tracker?: string;
  locale?: string;
  wording?: Record<string, Record<string, string>>;
  policyUrl?: string | null;
  position?: string;
  theme?: Record<string, string>;
  cookieDays?: number;
}

interface BootConfig {
  /** The compiled artifact, as `GET /api/consent/config` would have served it. */
  cfg: ConsentConfig;
  /** The artifact hash. Bare hex — the ETag carries it QUOTED, and the
   *  server's `SHA256_HEX_RE` rejects the quotes, silently downgrading every
   *  record to `hashGrade: "unresolved"`. Stripped where it is embedded. */
  hash: string;
  /** Absolute origin to post a decision to. */
  endpoint: string;
}

type W = typeof globalThis & {
  backlex?: { consent?: (v: unknown) => void };
  __backlexConsentBanner?: (c: unknown) => void;
  __backlexConsentBannerBooted?: number;
  __backlexConsent?: {
    open: () => void;
    decision: () => Decision | null;
  };
};

const w = globalThis as W;

/** Grant every offered category, or none of them. */
const uniform = (categories: string[], value: boolean): Record<string, boolean> => {
  const out: Record<string, boolean> = {};
  for (const c of categories) out[c] = value;
  return out;
};

/**
 * Tell the tracker what is granted.
 *
 * `backlex.consent()` takes a TOTAL map — an omitted category is denied, the
 * same rule the server applies when it stores the record — so this always
 * passes every offered category explicitly.
 */
const applyGrants = (grants: Record<string, boolean>): void => {
  try {
    w.backlex?.consent?.(grants);
  } catch {
    // The tracker is the only consumer that has to exist for gating to work,
    // and it is concatenated ahead of this file. If it somehow is not there,
    // the banner still renders and still records.
  }
};

/**
 * Post the decision.
 *
 * Six one-letter keys, because that is what the route reads: anything else is
 * ignored, and a body shaped like the cookie would record grants of `{}` —
 * a `denied` — silently, at 202. `sendBeacon` with a `text/plain` body keeps
 * the request simple, which is why the route accepts that content type.
 */
const postDecision = (boot: BootConfig, d: Decision, source: string): void => {
  const body = JSON.stringify({
    s: boot.cfg.site,
    u: d.id,
    h: boot.hash,
    g: d.g,
    l: boot.cfg.locale || "",
    src: source,
  });
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([body], { type: "text/plain;charset=UTF-8" });
      if (navigator.sendBeacon(boot.endpoint, blob)) return;
    }
  } catch {
    /* fall through to fetch */
  }
  try {
    void fetch(boot.endpoint, {
      method: "POST",
      body,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      keepalive: true,
      mode: "cors",
      credentials: "omit",
    }).catch(() => {});
  } catch {
    /* a dropped record must not throw on someone's site */
  }
};

export const boot = (boot0: unknown): void => {
  const boot1 = boot0 as BootConfig | null;
  if (!boot1 || !boot1.cfg || boot1.cfg.enabled === false) return;
  // One banner per page, whichever snippet started it — the same reasoning as
  // the tracker's own boot guard, and the same failure without it (two
  // overlays, two records for one decision).
  if (w.__backlexConsentBannerBooted) return;
  w.__backlexConsentBannerBooted = 1;

  const cfg = boot1.cfg;
  const categories = Array.isArray(cfg.categories) ? cfg.categories.slice() : [];
  const cookieDays = Number(cfg.cookieDays) || 180;

  const prior = readDecision();
  // A decision made against a DIFFERENT version of the policy is evidence of
  // what they were shown then, not consent to what is offered now. Honour it
  // for this page load so nothing fires that they refused, but ask again.
  const stale = !!prior && prior.v !== boot1.hash;

  if (prior) {
    applyGrants(prior.g);
    if (!stale) return;
  } else {
    // Nobody has answered. This is the line prior blocking rests on, and it
    // runs before the container is started.
    applyGrants(uniform(categories, cfg.undecided === "allow"));
  }

  const strings = resolveStrings(cfg.wording, cfg.locale);
  const id = prior?.id || mintSubjectId();

  let banner: { destroy: () => void } | null = null;

  const decide = (grants: Record<string, boolean>, source: string): void => {
    const d: Decision = { id, g: grants, v: boot1.hash, t: Date.now() };
    applyGrants(grants);
    writeDecision(d, cookieDays);
    postDecision(boot1, d, source);
    banner?.destroy();
    banner = null;
  };

  const open = (): void => {
    if (banner) return;
    banner = mount({
      strings,
      categories,
      grants: prior?.g || uniform(categories, cfg.undecided === "allow"),
      position: String(cfg.position || "bottom"),
      theme: cfg.theme || {},
      policyUrl: cfg.policyUrl || null,
      onAcceptAll: () => decide(uniform(categories, true), "banner"),
      onRejectAll: () => decide(uniform(categories, false), "banner"),
      onSave: (g) => decide(g, "preferences"),
    });
  };

  // A handle the operator can wire to their own "Cookie settings" link, which
  // is what makes withdrawal as easy as granting.
  w.__backlexConsent = { open, decision: readDecision };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", open);
  } else {
    open();
  }
};

// Self-registering, so the generated bundle needs no wrapper to expose an
// entry point. The per-site file calls this by name immediately after it
// starts the tracker and immediately BEFORE it starts the container.
w.__backlexConsentBanner = boot;
