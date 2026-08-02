import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, errorResponses } from "../lib/openapi";
import { defaultHook } from "../lib/openapi-router";
import {
  MAX_EXPIRY_DAYS,
  MAX_SIGNERS,
  SIGNATURE_STATUSES,
  createSignatureRequest,
  finalizePendingRequest,
  getSignatureRequest,
  listSignatureRequests,
  resendSignatureInvite,
  signatureDocument,
  voidSignatureRequest,
} from "../services/signatures";

/**
 * Signature requests, from the operator's side.
 *
 * Admin-only, for the same reason document templates are: the body being sent
 * out is interpolated HTML handed to a browser, and the act itself commits the
 * workspace to something. The signer's side needs no account at all and lives
 * in `routes/signatures-public.ts`.
 */

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const tags = ["signatures"];

const tenantOf = (c: { get: (k: string) => any }): string | null =>
  (c.get("auth")?.tenantId as string | undefined) ?? null;

const SignerView = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    role: z.string().nullable(),
    order: z.number(),
    status: z.string(),
    sentAt: z.unknown().nullable(),
    viewedAt: z.unknown().nullable(),
    signedAt: z.unknown().nullable(),
    declinedAt: z.unknown().nullable(),
    declineReason: z.string().nullable(),
    signatureKind: z.string().nullable(),
    ip: z.string().nullable(),
    userAgent: z.string().nullable(),
  })
  .openapi("SignatureSigner");

const RequestView = z
  .object({
    id: z.string(),
    title: z.string(),
    message: z.string().nullable(),
    templateKey: z.string().nullable(),
    status: z.string(),
    ordered: z.boolean(),
    documentHash: z.string(),
    documentKey: z.string().nullable(),
    signedDocumentKey: z.string().nullable(),
    signedDocumentHash: z.string().nullable(),
    filename: z.string().nullable(),
    expiresAt: z.unknown().nullable(),
    completedAt: z.unknown().nullable(),
    voidedAt: z.unknown().nullable(),
    voidReason: z.string().nullable(),
    writeBack: z.unknown().nullable(),
    notifyEmails: z.array(z.string()),
    createdBy: z.string().nullable(),
    createdAt: z.unknown().nullable(),
    updatedAt: z.unknown().nullable(),
    signers: z.array(SignerView),
    bodyHtml: z.string().optional(),
  })
  .openapi("SignatureRequest");

const PageOptions = z
  .object({
    format: z.enum(["A4", "Letter", "Legal", "A3", "A5"]).optional(),
    landscape: z.boolean().optional(),
    margin: z
      .union([
        z.string(),
        z.object({
          top: z.string().optional(),
          right: z.string().optional(),
          bottom: z.string().optional(),
          left: z.string().optional(),
        }),
      ])
      .optional(),
    printBackground: z.boolean().optional(),
  })
  .openapi("SignaturePageOptions");

const CreateInput = z
  .object({
    title: z.string().min(1).max(200).optional(),
    message: z.string().max(2000).nullish(),
    templateKey: z.string().min(1).max(200).optional(),
    html: z.string().min(1).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
    pageOptions: PageOptions.optional(),
    filename: z.string().max(200).optional(),
    signers: z
      .array(
        z.object({
          email: z.string().min(3).max(320),
          name: z.string().max(120).nullish(),
          role: z.string().max(80).nullish(),
        }),
      )
      .min(1)
      .max(MAX_SIGNERS),
    ordered: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional(),
    writeBack: z
      .object({ collection: z.string(), id: z.string(), field: z.string() })
      .nullish(),
    notifyEmails: z.array(z.string().max(320)).max(10).optional(),
    send: z.boolean().optional(),
  })
  .refine((v) => (v.templateKey == null) !== (v.html == null), {
    message: "Provide exactly one of templateKey or html",
  })
  .openapi("CreateSignatureRequestInput");

const CreateResult = z
  .object({
    request: RequestView,
    /** Returned exactly once — only the hashes are stored, so nothing can
     *  reproduce these afterwards. */
    links: z.array(z.object({ signerId: z.string(), email: z.string(), url: z.string() })),
    sent: z.boolean(),
  })
  .openapi("CreateSignatureRequestResult");

export const signaturesRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List signature requests",
      description:
        "Admin-only. `expired` is derived from the expiry timestamp rather than stored, so filtering by it matches requests nothing has swept yet.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        query: z.object({
          status: z.enum(SIGNATURE_STATUSES as [string, ...string[]]).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.array(RequestView), total: z.number() }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const q = c.req.valid("query");
      const out = await listSignatureRequests(c.get("ctx"), tenantOf(c), {
        ...(q.status ? { status: q.status as (typeof SIGNATURE_STATUSES)[number] } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
        ...(q.offset ? { offset: q.offset } : {}),
      });
      return c.json(out);
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Send a document for signature",
      description:
        "Admin-only. Freezes the interpolated document, renders and stores the PDF, mints one link per signer and (unless `send:false`) emails them. The plaintext links come back on this response and nowhere else.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: CreateInput } } } },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: z.object({ data: CreateResult }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const auth = c.get("auth");
      const data = await createSignatureRequest(
        c.get("ctx"),
        tenantOf(c),
        body as Parameters<typeof createSignatureRequest>[2],
        auth?.userId ?? null,
      );
      return c.json({ data }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}",
      tags,
      summary: "Get one signature request",
      description: "Admin-only. Includes the frozen document HTML so the admin can see what was sent.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: RequestView }) } } },
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json({ data: await getSignatureRequest(c.get("ctx"), tenantOf(c), c.req.valid("param").id) }),
  )
  .openapi(
    createRoute({
      method: "get",
      path: "/{id}/document",
      tags,
      summary: "Download a request's PDF",
      description:
        "Admin-only. Defaults to the signed copy and falls back to the original while it is outstanding; `?which=original` always returns what was sent.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        query: z.object({ which: z.enum(["original", "signed"]).optional() }),
      },
      responses: {
        200: {
          description: "The PDF",
          content: { "application/pdf": { schema: z.string().openapi({ format: "binary" }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const { which } = c.req.valid("query");
      const out = await signatureDocument(c.get("ctx"), tenantOf(c), id, which ?? "signed");
      return c.body(out.bytes as unknown as ArrayBuffer, 200, {
        "content-type": "application/pdf",
        "content-disposition": `inline; filename="${out.filename}"`,
      });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/void",
      tags,
      summary: "Cancel a signature request",
      description:
        "Admin-only. Replaces every outstanding token, so links already delivered stop working rather than relying on each read path to check a status.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          content: {
            "application/json": {
              schema: z.object({ reason: z.string().max(500).nullish() }).openapi("VoidSignatureInput"),
            },
          },
        },
      },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: RequestView }) } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      return c.json({ data: await voidSignatureRequest(c.get("ctx"), tenantOf(c), id, body?.reason ?? null) });
    },
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/finalize",
      tags,
      summary: "Produce the signed copy for a fully-signed request",
      description:
        "Admin-only. Recovery for the one case that can strand a request: signing commits the signature before the render, so a renderer that was down for those seconds leaves every signature in and no artefact — and every signing link is already spent. Idempotent.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: z.object({ data: RequestView }) } } },
        ...errorResponses,
      },
    }),
    async (c) =>
      c.json({ data: await finalizePendingRequest(c.get("ctx"), tenantOf(c), c.req.valid("param").id) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/{id}/signers/{signerId}/resend",
      tags,
      summary: "Re-send one signer's invitation",
      description:
        "Admin-only. Mints a FRESH link and invalidates the previous one — resending is what an operator reaches for when a link went astray, and one that left the old link live would fix nothing.",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string(), signerId: z.string() }) },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ data: z.object({ sent: z.boolean(), email: z.string() }) }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id, signerId } = c.req.valid("param");
      return c.json({ data: await resendSignatureInvite(c.get("ctx"), tenantOf(c), id, signerId) });
    },
  );
