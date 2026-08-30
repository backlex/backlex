import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

export const getSettings: McpTool = {
  name: "settings.get",
  description:
    "Read workspace-level settings (default locale, timezone, feature flags, " +
    "branding, etc.). Returns the full app_settings row.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/settings`);
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

/**
 * The keys `PATCH /api/admin/settings` actually accepts.
 *
 * This list used to be four properties long and two of them — `brandName` and
 * `flags` — never existed on the route at all. The route's `SettingsInput` is
 * `.strict()`, so every call an agent made off the advertised schema came back
 * as `VALIDATION: Unrecognized key: "brandName"`: an advertised input that can
 * only ever fail. It is the third instance of this shape on this branch
 * (`users.invite` advertised a `roleName` the route never had, `tenants.switch`
 * posted a body key the route did not accept), so `settings-usage-surfaces`
 * pins the two sets equal by reading the route's own OpenAPI component — a
 * rename on either side now fails a test instead of an agent's tool call.
 *
 * Feature flags are NOT settings; they are their own resource with their own
 * tools (`flags.list` / `flags.set` / `flags.remove`), which is where `flags`
 * came from and why it never belonged here.
 */
const SETTINGS_PROPERTIES: Record<string, Record<string, unknown>> = {
  i18nLocales: {
    type: "array",
    items: { type: "string" },
    description:
      "Active locales for this workspace, most-preferred first. Must contain " +
      "`i18nDefaultLocale` when both are sent.",
  },
  i18nDefaultLocale: {
    type: "string",
    description: "Fallback locale for strings with no translation, e.g. `en`.",
  },
  timezone: {
    type: "string",
    description: "Workspace default IANA time zone, e.g. `Europe/Istanbul`.",
  },
  defaultCurrency: {
    type: "string",
    description:
      "Three-letter ISO-4217 code pre-selected when a money field is created. " +
      "Authoring convenience only — it is copied onto the field and never read " +
      "at runtime, so changing it never restates an existing amount.",
  },
  signInHeadline: {
    type: "string",
    description:
      "Instance-global sign-in headline (blank = built-in default). Only the " +
      "instance operator may write it.",
  },
  signInTagline: {
    type: "string",
    description:
      "Instance-global sign-in tagline (blank = built-in default). Only the " +
      "instance operator may write it.",
  },
  termsUrl: {
    type: "string",
    description:
      "Instance-global Terms of Service link on the sign-up consent line; " +
      "empty string hides it. Operator-only.",
  },
  privacyUrl: {
    type: "string",
    description:
      "Instance-global Privacy Policy link on the sign-up consent line; " +
      "empty string hides it. Operator-only.",
  },
  passwordLogin: {
    type: "string",
    enum: ["enabled", "app-only", "disabled"],
    description:
      "Instance-global: whether an email + password may be exchanged for a " +
      "session, and on which plane. Operator-only, and refused outright unless " +
      "another way in (SSO, passkey, magic link, email code) is configured.",
  },
  erdLayout: {
    type: "object",
    description:
      "Schema-graph node positions, keyed by collection slug → `{x, y}`. " +
      "Admin-UI state; the query engine never reads it.",
  },
  listColumns: {
    type: "object",
    description:
      "Per-collection list-view columns, keyed by collection slug → ordered " +
      "field names. Admin-UI state.",
  },
  collectionGroups: {
    type: "array",
    items: { type: "string" },
    description: "Ordered group-header names for the Collections page and sidebar.",
  },
  schemaSnapshotSchedule: {
    type: "string",
    enum: ["off", "daily", "weekly"],
    description: "Automatic schema-snapshot cadence.",
  },
  schemaSnapshotKeepLast: {
    type: "integer",
    description: "How many scheduled schema snapshots to retain (1-50).",
  },
};

export const patchSettings: McpTool = {
  name: "settings.update",
  description:
    "Patch workspace settings. Send only the keys you want to change; " +
    "omitted keys retain their current value. Unlisted keys are rejected, not " +
    "ignored. Admin-only, and the sign-in keys (signInHeadline, signInTagline, " +
    "termsUrl, privacyUrl, passwordLogin) are instance-global, so only the " +
    "instance operator may write those. Feature flags are not settings — use " +
    "`flags.set` / `flags.remove`.",
  inputSchema: {
    type: "object",
    properties: SETTINGS_PROPERTIES,
    // The route is `.strict()`, so an unlisted key is refused with a 422 rather
    // than dropped. Saying so here keeps the advertisement honest: an agent
    // reading this schema learns that guessing a key name fails loudly.
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const res = await ctx.fetchInternal(`/api/admin/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const body = await readJson<unknown>(res);
    return textResult(body);
  },
};

export const settingsTools: McpTool[] = [getSettings, patchSettings];
