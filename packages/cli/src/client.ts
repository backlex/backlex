/**
 * Shared connection-context resolution + client factory for CLI commands.
 *
 * Every remote command resolves a {@link Context} the same way: explicit flags
 * win, then environment variables, then the saved profile (active or named).
 * That single precedence is the reason commands don't each re-implement
 * `--url`/`--key` handling. `makeClient` wraps the public SDK (`backlex`) so the
 * CLI and end-user apps share one HTTP path (auth headers, error shape, retries).
 */
import { readFileSync } from "node:fs";
import { createClient, type BacklexClient, type ListQuery } from "backlex";
import { getProfile, loadConfig, type Profile } from "./config";

export interface Context {
  url: string;
  key?: string;
  tenant?: string;
  /** Name of the profile the url/key were resolved from (for messages). */
  profileName?: string;
  /** `--json` was passed: commands should emit machine-readable JSON. */
  json: boolean;
}

/** Read a `--name value` flag from an argv slice (returns undefined if absent). */
export const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** Whether a boolean flag is present. */
export const has = (args: string[], name: string): boolean => args.includes(name);

/**
 * Resolve the connection context for a command. Precedence per field:
 *   1. explicit flag (`--url` / `--key` / `--tenant`)
 *   2. environment (`BACKLEX_URL` / `BACKLEX_API_KEY` / `BACKLEX_TENANT`)
 *   3. the saved profile (`--profile <name>`, else the active profile)
 * `url` falls back to `http://localhost:8787` so local dev needs no setup.
 */
export const resolveContext = (args: string[]): Context => {
  const cfg = loadConfig();
  const named = getProfile(cfg, flag(args, "--profile"));
  const p: Profile = named?.profile ?? { url: "" };

  const url =
    flag(args, "--url") ?? process.env.BACKLEX_URL ?? p.url ?? "";
  const key = flag(args, "--key") ?? process.env.BACKLEX_API_KEY ?? p.key;
  const tenant = flag(args, "--tenant") ?? process.env.BACKLEX_TENANT ?? p.tenant;

  return {
    url: url || "http://localhost:8787",
    key,
    tenant,
    profileName: named?.name,
    json: has(args, "--json"),
  };
};

/** Build an SDK client from a resolved context (server-to-server / PAK mode). */
export const makeClient = (ctx: Context): BacklexClient =>
  createClient({ url: ctx.url, apiKey: ctx.key, tenant: ctx.tenant });

/**
 * Raw authenticated fetch — for endpoints the JSON-only SDK `request` can't
 * handle (e.g. the octet-stream backup download). Applies the same Bearer +
 * tenant headers `makeClient` does.
 */
export const authedFetch = (
  ctx: Context,
  method: string,
  path: string,
  init?: { headers?: Record<string, string> },
): Promise<Response> =>
  fetch(`${ctx.url}${path}`, {
    method,
    headers: {
      ...(ctx.key ? { authorization: `Bearer ${ctx.key}` } : {}),
      ...(ctx.tenant ? { "x-backlex-tenant": ctx.tenant } : {}),
      ...(init?.headers ?? {}),
    },
  });

// ── Query + payload helpers (shared by items / collections commands) ──────────

const csv = (v: string | undefined): string[] | undefined =>
  v == null ? undefined : v.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * Build a `ListQuery` from CLI flags. `--filter` takes a JSON object (the same
 * Directus-style operators the REST API accepts); the rest mirror the query
 * string the SDK already serializes.
 */
export const buildListQuery = (args: string[]): ListQuery => {
  const q: ListQuery = {};
  const filter = flag(args, "--filter");
  // The filter DSL is open-ended JSON; the SDK's `Condition` type is a strict
  // union, so widen through `unknown` rather than re-encode the operators here.
  if (filter) q.filter = JSON.parse(filter) as ListQuery["filter"];
  const sort = csv(flag(args, "--sort"));
  if (sort) q.sort = sort;
  const fields = csv(flag(args, "--fields"));
  if (fields) q.fields = fields;
  const expand = csv(flag(args, "--expand"));
  if (expand) q.expand = expand;
  const limit = flag(args, "--limit");
  if (limit) q.limit = Number(limit);
  const offset = flag(args, "--offset");
  if (offset) q.offset = Number(offset);
  // `--cursor ""` opts into keyset paging (empty = first page); echo back the
  // `next_cursor` from each response to page forward.
  const cursor = flag(args, "--cursor");
  if (cursor !== undefined) q.cursor = cursor;
  const meta = flag(args, "--meta");
  if (meta === "filter_count" || meta === "total_count" || meta === "*") q.meta = meta;
  const search = flag(args, "--q") ?? flag(args, "-q");
  if (search) q.q = search;
  const status = flag(args, "--status");
  if (status) q.status = status as ListQuery["status"];
  const locale = flag(args, "--locale");
  if (locale) q.locale = locale;
  return q;
};

/** Read all of stdin as a string (for `--data -` / `import -`). */
export const readStdin = async (): Promise<string> => {
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array | string>) {
    buf += typeof chunk === "string" ? chunk : dec.decode(chunk, { stream: true });
  }
  return buf;
};

/**
 * Resolve a payload argument that may be inline JSON, `@<file>` (read from
 * disk), or `-` (read from stdin). Returns the raw string; callers parse it.
 */
export const resolvePayload = async (raw: string | undefined): Promise<string> => {
  if (raw === undefined) throw new Error("missing --data (inline JSON, @file, or - for stdin)");
  if (raw === "-") return readStdin();
  if (raw.startsWith("@")) return readFileSync(raw.slice(1), "utf8");
  return raw;
};

// ── Output helpers ──────────────────────────────────────────────────────────

/** Print a value as pretty JSON (used whenever `--json` is set). */
export const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

/** Print `key: value` rows aligned on the colon — the default human view. */
export const printKeyValues = (rows: Record<string, unknown>): void => {
  const keys = Object.keys(rows);
  const width = keys.reduce((m, k) => Math.max(m, k.length), 0);
  for (const k of keys) {
    const v = rows[k];
    const shown = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    process.stdout.write(`${k.padEnd(width)}  ${shown}\n`);
  }
};

/** Print a compact table from an array of records (keys from the first row). */
export const printTable = (rows: Record<string, unknown>[]): void => {
  if (rows.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  const cols = Object.keys(rows[0] as Record<string, unknown>);
  const cell = (v: unknown): string =>
    v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const widths = cols.map((col) =>
    Math.max(col.length, ...rows.map((r) => cell(r[col]).length)),
  );
  const line = (vals: string[]): string =>
    vals.map((v, i) => v.padEnd(widths[i] as number)).join("  ");
  process.stdout.write(`${line(cols)}\n`);
  process.stdout.write(`${line(widths.map((w) => "-".repeat(w)))}\n`);
  for (const r of rows) process.stdout.write(`${line(cols.map((c) => cell(r[c])))}\n`);
};
