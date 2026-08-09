/**
 * Credentials for the S3-compatible endpoint. Admin-only, mounted at
 * `/api/admin/s3-credentials`.
 *
 * The secret comes back exactly once, from `create`. There is no read-back
 * route, deliberately: the secret is stored encrypted so that a database dump
 * does not yield it, and an endpoint that decrypts it on request would undo
 * that for anyone who reaches the admin API.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { AppError, SYSTEM_ROLES } from "@backlex/core";
import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "../app";
import { requireUser } from "../middleware/session";
import { SECURITY, OkSchema, errorResponses } from "../lib/openapi";
import {
  createS3Credential,
  deleteS3Credential,
  listS3Credentials,
  updateS3Credential,
} from "../services/s3/credentials";
import { logActivity } from "../services/activity";
import { defaultHook } from "../lib/openapi-router";

const CredentialView = z
  .object({
    id: z.string(),
    name: z.string(),
    accessKeyId: z.string(),
    prefix: z.string().nullable(),
    readOnly: z.boolean(),
    enabled: z.boolean(),
    expiresAt: z.number().nullable(),
    lastUsedAt: z.number().nullable(),
    createdAt: z.number().nullable(),
  })
  .openapi("S3Credential");

const CreateInput = z
  .object({
    name: z.string().min(1).max(120),
    prefix: z.string().nullish().openapi({
      description:
        "Restrict this credential to keys under one prefix. Omit for the whole workspace bucket.",
    }),
    readOnly: z.boolean().optional().openapi({
      description: "Refuse every mutating verb — for a backup tool that should never delete.",
    }),
    expiresAt: z.number().nullish().openapi({ description: "Epoch ms." }),
  })
  .openapi("S3CredentialInput");

const requireAdminMiddleware: MiddlewareHandler<AppBindings> = async (c, next) => {
  const auth = c.get("auth");
  if (!auth.roles.includes(SYSTEM_ROLES.admin)) {
    throw new AppError("FORBIDDEN", "Admin role required");
  }
  await next();
};
const adminGate = [requireUser, requireAdminMiddleware];

const requireTenant = (c: { get: (k: string) => any }): string => {
  const tenantId = c.get("auth")?.tenantId as string | undefined;
  if (!tenantId) throw new AppError("UNAUTHORIZED", "Active tenant required");
  return tenantId;
};

const tags = ["s3"];

export const s3CredentialsRoutes = new OpenAPIHono<AppBindings>({ defaultHook })
  .openapi(
    createRoute({
      method: "get",
      path: "/",
      tags,
      summary: "List S3 credentials",
      description: "Secrets are never included — `create` is the only time one is shown.",
      security: SECURITY,
      middleware: adminGate,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: z.object({ data: z.array(CredentialView) }) },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => c.json({ data: await listS3Credentials(c.get("ctx"), requireTenant(c)) }),
  )
  .openapi(
    createRoute({
      method: "post",
      path: "/",
      tags,
      summary: "Mint an S3 credential",
      description:
        "The secret access key is returned ONCE and cannot be read back. Point any S3 tool at " +
        "`<your instance>/s3` with these credentials; the bucket name is the workspace slug.",
      security: SECURITY,
      middleware: adminGate,
      request: { body: { required: true, content: { "application/json": { schema: CreateInput } } } },
      responses: {
        201: {
          description: "Created",
          content: {
            "application/json": {
              schema: z.object({
                data: CredentialView,
                secretAccessKey: z.string().openapi({
                  description: "Shown once. Store it now — there is no read-back path.",
                }),
              }),
            },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const res = await createS3Credential(c.get("ctx"), requireTenant(c), {
        name: body.name,
        prefix: body.prefix ?? null,
        readOnly: body.readOnly,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      });
      await logActivity(c, {
        action: "create",
        collection: "system_s3_credentials",
        itemId: res.credential.id,
        // The access key id is an identifier, not a credential; the secret is
        // never written anywhere but the response.
        payload: { accessKeyId: res.credential.accessKeyId, readOnly: res.credential.readOnly },
      });
      return c.json({ data: res.credential, secretAccessKey: res.secretAccessKey }, 201);
    },
  )
  .openapi(
    createRoute({
      method: "patch",
      path: "/{id}",
      tags,
      summary: "Update an S3 credential",
      description: "Disabling one takes effect on the next request; there is no session to expire.",
      security: SECURITY,
      middleware: adminGate,
      request: {
        params: z.object({ id: z.string() }),
        body: {
          required: true,
          content: {
            "application/json": {
              schema: z.object({
                name: z.string().min(1).max(120).optional(),
                prefix: z.string().nullish(),
                readOnly: z.boolean().optional(),
                enabled: z.boolean().optional(),
              }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ data: CredentialView }) } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      const data = await updateS3Credential(
        c.get("ctx"),
        requireTenant(c),
        id,
        c.req.valid("json"),
      );
      await logActivity(c, {
        action: "update",
        collection: "system_s3_credentials",
        itemId: id,
      });
      return c.json({ data });
    },
  )
  .openapi(
    createRoute({
      method: "delete",
      path: "/{id}",
      tags,
      summary: "Delete an S3 credential",
      security: SECURITY,
      middleware: adminGate,
      request: { params: z.object({ id: z.string() }) },
      responses: {
        200: { description: "OK", content: { "application/json": { schema: OkSchema } } },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid("param");
      await deleteS3Credential(c.get("ctx"), requireTenant(c), id);
      await logActivity(c, {
        action: "delete",
        collection: "system_s3_credentials",
        itemId: id,
      });
      return c.json({ ok: true });
    },
  );
