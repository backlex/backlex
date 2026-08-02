/**
 * E-signature — the document #28 renders, actually signed.
 *
 * Five of the schema templates end in a signature (rental `agreements`,
 * field-service and fleet `contracts`, real-estate `offers`, legal
 * `documents`), and the artefact backlex could already produce was the exact
 * thing those flows were waiting on. This is the native path: a public link per
 * signer, a signature drawn or typed in the browser, and a re-rendered PDF that
 * carries the signatures plus a certificate of who signed from where and when.
 *
 * Three properties the design is built around, in order of how much they cost
 * to get wrong:
 *
 * 1. **What was sent is what is signed.** The interpolated HTML is SNAPSHOT
 *    onto the request at send time. Re-deriving it from the template and the
 *    row at signing time would mean an edit to either — a corrected price, a
 *    renamed customer — silently changes the document under somebody who
 *    already read it. The snapshot also makes the signed PDF reproducible
 *    forever, after the row is deleted and the template rewritten.
 * 2. **The token is the only grant, so it is never at rest.** Only its SHA-256
 *    is stored, exactly like a form token or a share link. It reaches the
 *    signer in one email and appears nowhere else — notably NOT on the flow
 *    op's result, which is persisted in the run log (see `document.sign`).
 * 3. **Signing is one-shot per signer.** The transition is a conditional
 *    UPDATE guarded on the current status and confirmed by `.returning()`, so
 *    a double-submitted form or a retried request cannot produce two
 *    signatures, two certificates or two completion emails.
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import * as pg from "@backlex/db/pg";
import * as sqlite from "@backlex/db/sqlite";
import { AppError, renderTemplate, type PdfPageOptions } from "@backlex/core";
import type { Ctx } from "../context";
import { MAX_PDF_BYTES, resolveTemplate, safeFilename } from "./documents";
import { hashToken } from "./shared-links";
import { updateItem } from "./items-helpers";
import { sendTemplatedEmail } from "./email";

type AnyDb = any;

const requestsTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.signatureRequests
    : sqlite.schema.signatureRequests) as typeof pg.schema.signatureRequests;

const signersTable = (dialect: "pg" | "sqlite") =>
  (dialect === "pg"
    ? pg.schema.signatureSigners
    : sqlite.schema.signatureSigners) as typeof pg.schema.signatureSigners;

const TOKEN_PREFIX = "sig";
const TOKEN_BYTES = 24;

/** How long a link lives when the caller does not say. Long enough for a
 *  contract to go round an office, short enough that a forwarded mail from
 *  last quarter no longer signs anything. */
export const DEFAULT_EXPIRY_DAYS = 30;
export const MAX_EXPIRY_DAYS = 365;

/** A drawn signature is a small PNG — a full-width canvas at 2× is ~30 KB.
 *  The ceiling exists because the value is stored, re-served and interpolated
 *  into HTML handed to a browser, so it is an upload in everything but name. */
export const MAX_SIGNATURE_IMAGE_BYTES = 512 * 1024;
/** A typed signature is a name, not a paragraph. */
export const MAX_SIGNATURE_TEXT = 120;
export const MAX_SIGNERS = 10;
export const MAX_DECLINE_REASON = 500;

export type SignatureStatus = "pending" | "completed" | "declined" | "voided" | "expired";
export type SignerStatus = "pending" | "viewed" | "signed" | "declined";

export interface SignatureRequestRow {
  id: string;
  tenantId: string | null;
  title: string;
  message: string | null;
  templateKey: string | null;
  bodyHtml: string;
  pageOptions: Record<string, unknown> | null;
  filename: string | null;
  documentHash: string;
  documentKey: string | null;
  signedDocumentKey: string | null;
  signedDocumentHash: string | null;
  status: string;
  ordered: boolean;
  expiresAt: Date | number | null;
  completedAt: Date | number | null;
  voidedAt: Date | number | null;
  voidReason: string | null;
  writeBack: Record<string, unknown> | null;
  notifyEmails: string[] | null;
  createdBy: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

export interface SignatureSignerRow {
  id: string;
  requestId: string;
  email: string;
  name: string | null;
  role: string | null;
  orderIndex: number;
  tokenHash: string;
  status: string;
  sentAt: Date | number | null;
  viewedAt: Date | number | null;
  signedAt: Date | number | null;
  declinedAt: Date | number | null;
  declineReason: string | null;
  signatureKind: string | null;
  signatureImage: string | null;
  signatureText: string | null;
  consentText: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date | number | null;
  updatedAt: Date | number | null;
}

const asMs = (v: Date | number | null | undefined): number | null =>
  v == null ? null : v instanceof Date ? v.getTime() : Number(v);

/**
 * Expiry is DERIVED, never written.
 *
 * A stored `expired` status would need something to run to become true, and a
 * deployment whose cron is wedged would keep handing out signable links. This
 * way the passage of time alone closes the request, on every surface at once.
 */
export const effectiveStatus = (row: SignatureRequestRow): SignatureStatus => {
  const status = row.status as SignatureStatus;
  if (status !== "pending") return status;
  const expires = asMs(row.expiresAt);
  return expires != null && expires <= Date.now() ? "expired" : "pending";
};

export const toPublicSigner = (row: SignatureSignerRow) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  order: row.orderIndex,
  status: row.status as SignerStatus,
  sentAt: row.sentAt,
  viewedAt: row.viewedAt,
  signedAt: row.signedAt,
  declinedAt: row.declinedAt,
  declineReason: row.declineReason,
  signatureKind: row.signatureKind,
  /** The captured image is deliberately absent: a signature is reusable
   *  evidence, so the admin list has no reason to hand it around. It exists on
   *  the certificate page of the signed PDF, where it belongs. */
  ip: row.ip,
  userAgent: row.userAgent,
});

export const toPublicRequest = (
  row: SignatureRequestRow,
  signers: SignatureSignerRow[],
  opts: { includeHtml?: boolean } = {},
) => ({
  id: row.id,
  title: row.title,
  message: row.message,
  templateKey: row.templateKey,
  status: effectiveStatus(row),
  ordered: row.ordered,
  documentHash: row.documentHash,
  documentKey: row.documentKey,
  signedDocumentKey: row.signedDocumentKey,
  signedDocumentHash: row.signedDocumentHash,
  filename: row.filename,
  expiresAt: row.expiresAt,
  completedAt: row.completedAt,
  voidedAt: row.voidedAt,
  voidReason: row.voidReason,
  writeBack: (row.writeBack ?? null) as { collection: string; id: string; field: string } | null,
  notifyEmails: row.notifyEmails ?? [],
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  signers: signers.map(toPublicSigner),
  ...(opts.includeHtml ? { bodyHtml: row.bodyHtml } : {}),
});

export type PublicSignatureRequest = ReturnType<typeof toPublicRequest>;

// ── helpers ──────────────────────────────────────────────────────────────────

const randomHex = (bytes: number): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
};

const sha256Hex = async (data: Uint8Array | string): Promise<string> => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );

/** Deliberately permissive but structural — the address has to survive being
 *  put in a `To:` header, and anything cleverer rejects real addresses. */
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;

export const normalizeEmail = (raw: unknown, what = "signer"): string => {
  const email = String(raw ?? "").trim();
  if (!EMAIL_RE.test(email)) throw new AppError("VALIDATION", `"${email}" is not a valid ${what} email`);
  return email;
};

/**
 * Validate a drawn signature and re-emit it in canonical form.
 *
 * The value arrives from an unauthenticated browser and ends up interpolated
 * into HTML that a headless Chromium is asked to render, so it is parsed
 * rather than trusted: only `image/png`, only base64, only a payload whose
 * decoded prefix is the PNG magic number. Everything else — an `svg+xml` that
 * can carry script, a `data:text/html`, a payload with a quote in it that
 * would close the `src` attribute — is refused here rather than escaped
 * downstream and hoped about.
 */
export const parseSignatureImage = (raw: unknown): string => {
  const value = String(raw ?? "").trim();
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value);
  if (!m?.[1]) {
    throw new AppError("VALIDATION", "A drawn signature must be a data:image/png;base64 value");
  }
  const payload = m[1];
  // 4 base64 chars per 3 bytes — checked before decoding so an oversized
  // payload is refused without being materialised.
  if ((payload.length * 3) / 4 > MAX_SIGNATURE_IMAGE_BYTES) {
    throw new AppError("VALIDATION", "That signature image is too large");
  }
  let bytes: Uint8Array;
  try {
    const bin = atob(payload);
    bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  } catch {
    throw new AppError("VALIDATION", "That signature image is not valid base64");
  }
  const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) {
    // A file that claims png in its data URL and is not one is either a bug in
    // the caller or somebody probing what the renderer will open.
    throw new AppError("VALIDATION", "That signature image is not a PNG");
  }
  return `data:image/png;base64,${payload}`;
};

const loadRequest = async (
  ctx: Ctx,
  id: string,
  tenantId: string | null,
): Promise<SignatureRequestRow | null> => {
  const t = requestsTable(ctx.dialect);
  const where =
    tenantId == null ? and(eq(t.id, id), isNull(t.tenantId)) : and(eq(t.id, id), eq(t.tenantId, tenantId));
  const [row] = (await (ctx.db as AnyDb).select().from(t).where(where)) as SignatureRequestRow[];
  return row ?? null;
};

const loadSigners = async (ctx: Ctx, requestId: string): Promise<SignatureSignerRow[]> => {
  const s = signersTable(ctx.dialect);
  return (await (ctx.db as AnyDb)
    .select()
    .from(s)
    .where(eq(s.requestId, requestId))
    .orderBy(asc(s.orderIndex))) as SignatureSignerRow[];
};

/**
 * Whose turn it is on an ordered request: the first signer, by order, who has
 * not signed. On an unordered request everyone pending may sign at once.
 */
export const isSignersTurn = (
  request: SignatureRequestRow,
  signers: SignatureSignerRow[],
  signerId: string,
): boolean => {
  if (!request.ordered) return true;
  const next = [...signers]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .find((s) => s.status !== "signed" && s.status !== "declined");
  return next?.id === signerId;
};

// ── the signed artefact ──────────────────────────────────────────────────────

/** Where a template may place the signature block itself. Absent, the block is
 *  appended — a template written before this feature existed still signs. */
const SIGNATURE_MARKER = "<!--backlex:signatures-->";

const formatStamp = (value: Date | number | null): string => {
  const ms = asMs(value);
  return ms == null ? "—" : new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
};

/**
 * The signature block and the certificate that backs it.
 *
 * Every interpolated value is escaped, including the ones that came from the
 * operator rather than the signer: a role label typed in the admin is still
 * arbitrary text arriving in a document a browser will execute. The image is
 * the one exception and it is not an exception at all — `parseSignatureImage`
 * has already reduced it to a base64 PNG payload.
 */
export const buildSignatureBlock = (
  request: SignatureRequestRow,
  signers: SignatureSignerRow[],
): string => {
  const signed = [...signers].sort((a, b) => a.orderIndex - b.orderIndex);
  const cell = (s: SignatureSignerRow): string => {
    const mark =
      s.signatureKind === "drawn" && s.signatureImage
        ? `<img src="${s.signatureImage}" alt="" style="max-height:60px;max-width:230px" />`
        : `<span style="font-family:'Segoe Script','Bradley Hand',cursive;font-size:26px">${escapeHtml(
            s.signatureText ?? "",
          )}</span>`;
    return `<td style="padding:0 18px 0 0;vertical-align:bottom;width:50%">
  <div style="min-height:64px;display:flex;align-items:flex-end">${mark}</div>
  <div style="border-top:1px solid #333;margin-top:4px;padding-top:4px;font-size:12px;line-height:1.5">
    <strong>${escapeHtml(s.name || s.email)}</strong>${s.role ? ` — ${escapeHtml(s.role)}` : ""}<br />
    ${escapeHtml(s.email)}<br />
    ${escapeHtml(formatStamp(s.signedAt))}
  </div>
</td>`;
  };

  // Two per row: a contract signed by two parties reads as two columns, and
  // more than that in one row stops fitting on A4.
  const rows: string[] = [];
  for (let i = 0; i < signed.length; i += 2) {
    rows.push(`<tr>${signed.slice(i, i + 2).map(cell).join("")}</tr>`);
  }

  const audit = signed
    .map(
      (s) => `<tr>
  <td>${escapeHtml(s.name || s.email)}</td>
  <td>${escapeHtml(s.email)}</td>
  <td>${escapeHtml(formatStamp(s.signedAt))}</td>
  <td>${escapeHtml(s.ip ?? "—")}</td>
</tr>`,
    )
    .join("");

  // Every DISTINCT wording that was agreed to, not just the first. Two signers
  // can be shown the sentence in different languages, and a certificate that
  // quotes one of them under-states what the other actually agreed to.
  const consents = [...new Set(signed.map((s) => s.consentText).filter(Boolean))] as string[];

  return `
<div style="page-break-inside:avoid;margin-top:36px">
  <table style="width:100%;border-collapse:collapse">${rows.join("")}</table>
</div>
<div style="page-break-before:always;font-family:system-ui,sans-serif;font-size:11px;color:#222">
  <h2 style="font-size:15px;margin:0 0 4px">Signature certificate</h2>
  <p style="margin:0 0 12px;color:#666">Document ${escapeHtml(request.title)} · request ${escapeHtml(
    request.id,
  )}</p>
  <table style="width:100%;border-collapse:collapse;font-size:11px" border="1" cellpadding="5">
    <thead><tr style="background:#f2f2f2">
      <th align="left">Signer</th><th align="left">Email</th><th align="left">Signed (UTC)</th><th align="left">IP</th>
    </tr></thead>
    <tbody>${audit}</tbody>
  </table>
  <p style="margin:12px 0 0;word-break:break-all">
    Document hash (SHA-256): <code>${escapeHtml(request.documentHash)}</code>
  </p>
  ${consents
    .map((line) => `<p style="margin:8px 0 0;color:#666">${escapeHtml(line)}</p>`)
    .join("")}
</div>`;
};

/** The snapshot with the signatures placed in it — the exact HTML the signed
 *  PDF is rendered from, and the thing to look at when one comes out wrong. */
export const buildSignedHtml = (
  request: SignatureRequestRow,
  signers: SignatureSignerRow[],
): string => {
  const block = buildSignatureBlock(request, signers);
  if (request.bodyHtml.includes(SIGNATURE_MARKER)) {
    return request.bodyHtml.replace(SIGNATURE_MARKER, block);
  }
  const idx = request.bodyHtml.toLowerCase().lastIndexOf("</body>");
  return idx === -1
    ? request.bodyHtml + block
    : `${request.bodyHtml.slice(0, idx)}${block}${request.bodyHtml.slice(idx)}`;
};

const renderAndStore = async (
  ctx: Ctx,
  tenantId: string | null,
  html: string,
  pageOptions: PdfPageOptions,
  filename: string,
): Promise<{ key: string; hash: string; size: number }> => {
  if (!ctx.pdf) {
    throw new AppError(
      "VALIDATION",
      "No PDF renderer is configured — set PDF_CF_ACCOUNT_ID + PDF_CF_API_TOKEN, or PDF_GOTENBERG_URL",
    );
  }
  const bytes = await ctx.pdf.render(html, pageOptions);
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new AppError(
      "VALIDATION",
      `Rendered document is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, past the ${
        MAX_PDF_BYTES / 1024 / 1024
      }MB ceiling`,
    );
  }
  // Same prefix and the same random-key rule as `document.render`: a filename
  // comes from row data, so deriving the object path from it would let whoever
  // filled in the row choose where the object lands.
  const key = `documents/${tenantId ?? "shared"}/${crypto.randomUUID()}/${filename}`;
  const stored = await ctx.storage.put({ key, body: bytes, contentType: "application/pdf" });
  return { key, hash: await sha256Hex(bytes), size: stored.size };
};

// ── creating a request ───────────────────────────────────────────────────────

export interface SignerInput {
  email: string;
  name?: string | null;
  role?: string | null;
}

export interface CreateSignatureInput {
  title?: string;
  message?: string | null;
  /** A stored document template's key… */
  templateKey?: string;
  /** …or a complete HTML document, for a caller that has one already. */
  html?: string;
  vars?: Record<string, unknown>;
  pageOptions?: PdfPageOptions;
  filename?: string;
  signers: SignerInput[];
  ordered?: boolean;
  expiresInDays?: number;
  writeBack?: { collection: string; id: string; field: string } | null;
  notifyEmails?: string[];
  /** Send the invitation now. Off is for a caller that wants the links back
   *  and will deliver them itself. */
  send?: boolean;
}

export interface CreatedSignatureRequest {
  request: PublicSignatureRequest;
  /** Plaintext links, returned EXACTLY ONCE — nothing can reproduce them
   *  afterwards, because only the hashes are stored. */
  links: Array<{ signerId: string; email: string; url: string }>;
  sent: boolean;
}

/**
 * Freeze a document, mint a link per signer, and (by default) email them.
 *
 * The render happens HERE rather than at signing time, and its failure is the
 * whole call's failure. An unconfigured renderer discovered after the signer
 * has read the contract and drawn their name is the worst moment available to
 * find out; discovered while the operator is still looking at the form, it is
 * a message.
 */
export const createSignatureRequest = async (
  ctx: Ctx,
  tenantId: string | null,
  input: CreateSignatureInput,
  createdBy: string | null,
): Promise<CreatedSignatureRequest> => {
  if (!input.templateKey && !input.html?.trim()) {
    throw new AppError("VALIDATION", "A signature request needs a templateKey or html");
  }
  if (input.templateKey && input.html?.trim()) {
    // Same exactly-one-of rule the render endpoint enforces: with both, the
    // inline body would silently beat the stored template.
    throw new AppError("VALIDATION", "Pass a templateKey or html, not both");
  }

  const people = input.signers ?? [];
  if (people.length === 0) throw new AppError("VALIDATION", "A signature request needs at least one signer");
  if (people.length > MAX_SIGNERS) {
    throw new AppError("VALIDATION", `A signature request takes at most ${MAX_SIGNERS} signers`);
  }
  const emails = people.map((p) => normalizeEmail(p.email));
  const seen = new Set<string>();
  for (const email of emails) {
    const lower = email.toLowerCase();
    // Two links to one address is one person signing twice — an ordered
    // request would also deadlock waiting for a turn that already passed.
    if (seen.has(lower)) throw new AppError("VALIDATION", `${email} is listed twice`);
    seen.add(lower);
  }

  const vars = input.vars ?? {};
  let bodyHtml = input.html;
  let headerHtml: string | undefined;
  let footerHtml: string | undefined;
  let pageOptions: PdfPageOptions = {};
  let filename = input.filename;
  let title = input.title?.trim();

  if (input.templateKey) {
    const tpl = await resolveTemplate(ctx, input.templateKey, tenantId);
    if (!tpl) throw new AppError("NOT_FOUND", `Document template "${input.templateKey}" not found`);
    bodyHtml = tpl.bodyHtml;
    headerHtml = tpl.headerHtml ?? undefined;
    footerHtml = tpl.footerHtml ?? undefined;
    pageOptions = (tpl.pageOptions ?? {}) as PdfPageOptions;
    filename = filename ?? tpl.filename ?? undefined;
    title = title || tpl.name;
  }
  if (!bodyHtml?.trim()) throw new AppError("VALIDATION", "A signature request needs a document body");

  // The snapshot. Header and footer are interpolated into it as well and kept
  // on the request, so the signed re-render reproduces the whole page — a
  // running footer that says "page 1 of 3" is part of the document.
  const snapshot = renderTemplate(bodyHtml, vars);
  const frozenOptions: PdfPageOptions = {
    ...pageOptions,
    ...input.pageOptions,
    ...(headerHtml ? { headerHtml: renderTemplate(headerHtml, vars) } : {}),
    ...(footerHtml ? { footerHtml: renderTemplate(footerHtml, vars) } : {}),
  };
  // The hash covers everything the reader sees, not just the body — a value in
  // a running header is document content too.
  const documentHash = await sha256Hex(
    `${snapshot}\0${frozenOptions.headerHtml ?? ""}\0${frozenOptions.footerHtml ?? ""}`,
  );
  const outName = safeFilename(renderTemplate(filename ?? title ?? "document.pdf", vars));

  const stored = await renderAndStore(ctx, tenantId, snapshot, frozenOptions, outName);

  const days = Math.min(Math.max(input.expiresInDays ?? DEFAULT_EXPIRY_DAYS, 1), MAX_EXPIRY_DAYS);
  const now = new Date();
  const id = crypto.randomUUID();
  const t = requestsTable(ctx.dialect);
  await (ctx.db as AnyDb).insert(t).values({
    id,
    tenantId,
    title: title || outName,
    message: input.message ?? null,
    templateKey: input.templateKey ?? null,
    bodyHtml: snapshot,
    pageOptions: frozenOptions as Record<string, unknown>,
    filename: outName,
    documentHash,
    documentKey: stored.key,
    status: "pending",
    ordered: input.ordered ?? false,
    expiresAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
    writeBack: input.writeBack ?? null,
    notifyEmails: (input.notifyEmails ?? []).map((e) => normalizeEmail(e, "notify")),
    createdBy,
    createdAt: now,
    updatedAt: now,
  });

  const s = signersTable(ctx.dialect);
  const links: CreatedSignatureRequest["links"] = [];
  const rows: Record<string, unknown>[] = [];
  for (const [i, person] of people.entries()) {
    const token = `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
    const signerId = crypto.randomUUID();
    rows.push({
      id: signerId,
      requestId: id,
      email: emails[i]!,
      name: person.name?.trim() || null,
      role: person.role?.trim() || null,
      orderIndex: i,
      tokenHash: await hashToken(token),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });
    links.push({ signerId, email: emails[i]!, url: signingUrl(ctx, token) });
  }
  await (ctx.db as AnyDb).insert(s).values(rows);

  const request = (await loadRequest(ctx, id, tenantId))!;
  const signers = await loadSigners(ctx, id);

  let sent = false;
  if (input.send !== false) {
    sent = await sendInvitations(ctx, request, signers, links);
  }
  return { request: toPublicRequest(request, signers), links, sent };
};

export const signingUrl = (ctx: Ctx, token: string): string =>
  `${(ctx.env.APP_URL ?? "").replace(/\/+$/, "")}/sign/${token}`;

/**
 * Email the people whose turn it is.
 *
 * On an ordered request only the next signer is written to — mailing everyone
 * at once would hand out links that answer "it is not your turn yet", which
 * reads as a broken link rather than as a queue.
 */
const sendInvitations = async (
  ctx: Ctx,
  request: SignatureRequestRow,
  signers: SignatureSignerRow[],
  links: Array<{ signerId: string; email: string; url: string }>,
): Promise<boolean> => {
  let any = false;
  for (const link of links) {
    const signer = signers.find((s) => s.id === link.signerId);
    if (!signer || signer.status === "signed" || signer.status === "declined") continue;
    if (!isSignersTurn(request, signers, signer.id)) continue;
    try {
      await sendTemplatedEmail(ctx, {
        to: signer.email,
        templateKey: "signature_request",
        tenantId: request.tenantId,
        vars: {
          title: request.title,
          message: request.message ?? "",
          url: link.url,
          signer: { email: signer.email, name: signer.name ?? "", role: signer.role ?? "" },
          expiresAt: formatStamp(request.expiresAt),
        },
        fallback: {
          subject: `Please sign: ${request.title}`,
          html: `<p>${escapeHtml(signer.name || signer.email)},</p>
<p>${escapeHtml(request.message || `You have been asked to sign "${request.title}".`)}</p>
<p><a href="${escapeHtml(link.url)}">Review and sign</a></p>
<p style="color:#666;font-size:12px">This link is personal to you and expires ${escapeHtml(
            formatStamp(request.expiresAt),
          )}.</p>`,
        },
      });
      any = true;
      const s = signersTable(ctx.dialect);
      await (ctx.db as AnyDb)
        .update(s)
        .set({ sentAt: new Date(), updatedAt: new Date() })
        .where(eq(s.id, signer.id));
    } catch (e) {
      // One bad address must not strand the other signers, and the request
      // itself is already durable — the operator can resend from the admin.
      console.warn(`[signatures] invite to ${signer.email} failed: ${(e as Error).message}`);
    }
  }
  return any;
};

// ── the signing side ─────────────────────────────────────────────────────────

export interface ResolvedSigner {
  request: SignatureRequestRow;
  signer: SignatureSignerRow;
  signers: SignatureSignerRow[];
}

/** Resolve a plaintext link token. Returns null for anything unknown — a
 *  wrong token and a deleted request are the same answer on purpose. */
export const resolveSignerToken = async (ctx: Ctx, token: string): Promise<ResolvedSigner | null> => {
  if (!token || !token.startsWith(`${TOKEN_PREFIX}_`)) return null;
  const tokenHash = await hashToken(token);
  const s = signersTable(ctx.dialect);
  const [signer] = (await (ctx.db as AnyDb)
    .select()
    .from(s)
    .where(eq(s.tokenHash, tokenHash))) as SignatureSignerRow[];
  if (!signer) return null;
  const t = requestsTable(ctx.dialect);
  const [request] = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(eq(t.id, signer.requestId))) as SignatureRequestRow[];
  if (!request) return null;
  return { request, signer, signers: await loadSigners(ctx, request.id) };
};

/** What a signer's page needs, and nothing else. No ids that address anything,
 *  no other signer's email — a counterparty's address is not this signer's to
 *  read just because they share a contract. */
export const signerView = (resolved: ResolvedSigner, locale?: string | null) => {
  const { request, signer, signers } = resolved;
  const status = effectiveStatus(request);
  return {
    title: request.title,
    message: request.message,
    status,
    signerStatus: signer.status as SignerStatus,
    signerName: signer.name,
    signerEmail: signer.email,
    signerRole: signer.role,
    /** False while an earlier signer on an ordered request still owes one. */
    yourTurn: isSignersTurn(request, signers, signer.id),
    signedCount: signers.filter((s) => s.status === "signed").length,
    signerCount: signers.length,
    expiresAt: request.expiresAt,
    documentHash: request.documentHash,
    /** Shown above the sign button, and the exact string the certificate will
     *  quote — the page never composes its own wording. */
    consentText: esignConsentText(locale),
    /** The snapshot itself — the page shows what is being signed, and the
     *  snapshot is exactly that. Rendered in a sandboxed iframe client-side. */
    html: request.bodyHtml,
    completedAt: request.completedAt,
  };
};

export type SignerView = ReturnType<typeof signerView>;

/** Record that the signer opened the link. Best-effort and never blocking —
 *  the timestamp is evidence, not control flow. */
export const markViewed = async (ctx: Ctx, signer: SignatureSignerRow): Promise<void> => {
  if (signer.status !== "pending") return;
  const s = signersTable(ctx.dialect);
  const now = new Date();
  await (ctx.db as AnyDb)
    .update(s)
    .set({ status: "viewed", viewedAt: now, updatedAt: now })
    .where(and(eq(s.id, signer.id), eq(s.status, "pending")));
};

/** Refuse anything that is not an open, in-turn signing slot, with a message
 *  that says which of the several reasons applies. */
const assertSignable = (resolved: ResolvedSigner): void => {
  const status = effectiveStatus(resolved.request);
  if (status === "voided") throw new AppError("GONE", "This request was cancelled");
  if (status === "expired") throw new AppError("GONE", "This signing link has expired");
  if (status === "declined") throw new AppError("GONE", "This request was declined");
  if (status === "completed") throw new AppError("GONE", "This document has already been signed");
  if (resolved.signer.status === "signed") throw new AppError("GONE", "You have already signed this document");
  if (resolved.signer.status === "declined") throw new AppError("GONE", "You declined this document");
  if (!isSignersTurn(resolved.request, resolved.signers, resolved.signer.id)) {
    throw new AppError("FORBIDDEN", "It is not your turn to sign yet — you will be emailed when it is");
  }
};

/**
 * The wording a signer agrees to, and the reason the SERVER owns it.
 *
 * The signing page displays exactly the string the API sends and the
 * certificate quotes exactly that string. If the browser supplied it, the
 * person being held to the signature would be the one choosing what the
 * evidence says they agreed to.
 *
 * It is localised, and that does not weaken the above: the page asks for a
 * language, the server chooses the sentence, and the sentence it chose is what
 * gets stored. Somebody signing a Turkish lease is entitled to agree to
 * something they can read — a consent notice in a language the signer does not
 * speak is weaker evidence than one they do, not stronger.
 */
/** Null-prototype so a language tag cannot reach an inherited member:
 *  `?lang=constructor` on a plain object literal resolves to a function, and
 *  the consent would then travel as a non-bindable value into the signer row. */
const CONSENT_TEXT: Record<string, string> = Object.assign(Object.create(null) as Record<string, string>, {
  en: "By signing, I agree that my electronic signature is the legal equivalent of my handwritten signature on this document.",
  tr: "İmzalayarak, elektronik imzamın bu belgedeki el yazısı imzamla hukuken eşdeğer olduğunu kabul ediyorum.",
});

export const ESIGN_CONSENT_TEXT = CONSENT_TEXT.en!;

/** Resolve a request's language tag to a consent sentence. Region subtags are
 *  dropped (`tr-TR` → `tr`); anything unknown falls back to English rather
 *  than to nothing. */
export const esignConsentText = (locale: string | null | undefined): string => {
  const tag = String(locale ?? "")
    .split(",")[0]!
    .split("-")[0]!
    .trim()
    .toLowerCase();
  return CONSENT_TEXT[tag] ?? ESIGN_CONSENT_TEXT;
};

export interface SignInput {
  kind: "drawn" | "typed";
  /** `data:image/png;base64,…` for the drawn path. */
  image?: string;
  /** The typed name for the keyboard path. */
  text?: string;
  consent: boolean;
}

export interface SignResult {
  status: SignatureStatus;
  signedCount: number;
  signerCount: number;
  /** False when everybody has signed but producing the signed copy failed —
   *  see {@link finalizePendingRequest}. */
  finalized: boolean;
  /** Present once the last signer is in and the copy exists. */
  signedDocumentKey?: string;
}

/**
 * Apply one signature.
 *
 * The write is a conditional UPDATE confirmed by `.returning()`: two requests
 * racing (a double tap, a retried POST) both pass `assertSignable`, and only
 * the one that changes the row proceeds. Without it the loser would go on to
 * finalize a second time — a second render, a second write-back, a second
 * completion email carrying a different PDF.
 */
export const signDocument = async (
  ctx: Ctx,
  resolved: ResolvedSigner,
  input: SignInput,
  meta: { ip: string | null; userAgent: string | null; locale?: string | null },
): Promise<SignResult> => {
  assertSignable(resolved);
  if (!input.consent) {
    throw new AppError("VALIDATION", "Signing requires agreeing to sign electronically");
  }

  let signatureImage: string | null = null;
  let signatureText: string | null = null;
  if (input.kind === "drawn") {
    signatureImage = parseSignatureImage(input.image);
  } else if (input.kind === "typed") {
    const text = String(input.text ?? "").trim();
    if (!text) throw new AppError("VALIDATION", "Type your name to sign");
    if (text.length > MAX_SIGNATURE_TEXT) throw new AppError("VALIDATION", "That name is too long");
    signatureText = text;
  } else {
    throw new AppError("VALIDATION", "A signature is either drawn or typed");
  }

  const now = new Date();
  const s = signersTable(ctx.dialect);
  const claimed = (await (ctx.db as AnyDb)
    .update(s)
    .set({
      status: "signed",
      signedAt: now,
      updatedAt: now,
      signatureKind: input.kind,
      signatureImage,
      signatureText,
      consentText: esignConsentText(meta.locale),
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    })
    .where(and(eq(s.id, resolved.signer.id), inArray(s.status, ["pending", "viewed"])))
    .returning()) as SignatureSignerRow[];
  if (claimed.length === 0) {
    throw new AppError("GONE", "You have already signed this document");
  }

  const signers = await loadSigners(ctx, resolved.request.id);
  const signedCount = signers.filter((x) => x.status === "signed").length;
  if (signedCount < signers.length) {
    // Ordered request: whoever is next needs their link now, not when somebody
    // remembers to chase it.
    if (resolved.request.ordered) await sendNextInvite(ctx, resolved.request, signers);
    return { status: "pending", signedCount, signerCount: signers.length, finalized: false };
  }

  // The signature is already committed above, so a renderer that is down at
  // this exact moment must not undo it — and must not answer the person who
  // just signed with an error either, because their signature DID land. The
  // request stays pending with every signer in, which is what
  // `finalizePendingRequest` picks up.
  let completed: { signedDocumentKey: string | null };
  try {
    completed = await finalizeRequest(ctx, resolved.request, signers);
  } catch (e) {
    console.warn(`[signatures] finalize for ${resolved.request.id} failed: ${(e as Error).message}`);
    return { status: "pending", signedCount, signerCount: signers.length, finalized: false };
  }
  return {
    status: "completed",
    signedCount,
    signerCount: signers.length,
    finalized: true,
    ...(completed.signedDocumentKey ? { signedDocumentKey: completed.signedDocumentKey } : {}),
  };
};

/**
 * An ordered request cannot email the next signer at creation time — their
 * link would be live before the document had the signature above theirs. So it
 * is minted and sent here, on the transition.
 */
const sendNextInvite = async (
  ctx: Ctx,
  request: SignatureRequestRow,
  signers: SignatureSignerRow[],
): Promise<void> => {
  const next = [...signers]
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .find((x) => x.status !== "signed" && x.status !== "declined");
  if (!next || next.sentAt) return;
  const token = `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const s = signersTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(s)
    .set({ tokenHash: await hashToken(token), updatedAt: new Date() })
    .where(eq(s.id, next.id));
  await sendInvitations(ctx, request, signers, [
    { signerId: next.id, email: next.email, url: signingUrl(ctx, token) },
  ]);
};

export const declineDocument = async (
  ctx: Ctx,
  resolved: ResolvedSigner,
  reason: string | null,
): Promise<{ status: SignatureStatus }> => {
  assertSignable(resolved);
  const now = new Date();
  const s = signersTable(ctx.dialect);
  const claimed = (await (ctx.db as AnyDb)
    .update(s)
    .set({
      status: "declined",
      declinedAt: now,
      updatedAt: now,
      declineReason: reason?.trim().slice(0, MAX_DECLINE_REASON) || null,
    })
    .where(and(eq(s.id, resolved.signer.id), inArray(s.status, ["pending", "viewed"])))
    .returning()) as SignatureSignerRow[];
  if (claimed.length === 0) throw new AppError("GONE", "This link is no longer open");

  // One refusal ends the request. A contract two of three people signed is not
  // a partially valid contract, and leaving it open would keep the remaining
  // links live against a document nobody can complete.
  const t = requestsTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({ status: "declined", updatedAt: now })
    .where(and(eq(t.id, resolved.request.id), eq(t.status, "pending")));
  return { status: "declined" };
};

/**
 * Everybody has signed: render the signed artefact, store it, write it back
 * and tell people.
 *
 * The write-back and the emails are deliberately AFTER the PDF is stored and
 * the row updated — a run that dies mid-way leaves a completed request with a
 * document, which is recoverable, rather than a notified counterparty and no
 * artefact, which is not.
 */
export const finalizeRequest = async (
  ctx: Ctx,
  request: SignatureRequestRow,
  signers: SignatureSignerRow[],
): Promise<{ signedDocumentKey: string | null }> => {
  const html = buildSignedHtml(request, signers);
  const filename = safeFilename(`signed-${request.filename ?? "document.pdf"}`);
  const stored = await renderAndStore(
    ctx,
    request.tenantId,
    html,
    (request.pageOptions ?? {}) as PdfPageOptions,
    filename,
  );

  const now = new Date();
  const t = requestsTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({
      status: "completed",
      completedAt: now,
      updatedAt: now,
      signedDocumentKey: stored.key,
      signedDocumentHash: stored.hash,
    })
    .where(eq(t.id, request.id));

  const writeBack = request.writeBack as { collection?: string; id?: string; field?: string } | null;
  if (writeBack?.collection && writeBack.id && writeBack.field && request.tenantId) {
    try {
      await updateItem(ctx, {
        slug: writeBack.collection,
        tenantId: request.tenantId,
        id: writeBack.id,
        data: { [writeBack.field]: stored.key },
      });
    } catch (e) {
      // The document exists and is stored; a row that moved on (deleted,
      // renamed field) must not undo that.
      console.warn(`[signatures] write-back for ${request.id} failed: ${(e as Error).message}`);
    }
  }

  await sendCompletionEmails(ctx, { ...request, signedDocumentKey: stored.key }, signers);
  return { signedDocumentKey: stored.key };
};

/** The signed copy goes to everyone who signed it plus any extra addresses —
 *  a counterparty who has to ask for their own contract does not have one. */
const sendCompletionEmails = async (
  ctx: Ctx,
  request: SignatureRequestRow,
  signers: SignatureSignerRow[],
): Promise<void> => {
  let attachment: { filename: string; content: string; contentType: string } | undefined;
  try {
    const object = request.signedDocumentKey ? await ctx.storage.get(request.signedDocumentKey) : null;
    if (object) {
      const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      attachment = {
        filename: request.signedDocumentKey!.split("/").pop() || "signed.pdf",
        content: btoa(bin),
        contentType: "application/pdf",
      };
    }
  } catch (e) {
    console.warn(`[signatures] could not attach signed copy: ${(e as Error).message}`);
  }

  const recipients = [
    ...signers.filter((s) => s.status === "signed").map((s) => s.email),
    ...(request.notifyEmails ?? []),
  ];
  for (const to of [...new Set(recipients)]) {
    try {
      await sendTemplatedEmail(ctx, {
        to,
        templateKey: "signature_completed",
        tenantId: request.tenantId,
        vars: {
          title: request.title,
          signers: signers.map((s) => ({ email: s.email, name: s.name ?? "" })),
          documentHash: request.documentHash,
        },
        fallback: {
          subject: `Signed: ${request.title}`,
          html: `<p>"${escapeHtml(request.title)}" has been signed by everyone.</p>
<p>A copy is attached.</p>
<p style="color:#666;font-size:12px">Document hash (SHA-256): ${escapeHtml(request.documentHash)}</p>`,
        },
        ...(attachment ? { attachments: [attachment] } : {}),
      });
    } catch (e) {
      console.warn(`[signatures] completion mail to ${to} failed: ${(e as Error).message}`);
    }
  }
};

// ── admin side ───────────────────────────────────────────────────────────────

export interface ListSignaturesOptions {
  status?: SignatureStatus;
  limit?: number;
  offset?: number;
}

export const listSignatureRequests = async (
  ctx: Ctx,
  tenantId: string | null,
  opts: ListSignaturesOptions = {},
): Promise<{ data: PublicSignatureRequest[]; total: number }> => {
  const t = requestsTable(ctx.dialect);
  const scope = tenantId == null ? isNull(t.tenantId) : eq(t.tenantId, tenantId);
  // `expired` is derived, so it cannot be a WHERE clause — the rows are
  // fetched as `pending` and filtered after the status is computed.
  const stored = opts.status === "expired" ? "pending" : opts.status;
  const where = stored ? and(scope, eq(t.status, stored)) : scope;
  const rows = (await (ctx.db as AnyDb)
    .select()
    .from(t)
    .where(where)
    .orderBy(desc(t.createdAt))) as SignatureRequestRow[];
  const matching = opts.status
    ? rows.filter((r) => effectiveStatus(r) === opts.status)
    : rows;

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const page = matching.slice(offset, offset + limit);
  const signers = page.length
    ? ((await (ctx.db as AnyDb)
        .select()
        .from(signersTable(ctx.dialect))
        .where(
          inArray(
            signersTable(ctx.dialect).requestId,
            page.map((r) => r.id),
          ),
        )
        .orderBy(asc(signersTable(ctx.dialect).orderIndex))) as SignatureSignerRow[])
    : [];
  return {
    data: page.map((r) => toPublicRequest(r, signers.filter((s) => s.requestId === r.id))),
    total: matching.length,
  };
};

export const getSignatureRequest = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
): Promise<PublicSignatureRequest> => {
  const row = await loadRequest(ctx, id, tenantId);
  if (!row) throw new AppError("NOT_FOUND", `No signature request "${id}"`);
  return toPublicRequest(row, await loadSigners(ctx, row.id), { includeHtml: true });
};

/** The stored PDF for a request — the signed copy once there is one, the
 *  original until then. */
export const signatureDocument = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
  which: "original" | "signed" = "signed",
): Promise<{ bytes: Uint8Array; filename: string }> => {
  const row = await loadRequest(ctx, id, tenantId);
  if (!row) throw new AppError("NOT_FOUND", `No signature request "${id}"`);
  const key = which === "original" ? row.documentKey : (row.signedDocumentKey ?? row.documentKey);
  if (!key) throw new AppError("NOT_FOUND", "This request has no stored document");
  const object = await ctx.storage.get(key);
  if (!object) throw new AppError("NOT_FOUND", "This request's document is no longer in storage");
  return {
    bytes: new Uint8Array(await new Response(object.body).arrayBuffer()),
    filename: key.split("/").pop() || "document.pdf",
  };
};

/**
 * Produce the signed copy for a request everybody has already signed.
 *
 * The one recovery this feature needs. Signing commits the signature before
 * the render, so a renderer that was down for those few seconds leaves a
 * request with every signature in and no artefact — real, and unreachable
 * otherwise, since every signing link is spent. Idempotent by the same status
 * guard the signing path uses.
 */
export const finalizePendingRequest = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
): Promise<PublicSignatureRequest> => {
  const row = await loadRequest(ctx, id, tenantId);
  if (!row) throw new AppError("NOT_FOUND", `No signature request "${id}"`);
  if (row.status !== "pending") {
    throw new AppError("VALIDATION", `This request is ${effectiveStatus(row)}`);
  }
  const signers = await loadSigners(ctx, id);
  if (signers.some((s) => s.status !== "signed")) {
    throw new AppError("VALIDATION", "Not everyone has signed this yet");
  }
  await finalizeRequest(ctx, row, signers);
  const updated = (await loadRequest(ctx, id, tenantId))!;
  return toPublicRequest(updated, await loadSigners(ctx, id));
};

/**
 * Cancel a request. Voiding replaces every outstanding token, so a link
 * already delivered stops working — revoking by status alone would rely on
 * every read path checking it.
 */
export const voidSignatureRequest = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
  reason: string | null,
): Promise<PublicSignatureRequest> => {
  const row = await loadRequest(ctx, id, tenantId);
  if (!row) throw new AppError("NOT_FOUND", `No signature request "${id}"`);
  const status = effectiveStatus(row);
  if (status === "completed") {
    throw new AppError("VALIDATION", "A signed document cannot be cancelled");
  }
  const now = new Date();
  const t = requestsTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(t)
    .set({ status: "voided", voidedAt: now, voidReason: reason?.trim().slice(0, 500) || null, updatedAt: now })
    .where(eq(t.id, id));

  const s = signersTable(ctx.dialect);
  const signers = await loadSigners(ctx, id);
  for (const signer of signers) {
    if (signer.status === "signed") continue;
    await (ctx.db as AnyDb)
      .update(s)
      .set({ tokenHash: await hashToken(`${TOKEN_PREFIX}_void_${crypto.randomUUID()}`), updatedAt: now })
      .where(eq(s.id, signer.id));
  }
  const updated = (await loadRequest(ctx, id, tenantId))!;
  return toPublicRequest(updated, await loadSigners(ctx, id));
};

/**
 * Re-send one signer's invitation with a FRESH link.
 *
 * The old token stops working, which is the point: "resend" is what an
 * operator reaches for when a link went to the wrong address or leaked into a
 * forwarded thread, and one that left the previous link live would fix
 * neither.
 */
export const resendSignatureInvite = async (
  ctx: Ctx,
  tenantId: string | null,
  id: string,
  signerId: string,
): Promise<{ sent: boolean; email: string }> => {
  const row = await loadRequest(ctx, id, tenantId);
  if (!row) throw new AppError("NOT_FOUND", `No signature request "${id}"`);
  const status = effectiveStatus(row);
  if (status !== "pending") throw new AppError("VALIDATION", `This request is ${status}`);
  const signers = await loadSigners(ctx, id);
  const signer = signers.find((s) => s.id === signerId);
  if (!signer) throw new AppError("NOT_FOUND", "No such signer on this request");
  if (signer.status === "signed") throw new AppError("VALIDATION", "That signer has already signed");
  if (signer.status === "declined") throw new AppError("VALIDATION", "That signer declined");
  if (!isSignersTurn(row, signers, signer.id)) {
    throw new AppError("VALIDATION", "It is not that signer's turn yet");
  }

  const token = `${TOKEN_PREFIX}_${randomHex(TOKEN_BYTES)}`;
  const s = signersTable(ctx.dialect);
  await (ctx.db as AnyDb)
    .update(s)
    .set({ tokenHash: await hashToken(token), sentAt: null, updatedAt: new Date() })
    .where(eq(s.id, signer.id));
  const fresh = await loadSigners(ctx, id);
  const sent = await sendInvitations(ctx, row, fresh, [
    { signerId: signer.id, email: signer.email, url: signingUrl(ctx, token) },
  ]);
  return { sent, email: signer.email };
};

/** The status vocabulary, shared by every surface's filter so a typo in one of
 *  them is a type error rather than a filter that silently matches nothing. */
export const SIGNATURE_STATUSES: SignatureStatus[] = [
  "pending",
  "completed",
  "declined",
  "voided",
  "expired",
];
