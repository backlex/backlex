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
import {
  clearDecision,
  mintSubjectId,
  readDecision,
  writeDecision,
  type Decision,
} from "./cookie";
import { pickLocale, resolveStrings } from "./strings";
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
  /** Exported by the tracker: do GPC / Do Not Track amount to a refusal of
   *  every optional category on this site? Only ever true when the site chose
   *  `signalHandling: "all"`. */
  __backlexSignalsRefuseAll?: () => boolean;
  __backlexConsentBanner?: (c: unknown) => void;
  __backlexConsentBannerBooted?: number;
  __backlexConsentOpenerArmed?: number;
  __backlexConsent?: {
    open: () => void;
    close: () => void;
    withdraw: () => void;
    decision: () => Decision | null;
  };
};

const w = globalThis as W;

/**
 * The posture for a visitor who has not answered.
 *
 * `undecided` is the operator's guess, and a browser signal outranks a guess:
 * a visitor sending Global Privacy Control on a site that chose
 * `signalHandling: "all"` is refusing, and `allow` must not fire tags at them.
 *
 * It does NOT outrank a real decision — that path never reaches here. The
 * distinction is the whole reason this lives in the banner: the tracker is
 * handed a flat grant map and cannot tell a guess from an answer.
 */
const undecidedPosture = (categories: string[], allow: boolean): Record<string, boolean> => {
  let refuse = false;
  try {
    refuse = w.__backlexSignalsRefuseAll?.() === true;
  } catch {
    // The tracker is concatenated ahead of this file, but a page that broke it
    // must not take the banner down with it.
  }
  return uniform(categories, allow && !refuse);
};

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
const postDecision = (
  boot: BootConfig,
  d: Decision,
  source: string,
  locale: string,
): void => {
  const body = JSON.stringify({
    s: boot.cfg.site,
    u: d.id,
    h: boot.hash,
    g: d.g,
    // The locale actually RENDERED, not the policy's default. A record naming a
    // language the visitor never saw is evidence about the wrong text.
    l: locale,
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

/**
 * Withdraw: erase the record, not just stop honouring it.
 *
 * `DELETE /api/consent/record` has existed since the records phase, and its own
 * docblock says it is "the ONLY erasure path that can reach an anonymous
 * visitor" — with, until now, no caller anywhere. `sendBeacon` cannot send it:
 * a method outside the safelisted set always preflights, which is why the route
 * grew an `.options()` handler the POST does not need.
 */
const forget = (boot: BootConfig, subjectId: string): void => {
  const url =
    boot.endpoint +
    "?s=" +
    encodeURIComponent(boot.cfg.site) +
    "&u=" +
    encodeURIComponent(subjectId);
  try {
    void fetch(url, {
      method: "DELETE",
      keepalive: true,
      mode: "cors",
      credentials: "omit",
    }).catch(() => {});
  } catch {
    // The cookie is already gone either way, so the visitor's browser has
    // forgotten regardless. A failed DELETE loses the server's copy, not their
    // withdrawal.
  }
};

/** An element an operator can mark up instead of writing JavaScript.
 *  NOT `data-backlex-consent` — `render.ts` puts that one on the banner's own
 *  host element, and a delegated handler matching it would reopen the banner
 *  on every click inside it. */
const OPENER_ATTR = "data-backlex-consent-open";

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

  // What the manage view shows, and it MOVES. Reading `prior` at render time
  // was wrong once already: a visitor who accepted, then reopened to switch
  // marketing off, was shown the boxes as they stood BEFORE they accepted.
  let current = prior
    ? { ...prior.g }
    : undecidedPosture(categories, cfg.undecided === "allow");
  let subjectId = prior?.id || mintSubjectId();

  // The line prior blocking rests on, and it runs before the container starts.
  applyGrants(current);

  // The locale a visitor is actually shown, which is not necessarily the one the
  // policy defaults to. It only ever resolves to a block the operator wrote —
  // see `pickLocale` — so the multi-locale payload the artifact has always
  // carried finally has a consumer, and a visitor asking for a language nobody
  // authored still gets the operator's default rather than our built-ins.
  //
  // Used for BOTH what is rendered and what is recorded, because those two must
  // not be allowed to disagree.
  let shownLocale = String(cfg.locale || "en");
  try {
    shownLocale = pickLocale(cfg.wording, shownLocale, navigator.languages);
  } catch {
    // A page can define a hostile `navigator`. The policy default is still a
    // correct answer, just not the best available one.
  }
  const strings = resolveStrings(cfg.wording, shownLocale);
  let banner: { destroy: () => void } | null = null;

  const close = (): void => {
    banner?.destroy();
    banner = null;
  };

  const decide = (grants: Record<string, boolean>, source: string): void => {
    const d: Decision = { id: subjectId, g: grants, v: boot1.hash, t: Date.now() };
    current = grants;
    applyGrants(grants);
    writeDecision(d, cookieDays);
    postDecision(boot1, d, source, shownLocale);
    close();
  };

  /**
   * Withdrawal, which GDPR Art. 7(3) requires to be as easy as granting.
   *
   * Three things, in an order that survives any one of them failing: deny
   * everything locally so nothing keeps running while the network settles,
   * drop the cookie, then ask the server to erase the record. The id is
   * re-minted afterwards, so a decision they make later cannot be joined to
   * the record they just had deleted — keeping it would make "erased" mean
   * "erased until you press a button".
   */
  const withdraw = (): void => {
    const erased = subjectId;
    current = uniform(categories, false);
    applyGrants(current);
    clearDecision();
    forget(boot1, erased);
    subjectId = mintSubjectId();
    close();
  };

  const open = (): void => {
    if (banner) return;
    banner = mount({
      strings,
      categories,
      grants: current,
      position: String(cfg.position || "bottom"),
      theme: cfg.theme || {},
      policyUrl: cfg.policyUrl || null,
      subjectId,
      // Asked at MOUNT, not captured at boot: withdrawing clears the cookie, so
      // the next open must offer neither a close nor a withdraw.
      decided: readDecision() !== null,
      onAcceptAll: () => decide(uniform(categories, true), "banner"),
      onRejectAll: () => decide(uniform(categories, false), "banner"),
      onSave: (g) => decide(g, "preferences"),
      onWithdraw: withdraw,
      onClose: close,
    });
  };

  // The handle an operator wires to their own "Cookie settings" control, which
  // is what makes withdrawal as easy as granting.
  //
  // Installed BEFORE the early return below, and that ordering is the whole
  // point. It used to sit after it, so the one visitor who needs it — the one
  // who already decided — was the one visitor for whom it was `undefined`, and
  // `docs/cookie-consent.md` told operators to wire a footer link to it.
  w.__backlexConsent = { open, close, withdraw, decision: readDecision };

  // …and a version for operators who cannot add script to their pages at all,
  // which on a hosted CMS is most of them. One attribute on a footer link.
  // Capture phase, so a page that stops propagation on its own handlers does
  // not silently take the control away.
  if (!w.__backlexConsentOpenerArmed) {
    w.__backlexConsentOpenerArmed = 1;
    try {
      document.addEventListener(
        "click",
        (e) => {
          try {
            const t = e.target as HTMLElement | null;
            if (!t || !t.closest) return;
            if (!t.closest("[" + OPENER_ATTR + "]")) return;
            e.preventDefault();
            // Through the HANDLE, not this closure's `open`. A listener cannot
            // be unbound without the reference that made it, so one that
            // captured a superseded boot would keep mounting that boot's
            // banner forever.
            w.__backlexConsent?.open();
          } catch {
            // Never throw out of a click handler on somebody else's page.
          }
        },
        true,
      );
    } catch {
      /* no delegation, but `__backlexConsent.open()` still works */
    }
  }

  // Decided, against the policy they are being served: nothing to ask.
  if (prior && !stale) return;

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
