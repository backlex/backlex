import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const FIELD_CONFIG_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      label: { type: "string" },
      help: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
} as const;

const SETTINGS_SCHEMA = {
  type: "object",
  properties: {
    submitLabel: { type: "string" },
    successMessage: { type: "string" },
    redirectUrl: { type: "string" },
    turnstile: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

export const listForms: McpTool = {
  name: "forms.list",
  description:
    "List public forms in the active workspace. Each row shows id, name, target " +
    "collection, exposed fields, and whether the form is active. The public " +
    "token is never included — mint a new link with `forms.rotate_token`.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/forms`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const getForm: McpTool = {
  name: "forms.get",
  description: "Fetch a single public form's definition by id.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/admin/forms/${encodeURIComponent(id)}`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const listFormEligibleFields: McpTool = {
  name: "forms.eligible_fields",
  description:
    "List a collection's form-eligible fields (scalar, non-private, " +
    "non-computed). Use before `forms.create` to know what can be exposed.",
  inputSchema: {
    type: "object",
    properties: { collection: { type: "string" } },
    required: ["collection"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const collection = String(args.collection ?? "");
    if (!collection) throw new Error("VALIDATION: collection is required");
    const res = await ctx.fetchInternal(
      `/api/admin/forms/eligible-fields/${encodeURIComponent(collection)}`,
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const createForm: McpTool = {
  name: "forms.create",
  description:
    "Create a public form that writes submissions into a collection. Returns " +
    "the ONE-TIME plaintext token plus the public `/f/<token>` and " +
    "`/embed/f/<token>` URLs — it is never shown again.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      collection: { type: "string" },
      fields: FIELD_CONFIG_SCHEMA,
      settings: SETTINGS_SCHEMA,
      active: { type: "boolean" },
    },
    required: ["name", "collection", "fields"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/forms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const updateForm: McpTool = {
  name: "forms.update",
  description:
    "Partial update of a public form (name, collection, fields, settings, active).",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      collection: { type: "string" },
      fields: FIELD_CONFIG_SCHEMA,
      settings: SETTINGS_SCHEMA,
      active: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...patch } = args as { id?: unknown } & Record<string, unknown>;
    const idStr = String(id ?? "");
    if (!idStr) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/admin/forms/${encodeURIComponent(idStr)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const rotateFormToken: McpTool = {
  name: "forms.rotate_token",
  description:
    "Replace a form's public token. The old link dies immediately; returns the " +
    "new one-time token + URLs.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/admin/forms/${encodeURIComponent(id)}/rotate-token`,
      { method: "POST" },
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const deleteForm: McpTool = {
  name: "forms.delete",
  description: "Delete a public form. Its link stops working immediately.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(`/api/admin/forms/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const formResults: McpTool = {
  name: "forms.results",
  description:
    "Summarise a form's answers: one distribution per exposed question — choice " +
    "counts in the schema's own order, a scale's points with its mean, an NPS " +
    "score, and how many rows answered at all. Counts only: free-text answers " +
    "are never quoted here, and the figures cover the whole target collection " +
    "(nothing stamps a row with the form that wrote it). To read individual " +
    "answers use `collections.read` on the form's collection.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const id = String(args.id ?? "");
    if (!id) throw new Error("VALIDATION: id is required");
    const res = await ctx.fetchInternal(
      `/api/admin/forms/${encodeURIComponent(id)}/results`,
    );
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const formsTools: McpTool[] = [
  listForms,
  getForm,
  listFormEligibleFields,
  createForm,
  updateForm,
  rotateFormToken,
  formResults,
  deleteForm,
];
