// @ts-nocheck
// Shared helpers used across multiple admin pages
import { api } from "@/lib/api";

/** Best-effort GET — returns the parsed body or `null` when offline/unauth. */
export const fetchSafely = async <T,>(path: string): Promise<T | null> => {
  try {
    return await api<T>(path);
  } catch {
    return null;
  }
};
