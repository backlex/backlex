/**
 * Document generation — a row plus a stored HTML template becomes a PDF.
 *
 * Fourteen of the schema templates carry documents (contracts, agreements,
 * quotes, invoices, offers), and until now backlex could hold the data for one
 * and never produce the artefact. The renderer itself lives behind
 * {@link Ctx.pdf}; this module owns the part that is ours — resolving a
 * template, interpolating it against a row, and handing the bytes somewhere
 * useful.
 *
 * Templates resolve exactly like `email_templates`: a workspace row overrides
 * an instance-wide one with the same key. That is deliberate reuse of a rule
 * operators here already know rather than a second, subtly different one.
 */
import { and, asc, eq, isNull, or } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError, renderTemplate, type PdfPageOptions } from "@backlex/core";
import type { Ctx } from "../context";

type AnyDb = any;

const tableFor = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.documentTemplates
    : sqlite.schema.documentTemplates) as typeof pg.schema.documentTemplates;

export interface DocumentTemplateRow {
  id: string;
  tenantId: string | null;
  key: string;
  name: string;
  description: string | null;
  bodyHtml: string;
  headerHtml: string | null;
  footerHtml: string | null;
  pageOptions: Record<string, unknown> | null;
  filename: string | null;
  variables: string[] | null;
  updatedBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export const toPublicTemplate = (row: DocumentTemplateRow) => ({
  id: row.id,
  key: row.key,
  name: row.name,
  description: row.description,
  bodyHtml: row.bodyHtml,
  headerHtml: row.headerHtml,
  footerHtml: row.footerHtml,
  pageOptions: (row.pageOptions ?? {}) as PdfPageOptions,
  filename: row.filename,
  variables: row.variables ?? [],
  /** True for an instance-wide row a workspace has not overridden. Editing one
   *  from a workspace creates the override rather than changing the shared
   *  default, so the UI needs to know which it is looking at. */
  inherited: row.tenantId === null,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export type PublicDocumentTemplate = ReturnType<typeof toPublicTemplate>;

/** Longest document a single render may produce, in bytes. A generated
 *  contract is tens of kilobytes; anything past this is a runaway template
 *  (an unbounded loop over a relation) rather than a long document. */
export const MAX_PDF_BYTES = 20 * 1024 * 1024;

// ── Template CRUD ────────────────────────────────────────────────────────────

export async function listTemplates(
  ctx: Ctx,
  tenantId: string | null,
): Promise<PublicDocumentTemplate[]> {
  const t = tableFor(ctx.dialect);
  const where =
    tenantId == null ? isNull(t.tenantId) : or(eq(t.tenantId, tenantId), isNull(t.tenantId));
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(where)
    .orderBy(asc(t.key))) as DocumentTemplateRow[];

  // A workspace override hides the instance-wide row with the same key, rather
  // than both appearing and the operator having to know which one renders.
  const byKey = new Map<string, DocumentTemplateRow>();
  for (const row of rows) {
    const existing = byKey.get(row.key);
    if (!existing || (existing.tenantId === null && row.tenantId !== null)) byKey.set(row.key, row);
  }
  return [...byKey.values()].map(toPublicTemplate);
}

/** Resolve one key: the workspace's own row wins over the instance default. */
export async function resolveTemplate(
  ctx: Ctx,
  key: string,
  tenantId: string | null,
): Promise<DocumentTemplateRow | null> {
  const t = tableFor(ctx.dialect);
  const where =
    tenantId == null
      ? and(eq(t.key, key), isNull(t.tenantId))
      : and(eq(t.key, key), or(eq(t.tenantId, tenantId), isNull(t.tenantId)));
  const rows = (await (ctx.db as AnyDb).select().from(t).where(where)) as DocumentTemplateRow[];
  if (rows.length === 0) return null;
  rows.sort((a, b) => (a.tenantId === tenantId ? -1 : b.tenantId === tenantId ? 1 : 0));
  return rows[0]!;
}

export interface UpsertTemplateInput {
  key: string;
  name?: string;
  description?: string | null;
  bodyHtml?: string;
  headerHtml?: string | null;
  footerHtml?: string | null;
  pageOptions?: PdfPageOptions | null;
  filename?: string | null;
  variables?: string[] | null;
}

/**
 * Create or update a workspace's template.
 *
 * Always writes a row scoped to `tenantId`, even when the caller was reading an
 * inherited one — editing a shared default from inside one workspace must not
 * change what every other workspace renders.
 */
export async function upsertTemplate(
  ctx: Ctx,
  tenantId: string | null,
  input: UpsertTemplateInput,
  updatedBy?: string | null,
): Promise<PublicDocumentTemplate> {
  const key = input.key?.trim();
  if (!key) throw new AppError("VALIDATION", "A document template needs a key");

  const t = tableFor(ctx.dialect);
  const [own] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(
      tenantId == null ? and(eq(t.key, key), isNull(t.tenantId)) : and(eq(t.key, key), eq(t.tenantId, tenantId)),
    )) as DocumentTemplateRow[];

  const now = new Date();
  if (own) {
    const set: Record<string, unknown> = { updatedAt: now, updatedBy: updatedBy ?? null };
    if (input.name !== undefined) set.name = input.name;
    if (input.description !== undefined) set.description = input.description;
    if (input.bodyHtml !== undefined) set.bodyHtml = input.bodyHtml;
    if (input.headerHtml !== undefined) set.headerHtml = input.headerHtml;
    if (input.footerHtml !== undefined) set.footerHtml = input.footerHtml;
    if (input.pageOptions !== undefined) set.pageOptions = input.pageOptions;
    if (input.filename !== undefined) set.filename = input.filename;
    if (input.variables !== undefined) set.variables = input.variables;
    await (ctx.db as AnyDb).update(t).set(set).where(eq(t.id, own.id));
  } else {
    if (!input.bodyHtml?.trim()) {
      throw new AppError("VALIDATION", "A new document template needs a body");
    }
    await (ctx.db as AnyDb).insert(t).values({
      id: crypto.randomUUID(),
      tenantId,
      key,
      name: input.name?.trim() || key,
      description: input.description ?? null,
      bodyHtml: input.bodyHtml,
      headerHtml: input.headerHtml ?? null,
      footerHtml: input.footerHtml ?? null,
      pageOptions: input.pageOptions ?? null,
      filename: input.filename ?? null,
      variables: input.variables ?? null,
      updatedBy: updatedBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const row = await resolveTemplate(ctx, key, tenantId);
  if (!row) throw new Error("document template missing after write");
  return toPublicTemplate(row);
}

/** Delete a workspace's own row. An inherited default is not deletable from
 *  inside a workspace — there is nothing there to delete, and silently doing
 *  nothing would read as a broken button. */
export async function deleteTemplate(ctx: Ctx, tenantId: string | null, key: string): Promise<void> {
  const t = tableFor(ctx.dialect);
  const where =
    tenantId == null ? and(eq(t.key, key), isNull(t.tenantId)) : and(eq(t.key, key), eq(t.tenantId, tenantId));
  const [own] = (await (ctx.db as AnyDb).select().from(t).where(where)) as DocumentTemplateRow[];
  if (!own) throw new AppError("NOT_FOUND", `No document template "${key}" in this workspace`);
  await (ctx.db as AnyDb).delete(t).where(eq(t.id, own.id));
}

// ── Rendering ────────────────────────────────────────────────────────────────

export interface RenderDocumentInput {
  /** A stored template's key. Omit when passing `html` directly. */
  templateKey?: string;
  /** A complete HTML document, for a caller that has one already. */
  html?: string;
  /** Values available to `{{ … }}` in the template. */
  vars?: Record<string, unknown>;
  /** Overrides the template's own page setup, field by field. */
  pageOptions?: PdfPageOptions;
  /** Overrides the template's suggested filename. Templated. */
  filename?: string;
}

export interface RenderedDocument {
  bytes: Uint8Array;
  filename: string;
  contentType: "application/pdf";
  /** Which renderer produced it, for diagnostics. */
  renderer: string;
}

/** Strip anything that would make a filename mean something to a filesystem or
 *  a header. It is templated from row data, so it is not the author's literal. */
export const safeFilename = (name: string): string => {
  const cleaned = name
    .replace(/[\r\n"\\]/g, "")
    // A path separator here would decide where the object is written.
    .replace(/[/\\]/g, "-")
    .replace(/\.\.+/g, ".")
    // A name starting with a dot is a hidden file on every unix host that ends
    // up handling it, which is not what anyone typing an invoice number meant.
    .replace(/^[.\-\s]+/, "")
    .trim();
  const base = cleaned || "document";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
};

/**
 * Render a document to PDF bytes.
 *
 * Refuses rather than degrades when no renderer is configured. There is no
 * fallback that both works everywhere and renders Turkish correctly (see the
 * adapter contract), and a contract with the customer's name mangled is worse
 * than a run that stopped and said why.
 */
export async function renderDocument(
  ctx: Ctx,
  tenantId: string | null,
  input: RenderDocumentInput,
): Promise<RenderedDocument> {
  if (!ctx.pdf) {
    throw new AppError(
      "VALIDATION",
      "No PDF renderer is configured — set PDF_CF_ACCOUNT_ID + PDF_CF_API_TOKEN, or PDF_GOTENBERG_URL",
    );
  }

  const vars = input.vars ?? {};
  let bodyHtml = input.html;
  let headerHtml: string | undefined;
  let footerHtml: string | undefined;
  let pageOptions: PdfPageOptions = {};
  let filename = input.filename;

  if (input.templateKey) {
    const tpl = await resolveTemplate(ctx, input.templateKey, tenantId);
    if (!tpl) throw new AppError("NOT_FOUND", `Document template "${input.templateKey}" not found`);
    bodyHtml = tpl.bodyHtml;
    headerHtml = tpl.headerHtml ?? undefined;
    footerHtml = tpl.footerHtml ?? undefined;
    pageOptions = (tpl.pageOptions ?? {}) as PdfPageOptions;
    filename = filename ?? tpl.filename ?? undefined;
  }
  if (!bodyHtml?.trim()) {
    throw new AppError("VALIDATION", "renderDocument needs a templateKey or html");
  }

  const opts: PdfPageOptions = {
    ...pageOptions,
    ...input.pageOptions,
    ...(headerHtml ? { headerHtml: renderTemplate(headerHtml, vars) } : {}),
    ...(footerHtml ? { footerHtml: renderTemplate(footerHtml, vars) } : {}),
  };

  const bytes = await ctx.pdf.render(renderTemplate(bodyHtml, vars), opts);
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new AppError(
      "VALIDATION",
      `Rendered document is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, past the ${MAX_PDF_BYTES / 1024 / 1024}MB ceiling`,
    );
  }

  return {
    bytes,
    filename: safeFilename(renderTemplate(filename ?? "document.pdf", vars)),
    contentType: "application/pdf",
    renderer: ctx.pdf.name,
  };
}
