/**
 * `backlex auth` family: login / logout / whoami / profile.
 *
 * These commands manage the saved connection profiles (see `./config`) and
 * verify a key against the live API. Identity is read from `GET /api/me`, which
 * resolves a `pak_…` key (or session) to the user + roles + active tenant — the
 * same surface the admin SPA header uses.
 */
import { BacklexError } from "backlex";
import {
  loadConfig,
  saveConfig,
  getProfile,
  setProfile,
  removeProfile,
  setActive,
} from "./config";
import {
  flag,
  has,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
  type Context,
} from "./client";

/** Identity shape returned by `GET /api/me`. */
interface Me {
  id: string;
  email: string;
  name: string | null;
  roles: string[];
  isAdmin: boolean;
  tenantId: string | null;
}

const fetchMe = (ctx: Context): Promise<Me> =>
  makeClient(ctx)
    .request<{ data: Me }>("GET", "/api/me")
    .then((r) => r.data);

/** Read all of stdin as a trimmed string (for `--key -`, pipe-friendly CI). */
const readStdin = async (): Promise<string> => {
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array | string>) {
    buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
  }
  return buf.trim();
};

/** Prompt for a secret on a TTY without echoing it. Falls back to a plain
 *  read if the stream isn't a TTY. */
const promptHidden = async (label: string): Promise<string> => {
  const stdin = process.stdin as NodeJS.ReadStream;
  process.stderr.write(label);
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    return readStdin();
  }
  stdin.setRawMode(true);
  stdin.resume();
  return await new Promise<string>((resolve) => {
    let secret = "";
    const onData = (data: Buffer) => {
      const s = data.toString("utf8");
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stderr.write("\n");
          resolve(secret);
          return;
        }
        if (code === 3) {
          // Ctrl-C
          stdin.setRawMode(false);
          process.exit(130);
        }
        if (code === 8 || code === 127) {
          // backspace / DEL
          secret = secret.slice(0, -1);
        } else {
          secret += ch;
        }
      }
    };
    stdin.on("data", onData);
  });
};

/** Resolve the API key for `login` from `--key` (value | `-` for stdin),
 *  the `BACKLEX_API_KEY` env, or an interactive hidden prompt. */
const resolveLoginKey = async (args: string[]): Promise<string> => {
  const raw = flag(args, "--key");
  if (raw === "-") return readStdin();
  if (raw) return raw;
  if (process.env.BACKLEX_API_KEY) return process.env.BACKLEX_API_KEY;
  return promptHidden("API key (pak_…): ");
};

const renderMe = (me: Me, ctx: Context, json: boolean): void => {
  if (json) {
    printJson({ ...me, url: ctx.url, profile: ctx.profileName });
    return;
  }
  printKeyValues({
    user: `${me.name ?? "(no name)"} <${me.email}>`,
    id: me.id,
    roles: me.roles.join(", ") || "(none)",
    admin: me.isAdmin ? "yes" : "no",
    tenant: me.tenantId ?? "(home)",
    url: ctx.url,
    profile: ctx.profileName ?? "(none)",
  });
};

/** `backlex login` — verify a key against `/api/me` and save it as a profile. */
export const runLogin = async (args: string[]): Promise<void> => {
  const json = has(args, "--json");
  const url = flag(args, "--url") ?? process.env.BACKLEX_URL ?? "http://localhost:8787";
  const tenant = flag(args, "--tenant") ?? process.env.BACKLEX_TENANT;
  const profileName = flag(args, "--profile") ?? "default";
  const key = await resolveLoginKey(args);
  if (!key) {
    process.stderr.write("login: an API key is required (--key pak_… or BACKLEX_API_KEY)\n");
    process.exit(1);
  }

  const ctx: Context = { url, key, tenant, profileName, json };
  let me: Me;
  try {
    me = await fetchMe(ctx);
  } catch (e) {
    const msg =
      e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
    process.stderr.write(`login failed: ${msg}\n`);
    process.exit(1);
  }

  const cfg = loadConfig();
  saveConfig(setProfile(cfg, profileName, { url, key, tenant }));
  if (!json) process.stderr.write(`Saved profile "${profileName}".\n`);
  renderMe(me, ctx, json);
};

/** `backlex logout` — drop the saved key (and tenant) for a profile, or remove
 *  it entirely with `--all`. */
export const runLogout = (args: string[]): void => {
  const cfg = loadConfig();
  const name = flag(args, "--profile") ?? cfg.activeProfile;
  if (!name || !cfg.profiles[name]) {
    process.stderr.write("logout: no matching profile\n");
    process.exit(1);
  }
  if (has(args, "--all")) {
    saveConfig(removeProfile(cfg, name));
    process.stderr.write(`Removed profile "${name}".\n`);
    return;
  }
  const existing = cfg.profiles[name];
  saveConfig(setProfile(cfg, name, { url: existing?.url ?? "" }));
  process.stderr.write(`Cleared credentials for profile "${name}".\n`);
};

/** `backlex whoami` — show the identity behind the resolved key. */
export const runWhoami = async (args: string[]): Promise<void> => {
  const ctx = resolveContext(args);
  if (!ctx.key) {
    process.stderr.write("whoami: no API key — run `backlex login` first.\n");
    process.exit(1);
  }
  try {
    const me = await fetchMe(ctx);
    renderMe(me, ctx, ctx.json);
  } catch (e) {
    const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
    process.stderr.write(`whoami failed: ${msg}\n`);
    process.exit(1);
  }
};

/** `backlex profile <list|use|add|remove>` — manage saved profiles. */
export const runProfile = (args: string[]): void => {
  const sub = args[0];
  const json = has(args, "--json");
  const cfg = loadConfig();

  if (!sub || sub === "list") {
    const rows = Object.entries(cfg.profiles).map(([name, p]) => ({
      profile: name === cfg.activeProfile ? `* ${name}` : `  ${name}`,
      url: p.url,
      key: p.key ? "set" : "—",
      tenant: p.tenant ?? "—",
    }));
    if (json) printJson({ activeProfile: cfg.activeProfile, profiles: cfg.profiles });
    else printTable(rows);
    return;
  }

  if (sub === "use") {
    const name = args[1];
    if (!name) {
      process.stderr.write("profile use <name>\n");
      process.exit(1);
    }
    try {
      saveConfig(setActive(cfg, name));
      process.stderr.write(`Active profile: ${name}\n`);
    } catch (e) {
      process.stderr.write(`${(e as Error).message}\n`);
      process.exit(1);
    }
    return;
  }

  if (sub === "add") {
    const name = args[1];
    const url = flag(args, "--url");
    if (!name || !url) {
      process.stderr.write("profile add <name> --url <url> [--key pak_…] [--tenant <t>]\n");
      process.exit(1);
    }
    saveConfig(
      setProfile(cfg, name, { url, key: flag(args, "--key"), tenant: flag(args, "--tenant") }),
    );
    process.stderr.write(`Saved profile "${name}".\n`);
    return;
  }

  if (sub === "remove" || sub === "rm") {
    const name = args[1];
    if (!name || !getProfile(cfg, name)) {
      process.stderr.write("profile remove <name> — no such profile\n");
      process.exit(1);
    }
    saveConfig(removeProfile(cfg, name));
    process.stderr.write(`Removed profile "${name}".\n`);
    return;
  }

  process.stderr.write(`unknown profile subcommand: ${sub}\n`);
  process.exit(1);
};
