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
