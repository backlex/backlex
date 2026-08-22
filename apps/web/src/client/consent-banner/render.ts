/**
 * The banner's DOM, built on a page backlex does not own.
 *
 * ── `textContent`, everywhere, and why it is a constraint rather than taste ─
 * `services/consent.ts` stores operator wording UNESCAPED, deliberately:
 * "Escaping at this boundary would mean storing `&amp;` in what a lawyer
 * reviews, so the obligation lands on the banner instead." Every operator
 * string in this file is therefore assigned with `textContent`, and
 * `consent-surfaces.test.ts` fails if the markup-parsing sink appears anywhere
 * in this directory — by NAME, as a substring, which is why this paragraph
 * does not spell it. A scan cannot tell a comment from a call, and that
 * bluntness is the feature: there is no wording that argues its way past it.
 * The test was written and armed BEFORE this directory existed.
 *
 * ── Shadow DOM, and what it does and does not buy ─────────────────────────
 * Two-way isolation: the customer's CSS cannot reach in and break the banner,
 * and the banner's CSS cannot leak out and restyle their page. It is also what
 * lets this be one element on one document — the repo's other five foreign-page
 * surfaces all use an iframe, and every one of them pays for it with a
 * postMessage/resize dance to size itself. A banner cannot take that trade: it
 * has to overlay the page, and an iframe that must size to its own content
 * needs exactly that dance.
 *
 * What it does NOT buy is escape from the host page's Content-Security-Policy.
 * `style-src` still governs a `<style>` inside a shadow root, so a customer
 * running a strict nonce-based CSP can block the banner's stylesheet while the
 * markup renders unstyled. That is a real failure mode no existing embed has,
 * and it is why `mount` reads a nonce when one is available.
 *
 * The fallback when `attachShadow` is missing is a namespaced plain element —
 * degraded isolation, but a banner that renders beats one that does not.
 */
import type { Strings } from "./strings";

export interface RenderOptions {
  strings: Strings;
  /** Optional categories the policy actually offers, in display order. */
  categories: string[];
  /** Current grant state shown in the manage view. */
  grants: Record<string, boolean>;
  position: string;
  theme: Record<string, string>;
  policyUrl: string | null;
  /** The opaque id the visitor quotes to ask for their record to be erased.
   *  Shown, because `docs/erasure.md` can reach an anonymous visitor's consent
   *  record by this and nothing else. */
  subjectId: string;
  /** Whether a decision is already on file. Drives BOTH the close control and
   *  the withdraw control: leaving without choosing, and revoking a choice,
   *  are only meaningful once a choice exists. An undecided visitor gets
   *  neither — and pays nothing for it, because Reject all is one click. */
  decided: boolean;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onSave: (grants: Record<string, boolean>) => void;
  onWithdraw: () => void;
  onClose: () => void;
}

export interface Banner {
  destroy: () => void;
}

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
};

/** The nonce the host page's CSP may require, if this script can see one.
 *  `document.currentScript` is null for a dynamically injected script, which is
 *  the shape the tag-manager snippet takes, so this is best-effort. */
const readNonce = (): string => {
  try {
    const s = document.currentScript as HTMLScriptElement | null;
    return (s && (s.nonce || s.getAttribute("nonce"))) || "";
  } catch {
    return "";
  }
};

/**
 * ── Comments in here SHIP ─────────────────────────────────────────────────
 * This is a template literal, so `Bun.build({ minify: true })` treats it as an
 * opaque string: a `/* *\/` comment inside it survives into the bundle and is
 * downloaded by every visitor of every site. Explanations belong out here,
 * where minification strips them. Two of them, both load-bearing:
 *
 * **`[hidden]`.** The UA sheet's `[hidden] { display: none }` is USER-AGENT
 * origin, so any author `display` beats it — and `.blx-cats` sets
 * `display: grid`. The result was a manage panel that was never actually
 * hidden: every visitor saw the category checkboxes on first paint while
 * `cats.hidden = true` said otherwise, and Manage only swapped itself for Save.
 * Found by measuring rects in a real engine; happy-dom reports no layout, so no
 * unit test could have seen it.
 *
 * **`.blx-scroll`.** The root is deliberately NOT the scroller. It was, and
 * that put the absolutely-positioned close control inside the scrolling box, so
 * on a short viewport it scrolled out of view and left a reopened banner whose
 * only exit was Escape.
 */
const CSS = `
:host { all: initial; }
[hidden] { display: none !important; }
.blx-root {
  position: fixed; z-index: 2147483647;
  left: 16px; right: 16px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.5;
  color: var(--blx-fg); background: var(--blx-bg);
  border: 1px solid var(--blx-border); border-radius: var(--blx-radius);
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
  padding: 16px; box-sizing: border-box;
  max-height: calc(100vh - 32px); overflow: hidden;
}
.blx-scroll { max-height: calc(100vh - 64px); overflow-y: auto; }
.blx-bottom { bottom: 16px; }
.blx-top { top: 16px; }
.blx-corner { bottom: 16px; left: auto; max-width: 380px; }
@media (min-width: 640px) { .blx-bottom, .blx-top { left: 50%; right: auto; transform: translateX(-50%); width: 640px; max-width: calc(100vw - 32px); } }
.blx-title { font-weight: 600; font-size: 15px; margin: 0 0 6px; }
.blx-body { margin: 0 0 12px; }
.blx-link { color: var(--blx-accent); text-decoration: underline; }
.blx-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.blx-btn {
  appearance: none; cursor: pointer; font: inherit;
  padding: 8px 14px; border-radius: var(--blx-radius);
  border: 1px solid var(--blx-border); background: transparent; color: inherit;
  flex: 1 1 auto; min-width: 120px;
}
.blx-btn:focus-visible { outline: 2px solid var(--blx-accent); outline-offset: 2px; }
.blx-primary { background: var(--blx-accent); color: var(--blx-accent-fg); border-color: var(--blx-accent); }
.blx-cats { margin: 4px 0 12px; display: grid; gap: 10px; }
.blx-cat { display: flex; gap: 10px; align-items: flex-start; }
.blx-cat input { margin: 2px 0 0; }
.blx-cat-label { font-weight: 600; display: block; }
.blx-cat-body { opacity: .8; }
.blx-cat input:disabled { opacity: .6; }
.blx-close {
  position: absolute; top: 8px; right: 8px;
  appearance: none; background: transparent; border: 0; color: inherit;
  font: inherit; font-size: 18px; line-height: 1; cursor: pointer;
  padding: 6px 8px; border-radius: var(--blx-radius); opacity: .6;
}
.blx-close:hover { opacity: 1; }
.blx-close:focus-visible { outline: 2px solid var(--blx-accent); outline-offset: 2px; }
.blx-has-close .blx-title { padding-right: 32px; }
.blx-id { margin: 0 0 10px; font-size: 12px; opacity: .8; }
.blx-id-value {
  display: block; margin-top: 2px; word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  -webkit-user-select: all; user-select: all;
}
.blx-withdraw { margin: 0 0 12px; }
.blx-linkish {
  appearance: none; background: transparent; border: 0; padding: 0;
  font: inherit; font-size: 12px; color: inherit; opacity: .8;
  text-decoration: underline; cursor: pointer;
}
.blx-linkish:hover { opacity: 1; }
.blx-linkish:focus-visible { outline: 2px solid var(--blx-accent); outline-offset: 2px; }
@media (max-width: 400px) { .blx-btn { flex: 1 1 100%; } }
`;

const THEME_VARS: Record<string, string> = {
  background: "--blx-bg",
  foreground: "--blx-fg",
  accent: "--blx-accent",
  accentForeground: "--blx-accent-fg",
  border: "--blx-border",
  radius: "--blx-radius",
};

const DEFAULT_THEME: Record<string, string> = {
  background: "#ffffff",
  foreground: "#18181b",
  accent: "#4f46e5",
  accentForeground: "#ffffff",
  border: "#e4e4e7",
  radius: "10px",
};

/** Theme values are operator-supplied and land in a CSS custom property, so a
 *  value carrying `;` or `}` could close the declaration and inject rules.
 *  Restricted to the shapes a colour or a length actually takes. */
const SAFE_TOKEN = /^[#a-zA-Z0-9 ,.()%-]{1,64}$/;

export const mount = (o: RenderOptions): Banner => {
  const host = el("div");
  host.setAttribute("data-backlex-consent", "");
  // The host itself is inert: everything visible lives inside the root below,
  // so a customer stylesheet targeting `div` cannot move the overlay.
  host.style.cssText = "all:initial";

  let target: HTMLElement | ShadowRoot;
  try {
    target = host.attachShadow({ mode: "open" });
  } catch {
    // No shadow DOM. Isolation is now one-way at best — accept it rather than
    // showing nothing, since a missing banner is the worse compliance outcome.
    target = host;
  }

  const style = el("style");
  const nonce = readNonce();
  if (nonce) style.setAttribute("nonce", nonce);
  const theme = { ...DEFAULT_THEME };
  for (const k of Object.keys(o.theme || {})) {
    const v = o.theme[k];
    if (typeof v === "string" && SAFE_TOKEN.test(v) && THEME_VARS[k]) theme[k] = v;
  }
  let vars = "";
  for (const k of Object.keys(THEME_VARS)) vars += `${THEME_VARS[k]}:${theme[k]};`;
  style.textContent = `:host,.blx-root{${vars}}${CSS}`;
  target.appendChild(style);

  const pos = o.position === "top" ? "blx-top" : o.position === "corner" ? "blx-corner" : "blx-bottom";
  const root = el("div", `blx-root ${pos}${o.decided ? " blx-has-close" : ""}`);
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-label", o.strings.title || "Cookies");

  const content = el("div", "blx-scroll");

  const title = el("p", "blx-title");
  title.textContent = o.strings.title || "";
  content.appendChild(title);

  const body = el("p", "blx-body");
  body.textContent = o.strings.body || "";
  if (o.policyUrl) {
    body.appendChild(document.createTextNode(" "));
    const a = el("a", "blx-link");
    // `href` is operator-supplied. `services/consent.ts` validates it as a URL
    // on save, but this is the point where a `javascript:` value would execute,
    // so it is checked again here rather than trusted across a boundary.
    const href = String(o.policyUrl);
    if (/^https?:\/\//i.test(href)) {
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = o.strings.policyLink || href;
      body.appendChild(a);
    }
  }
  content.appendChild(body);

  const actions = el("div", "blx-actions");
  const mk = (label: string, cls: string, fn: () => void): HTMLButtonElement => {
    const b = el("button", `blx-btn ${cls}`);
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  };

  const inputs: Record<string, HTMLInputElement> = {};
  const cats = el("div", "blx-cats");
  cats.hidden = true;

  // `necessaryLabel` / `necessaryBody` have been in `WORDING_KEYS` since the
  // policy shipped, and nothing rendered them: "necessary" is not one of
  // `OPTIONAL_CATEGORIES`, so it never appears in `o.categories`. An operator
  // could write that text, have it reviewed, and no visitor would ever see it.
  // It is drawn here as a checked, disabled row — the standard shape, and the
  // honest one, because the site does set those cookies whatever the visitor
  // says. It carries no entry in `inputs`, so it can never reach `onSave`.
  const nec = el("label", "blx-cat");
  const necInput = el("input");
  necInput.type = "checkbox";
  necInput.checked = true;
  necInput.disabled = true;
  nec.appendChild(necInput);
  const necText = el("div");
  const necLabel = el("span", "blx-cat-label");
  necLabel.textContent = o.strings.necessaryLabel || "";
  const necBody = el("span", "blx-cat-body");
  necBody.textContent = o.strings.necessaryBody || "";
  necText.appendChild(necLabel);
  necText.appendChild(necBody);
  nec.appendChild(necText);
  cats.appendChild(nec);

  for (const cat of o.categories) {
    const row = el("label", "blx-cat");
    const input = el("input");
    input.type = "checkbox";
    input.checked = o.grants[cat] === true;
    inputs[cat] = input;
    row.appendChild(input);
    const text = el("div");
    const label = el("span", "blx-cat-label");
    label.textContent = o.strings[`${cat}Label`] || cat;
    const desc = el("span", "blx-cat-body");
    desc.textContent = o.strings[`${cat}Body`] || "";
    text.appendChild(label);
    text.appendChild(desc);
    row.appendChild(text);
    cats.appendChild(row);
  }
  // The id, and the withdrawal, live INSIDE the manage panel: both are answers
  // to "I already decided", and putting them on the first layer would compete
  // with the decision itself — which is the one thing that layer is for.
  const idBlock = el("p", "blx-id");
  const idLabel = el("span");
  idLabel.textContent = o.strings.idLabel || "";
  const idValue = el("code", "blx-id-value");
  idValue.textContent = o.subjectId;
  idBlock.appendChild(idLabel);
  idBlock.appendChild(idValue);
  cats.appendChild(idBlock);

  if (o.decided) {
    const wrap = el("p", "blx-withdraw");
    const btn = el("button", "blx-linkish");
    btn.type = "button";
    btn.textContent = o.strings.withdraw || "";
    btn.addEventListener("click", o.onWithdraw);
    wrap.appendChild(btn);
    cats.appendChild(wrap);
  }

  content.appendChild(cats);

  const saveBtn = mk(o.strings.save || "Save", "blx-primary", () => {
    const next: Record<string, boolean> = {};
    for (const cat of o.categories) next[cat] = inputs[cat]?.checked === true;
    o.onSave(next);
  });
  saveBtn.hidden = true;

  const manageBtn = mk(o.strings.manage || "Manage", "", () => {
    cats.hidden = false;
    manageBtn.hidden = true;
    saveBtn.hidden = false;
  });

  actions.appendChild(mk(o.strings.rejectAll || "Reject all", "", o.onRejectAll));
  if (o.categories.length > 0) actions.appendChild(manageBtn);
  actions.appendChild(saveBtn);
  actions.appendChild(mk(o.strings.acceptAll || "Accept all", "blx-primary", o.onAcceptAll));
  content.appendChild(actions);
  root.appendChild(content);

  // Last in the DOM, and therefore last in tab order: a dialog whose first
  // focusable control is "dismiss" invites dismissal. It is drawn top-right by
  // CSS, and Escape below covers the keyboard case without the tab walk.
  let onKey: ((e: KeyboardEvent) => void) | null = null;
  if (o.decided) {
    const close = el("button", "blx-close");
    close.type = "button";
    close.setAttribute("aria-label", o.strings.close || "Close");
    // Not the operator's text: a multiplication sign, so the accessible name
    // above is what carries the meaning and this carries the shape.
    close.textContent = "\u00d7";
    close.addEventListener("click", o.onClose);
    root.appendChild(close);

    onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" || e.key === "Esc") o.onClose();
    };
    document.addEventListener("keydown", onKey);
  }

  target.appendChild(root);
  (document.body || document.documentElement).appendChild(host);

  return {
    destroy: () => {
      try {
        if (onKey) document.removeEventListener("keydown", onKey);
      } catch {
        /* nothing to unbind */
      }
      try {
        host.parentNode?.removeChild(host);
      } catch {
        /* already gone */
      }
    },
  };
};
