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
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onSave: (grants: Record<string, boolean>) => void;
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

const CSS = `
:host { all: initial; }
.blx-root {
  position: fixed; z-index: 2147483647;
  left: 16px; right: 16px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px; line-height: 1.5;
  color: var(--blx-fg); background: var(--blx-bg);
  border: 1px solid var(--blx-border); border-radius: var(--blx-radius);
  box-shadow: 0 8px 30px rgba(0,0,0,.18);
  padding: 16px; box-sizing: border-box;
  max-height: calc(100vh - 32px); overflow-y: auto;
}
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
  const root = el("div", `blx-root ${pos}`);
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-live", "polite");
  root.setAttribute("aria-label", o.strings.title || "Cookies");

  const title = el("p", "blx-title");
  title.textContent = o.strings.title || "";
  root.appendChild(title);

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
  root.appendChild(body);

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
  root.appendChild(cats);

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
  root.appendChild(actions);

  target.appendChild(root);
  (document.body || document.documentElement).appendChild(host);

  return {
    destroy: () => {
      try {
        host.parentNode?.removeChild(host);
      } catch {
        /* already gone */
      }
    },
  };
};
