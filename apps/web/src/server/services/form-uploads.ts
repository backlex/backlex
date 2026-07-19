/**
 * Anonymous file uploads for public form file blocks.
 *
 * Two-phase flow: the form page POSTs the file to
 * `/api/public/forms/:token/upload` BEFORE submit; the server stores it under
 * `form-uploads/<form-id>/` (private ACL, pending marker in `files.metadata`)
 * and answers with a signed one-time TICKET. The submit payload carries the
 * ticket — never a raw storage key — and `consumeFormUploadTicket` swaps it
 * for the real key after verifying the HMAC, the form binding and that the
 * pending object still exists. An anonymous submitter therefore can't point a
 * row at an arbitrary object, and an uploaded-but-never-submitted file is
 * swept by the cron tick once it goes stale.
 *
 * Abuse posture (uploads happen pre-Turnstile, so they get their own valves):
 * per-form/IP minute rate limit + per-form daily budget (route), MIME
 * allow-list + per-block byte cap clamped by `FORM_UPLOAD_MAX_BYTES`, and the
 * workspace hard storage cap (`assertStorageWithinLimit`) — all enforced
 * server-side regardless of what the page claims.
 */
import { sql } from "drizzle-orm";
import { AppError } from "@backlex/core";
import type { Env } from "../env";
import type { Ctx } from "../context";
import { FORM_UPLOAD_DEFAULT_MAX_BYTES } from "./forms";
import { filesTable } from "./storage/folders";
import { physicalKey } from "./storage/keys";

const TICKET_PREFIX = "fut_";
/** How long a ticket stays valid between upload and submit. */
const TICKET_TTL_MS = 2 * 60 * 60 * 1000;
/** Pending uploads older than this are deleted by the cron sweep. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
/** `files.metadata` marker present until the upload is consumed by a submit. */
const PENDING_KEY = "formUploadPending";

export interface FormUploadPolicy {
  /** Global per-upload ceiling — block-level `maxBytes` can only go lower. */
  maxBytes: number;
  /** Per-form daily upload budget. */
  maxPerDay: number;
}

export const formUploadPolicy = (env: Env): FormUploadPolicy => ({
  maxBytes:
    Number(env.FORM_UPLOAD_MAX_BYTES ?? 0) || FORM_UPLOAD_DEFAULT_MAX_BYTES,
  maxPerDay: Number(env.FORM_UPLOAD_MAX_PER_DAY ?? 0) || 500,
});

/** True when `contentType` satisfies one of the block's MIME patterns
 *  (`image/*` prefix form or an exact type). No patterns ⇒ anything goes. */
export const matchesAccept = (
  patterns: string[] | undefined,
  contentType: string,
): boolean => {
  if (!patterns || patterns.length === 0) return true;
  const ct = contentType.toLowerCase().split(";")[0]!.trim();
  if (!ct) return false;
  return patterns.some((p) => {
    const pat = p.toLowerCase().trim();
    if (pat.endsWith("/*")) return ct.startsWith(pat.slice(0, -1));
    return ct === pat;
  });
};

/* ── ticket signing ─────────────────────────────────────────────────── */

interface TicketPayload {
  /** Form id the upload is bound to. */
  f: string;
  /** Logical storage key of the stored object. */
  k: string;
  /** Expiry, epoch ms. */
  exp: number;
}

// TS's lib.dom BufferSource wants a non-shared ArrayBuffer; runtime accepts
// any Uint8Array. Same cast as lib/crypto.ts.
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

const b64url = (bytes: Uint8Array): string => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const raw = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};

// Own derivation context — a form-upload ticket must not double as a storage
// signed-URL token (lib/crypto.ts) or vice versa.
const ticketKey = async (secret: string): Promise<CryptoKey> => {
  const material = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`backlex:form-upload-ticket:v1:${secret}`),
  );
  return crypto.subtle.importKey(
    "raw",
    material,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
};

export const signFormUploadTicket = async (
  formId: string,
  logicalKey: string,
  secret: string,
): Promise<string> => {
  const payload: TicketPayload = {
    f: formId,
    k: logicalKey,
    exp: Date.now() + TICKET_TTL_MS,
  };
  const body = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await ticketKey(secret);
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  return `${TICKET_PREFIX}${body}.${b64url(sig)}`;
};

/** Payload when the ticket is intact, unexpired and ours; null otherwise. */
export const verifyFormUploadTicket = async (
  ticket: string,
  secret: string,
): Promise<TicketPayload | null> => {
  if (typeof ticket !== "string" || !ticket.startsWith(TICKET_PREFIX)) return null;
  const dot = ticket.indexOf(".");
  if (dot <= TICKET_PREFIX.length || dot === ticket.length - 1) return null;
  const body = ticket.slice(TICKET_PREFIX.length, dot);
  const sig = ticket.slice(dot + 1);
  try {
    const key = await ticketKey(secret);
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      buf(b64urlToBytes(sig)),
      buf(new TextEncoder().encode(body)),
    );
    if (!ok) return null;
    const payload = JSON.parse(
      new TextDecoder().decode(b64urlToBytes(body)),
    ) as TicketPayload;
    if (!payload?.f || !payload.k || typeof payload.exp !== "number") return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
};

/* ── store / consume / sweep ────────────────────────────────────────── */

/** Keep the (sanitized) extension so served files get a sensible name; the
 *  basename is random, so the visitor's filename never becomes a key. */
const keyExtension = (filename: string): string => {
  const dot = filename.lastIndexOf(".");
  if (dot <= 0) return "";
  const ext = filename
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 10);
  return ext ? `.${ext}` : "";
};

export interface StoredFormUpload {
  ticket: string;
  name: string;
  size: number;
  contentType: string | null;
}

/** Store one validated upload and mint its ticket. Size/MIME checks happen in
 *  the route (it owns the multipart parse); this owns key minting, the
 *  pending `files` row and the signature. */
export const storeFormUpload = async (
  ctx: Ctx,
  form: { id: string; tenantId: string },
  file: File,
): Promise<StoredFormUpload> => {
  const logical = `form-uploads/${form.id}/${crypto.randomUUID()}${keyExtension(file.name)}`;
  const key = physicalKey(form.tenantId, logical);
  const contentType = file.type || undefined;
  const obj = await ctx.storage.put({ key, body: file.stream(), contentType });
  const t = filesTable(ctx.dialect);
  await (ctx.db as any).insert(t).values({
    key,
    folderId: null,
    ownerId: null,
    tenantId: form.tenantId,
    size: obj.size,
    contentType: obj.contentType ?? contentType ?? null,
    metadata: {
      [PENDING_KEY]: "1",
      formUpload: form.id,
      originalName: file.name.slice(0, 200),
    },
  });
  const ticket = await signFormUploadTicket(form.id, logical, ctx.env.AUTH_SECRET);
  return {
    ticket,
    name: file.name,
    size: obj.size,
    contentType: obj.contentType ?? contentType ?? null,
  };
};

/**
 * Swap a submitted ticket for its logical storage key. Verifies the HMAC, the
 * form binding, and that the pending object still exists (not yet swept);
 * clears the pending marker so the sweep leaves the referenced file alone.
 */
export const consumeFormUploadTicket = async (
  ctx: Ctx,
  form: { id: string; tenantId: string },
  ticket: unknown,
  fieldLabel: string,
): Promise<string> => {
  const invalid = () =>
    new AppError(
      "VALIDATION",
      `"${fieldLabel}": upload is missing or expired — please attach the file again`,
    );
  if (typeof ticket !== "string") throw invalid();
  const payload = await verifyFormUploadTicket(ticket, ctx.env.AUTH_SECRET);
  if (!payload || payload.f !== form.id) throw invalid();

  const t = filesTable(ctx.dialect);
  const key = physicalKey(form.tenantId, payload.k);
  const rows = (await (ctx.db as any)
    .select({ key: t.key, metadata: t.metadata })
    .from(t)
    .where(sql`${t.key} = ${key}`)
    .limit(1)) as Array<{ key: string; metadata: Record<string, string> | null }>;
  const row = rows[0];
  if (!row) throw invalid();

  if (row.metadata?.[PENDING_KEY]) {
    const { [PENDING_KEY]: _pending, ...rest } = row.metadata;
    await (ctx.db as any)
      .update(t)
      .set({ metadata: rest })
      .where(sql`${t.key} = ${key}`);
  }
  return payload.k;
};

/**
 * Delete pending form uploads that were never submitted. Runs from `cronTick`
 * (same posture as `sweepExpiredUploads`). The LIKE pattern is a literal —
 * D1 rejects bound LIKE parameters (see CLAUDE.md).
 */
export const sweepStaleFormUploads = async (ctx: Ctx): Promise<void> => {
  const t = filesTable(ctx.dialect);
  const cutoff = Date.now() - STALE_AFTER_MS;
  const rows = (await (ctx.db as any)
    .select({ key: t.key, metadata: t.metadata, createdAt: t.createdAt })
    .from(t)
    .where(sql`${t.key} LIKE 'tenants/%/form-uploads/%'`)
    .limit(500)) as Array<{
    key: string;
    metadata: Record<string, string> | null;
    createdAt: Date | number | null;
  }>;
  for (const row of rows) {
    if (!row.metadata?.[PENDING_KEY]) continue;
    const created =
      row.createdAt instanceof Date ? row.createdAt.getTime() : Number(row.createdAt ?? 0);
    if (created > cutoff) continue;
    try {
      await ctx.storage.delete(row.key);
      await (ctx.db as any).delete(t).where(sql`${t.key} = ${row.key}`);
    } catch (e) {
      console.error(`[form-uploads] sweep failed for ${row.key}`, e);
    }
  }
};
