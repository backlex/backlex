import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@workeros/ui/components/tooltip";
import "@workeros/ui/globals.css";
import { App } from "./App";
import { bootAdminLocale } from "@/admin/i18n";
import { ThemeProvider } from "@/components/theme-provider";

/**
 * Single QueryClient shared across the admin app. Reasonable defaults for an
 * always-online admin SPA:
 *   - staleTime 30s — same row often refetched as the user navigates pages;
 *     within a 30s window we serve from cache without hitting the API again
 *   - gcTime 5min — keep observable data resident a bit after components
 *     unmount so back-navigation feels instant
 *   - retry once on network errors; the API itself returns AppError statuses
 *     synchronously so retrying 4xx is wasted load
 *   - refetchOnWindowFocus off — admin pages are long-lived; constant tab
 *     refocus refetches were the most-complained-about UX wart in earlier
 *     React Query rollouts
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

type ResolvedBranding = {
  workspaceName: string | null;
  description: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  defaultTheme: "light" | "dark" | "system" | null;
};

/** Same whitelist as the server's `isValidColor`, applied client-side too —
 *  the value lands inside a `<style>` tag's text content and must not be able
 *  to break out (defence in depth against a tampered API response). */
const isSafeColor = (v: string): boolean => {
  const s = v.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(s)) {
    return s.length === 4 || s.length === 5 || s.length === 7 || s.length === 9;
  }
  return /^(rgb|hsl|oklch|oklab)a?\(\s*[\d\s%.,/-]+\s*\)$/i.test(s);
};

const applyBranding = (b: ResolvedBranding): void => {
  if (b.workspaceName) {
    document.title = b.workspaceName;
  }
  if (b.faviconUrl) {
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = b.faviconUrl;
  }
  applyPrimaryColor(b.primaryColor);
};

/**
 * Live-apply (or clear) the `--primary` workspace override without a reload.
 * Called both on boot (via `applyBranding`) and after the Appearance form
 * persists a new value so the swatch cascade visible immediately.
 */
export const applyPrimaryColor = (value: string | null): void => {
  const el = document.getElementById("workspace-tokens") as HTMLStyleElement | null;
  if (value && isSafeColor(value)) {
    const style = el ?? (() => {
      const s = document.createElement("style");
      s.id = "workspace-tokens";
      document.head.appendChild(s);
      return s;
    })();
    style.textContent = `:root{--primary:${value}}.dark{--primary:${value}}`;
  } else if (el) {
    el.remove();
  }
};

/**
 * Fetch the workspace's resolved branding before the app mounts so the
 * `--primary` override and the user's workspace default theme are applied
 * to the very first paint. Capped at 600ms so a slow API doesn't block
 * the admin from loading.
 */
const loadBranding = async (): Promise<ResolvedBranding | null> => {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 600);
    const res = await fetch("/api/workspace-config", {
      credentials: "include",
      signal: controller.signal,
    });
    window.clearTimeout(timer);
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: ResolvedBranding };
    return json.data ?? null;
  } catch {
    return null;
  }
};

// Resolve branding AND the admin locale before the first render — the locale
// catalog must be active up front so the sign-in screen paints translated.
const [branding] = await Promise.all([loadBranding(), bootAdminLocale()]);
if (branding) applyBranding(branding);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme={branding?.defaultTheme ?? "system"}>
        <BrowserRouter>
          <TooltipProvider delayDuration={0}>
            <App />
          </TooltipProvider>
        </BrowserRouter>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
