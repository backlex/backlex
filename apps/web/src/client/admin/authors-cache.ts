// Module-level cache for the workspace's real users, used by ItemsTable's
// author column and the ItemSheet author Select. Loaded once on mount via
// `loadAuthors()` from the admin app shell; consumers read synchronously.
//
// The shape mirrors the legacy MOCK.POST_AUTHORS interface so the existing
// callers don't need to know whether the data is real or mocked.

export interface AuthorEntry {
  id: string;
  name: string;
  initials: string;
}

let CACHE: AuthorEntry[] = [];
const subscribers = new Set<() => void>();

export const getAuthors = (): AuthorEntry[] => CACHE;

export const setAuthors = (next: AuthorEntry[]): void => {
  CACHE = next;
  for (const fn of subscribers) fn();
};

export const subscribeAuthors = (fn: () => void): (() => void) => {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
};

const initialsFor = (input: string): string => {
  const cleaned = input.split(/[\s._@-]+/).filter(Boolean);
  if (cleaned.length === 0) return "??";
  if (cleaned.length === 1) return (cleaned[0] ?? "??").slice(0, 2).toUpperCase();
  return ((cleaned[0]?.[0] ?? "") + (cleaned[1]?.[0] ?? "")).toUpperCase() || "??";
};

/**
 * Fetch the workspace users and populate the cache. Soft-fails on auth or
 * network errors — the design's previous behaviour was to fall back to a
 * hardcoded 5-person list, but we'd rather show "—" than fake names.
 */
export const loadAuthors = async (): Promise<void> => {
  try {
    const res = await fetch("/api/admin/users", { credentials: "include" });
    if (!res.ok) return;
    const json = (await res.json()) as { data?: Array<{ id: string; name?: string | null; email?: string | null }> };
    const users = json.data ?? [];
    setAuthors(
      users.map((u) => {
        const display = u.name?.trim() || u.email?.split("@")[0] || u.id;
        return { id: u.id, name: display, initials: initialsFor(display) };
      }),
    );
  } catch {
    // keep cache as-is
  }
};
