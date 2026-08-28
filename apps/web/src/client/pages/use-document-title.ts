import { useEffect } from "react";

/**
 * Name the tab after the thing on the page.
 *
 * Every page backlex hands a customer's own visitors — a form, a booking page,
 * a dashboard embed — is served by the admin SPA, so it inherited
 * `index.html`'s `<title>`: **"Backlex Admin"**. On a workspace with no
 * branding set, which is the default, a prospect filling in a dealer
 * application saw the vendor's product name in their tab, in the bookmark they
 * made, and in the preview of the link they shared. Measured on a live tenant
 * on 2026-08-27.
 *
 * Boot-time branding (`main.tsx::applyBranding`) is not a substitute for two
 * reasons: it only fires when the workspace HAS a name, and even then the
 * workspace name is the wrong title for a page about one specific form.
 *
 * Restores the previous title on unmount so a visitor navigating from a public
 * page into the admin does not keep the form's name in the tab.
 */
export const useDocumentTitle = (title: string | null | undefined): void => {
  useEffect(() => {
    const trimmed = title?.trim();
    if (!trimmed) return;
    const previous = document.title;
    document.title = trimmed;
    return () => {
      document.title = previous;
    };
  }, [title]);
};

/**
 * Say what language the page is in.
 *
 * `index.html` ships `lang="en"`, and the public pages are routes of the same
 * SPA — so a booking page rendering entirely in Turkish still declared itself
 * English. Measured on a live tenant 2026-08-27. That is what a screen reader
 * picks its voice and pronunciation rules from, what a browser uses to decide
 * whether to offer a translation, and what hyphenation follows.
 *
 * Takes the ACTIVE Lingui locale rather than a preference or a header, because
 * that is the one that decided the words actually on the screen.
 */
export const useDocumentLang = (locale: string | null | undefined): void => {
  useEffect(() => {
    const tag = locale?.trim();
    if (!tag) return;
    const el = document.documentElement;
    const previous = el.lang;
    el.lang = tag;
    return () => {
      el.lang = previous;
    };
  }, [locale]);
};
