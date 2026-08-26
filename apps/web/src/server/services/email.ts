import { and, eq, isNull, or } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError, renderTemplate, htmlToText, type EmailAttachment } from "@backlex/core";
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
  /** Files to attach. Independent of the template — a calendar invite rides
   *  along with whatever body the template produced. */
  attachments?: EmailAttachment[];
}

export interface SendTemplatedResult {
  sent: boolean;
  templateKey: string | null;
  /** True when a template was found and used; false when fallback rendered. */
  templateApplied: boolean;
  /**
   * Set when attachments were requested and the configured transport cannot
   * carry them, so the caller can say the mail went WITHOUT its invite.
   *
   * The mail is still sent. A booking confirmation that never arrives because
   * its calendar file could not travel is the worse of the two failures.
   */
  attachmentsDropped?: boolean;
}

/** Base64 with optional padding, and nothing else — no whitespace, no
 *  `data:` prefix, no raw text that merely happens to be alphanumeric. */
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Refuse an attachment whose `content` is not base64.
 *
 * Loud rather than lenient on purpose. A transport hands the DECODED bytes to
 * its provider, so raw text is not "mostly fine" — it is a file the recipient
 * cannot open, and the failure surfaces days later as "the calendar invite
 * didn't work" with nothing in a log to point at.
 */
const assertBase64Attachment = (a: EmailAttachment): void => {
  const packed = a.content.replace(/\s+/g, "");
  if (!packed || !BASE64_ONLY.test(packed)) {
    throw new AppError(
      "INTERNAL",
      `Attachment "${a.filename}" must be base64 (see EmailAttachment.content) — it looks like raw content.`,
    );
  }
};

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

  // `attachments === false` is an explicit "I would drop this". An adapter that
  // says nothing is assumed to support them, which is true of every transport
  // in this repo bar the managed-cloud gateway.
  const wanted = opts.attachments ?? [];
  // `EmailAttachment.content` is documented as base64, and until this check the
  // only thing enforcing it was the managed-cloud mail gateway — which meant a
  // caller that forgot got a corrupt file on every self-hosted transport and a
  // 500 on cloud, *after* whatever it was confirming had already been written.
  // Booking did exactly that. One check here, in front of every transport, so
  // the mistake is named the same way everywhere instead of depending on where
  // the deployment happens to send its mail from.
  for (const a of wanted) assertBase64Attachment(a);
  const attachmentsDropped = wanted.length > 0 && transport.attachments === false;
  const attachments = attachmentsDropped ? undefined : wanted.length > 0 ? wanted : undefined;

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
      ...(attachments ? { attachments } : {}),
    });
    return {
      sent: true,
      templateKey: opts.templateKey ?? null,
      templateApplied: true,
      ...(attachmentsDropped ? { attachmentsDropped } : {}),
    };
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
    ...(attachments ? { attachments } : {}),
  });
  return {
    sent: true,
    templateKey: opts.templateKey ?? null,
    templateApplied: false,
    ...(attachmentsDropped ? { attachmentsDropped } : {}),
  };
};
