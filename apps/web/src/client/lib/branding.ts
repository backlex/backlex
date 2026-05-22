import { useSyncExternalStore } from "react";
import { api } from "./api";

/**
 * Resolved workspace branding — the public view from `GET /api/workspace-config`
 * (the workspace's own row layered onto `_global`). `logoUrl` / `faviconUrl`
 * already carry the cache-busting `?v=<updatedAt>` token, so a re-upload yields
 * a new URL and the browser refetches.
 */
export interface WorkspaceBranding {
  workspaceName: string | null;
  description: string | null;
  logoUrl: string | null;
  faviconUrl: string | null;
  primaryColor: string | null;
  defaultTheme: "light" | "dark" | "system" | null;
}

let current: WorkspaceBranding | null = null;
let loaded = false;
let initialKicked = false;
const listeners = new Set<() => void>();

const emit = (): void => {
  for (const l of listeners) l();
};

/**
 * Seed the store from a fetch the caller already did (the boot-time branding
 * fetch in `main.tsx`) so the first `useWorkspaceBranding()` read needs no
 * extra round-trip.
 */
export const primeBranding = (b: WorkspaceBranding | null): void => {
  current = b;
  loaded = true;
  initialKicked = true;
  emit();
};

const fetchBranding = async (): Promise<WorkspaceBranding | null> => {
  try {
    const r = await api<{ data: WorkspaceBranding }>("/api/workspace-config");
    return r.data ?? null;
  } catch {
    // The login screen and other unauthenticated surfaces degrade to the
    // bundled fallback (initial letter) when this fails — never throw.
    return null;
  }
};

const loadInto = async (): Promise<void> => {
  current = await fetchBranding();
  loaded = true;
  emit();
};

/**
 * Re-pull the resolved branding and notify every subscriber. Call this after
 * the Appearance form saves so the sidebar logo/name update live, no reload.
 */
export const refreshBranding = async (): Promise<void> => {
  await loadInto();
};

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb);
  // First subscriber triggers the initial load; the guard keeps N components
  // mounting on one screen from fanning out N duplicate requests.
  if (!loaded && !initialKicked) {
    initialKicked = true;
    void loadInto();
  }
  return () => {
    listeners.delete(cb);
  };
};

const getSnapshot = (): WorkspaceBranding | null => current;

/**
 * Subscribe a component to the resolved workspace branding. Returns `null`
 * until the first fetch (or `primeBranding`) resolves.
 */
export const useWorkspaceBranding = (): WorkspaceBranding | null =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
