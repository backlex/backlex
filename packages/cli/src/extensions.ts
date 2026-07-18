/**
 * `backlex extensions` — extension packages over `/api/extensions`.
 *
 * `install` pulls a package from the npm registry server-side; `push` uploads
 * a local extension directory (the dev loop: edit files → push → reload the
 * admin). See `docs/extensions.md`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BacklexError } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printTable,
  resolvePayload,
  resolveContext,
} from "./client";

interface ExtensionRow {
  id: string;
  name: string;
  version: string;
  source: string;
  npmPackage: string | null;
  enabled: boolean;
  manifest: {
    title?: string;
    contributes?: {
      panels?: unknown[];
      fieldEditors?: unknown[];
      hooks?: unknown[];
    };
  };
}

const EXTENSIONS_HELP = `backlex extensions <list|install|push|enable|disable|uninstall|invoke>

  list                                   installed extensions
  install <package> [--version <v>]      install/upgrade from the npm registry
  push <dir>                             upload a local extension directory
                                         (must contain backlex-extension.json)
  enable <name> | disable <name>         toggle an installed extension
  uninstall <name>
  invoke <name> <hookId> [--data <json|@file|->]   run a hook in the sandbox
`;

const BASE = "/api/extensions";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

/** Collect text files under dir (recursive), keyed by /-joined relative path. */
const collectFiles = (dir: string): Record<string, string> => {
  const files: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(d, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.size <= 1024 * 1024) {
        files[relative(dir, full).split("\\").join("/")] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return files;
};

export const runExtensions = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(EXTENSIONS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: ExtensionRow[] }>("GET", BASE);
        if (json) printJson(data);
        else
          printTable(
            data.map((e) => ({
              name: e.name,
              version: e.version,
              source: e.npmPackage ?? e.source,
              enabled: e.enabled ? "yes" : "no",
              panels: e.manifest.contributes?.panels?.length ?? 0,
              editors: e.manifest.contributes?.fieldEditors?.length ?? 0,
              hooks: e.manifest.contributes?.hooks?.length ?? 0,
            })),
          );
        return;
      }
      case "install": {
        const pkg = rest[0];
        if (!pkg || pkg.startsWith("-")) {
          process.stderr.write("extensions install <package> [--version <v>]\n");
          process.exit(1);
        }
        const version = flag(rest, "--version");
        const res = await client.request<{ data: ExtensionRow }>(
          "POST",
          `${BASE}/install`,
          { package: pkg, ...(version ? { version } : {}) },
        );
        if (json) printJson(res.data);
        else
          process.stderr.write(
            `Installed "${res.data.name}" ${res.data.version} from ${pkg}.\n`,
          );
        return;
      }
      case "push": {
        const dir = rest[0];
        if (!dir || dir.startsWith("-")) {
          process.stderr.write("extensions push <dir>\n");
          process.exit(1);
        }
        const files = collectFiles(dir);
        if (files["backlex-extension.json"] === undefined) {
          process.stderr.write(`${dir} has no backlex-extension.json\n`);
          process.exit(1);
        }
        const res = await client.request<{ data: ExtensionRow }>(
          "POST",
          `${BASE}/upload`,
          { files },
        );
        if (json) printJson(res.data);
        else
          process.stderr.write(
            `Pushed "${res.data.name}" ${res.data.version} (${Object.keys(files).length} files scanned).\n`,
          );
        return;
      }
      case "enable":
      case "disable": {
        const name = rest[0];
        if (!name || name.startsWith("-")) {
          process.stderr.write(`extensions ${sub} <name>\n`);
          process.exit(1);
        }
        const res = await client.request<{ data: ExtensionRow }>(
          "PATCH",
          `${BASE}/${encodeURIComponent(name)}`,
          { enabled: sub === "enable" },
        );
        if (json) printJson(res.data);
        else process.stderr.write(`Extension "${name}" ${sub}d.\n`);
        return;
      }
      case "uninstall": {
        const name = rest[0];
        if (!name || name.startsWith("-")) {
          process.stderr.write("extensions uninstall <name>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${BASE}/${encodeURIComponent(name)}`);
        process.stderr.write(`Uninstalled extension "${name}".\n`);
        return;
      }
      case "invoke": {
        const name = rest[0];
        const hookId = rest[1];
        if (!name || name.startsWith("-") || !hookId || hookId.startsWith("-")) {
          process.stderr.write(
            "extensions invoke <name> <hookId> [--data <json|@file|->]\n",
          );
          process.exit(1);
        }
        const dataFlag = flag(rest, "--data");
        const input =
          dataFlag !== undefined ? JSON.parse(await resolvePayload(dataFlag)) : {};
        const res = await client.request<unknown>(
          "POST",
          `${BASE}/${encodeURIComponent(name)}/hooks/${encodeURIComponent(hookId)}/invoke`,
          input,
        );
        printJson(res);
        return;
      }
      default:
        process.stderr.write(`unknown extensions subcommand: ${sub}\n\n${EXTENSIONS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `extensions ${sub}`);
  }
};
