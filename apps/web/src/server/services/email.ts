import { and, eq, isNull, or } from "drizzle-orm";
import * as pg from "@workeros/db/pg";
import * as sqlite from "@workeros/db/sqlite";
import { renderTemplate, htmlToText } from "@workeros/core";
import type { Ctx } from "../context";

const tableFor = (dialect: "pg" | "sqlite") =>
  dialect === "pg" ? pg.schema.emailTemplates : sqlite.schema.emailTemplates;

interface TemplateRow {
  id: string;
  tenantId: string | null;
  key: string;
  subject: string;
  fromAddress: string | null;
  bodyHtml: string;
  bodyText: string | null;
}

/**
 * Resolve a template by key with tenant override → global (`tenant_id IS NULL`)
 * fallback. Returns null if neither exists.
 */
export const resolveTemplate = async (
  ctx: Ctx,
  key: string,
  tenantId: string | null,
): Promise<TemplateRow | null> => {
  const t = tableFor(ctx.dialect);
  const where =
    tenantId == null
      ? and(eq(t.key, key), isNull(t.tenantId))
      : and(eq(t.key, key), or(eq(t.tenantId, tenantId), isNull(t.tenantId)));
  const rows = (await (ctx.db as any).select().from(t).where(where)) as TemplateRow[];
  if (rows.length === 0) return null;
  // Prefer the tenant-specific override over the global fallback.
  rows.sort((a, b) => {
    if (a.tenantId === tenantId && b.tenantId !== tenantId) return -1;
    if (b.tenantId === tenantId && a.tenantId !== tenantId) return 1;
    return 0;
  });
  return rows[0]!;
};

export interface SendTemplatedOptions {
  to: string;
  templateKey?: string;
  tenantId?: string | null;
  /** Variables available to `{{ ... }}` placeholders in the template body. */
  vars?: Record<string, unknown>;
  /** Used when no `templateKey` is given OR the template can't be resolved. */
  fallback?: {
    subject?: string;
    html?: string;
    text?: string;
    from?: string;
  };
}

export interface SendTemplatedResult {
  sent: boolean;
  templateKey: string | null;
  /** True when a template was found and used; false when fallback rendered. */
  templateApplied: boolean;
}

/**
 * Send an email through a stored template (with optional fallback). Centralizes
 * tenant lookup + render so flows, send-test, and any future system mailers
 * share the same wire format. Throws if neither a template nor fallback yields
 * a renderable subject + body.
 */
export const sendTemplatedEmail = async (
  ctx: Ctx,
  opts: SendTemplatedOptions,
): Promise<SendTemplatedResult> => {
  const vars = opts.vars ?? {};
  const tenantId = opts.tenantId ?? null;
  const transport = await ctx.emailFor(tenantId);

  let tpl: TemplateRow | null = null;
  if (opts.templateKey) {
    tpl = await resolveTemplate(ctx, opts.templateKey, tenantId);
  }

  if (tpl) {
    const subject = renderTemplate(tpl.subject, vars);
    const html = renderTemplate(tpl.bodyHtml, vars);
    const text = tpl.bodyText
      ? renderTemplate(tpl.bodyText, vars)
      : htmlToText(html);
    await transport.send({
      to: opts.to,
      from: tpl.fromAddress ?? opts.fallback?.from ?? undefined,
      subject,
      html,
      text,
    });
    return { sent: true, templateKey: opts.templateKey ?? null, templateApplied: true };
  }

  const fb = opts.fallback ?? {};
  const subject = fb.subject ? renderTemplate(fb.subject, vars) : undefined;
  const html = fb.html ? renderTemplate(fb.html, vars) : undefined;
  const text = fb.text
    ? renderTemplate(fb.text, vars)
    : html
      ? htmlToText(html)
      : undefined;

  if (!subject || (!text && !html)) {
    throw new Error(
      opts.templateKey
        ? `Email template "${opts.templateKey}" not found and no fallback provided`
        : "sendTemplatedEmail requires a templateKey or a fallback with subject + body",
    );
  }

  await transport.send({
    to: opts.to,
    from: fb.from,
    subject,
    html,
    text: text ?? "",
  });
  return { sent: true, templateKey: opts.templateKey ?? null, templateApplied: false };
};
