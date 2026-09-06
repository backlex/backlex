import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError } from "@backlex/core";
import type { AppBindings } from "../app";
import { PUBLIC_SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import { rateLimitOk } from "../lib/rate-limit";
import { setMeterTenant } from "../lib/usage-meter";
import { requestMeta } from "../services/activity";
import {
  MAX_DECLINE_REASON,
  MAX_SIGNATURE_TEXT,
  declineDocument,
  effectiveStatus,
  markViewed,
  resolveSignerToken,
  signDocument,
  signerView,
  type ResolvedSigner,
} from "../services/signatures";

/**
 * The signer's side — public, unauthenticated, mounted at `/api/public/sign`.
 * The link token is the entire grant, exactly like a form token or a share
 * link, so there is no `requireUser` here and nothing on these routes takes an
 * id: a caller who has the token is the signer, and a caller who does not
 * cannot address anybody else's request.
 *
 * The `/api/public/` prefix inherits the framable CSP + XFO-strip in app.ts,
 * which the signing page needs for the same reason the form page does.
 */

const TAGS = ["signatures"];

/** A signer opens the link, reads, maybe re-reads on another device. Generous. */
const VIEW_MAX_PER_MINUTE = 60;
/** Signing is a once-per-request act; the budget is for retries, not traffic. */
const SIGN_MAX_PER_MINUTE = 8;
const WINDOW_MS = 60_000;

const NOT_AVAILABLE = "This signing link is not valid";

/**
 * Which language the consent sentence is chosen in.
 *
 * `?lang=` is what the signing page actually renders in (it resolves its own
 * locale before it calls), with `Accept-Language` as the fallback for anything
 * else reaching this endpoint. The SERVER still owns the wording — this only
 * picks which of its sentences applies, and the one it picked is what gets
 * stored as the evidence.
 */
const requestLocale = (c: { req: { query: (k: string) => string | undefined; header: (k: string) => string | undefined } }): string | null =>
  c.req.query("lang") ?? c.req.header("accept-language") ?? null;

const SignerViewSchema = z
  .object({
    title: z.string(),
    message: z.string().nullable(),
    status: z.string(),
    signerStatus: z.string(),
    signerName: z.string().nullable(),
    signerEmail: z.string(),
    signerRole: z.string().nullable(),
    yourTurn: z.boolean(),
    signedCount: z.number(),
    signerCount: z.number(),
    expiresAt: z.unknown().nullable(),
    documentHash: z.string(),
    consentText: z.string(),
    html: z.string(),
    completedAt: z.unknown().nullable(),
  })
  .openapi("SignerView");

const SignBody = z
  .object({
    kind: z.enum(["drawn", "typed"]),
    /** `data:image/png;base64,…`. Validated structurally in the service — it
     *  is interpolated into HTML a browser renders. */
    image: z.string().max(1_000_000).optional(),
    text: z.string().max(MAX_SIGNATURE_TEXT).optional(),
    consent: z.boolean(),
  })
  .openapi("SignDocumentInput");

const SignResultSchema = z
  .object({
    status: z.string(),
    signedCount: z.number(),
    signerCount: z.number(),
    /** False when everybody has signed but the signed copy could not be
     *  produced — the signature is recorded either way. */
    finalized: z.boolean(),
  })
  .openapi("SignDocumentResult");

/**
 * Resolve the token or refuse identically for every failure.
 *
 * An unknown token, a deleted request and a voided one all answer 404 with the
 * same sentence: distinguishing them would turn this endpoint into an oracle
 * for whether a given token ever existed.
 */
const requireSigner = async (
  ctx: Parameters<typeof resolveSignerToken>[0],
  token: string,
): Promise<ResolvedSigner> => {
  const resolved = await resolveSignerToken(ctx, token);
  if (!resolved) throw new AppError("NOT_FOUND", NOT_AVAILABLE);
  return resolved;
};

export const signaturesPublicRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/{token}",
      tags: TAGS,
      summary: "Resolve a signing link",
      description:
        "PUBLIC — no auth. Returns the frozen document HTML, the signer's own state and whose turn it is. Marks the link as viewed. Never exposes the other signers' addresses.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        query: z.object({ lang: z.string().optional() }),
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: SignerViewSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const meta = requestMeta(c.req.raw, c.get("ctx").env);
      const ok = await rateLimitOk(
        ctx.env,
        `sign-view:${meta.ip ?? "unknown"}`,
        VIEW_MAX_PER_MINUTE,
        WINDOW_MS,
      );
      if (!ok) throw new AppError("RATE_LIMITED", "Too many requests — please wait a moment");

      const resolved = await requireSigner(ctx, token);
      // No authenticated identity on this path, so the request row is what
      // attributes the call to a workspace for usage metering.
      setMeterTenant(c, resolved.request.tenantId);
      if (effectiveStatus(resolved.request) === "pending") await markViewed(ctx, resolved.signer);
      return c.json({ data: signerView(resolved, requestLocale(c)) });
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{token}/document",
      tags: TAGS,
      summary: "Download the document behind a signing link",
      description:
        "PUBLIC — no auth. The signed copy once everyone has signed, the original until then. Streams the stored PDF; nothing is rendered on this path.",
      security: PUBLIC_SECURITY,
      request: { params: z.object({ token: z.string() }) },
      responses: {
        200: {
          description: "The PDF",
          content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const resolved = await requireSigner(ctx, token);
      setMeterTenant(c, resolved.request.tenantId);
      const status = effectiveStatus(resolved.request);
      if (status === "voided") throw new AppError("GONE", "This request was cancelled");
      // The signed copy is only offered to somebody who signed it — an
      // outstanding signer on a completed request still gets the original.
      const key =
        resolved.signer.status === "signed"
          ? (resolved.request.signedDocumentKey ?? resolved.request.documentKey)
          : resolved.request.documentKey;
      if (!key) throw new AppError("NOT_FOUND", "This request has no stored document");
      const object = await ctx.storage.get(key);
      if (!object) throw new AppError("NOT_FOUND", "This document is no longer in storage");
      return c.body(object.body as unknown as ReadableStream, 200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${key.split("/").pop() || "document.pdf"}"`,
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{token}/sign",
      tags: TAGS,
      summary: "Sign the document",
      description:
        "PUBLIC — no auth. Records the signature, the consent, the IP and the user agent. When the last signer lands, the signed PDF is rendered, stored, written back and emailed. One-shot: a second call answers 410.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        query: z.object({ lang: z.string().optional() }),
        body: { required: true, content: { "application/json": { schema: SignBody } } },
      },
      responses: {
        200: {
          description: "Signed",
          content: { "application/json": { schema: z.object({ data: SignResultSchema }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const body = c.req.valid("json");
      const meta = requestMeta(c.req.raw, c.get("ctx").env);
      const resolved = await requireSigner(ctx, token);
      setMeterTenant(c, resolved.request.tenantId);
      // Keyed on the token, not the IP: two people signing from one office
      // must not spend each other's budget, and one token is one signer.
      const ok = await rateLimitOk(ctx.env, `sign:${resolved.signer.id}`, SIGN_MAX_PER_MINUTE, WINDOW_MS);
      if (!ok) throw new AppError("RATE_LIMITED", "Too many attempts — please wait a moment");

      const result = await signDocument(ctx, resolved, body, {
        ...meta,
        locale: requestLocale(c),
      });
      return c.json({
        data: {
          status: result.status,
          signedCount: result.signedCount,
          signerCount: result.signerCount,
          finalized: result.finalized,
        },
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{token}/decline",
      tags: TAGS,
      summary: "Decline to sign",
      description:
        "PUBLIC — no auth. One refusal ends the whole request: a document two of three people signed is not partially signed, and the remaining links would otherwise stay live against something nobody can complete.",
      security: PUBLIC_SECURITY,
      request: {
        params: z.object({ token: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z
                .object({ reason: z.string().max(MAX_DECLINE_REASON).nullish() })
                .openapi("DeclineSignatureInput"),
            },
          },
        },
      },
      responses: {
        200: {
          description: "Declined",
          content: { "application/json": { schema: z.object({ data: z.object({ status: z.string() }) }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const ctx = c.get("ctx");
      const { token } = c.req.valid("param");
      const { reason } = c.req.valid("json");
      const resolved = await requireSigner(ctx, token);
      setMeterTenant(c, resolved.request.tenantId);
      const ok = await rateLimitOk(ctx.env, `sign:${resolved.signer.id}`, SIGN_MAX_PER_MINUTE, WINDOW_MS);
      if (!ok) throw new AppError("RATE_LIMITED", "Too many attempts — please wait a moment");
      return c.json({ data: await declineDocument(ctx, resolved, reason ?? null) });
    },
  );
