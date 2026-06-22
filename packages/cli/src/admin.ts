/**
 * `backlex users` / `roles` / `flags` / `settings` — workspace administration.
 *
 * `users grant` is the CLI replacement for the manual `INSERT INTO user_roles`
 * documented in CLAUDE.md: it resolves a role by name (or id) and attaches it
 * via `POST /api/users/{id}/roles`. Flags and settings wrap the admin CRUD at
 * `/api/admin/feature-flags` and `/api/admin/settings`.
 */
import { BacklexError, type BacklexClient } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
} from "./client";

interface Role {
  id: string;
  name: string;
  description: string | null;
  admin: boolean;
}
interface User {
  id: string;
  email: string;
  name: string | null;
  roles: { id: string; name: string }[];
}

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

/** Resolve a role argument that may be a role id or a role name. */
const resolveRoleId = async (client: BacklexClient, ref: string): Promise<string> => {
  const { data } = await client.request<{ data: Role[] }>("GET", "/api/roles");
  const byId = data.find((r) => r.id === ref);
  if (byId) return byId.id;
  const byName = data.find((r) => r.name === ref);
  if (byName) return byName.id;
  throw new Error(`no role matches "${ref}" (try \`backlex roles list\`)`);
};

// ── users ─────────────────────────────────────────────────────────────────

const USERS_HELP = `backlex users <list|grant|revoke>

  list                          workspace users + their roles
  grant <userId> <role>         attach a role (by name or id) — e.g. grant <id> admin
  revoke <userId> <role>        detach a role (by name or id)
`;

export const runUsers = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(USERS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: User[] }>("GET", "/api/users");
        if (json) printJson(data);
        else
          printTable(
            data.map((u) => ({
              id: u.id,
              email: u.email,
              name: u.name ?? "—",
              roles: u.roles.map((r) => r.name).join(", ") || "—",
            })),
          );
        return;
      }
      case "grant": {
        const [userId, role] = [rest[0], rest[1]];
        if (!userId || !role) {
          process.stderr.write("users grant <userId> <role>\n");
          process.exit(1);
        }
        const roleId = await resolveRoleId(client, role);
        await client.request("POST", `/api/users/${encodeURIComponent(userId)}/roles`, { roleId });
        process.stderr.write(`Granted role "${role}" to ${userId}.\n`);
        return;
      }
      case "revoke": {
        const [userId, role] = [rest[0], rest[1]];
        if (!userId || !role) {
          process.stderr.write("users revoke <userId> <role>\n");
          process.exit(1);
        }
        const roleId = await resolveRoleId(client, role);
        await client.request(
          "DELETE",
          `/api/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(roleId)}`,
        );
        process.stderr.write(`Revoked role "${role}" from ${userId}.\n`);
        return;
      }
      default:
        process.stderr.write(`unknown users subcommand: ${sub}\n\n${USERS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `users ${sub}`);
  }
};

// ── roles ───────────────────────────────────────────────────────────────────

export const runRoles = async (args: string[]): Promise<void> => {
  const sub = args[0] ?? "list";
  const json = has(args, "--json");
  if (sub === "help" || sub === "--help") {
    process.stdout.write("backlex roles list\n");
    return;
  }
  if (sub !== "list") {
    process.stderr.write(`unknown roles subcommand: ${sub}\n\nbacklex roles list\n`);
    process.exit(1);
  }
  const client = makeClient(resolveContext(args));
  try {
    const { data } = await client.request<{ data: Role[] }>("GET", "/api/roles");
    if (json) printJson(data);
    else
      printTable(
        data.map((r) => ({
          id: r.id,
          name: r.name,
          admin: r.admin ? "yes" : "no",
          description: r.description ?? "—",
        })),
      );
  } catch (e) {
    die(e, "roles list");
  }
};

// ── flags ─────────────────────────────────────────────────────────────────

const FLAGS_HELP = `backlex flags <list|set|delete>

  list                          all flag definitions
  set <key> [--enabled true|false] [--value <json>] [--rollout 0-100] [--global]
  delete <key> [--global]
`;

export const runFlags = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(FLAGS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  const scopeQuery = has(rest, "--global") ? "?scope=global" : "";
  try {
    switch (sub) {
      case "list": {
        const res = await client.request<{ data: unknown }>("GET", "/api/admin/feature-flags");
        if (json) printJson(res.data);
        else if (Array.isArray(res.data)) printTable(res.data as Record<string, unknown>[]);
        else printJson(res.data);
        return;
      }
      case "set": {
        const key = rest[0];
        if (!key || key.startsWith("-")) {
          process.stderr.write("flags set <key> [--enabled true|false] [--value <json>] [--rollout N]\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = {};
        const enabled = flag(rest, "--enabled");
        if (enabled !== undefined) body.enabled = enabled === "true";
        const value = flag(rest, "--value");
        if (value !== undefined) body.value = JSON.parse(value);
        const rollout = flag(rest, "--rollout");
        if (rollout !== undefined) body.rules = { rollout: Number(rollout) };
        const res = await client.request<{ data: unknown }>(
          "PUT",
          `/api/admin/feature-flags/${encodeURIComponent(key)}${scopeQuery}`,
          body,
        );
        if (json) printJson(res.data);
        else process.stderr.write(`Saved flag "${key}".\n`);
        return;
      }
      case "delete": {
        const key = rest[0];
        if (!key || key.startsWith("-")) {
          process.stderr.write("flags delete <key> [--global]\n");
          process.exit(1);
        }
        await client.request("DELETE", `/api/admin/feature-flags/${encodeURIComponent(key)}${scopeQuery}`);
        process.stderr.write(`Deleted flag "${key}".\n`);
        return;
      }
      default:
        process.stderr.write(`unknown flags subcommand: ${sub}\n\n${FLAGS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `flags ${sub}`);
  }
};

// ── settings ────────────────────────────────────────────────────────────────

const SETTINGS_HELP = `backlex settings <get|set>

  get                           the active workspace's settings
  set <key> <value>             patch one whitelisted key (value parsed as JSON, else string)
`;

export const runSettings = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(SETTINGS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    if (sub === "get") {
      const { data } = await client.request<{ data: Record<string, unknown> }>(
        "GET",
        "/api/admin/settings",
      );
      if (json) printJson(data);
      else printKeyValues(data);
      return;
    }
    if (sub === "set") {
      const key = rest[0];
      const rawValue = rest[1];
      if (!key || rawValue === undefined) {
        process.stderr.write("settings set <key> <value>\n");
        process.exit(1);
      }
      let value: unknown = rawValue;
      try {
        value = JSON.parse(rawValue);
      } catch {
        // not JSON — keep the raw string
      }
      const { data } = await client.request<{ data: Record<string, unknown> }>(
        "PATCH",
        "/api/admin/settings",
        { [key]: value },
      );
      if (json) printJson(data);
      else process.stderr.write(`Set ${key}.\n`);
      return;
    }
    process.stderr.write(`unknown settings subcommand: ${sub}\n\n${SETTINGS_HELP}`);
    process.exit(1);
  } catch (e) {
    die(e, `settings ${sub}`);
  }
};
