import { and, eq } from "drizzle-orm";
import { z } from "zod";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError, type AuthSubject } from "@backlex/core";
import { runFunction, type SandboxResult } from "./sandbox";
import type { Ctx } from "../context";
import type { DbCtx } from "./seed";

/**
 * Extension system (#13). An extension is an installed package (npm tarball or
 * direct upload) whose `backlex-extension.json` manifest declares contribution
 * points:
 *   - panels       — admin pages rendered in a sandboxed iframe
 *   - fieldEditors — per-interface field editors for the item form (iframe)
 *   - widgets      — iframes mounted INSIDE an existing admin screen, handed
 *                    that screen's context (which collection, which row, which
 *                    rows are selected) — see WidgetSchema
 *   - hooks        — server-side code run in the functions sandbox on item
 *                    events (`trigger: "event"`) or on demand (`"manual"`)
 * UI entries talk to the admin through a postMessage bridge whose API access
 * is capped by the manifest's `permissions.api` allow-list (see apiPermits).
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ENTRY_RE = /^[\w-]+(?:\/[\w.-]+)*\.[\w]+$/;

const entryPath = z
  .string()
  .max(200)
  .regex(ENTRY_RE, "entry must be a relative file path inside the package")
  .refine((p) => !p.includes(".."), "entry must not contain ..");

const PanelSchema = z.object({
  id: z.string().regex(SLUG_RE),
  title: z.string().min(1).max(80),
  icon: z.string().max(40).optional(),
  entry: entryPath,
});

const FieldEditorSchema = z.object({
  interface: z.string().regex(SLUG_RE),
  title: z.string().min(1).max(80),
  types: z.array(z.string().max(40)).max(20).optional(),
  entry: entryPath,
});

/**
 * Where a widget mounts. A panel is a *destination* — the operator has to leave
 * what they were doing to reach it. A widget renders where the work already is,
 * which is the only way an extension can be about the row on screen.
 *
 * Each mount hands the iframe a different context, and the context is the whole
 * point: a shipping widget on `item-detail` is useless without the order id.
 */
export const WIDGET_MOUNTS = ["item-detail", "item-list", "home"] as const;
export type WidgetMount = (typeof WIDGET_MOUNTS)[number];

const WidgetSchema = z.object({
  id: z.string().regex(SLUG_RE),
  title: z.string().min(1).max(80),
  icon: z.string().max(40).optional(),
  mount: z.enum(WIDGET_MOUNTS),
  /** Collections this widget appears on; absent/empty = every collection.
   *  Ignored for `home`, which has no collection. */
  collections: z.array(z.string().regex(SLUG_RE)).max(50).optional(),
  entry: entryPath,
});

const HookSchema = z
  .object({
    id: z.string().regex(SLUG_RE),
    trigger: z.enum(["event", "manual", "cron"]),
    pattern: z.string().max(200).optional(),
    entry: entryPath,
    timeoutMs: z.number().int().min(50).max(60000).optional(),
  })
  .superRefine((h, ctx) => {
    if (h.trigger === "cron" && !h.pattern) {
      ctx.addIssue({
        code: "custom",
        path: ["pattern"],
        message: "cron hooks require a cron pattern",
      });
    }
  });

export const ManifestSchema = z.object({
  name: z.string().regex(SLUG_RE),
  version: z.string().min(1).max(40),
  title: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  contributes: z
    .object({
      panels: z.array(PanelSchema).max(20).optional(),
      fieldEditors: z.array(FieldEditorSchema).max(20).optional(),
      widgets: z.array(WidgetSchema).max(20).optional(),
      hooks: z.array(HookSchema).max(20).optional(),
    })
    .default({}),
  permissions: z
    .object({ api: z.array(z.string().max(200)).max(50).optional() })
    .optional(),
});

export type ExtensionManifest = z.infer<typeof ManifestSchema>;

export interface ExtensionRow {
  id: string;
  tenantId: string | null;
  name: string;
  version: string;
  source: string;
  npmPackage: string | null;
  manifest: ExtensionManifest;
  enabled: boolean | number;
  createdAt: Date | number;
  updatedAt: Date | number;
}

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.extensions : sqlite.schema.extensions;
const assetsFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.extensionAssets : sqlite.schema.extensionAssets;

const parseManifest = (row: ExtensionRow): ExtensionRow => {
  // sqlite json mode already gives an object; guard against string storage.
  if (typeof (row as { manifest: unknown }).manifest === "string") {
    row.manifest = JSON.parse(row.manifest as unknown as string);
  }
  return row;
};

/**
 * Does the manifest's `permissions.api` allow-list permit this admin-API call?
 * Entries look like `"GET /api/items/posts"`, `"* /api/items/*"`. Paths must
 * live under /api/ — the bridge refuses everything else regardless of list.
 */
export const apiPermits = (
  patterns: string[] | undefined,
  method: string,
  path: string,
): boolean => {
  if (!patterns || patterns.length === 0) return false;
  if (!path.startsWith("/api/") || path.includes("..")) return false;
  const m = method.toUpperCase();
  return patterns.some((p) => {
    const parts = p.trim().split(/\s+/);
    const pm = parts[0];
    const pp = parts[1];
    if (!pm || !pp || !pp.startsWith("/api/")) return false;
    if (pm !== "*" && pm.toUpperCase() !== m) return false;
    if (pp.endsWith("*")) return path.startsWith(pp.slice(0, -1));
    return path === pp;
  });
};

// ---------------------------------------------------------------------------
// Tarball handling (npm install path)
// ---------------------------------------------------------------------------

const MAX_TARBALL_BYTES = 5 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 15 * 1024 * 1024;
const MAX_ASSET_BYTES = 1 * 1024 * 1024;

const readStr = (block: Uint8Array, off: number, len: number): string => {
  let end = off;
  while (end < off + len && block[end] !== 0) end++;
  return new TextDecoder().decode(block.subarray(off, end));
};

/** Minimal ustar/pax reader — enough for npm-published tarballs. */
export const untar = (buf: Uint8Array): Map<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>();
  let off = 0;
  let longName: string | null = null;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const rawName = readStr(block, 0, 100);
    const prefix = readStr(block, 345, 155);
    const size = Number.parseInt(readStr(block, 124, 12).trim() || "0", 8) || 0;
    const type = block[156];
    off += 512;
    const body = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === 76 /* 'L' GNU longname */) {
      longName = new TextDecoder().decode(body).replace(/\0+$/, "");
      continue;
    }
    if (type === 120 || type === 103) continue; // pax headers
    const name = longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = null;
    if (type === 0 || type === 48 /* regular file */) files.set(name, body);
  }
  return files;
};

const gunzip = async (bytes: ArrayBuffer): Promise<Uint8Array> => {
  const stream = new Response(bytes).body;
  if (!stream) throw new AppError("INTERNAL", "empty tarball body");
  const out = new Uint8Array(
    await new Response(
      stream.pipeThrough(new DecompressionStream("gzip")),
    ).arrayBuffer(),
  );
  if (out.byteLength > MAX_UNPACKED_BYTES) {
    throw new AppError("VALIDATION", "extension package too large when unpacked");
  }
  return out;
};

const CONTENT_TYPES: Record<string, string> = {
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
};

export const contentTypeFor = (path: string): string => {
  const ext = path.split(".").pop() ?? "";
  return CONTENT_TYPES[ext] ?? "text/plain; charset=utf-8";
};

const NPM_NAME_RE =
  /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/** Resolve `ref` relative to the directory of `from` inside the package.
 *  Returns null when the ref escapes the package root or is absolute/remote. */
const resolvePackagePath = (from: string, ref: string): string | null => {
  if (/^[a-z][a-z0-9+.-]*:|^\/\/|^\//i.test(ref)) return null;
  const base = from.split("/").slice(0, -1);
  for (const seg of ref.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (base.length === 0) return null;
      base.pop();
      continue;
    }
    base.push(seg);
  }
  return base.join("/");
};

/**
 * Inline same-package `<script src>` / `<link rel="stylesheet">` references
 * into an entry document. Entries render inside a sandboxed iframe whose CSP
 * only permits inline script/style — install-time inlining is what makes
 * multi-file extension UIs work without relaxing that policy (subresource
 * fetches from the opaque-origin iframe would be uncredentialed anyway).
 * External URLs and refs that don't resolve to a package file are left
 * untouched (the CSP blocks them at render time, by design).
 */
export const inlineEntryAssets = (
  files: Record<string, string>,
  entryPath0: string,
  html: string,
): string => {
  const scriptRe =
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi;
  const linkRe = /<link\b[^>]*>/gi;
  let out = html.replace(scriptRe, (tag, src: string) => {
    const resolved = resolvePackagePath(entryPath0, src);
    const content = resolved !== null ? files[resolved] : undefined;
    if (content === undefined) return tag;
    return `<script>\n${content.replace(/<\/script/gi, "<\\/script")}\n</script>`;
  });
  out = out.replace(linkRe, (tag) => {
    if (!/\brel\s*=\s*["']stylesheet["']/i.test(tag)) return tag;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) return tag;
    const resolved = resolvePackagePath(entryPath0, href);
    const content = resolved !== null ? files[resolved] : undefined;
    if (content === undefined) return tag;
    return `<style>\n${content}\n</style>`;
  });
  return out;
};

/**
 * Validate a raw file map (path → content) as an extension package and return
 * the parsed manifest plus the subset of files the manifest actually
 * references. Shared by the npm and upload install paths, so every entry file
 * is guaranteed present and size-capped no matter how the package arrived.
 * HTML entries get their same-package script/style refs inlined (see
 * inlineEntryAssets) and are re-capped afterwards.
 */
export const validatePackage = (
  files: Record<string, string>,
): { manifest: ExtensionManifest; assets: Record<string, string> } => {
  const rawManifest = files["backlex-extension.json"];
  if (rawManifest === undefined) {
    throw new AppError("VALIDATION", "package has no backlex-extension.json");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawManifest);
  } catch {
    throw new AppError("VALIDATION", "backlex-extension.json is not valid JSON");
  }
  const parsed = ManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new AppError(
      "VALIDATION",
      "invalid extension manifest",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const manifest = parsed.data;
  const c = manifest.contributes;
  const entries = new Set<string>([
    ...(c.panels ?? []).map((p) => p.entry),
    ...(c.fieldEditors ?? []).map((f) => f.entry),
    ...(c.widgets ?? []).map((w) => w.entry),
    ...(c.hooks ?? []).map((h) => h.entry),
  ]);
  const assets: Record<string, string> = {};
  for (const entry of entries) {
    let content = files[entry];
    if (content === undefined) {
      throw new AppError("VALIDATION", `manifest references missing file: ${entry}`);
    }
    if (/\.html?$/i.test(entry)) {
      content = inlineEntryAssets(files, entry, content);
    }
    if (content.length > MAX_ASSET_BYTES) {
      throw new AppError("VALIDATION", `entry file too large: ${entry}`);
    }
    assets[entry] = content;
  }
  return { manifest, assets };
};

const fetchNpmPackage = async (
  registry: string,
  pkg: string,
  version: string | undefined,
): Promise<{ files: Record<string, string>; version: string }> => {
  if (!NPM_NAME_RE.test(pkg)) {
    throw new AppError("VALIDATION", `invalid npm package name: ${pkg}`);
  }
  const metaRes = await fetch(
    `${registry}/${pkg.replace("/", "%2f")}`,
    { headers: { accept: "application/vnd.npm.install-v1+json" } },
  );
  if (!metaRes.ok) {
    throw new AppError(
      metaRes.status === 404 ? "NOT_FOUND" : "INTERNAL",
      `npm registry lookup failed for ${pkg} (${metaRes.status})`,
    );
  }
  const meta = (await metaRes.json()) as {
    "dist-tags"?: Record<string, string>;
    versions?: Record<string, { dist?: { tarball?: string } }>;
  };
  const resolved = version ?? meta["dist-tags"]?.latest;
  const tarballUrl = resolved
    ? meta.versions?.[resolved]?.dist?.tarball
    : undefined;
  if (!resolved || !tarballUrl) {
    throw new AppError("NOT_FOUND", `version ${version ?? "latest"} not found for ${pkg}`);
  }
  // Only trust tarballs hosted by the registry we resolved against.
  if (new URL(tarballUrl).host !== new URL(registry).host) {
    throw new AppError("VALIDATION", "tarball host does not match registry host");
  }
  const tarRes = await fetch(tarballUrl);
  if (!tarRes.ok) {
    throw new AppError("INTERNAL", `tarball download failed (${tarRes.status})`);
  }
  const bytes = await tarRes.arrayBuffer();
  if (bytes.byteLength > MAX_TARBALL_BYTES) {
    throw new AppError("VALIDATION", "extension tarball too large (5MB cap)");
  }
  const raw = untar(await gunzip(bytes));
  const files: Record<string, string> = {};
  const decoder = new TextDecoder();
  for (const [name, body] of raw) {
    // npm tarballs prefix every path with "package/".
    if (!name.startsWith("package/")) continue;
    if (body.byteLength > MAX_ASSET_BYTES) continue;
    files[name.slice("package/".length)] = decoder.decode(body);
  }
  return { files, version: resolved };
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export const listExtensions = async (
  ctx: DbCtx,
  tenantId: string,
): Promise<ExtensionRow[]> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.tenantId, tenantId))) as ExtensionRow[];
  return rows.map(parseManifest).sort((a, b) => a.name.localeCompare(b.name));
};

export const getExtension = async (
  ctx: DbCtx,
  tenantId: string,
  name: string,
): Promise<ExtensionRow | null> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(and(eq(t.tenantId, tenantId), eq(t.name, name)))
    .limit(1)) as ExtensionRow[];
  const row = rows[0];
  return row ? parseManifest(row) : null;
};

const upsertExtension = async (
  ctx: DbCtx,
  tenantId: string,
  input: {
    manifest: ExtensionManifest;
    assets: Record<string, string>;
    source: "npm" | "upload";
    npmPackage?: string;
    version: string;
  },
): Promise<ExtensionRow> => {
  const t = tableFor(ctx.dialect);
  const a = assetsFor(ctx.dialect);
  const existing = await getExtension(ctx, tenantId, input.manifest.name);
  const now = ctx.dialect === "pg" ? new Date() : Date.now();
  const id = existing?.id ?? crypto.randomUUID();
  const values = {
    name: input.manifest.name,
    version: input.version,
    source: input.source,
    npmPackage: input.npmPackage ?? null,
    manifest: input.manifest,
    updatedAt: now,
  };
  if (existing) {
    await (ctx.db as any).update(t).set(values).where(eq(t.id, id));
    await (ctx.db as any).delete(a).where(eq(a.extensionId, id));
  } else {
    await (ctx.db as any).insert(t).values({
      id,
      tenantId,
      enabled: true,
      createdAt: now,
      ...values,
    });
  }
  for (const [path, content] of Object.entries(input.assets)) {
    await (ctx.db as any).insert(a).values({
      id: crypto.randomUUID(),
      extensionId: id,
      path,
      content,
      contentType: contentTypeFor(path),
    });
  }
  const row = await getExtension(ctx, tenantId, input.manifest.name);
  if (!row) throw new AppError("INTERNAL", "extension row vanished after install");
  return row;
};

export const installFromNpm = async (
  ctx: Ctx,
  tenantId: string,
  pkg: string,
  version?: string,
): Promise<ExtensionRow> => {
  const registry =
    ctx.env.EXTENSIONS_NPM_REGISTRY?.replace(/\/$/, "") ||
    "https://registry.npmjs.org";
  const fetched = await fetchNpmPackage(registry, pkg, version);
  const { manifest, assets } = validatePackage(fetched.files);
  return upsertExtension(ctx, tenantId, {
    manifest,
    assets,
    source: "npm",
    npmPackage: pkg,
    version: fetched.version,
  });
};

export const installFromUpload = async (
  ctx: DbCtx,
  tenantId: string,
  files: Record<string, string>,
): Promise<ExtensionRow> => {
  const { manifest, assets } = validatePackage(files);
  return upsertExtension(ctx, tenantId, {
    manifest,
    assets,
    source: "upload",
    version: manifest.version,
  });
};

export const setExtensionEnabled = async (
  ctx: DbCtx,
  tenantId: string,
  name: string,
  enabled: boolean,
): Promise<ExtensionRow> => {
  const row = await getExtension(ctx, tenantId, name);
  if (!row) throw new AppError("NOT_FOUND", `extension not found: ${name}`);
  const t = tableFor(ctx.dialect);
  await (ctx.db as any)
    .update(t)
    .set({ enabled, updatedAt: ctx.dialect === "pg" ? new Date() : Date.now() })
    .where(eq(t.id, row.id));
  return { ...row, enabled };
};

export const uninstallExtension = async (
  ctx: DbCtx,
  tenantId: string,
  name: string,
): Promise<void> => {
  const row = await getExtension(ctx, tenantId, name);
  if (!row) throw new AppError("NOT_FOUND", `extension not found: ${name}`);
  const t = tableFor(ctx.dialect);
  const a = assetsFor(ctx.dialect);
  await (ctx.db as any).delete(a).where(eq(a.extensionId, row.id));
  await (ctx.db as any).delete(t).where(eq(t.id, row.id));
};

export const getAsset = async (
  ctx: DbCtx,
  extensionId: string,
  path: string,
): Promise<{ content: string; contentType: string } | null> => {
  const a = assetsFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(a)
    .where(and(eq(a.extensionId, extensionId), eq(a.path, path)))
    .limit(1)) as { content: string; contentType: string }[];
  return rows[0] ?? null;
};

// ---------------------------------------------------------------------------
// Hooks (server-side extension code, run in the functions sandbox)
// ---------------------------------------------------------------------------

const isEnabled = (row: ExtensionRow): boolean =>
  row.enabled === true || row.enabled === 1;

const matchesPattern = (
  pattern: string | undefined,
  channel: string,
  event: string,
): boolean => {
  if (!pattern) return false;
  const target = `${channel}:${event}`;
  if (pattern === target || pattern === channel) return true;
  const parts = pattern.split(":");
  const targetParts = target.split(":");
  if (parts.length > targetParts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "*") continue;
    if (parts[i] !== targetParts[i]) return false;
  }
  return true;
};

export const invokeExtensionHook = async (
  ctx: Ctx,
  row: ExtensionRow,
  hookId: string,
  auth: AuthSubject,
  data: unknown,
): Promise<SandboxResult> => {
  const hook = (row.manifest.contributes.hooks ?? []).find(
    (h) => h.id === hookId,
  );
  if (!hook) throw new AppError("NOT_FOUND", `hook not found: ${hookId}`);
  const asset = await getAsset(ctx, row.id, hook.entry);
  if (!asset) throw new AppError("NOT_FOUND", `hook entry missing: ${hook.entry}`);
  return runFunction(
    asset.content,
    { ctx, auth },
    data,
    hook.timeoutMs ?? 5000,
  );
};

/** A cron-triggered hook of an enabled extension, across ALL workspaces —
 *  the scheduler tick consumes this and carries each row's own tenantId into
 *  the invocation, mirroring the cron-functions scan. */
export const listCronExtensionHooks = async (
  ctx: DbCtx,
): Promise<
  { row: ExtensionRow; hook: { id: string; pattern?: string; timeoutMs?: number } }[]
> => {
  const t = tableFor(ctx.dialect);
  const rows = (await (ctx.db as any)
    .select()
    .from(t)
    .where(eq(t.enabled, true))) as ExtensionRow[];
  const out: {
    row: ExtensionRow;
    hook: { id: string; pattern?: string; timeoutMs?: number };
  }[] = [];
  for (const raw of rows) {
    const row = parseManifest(raw);
    for (const hook of row.manifest.contributes.hooks ?? []) {
      if (hook.trigger === "cron") out.push({ row, hook });
    }
  }
  return out;
};

/**
 * Event fan-out twin of runEventFunctions — called from publishEvent for every
 * item event, runs matching `trigger: "event"` hooks of enabled extensions
 * with the system principal. Fire-and-forget per hook; a crashing extension
 * must never break the write path.
 */
export const runExtensionEventHooks = async (
  ctx: Ctx,
  tenantId: string | null,
  channel: string,
  payload: { event: string; data: Record<string, unknown> },
  auth: AuthSubject,
): Promise<void> => {
  if (!tenantId) return;
  const rows = await listExtensions(ctx, tenantId);
  const jobs: { row: ExtensionRow; hookId: string }[] = [];
  for (const row of rows) {
    if (!isEnabled(row)) continue;
    for (const hook of row.manifest.contributes.hooks ?? []) {
      if (hook.trigger !== "event") continue;
      if (!matchesPattern(hook.pattern, channel, payload.event)) continue;
      jobs.push({ row, hookId: hook.id });
    }
  }
  if (jobs.length === 0) return;
  await Promise.all(
    jobs.map(async ({ row, hookId }) => {
      try {
        const result = await invokeExtensionHook(
          ctx,
          row,
          hookId,
          { ...auth, tenantId },
          payload,
        );
        if (!result.ok) {
          console.error(`[ext:${row.name}:${hookId}] error: ${result.error}`);
        } else if (result.logs.length > 0) {
          console.log(
            `[ext:${row.name}:${hookId}] logs:\n${result.logs.join("\n")}`,
          );
        }
      } catch (e) {
        console.error(`[ext:${row.name}:${hookId}] crashed`, e);
      }
    }),
  );
};
