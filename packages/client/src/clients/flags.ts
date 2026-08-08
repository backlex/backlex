import type { FlagState } from "../types";
import type { ClientCore } from "../core";

/** Feature flags / remote config evaluated for the current caller. See `createClient`. */
export interface FlagsClient {
  /** Fetch + cache the evaluated flag map. */
  all(): Promise<Record<string, FlagState>>;
  /** Resolved value (remote config payload) for a flag, or `undefined`. */
  get(key: string, opts?: { refresh?: boolean }): Promise<unknown>;
  /** Whether a flag is on for the caller. */
  isEnabled(key: string, opts?: { refresh?: boolean }): Promise<boolean>;
}

export const makeFlags = (core: ClientCore): FlagsClient => {
  // Feature flags / remote config, evaluated for the current caller (targeting
  // rules + rollout already applied server-side).
  let flagsCache: Record<string, FlagState> | null = null;
  const fetchFlags = async (): Promise<Record<string, FlagState>> => {
    const res = await core.request<{ data: Record<string, FlagState> }>("GET", "/api/flags");
    flagsCache = res.data ?? {};
    return flagsCache;
  };
  const flags: FlagsClient = {
    /** Fetch + cache the evaluated flag map. */
    all: (): Promise<Record<string, FlagState>> => fetchFlags(),
    /** Resolved value for a flag (remote config payload), or `undefined`. Uses
     *  the cache if `all()` was already called this session; pass
     *  `{ refresh: true }` to force a re-fetch. */
    get: async (key: string, opts?: { refresh?: boolean }): Promise<unknown> => {
      const map = opts?.refresh || !flagsCache ? await fetchFlags() : flagsCache;
      return map[key]?.value;
    },
    /** Whether a flag is on for the caller. */
    isEnabled: async (key: string, opts?: { refresh?: boolean }): Promise<boolean> => {
      const map = opts?.refresh || !flagsCache ? await fetchFlags() : flagsCache;
      return Boolean(map[key]?.enabled);
    },
  };

  return flags;
};

