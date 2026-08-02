import { AppError } from "@backlex/core";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  type GraphQLFieldConfig,
} from "graphql";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  deleteTemplate,
  listTemplates,
  renderDocument,
  upsertTemplate,
} from "../documents";
import { recordActivity } from "../activity";

// ── Document generation ──────────────────────────────────────────────────────
// Admin-scoped mirror of REST `/api/admin/documents`. Everything funnels
// through services/documents.ts, so the workspace-override rule, the filename
// sanitising and the "no renderer configured" refusal are shared rather than
// restated — restating a guard per surface is how one of them ends up missing.
//
// `renderDocument` returns BYTES, which GraphQL has no type for. The mutation
// answers base64 and says so in its description, rather than inventing a scalar
// or silently truncating at the first null byte.

const TemplateType = new GraphQLObjectType({
  name: "DocumentTemplate",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    key: { type: new GraphQLNonNull(GraphQLString) },
    name: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: GraphQLString },
    bodyHtml: { type: new GraphQLNonNull(GraphQLString) },
    headerHtml: { type: GraphQLString },
    footerHtml: { type: GraphQLString },
    pageOptions: { type: JSONScalar },
    filename: { type: GraphQLString },
    variables: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    /** True for an instance-wide default this workspace has not overridden. */
    inherited: { type: new GraphQLNonNull(GraphQLBoolean) },
    createdAt: { type: JSONScalar },
    updatedAt: { type: JSONScalar },
  },
});

const TemplateInputType = new GraphQLInputObjectType({
  name: "DocumentTemplateInput",
  fields: {
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    bodyHtml: { type: GraphQLString },
    headerHtml: { type: GraphQLString },
    footerHtml: { type: GraphQLString },
    pageOptions: { type: JSONScalar },
    filename: { type: GraphQLString },
    variables: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
  },
});

const RenderedType = new GraphQLObjectType({
  name: "RenderedDocument",
  fields: {
    filename: { type: new GraphQLNonNull(GraphQLString) },
    contentType: { type: new GraphQLNonNull(GraphQLString) },
    /** Which backend produced it. */
    renderer: { type: new GraphQLNonNull(GraphQLString) },
    /** The PDF, base64-encoded. */
    base64: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** yoga masks non-GraphQLError throws — surface AppErrors with their code. */
const surfacing = async <T>(work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/** Chunked, so a multi-megabyte document does not blow the argument limit of
 *  the spread form of `String.fromCharCode`. */
const toBase64 = (bytes: Uint8Array): string => {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
};

export const documentQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  documentTemplates: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(TemplateType))),
    description:
      "List document templates in the active workspace (admin-only). A workspace override hides the instance-wide default with the same key.",
    resolve: (_s, _a, gqlCtx) =>
      surfacing(async () => listTemplates(gqlCtx.ctx, requireFlowAdmin(gqlCtx))),
  },
};

export const documentMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  saveDocumentTemplate: {
    type: new GraphQLNonNull(TemplateType),
    description:
      "Create or update a document template (admin-only). Always writes a workspace-scoped row, so editing an inherited default creates an override rather than changing what other workspaces render.",
    args: {
      key: { type: new GraphQLNonNull(GraphQLString) },
      data: { type: new GraphQLNonNull(TemplateInputType) },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as { key: string; data: Record<string, unknown> };
        const saved = await upsertTemplate(
          gqlCtx.ctx,
          tenantId,
          { key: a.key, ...a.data },
          gqlCtx.auth.userId ?? null,
        );
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "update",
          collection: "system_document_templates",
          itemId: saved.id,
          payload: { key: saved.key },
        });
        return saved;
      }),
  },
  deleteDocumentTemplate: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Delete this workspace's own document template (admin-only). An inherited default is not deletable from inside a workspace.",
    args: { key: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const { key } = args as { key: string };
        await deleteTemplate(gqlCtx.ctx, tenantId, key);
        await recordActivity(gqlCtx.ctx, {
          userId: gqlCtx.auth.userId ?? null,
          tenantId,
          action: "delete",
          collection: "system_document_templates",
          itemId: key,
        });
        return { ok: true };
      }),
  },
  renderDocument: {
    type: new GraphQLNonNull(RenderedType),
    description:
      "Render a document to PDF (admin-only). Returns the bytes base64-encoded. Exactly one of `templateKey` or `html`. Fails when no renderer is configured — there is deliberately no fallback that would produce a document with broken glyphs.",
    args: {
      templateKey: { type: GraphQLString },
      html: { type: GraphQLString },
      vars: { type: JSONScalar },
      pageOptions: { type: JSONScalar },
      filename: { type: GraphQLString },
    },
    resolve: (_s, args, gqlCtx) =>
      surfacing(async () => {
        const tenantId = requireFlowAdmin(gqlCtx);
        const a = args as {
          templateKey?: string;
          html?: string;
          vars?: Record<string, unknown>;
          pageOptions?: Record<string, unknown>;
          filename?: string;
        };
        // Restated here because GraphQL args cannot express "exactly one of",
        // and the service would otherwise silently prefer the template.
        if ((a.templateKey == null) === (a.html == null)) {
          throw new AppError("VALIDATION", "Provide exactly one of templateKey or html");
        }
        const out = await renderDocument(gqlCtx.ctx, tenantId, a as never);
        return {
          filename: out.filename,
          contentType: out.contentType,
          renderer: out.renderer,
          base64: toBase64(out.bytes),
        };
      }),
  },
};
