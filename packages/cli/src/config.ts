/**
 * Profile config store for the backlex CLI.
 *
 * Persists named connection profiles (url + API key + optional tenant) to
 * `~/.backlex/config.json` so `--url`/`--key` don't have to be retyped on every
 * command. The file holds secrets (`pak_…`), so it's written `0600` and the
 * containing dir `0700`. Override the location with `$BACKLEX_CONFIG`.
 *
 * Shape on disk:
 *   {
 *     "activeProfile": "prod",
 *     "profiles": {
 *       "prod":  { "url": "https://api.acme.com", "key": "pak_…", "tenant": "acme" },
 *       "local": { "url": "http://localhost:8787" }
 *     }
 *   }
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/** One named connection target. `key` is a `pak_…` API key; `tenant` scopes a
 *  cross-tenant key (slug or id) via the `X-Backlex-Tenant` header. */
export interface Profile {
  url: string;
  key?: string;
  tenant?: string;
}

export interface Config {
  /** Profile used when no `--profile` is passed. */
  activeProfile?: string;
  profiles: Record<string, Profile>;
}

/** Absolute path to the config file (`$BACKLEX_CONFIG` overrides the default). */
export const configPath = (): string =>
  process.env.BACKLEX_CONFIG ?? join(homedir(), ".backlex", "config.json");

const EMPTY: Config = { profiles: {} };

/** Read the config file, or an empty config if it doesn't exist / is corrupt. */
export const loadConfig = (): Config => {
  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { activeProfile: parsed.activeProfile, profiles: parsed.profiles ?? {} };
  } catch {
    return { ...EMPTY };
  }
};

/** Write the config file with `0600` perms (it stores API keys). */
export const saveConfig = (cfg: Config): void => {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies on create; chmod an existing file too.
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort (e.g. Windows) — the content is still written.
  }
};

/** Resolve a profile by name, or the active profile when `name` is omitted. */
export const getProfile = (
  cfg: Config,
  name?: string,
): { name: string; profile: Profile } | null => {
  const resolved = name ?? cfg.activeProfile;
  if (!resolved) return null;
  const profile = cfg.profiles[resolved];
  return profile ? { name: resolved, profile } : null;
};

/** Insert/replace a profile. The first profile added becomes the active one. */
export const setProfile = (cfg: Config, name: string, profile: Profile): Config => {
  const profiles = { ...cfg.profiles, [name]: profile };
  const activeProfile =
    cfg.activeProfile && cfg.profiles[cfg.activeProfile] ? cfg.activeProfile : name;
  return { activeProfile, profiles };
};

/** Remove a profile; clears `activeProfile` if it pointed at the removed one. */
export const removeProfile = (cfg: Config, name: string): Config => {
  const profiles = { ...cfg.profiles };
  delete profiles[name];
  const activeProfile =
    cfg.activeProfile === name ? Object.keys(profiles)[0] : cfg.activeProfile;
  return { activeProfile, profiles };
};

/** Point `activeProfile` at an existing profile. Throws if it doesn't exist. */
export const setActive = (cfg: Config, name: string): Config => {
  if (!cfg.profiles[name]) throw new Error(`no such profile: ${name}`);
  return { ...cfg, activeProfile: name };
};
