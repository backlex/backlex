import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { TooltipProvider } from "@workeros/ui/components/tooltip";
import "@workeros/ui/globals.css";
import { App } from "./App";
import { ThemeProvider } from "@/components/theme-provider";

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
  if (b.primaryColor && isSafeColor(b.primaryColor)) {
    let style = document.getElementById("workspace-tokens") as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = "workspace-tokens";
      document.head.appendChild(style);
    }
    style.textContent = `:root{--primary:${b.primaryColor}}.dark{--primary:${b.primaryColor}}`;
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

const branding = await loadBranding();
if (branding) applyBranding(branding);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme={branding?.defaultTheme ?? "system"}>
      <BrowserRouter>
        <TooltipProvider delayDuration={0}>
          <App />
        </TooltipProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>,
);
