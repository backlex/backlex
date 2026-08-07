import { AppError } from "@backlex/core";
import { JSONScalar, type GqlCtx } from "./core";
import { requireFlowAdmin } from "./flows";
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
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
import { sendFormReminders } from "../form-reminders";
import {
  createFormInvites,
  deleteFormInvite,
  listFormInvites,
  type FormInviteRow,
} from "../form-invites";

/** The invite shape a read surface hands out — no token, no hash. Mirrors
 *  `serializeInvite` in the REST route so the two agree. */
const publicInvite = (r: FormInviteRow) => ({
  id: r.id,
  formId: r.formId,
  email: r.email,
  name: r.name,
  sentAt: r.sentAt,
  usedAt: r.usedAt,
  remindedAt: r.remindedAt,
  reminderCount: r.reminderCount,
  createdAt: r.createdAt,
});

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
  publicFormInvites: {
    type: JSONScalar,
    description:
      "Who was invited to answer a form, whether their mail went out and whether they have answered (admin-only). Tokens are never listed — mint replacements with `invitePublicForm`.",
    args: { id: { type: new GraphQLNonNull(GraphQLID) } },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const row = await getForm(gqlCtx.ctx, tenantId, (args as { id: string }).id);
      if (!row) throw new GraphQLError("Form not found", { extensions: { code: "NOT_FOUND" } });
      const invites = await listFormInvites(gqlCtx.ctx, tenantId, row.id);
      return invites.map(publicInvite);
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
  invitePublicForm: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Mint one single-use invite link per recipient (admin-only). The plaintext tokens are in THIS response and nowhere else. Pass `formToken` to get ready-made links back.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      recipients: { type: new GraphQLNonNull(JSONScalar) },
      formToken: { type: GraphQLString },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const a = args as {
        id: string;
        recipients: unknown;
        formToken?: string | null;
      };
      const row = await getForm(gqlCtx.ctx, tenantId, a.id);
      if (!row) throw new GraphQLError("Form not found", { extensions: { code: "NOT_FOUND" } });
      if (!Array.isArray(a.recipients)) {
        throw new GraphQLError("recipients must be a list", {
          extensions: { code: "VALIDATION" },
        });
      }
      const minted = await surfaceAppError(() =>
        createFormInvites(
          gqlCtx.ctx,
          tenantId,
          row,
          a.formToken ?? null,
          a.recipients as { email?: string; name?: string }[],
        ),
      );
      return minted.map((m) => ({ ...publicInvite(m), token: m.token, url: m.url }));
    },
  },
  remindPublicFormInvites: {
    type: new GraphQLNonNull(JSONScalar),
    description:
      "Mint a fresh link for everyone who hasn't answered, and with `send: true` mail it (admin-only). Earlier links keep working — every link an invite has ever had opens the same turn. Answered invites are never reminded, and nobody is reminded twice inside `minIntervalHours` (default 24) unless `force`. The plaintext tokens are in THIS response and nowhere else.",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      inviteIds: { type: new GraphQLList(new GraphQLNonNull(GraphQLID)) },
      formToken: { type: GraphQLString },
      send: { type: GraphQLBoolean },
      minIntervalHours: { type: GraphQLInt },
      force: { type: GraphQLBoolean },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const a = args as {
        id: string;
        inviteIds?: string[] | null;
        formToken?: string | null;
        send?: boolean | null;
        minIntervalHours?: number | null;
        force?: boolean | null;
      };
      const row = await getForm(gqlCtx.ctx, tenantId, a.id);
      if (!row) throw new GraphQLError("Form not found", { extensions: { code: "NOT_FOUND" } });
      const result = await surfaceAppError(() =>
        sendFormReminders(gqlCtx.ctx, tenantId, row, {
          ...(a.inviteIds?.length ? { inviteIds: a.inviteIds } : {}),
          formToken: a.formToken ?? null,
          ...(a.send ? { send: true } : {}),
          ...(typeof a.minIntervalHours === "number"
            ? { minIntervalHours: a.minIntervalHours }
            : {}),
          ...(a.force ? { force: true } : {}),
        }),
      );
      return {
        invites: result.minted.map((m) => ({
          ...publicInvite(m),
          token: m.token,
          url: m.url,
        })),
        sent: result.sent,
        skipped: result.skipped,
      };
    },
  },
  revokePublicFormInvite: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description:
      "Revoke an invite; every link that opened it stops working immediately (admin-only).",
    args: {
      id: { type: new GraphQLNonNull(GraphQLID) },
      inviteId: { type: new GraphQLNonNull(GraphQLID) },
    },
    resolve: async (_src, args, gqlCtx) => {
      const tenantId = requireFormAdmin(gqlCtx);
      const a = args as { id: string; inviteId: string };
      const row = await getForm(gqlCtx.ctx, tenantId, a.id);
      if (!row) throw new GraphQLError("Form not found", { extensions: { code: "NOT_FOUND" } });
      await surfaceAppError(() =>
        deleteFormInvite(gqlCtx.ctx, tenantId, row.id, a.inviteId),
      );
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
