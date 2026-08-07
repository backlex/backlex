// Shared helpers used across multiple admin pages.
//
// This is the one such module. It used to be two — `pages/_shared.ts` and
// `parity/_shared.ts` — because the pages themselves were split across two
// folders by the order they were written rather than by what they do. The
// folders are gone; so is the second copy.
import { api } from "@/lib/api";

/** Best-effort GET — returns the parsed body or `null` when offline/unauth. */
export const fetchSafely = async <T,>(path: string): Promise<T | null> => {
  try {
    return await api<T>(path);
  } catch {
    return null;
  }
};

/** Origin the API is served from — same-origin on CF deploys; falls back to
 *  VITE_API_URL for cross-origin dev setups. */
export const apiOrigin = (): string => {
  const v = (import.meta.env.VITE_API_URL as string | undefined)?.trim();
  if (v) return v.replace(/\/+$/, "");
  return typeof window !== "undefined" ? window.location.origin : "";
};

export const copyText = async (text: string, ok: () => void): Promise<void> => {
  try {
    await navigator.clipboard.writeText(text);
    ok();
  } catch {
    /* clipboard blocked — no-op */
  }
};

export const I18N_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export const fmtRelative = (iso: string | null): string => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};
