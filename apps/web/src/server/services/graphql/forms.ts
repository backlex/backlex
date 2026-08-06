import { AppError } from "@backlex/core";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
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
import {
  createForm,
  deleteForm,
  getForm,
  listForms,
  rotateFormToken,
  updateForm,
  type FormBlock,
  type FormInput,
  type FormSettings,
} from "../forms";
import { formResults } from "../forms-results";

// ── Public form builder ──────────────────────────────────────────────────────
// Static, admin-scoped surface mirroring REST `/api/admin/forms` + MCP
// `forms.*` + SDK `client.forms.*`. Reuses the service layer (eligibility
// fence, token mint) so the rules stay in one place. The one-time plaintext
// token is only ever returned by createForm / rotateFormToken.
const FormType = new GraphQLObjectType({
  name: "PublicFormDef",
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    tenantId: { type: GraphQLString },
    name: { type: new GraphQLNonNull(GraphQLString) },
    collection: { type: new GraphQLNonNull(GraphQLString) },
    fields: { type: new GraphQLNonNull(JSONScalar) },
    settings: { type: JSONScalar },
    active: { type: new GraphQLNonNull(GraphQLBoolean) },
  },
});

const FormInputType = new GraphQLInputObjectType({
  name: "PublicFormInput",
  fields: {
    name: { type: GraphQLString },
    collection: { type: GraphQLString },
    fields: { type: JSONScalar },
    settings: { type: JSONScalar },
    active: { type: GraphQLBoolean },
  },
});

const CreatedFormType = new GraphQLObjectType({
  name: "CreatedPublicForm",
  fields: {
    form: { type: new GraphQLNonNull(FormType) },
    token: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
    embedUrl: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const RotatedFormTokenType = new GraphQLObjectType({
  name: "RotatedPublicFormToken",
  fields: {
    token: { type: new GraphQLNonNull(GraphQLString) },
    url: { type: new GraphQLNonNull(GraphQLString) },
    embedUrl: { type: new GraphQLNonNull(GraphQLString) },
  },
});

/** Forms are admin-only on every other surface — reuse the flow gate. */
const requireFormAdmin = requireFlowAdmin;

/** Re-throw service AppErrors as GraphQLErrors so yoga's error masking keeps
 *  the code + message (mirrors `surfaceAppError` in core/backups). */
const surfaceAppError = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (e) {
    if (e instanceof AppError) {
      throw new GraphQLError(e.message, { extensions: { code: e.code } });
    }
    throw e;
  }
};

/** Coerce sqlite 0/1 → boolean and drop the token hash from the API shape. */
const normalizeFormRow = (r: any) => ({
  id: r.id,
  tenantId: r.tenantId,
  name: r.name,
  collection: r.collection,
  fields: r.fields,
  settings: r.settings ?? null,
  active: Boolean(r.active),
});

const urls = (token: string) => ({
  token,
  url: `/f/${token}`,
  embedUrl: `/embed/f/${token}`,
});

const parseInput = (data: Record<string, unknown>): Partial<FormInput> => ({
  ...(data.name !== undefined ? { name: data.name as string } : {}),
  ...(data.collection !== undefined ? { collection: data.collection as string } : {}),
  ...(data.fields !== undefined ? { fields: data.fields as FormBlock[] } : {}),
  ...(data.settings !== undefined ? { settings: data.settings as FormSettings | null } : {}),
  ...(data.active !== undefined ? { active: Boolean(data.active) } : {}),
});

export const formQueryFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  publicForms: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(FormType))),
    description: "List public forms in the active workspace (admin-only).",
    resolve: async (_src, _args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const rows = await listForms(gqlCtx.ctx, tenantId);
      return rows.map((r) => normalizeFormRow(r));
    },
  },
  publicForm: {
    type: FormType,
    description: "Fetch a single public form by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const row = await getForm(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      return row ? normalizeFormRow(row) : null;
    },
  },
  publicFormResults: {
    type: JSONScalar,
    description:
      "Summarise a form's answers — one distribution per exposed question, counts only (admin-only). Free-text answers are never quoted here; read those through the items surface.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const row = await getForm(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      if (!row) throw new GraphQLError("Form not found", { extensions: { code: "NOT_FOUND" } });
      return await surfaceAppError(() =>
        formResults(gqlCtx.ctx, gqlCtx.auth, tenantId, row),
      );
    },
  },
};

export const formMutationFields: Record<string, GraphQLFieldConfig<unknown, GqlCtx>> = {
  createPublicForm: {
    type: new GraphQLNonNull(CreatedFormType),
    description:
      "Create a public form; returns the one-time plaintext token + public URLs (admin-only).",
    args: { data: { type: new GraphQLNonNull(FormInputType) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const data = (args as { data: Record<string, unknown> }).data;
      if (typeof data?.name !== "string" || data.name.length === 0)
        throw new GraphQLError("name is required", { extensions: { code: "VALIDATION" } });
      if (typeof data?.collection !== "string" || data.collection.length === 0)
        throw new GraphQLError("collection is required", { extensions: { code: "VALIDATION" } });
      if (!Array.isArray(data?.fields) || data.fields.length === 0)
        throw new GraphQLError("fields is required", { extensions: { code: "VALIDATION" } });
      const { row, token } = await surfaceAppError(() =>
        createForm(gqlCtx.ctx, {
          ...(parseInput(data) as FormInput),
          tenantId,
          createdBy: gqlCtx.auth.userId,
        }),
      );
      return { form: normalizeFormRow(row), ...urls(token) };
    },
  },
  updatePublicForm: {
    type: FormType,
    description: "Partial update of a public form by id (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      data: { type: new GraphQLNonNull(FormInputType) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const a = args as { id: string; data: Record<string, unknown> };
      const row = await surfaceAppError(() =>
        updateForm(gqlCtx.ctx, tenantId, a.id, parseInput(a.data)),
      );
      return normalizeFormRow(row);
    },
  },
  deletePublicForm: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: "Delete a public form by id (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      await surfaceAppError(() => deleteForm(gqlCtx.ctx, tenantId, (args as { id: string }).id));
      return true;
    },
  },
  rotatePublicFormToken: {
    type: new GraphQLNonNull(RotatedFormTokenType),
    description:
      "Replace the form's public token; the old link dies immediately (admin-only).",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const { token } = await surfaceAppError(() =>
        rotateFormToken(gqlCtx.ctx, tenantId, (args as { id: string }).id),
      );
      return urls(token);
    },
  },
};
