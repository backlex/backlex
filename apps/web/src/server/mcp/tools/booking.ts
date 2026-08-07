import type { McpTool, ToolResult } from "../types";
import { readJson } from "../internal-fetch";

/**
 * Availability & booking over MCP. Every tool proxies the admin REST routes
 * through `fetchInternal`, so the caller's identity, the workspace scoping, the
 * capacity guarantee and the derived statuses all come from the one
 * implementation rather than from a second copy of the rules.
 *
 * Two deliberate absences:
 *
 * - **No tool returns a token.** `booking.create_resource` mints the public page
 *   token and `booking.book` mints a manage link, and both are bearer
 *   credentials: whoever holds one can book against the calendar or cancel a
 *   stranger's appointment. An agent's tool result is transcript that gets
 *   summarised, forwarded and stored, so the tokens are stripped here. The page
 *   URL is available to an operator through the admin or the CLI, and the
 *   manage link rides on the confirmation email the call already sent.
 * - **No public booking tool.** Taking a slot as a stranger is authenticated by
 *   a page token and nothing else. `booking.book` is the operator's act and
 *   says so in the row's `source`.
 */
const textResult = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  structuredContent: value as object,
});

const BASE = "/api/admin/booking";

/**
 * Drop anything bearer-shaped from a payload before it becomes transcript.
 *
 * Deliberately keyed on the field NAMES the service returns rather than on a
 * pattern over the values: a future field that carries a credential should have
 * to be added here on purpose.
 */
const withoutTokens = <T extends Record<string, unknown>>(value: T): Partial<T> => {
  const { token, manageToken, manageUrl, url, ...rest } = value as Record<string, unknown>;
  return rest as Partial<T>;
};

const RESOURCE_PROPERTIES = {
  name: { type: "string" },
  description: { type: "string" },
  timeZone: {
    type: "string",
    description:
      "IANA zone the RULES are written in (e.g. Europe/Istanbul). Not a display preference — it is what decides which instant 'Mondays 09:00' names.",
  },
  slotMinutes: { type: "number", description: "How long one booking lasts." },
  stepMinutes: {
    type: "number",
    description: "Distance between consecutive slot starts. Omit for back-to-back.",
  },
  capacity: { type: "number", description: "How many bookings one instant holds." },
  bufferBeforeMinutes: { type: "number" },
  bufferAfterMinutes: {
    type: "number",
    description:
      "Buffers belong to every booking, so 15 either side means a 30-minute gap between two of them. Set one side for a one-sided gap.",
  },
  leadMinutes: { type: "number", description: "Minimum notice." },
  horizonDays: { type: "number", description: "How far ahead the calendar is open." },
  holdMinutes: { type: "number", description: "How long an unconfirmed hold survives." },
  questions: {
    type: "array",
    items: { type: "object" },
    description: "What the booker is asked beyond name and address.",
  },
  settings: {
    type: "object",
    description:
      "Public page appearance: { theme: dark|light, accent: #rrggbb, font: sans|lexend|mono|system }. Same vocabulary a form stores.",
  },
  mirrorEnabled: {
    type: "boolean",
    description:
      "Whether bookings are recorded into a collection at all. On by default — the workspace's `booking_records` collection is provisioned automatically and needs no configuring.",
  },
  mirrorCollection: {
    type: "string",
    description:
      "Record into a collection of your own instead of the provisioned default. Requires mirrorFieldMap — a target with no map records nothing, so it is refused rather than accepted silently.",
  },
  mirrorFieldMap: {
    type: "object",
    description:
      "Only for a custom mirrorCollection. Booking field → collection column. Keys: booking, start, end, name, email, phone, status, resource, source, notes, answers, or any question name.",
  },
  active: { type: "boolean" },
  confirmationMessage: { type: "string" },
  notifyEmails: { type: "array", items: { type: "string" } },
  rules: {
    type: "array",
    items: { type: "object" },
    description:
      "REPLACES the whole opening pattern. Each: { kind: open|block, weekday: 0-6 or null, startMinute, endMinute, startsOn?, endsOn?, reason? }. Minutes count from LOCAL midnight, 0..1440; a span crossing midnight is two rules.",
  },
} as const;

export const listBookingResourcesTool: McpTool = {
  name: "booking.list_resources",
  description:
    "List the workspace's bookable resources, each with its full opening pattern. The public page " +
    "token is never included — only its hash is stored.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_args, ctx) =>
    textResult(await readJson<unknown>(await ctx.fetchInternal(`${BASE}/resources`))),
};

export const getBookingResourceTool: McpTool = {
  name: "booking.get_resource",
  description: "One bookable resource, by key or id, with its rules.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" } },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { key } = args as { key: string };
    return textResult(
      await readJson<unknown>(await ctx.fetchInternal(`${BASE}/resources/${encodeURIComponent(key)}`)),
    );
  },
};

export const createBookingResourceTool: McpTool = {
  name: "booking.create_resource",
  description:
    "Create a bookable resource with its opening pattern. The public page token this mints is " +
    "STRIPPED from the result — it is a bearer credential and a tool result is transcript. An " +
    "operator can read the URL in the admin or with `backlex booking url`.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Lowercase handle, unique in the workspace." },
      ...RESOURCE_PROPERTIES,
    },
    required: ["key", "name"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const out = await readJson<{ data: Record<string, unknown> }>(
      await ctx.fetchInternal(`${BASE}/resources`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    );
    return textResult({ data: withoutTokens(out.data) });
  },
};

export const updateBookingResourceTool: McpTool = {
  name: "booking.update_resource",
  description:
    "Update a resource. Passing `rules` REPLACES the whole opening pattern — it is edited as one " +
    "thing, not row by row.",
  inputSchema: {
    type: "object",
    properties: { key: { type: "string" }, ...RESOURCE_PROPERTIES },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { key, ...patch } = args as { key: string } & Record<string, unknown>;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/resources/${encodeURIComponent(key)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        }),
      ),
    );
  },
};

export const bookingSlotsTool: McpTool = {
  name: "booking.slots",
  description:
    "The open slots for a resource — computed from its rules, its exceptions and what is already " +
    "taken. Times are ISO instants; present them in the resource's own `timeZone`. The window " +
    "defaults to a fortnight and is clamped to 62 days. `remaining` is the capacity left, and a " +
    "full slot is absent rather than present with zero.",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string" },
      from: { type: "string", description: "ISO instant. Defaults to now." },
      to: { type: "string", description: "ISO instant. Defaults to a fortnight out." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = args as { key: string; from?: string; to?: string };
    const q = new URLSearchParams();
    if (a.from) q.set("from", a.from);
    if (a.to) q.set("to", a.to);
    const qs = q.toString();
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(
          `${BASE}/resources/${encodeURIComponent(a.key)}/slots${qs ? `?${qs}` : ""}`,
        ),
      ),
    );
  },
};

export const listBookingsTool: McpTool = {
  name: "booking.list",
  description:
    "List bookings. `completed` and `expired` are derived from the clock rather than stored, so " +
    "filtering by them matches rows nothing has swept. `live` drops the ones that no longer " +
    "stand — cancelled, no-show, and holds the clock let go.",
  inputSchema: {
    type: "object",
    properties: {
      resource: { type: "string" },
      status: {
        type: "string",
        enum: ["held", "confirmed", "cancelled", "no_show", "completed", "expired"],
      },
      from: { type: "string" },
      to: { type: "string" },
      limit: { type: "number" },
      offset: { type: "number" },
      order: { type: "string", enum: ["asc", "desc"] },
      live: { type: "boolean" },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const a = args as Record<string, string | number | boolean | undefined>;
    const q = new URLSearchParams();
    for (const key of ["resource", "status", "from", "to", "limit", "offset", "order", "live"]) {
      const value = a[key];
      if (value !== undefined) q.set(key, String(value));
    }
    const qs = q.toString();
    return textResult(
      await readJson<unknown>(await ctx.fetchInternal(`${BASE}/bookings${qs ? `?${qs}` : ""}`)),
    );
  },
};

export const bookTool: McpTool = {
  name: "booking.book",
  description:
    "Take a slot as the OPERATOR — the row records `source: admin`. Unlike the public page this " +
    "is not restricted to the published grid, which is what makes it usable for a booking taken " +
    "over the phone; the capacity guarantee still applies and a taken slot answers CONFLICT. The " +
    "manage link is stripped from the result and reaches the customer by email.",
  inputSchema: {
    type: "object",
    properties: {
      resource: { type: "string" },
      start: { type: "string", description: "ISO instant." },
      end: { type: "string", description: "ISO instant. Defaults to start + slotMinutes." },
      name: { type: "string" },
      email: { type: "string" },
      phone: { type: "string" },
      answers: { type: "object" },
      notes: { type: "string" },
      hold: {
        type: "boolean",
        description: "Park the slot instead of confirming it — what a deposit is taken during.",
      },
    },
    required: ["resource", "start"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const out = await readJson<{ data: Record<string, unknown> }>(
      await ctx.fetchInternal(`${BASE}/bookings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      }),
    );
    return textResult({ data: withoutTokens(out.data) });
  },
};

export const confirmBookingTool: McpTool = {
  name: "booking.confirm",
  description:
    "Promote a held booking to a confirmation. The slot was never released so nothing is " +
    "re-checked, but a hold that already lapsed answers CONFLICT.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id } = args as { id: string };
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/bookings/${encodeURIComponent(id)}/confirm`, {
          method: "POST",
        }),
      ),
    );
  },
};

export const cancelBookingTool: McpTool = {
  name: "booking.cancel",
  description:
    "Cancel a booking, freeing the slot. Idempotent — cancelling an already-cancelled booking is " +
    "a no-op rather than an error. Set `notify: false` to skip the customer's email.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      reason: { type: "string" },
      notify: { type: "boolean" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, ...body } = args as { id: string } & Record<string, unknown>;
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/bookings/${encodeURIComponent(id)}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
    );
  },
};

export const rescheduleBookingTool: McpTool = {
  name: "booking.reschedule",
  description:
    "Move a booking to another time. Cancel-then-book through the same guard: the old row keeps a " +
    "pointer to the new one and is released LAST, so a clash leaves the customer with the " +
    "appointment they already had. The new manage link is stripped from the result.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, start: { type: "string" } },
    required: ["id", "start"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id, start } = args as { id: string; start: string };
    const out = await readJson<{ data: Record<string, unknown> }>(
      await ctx.fetchInternal(`${BASE}/bookings/${encodeURIComponent(id)}/reschedule`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start }),
      }),
    );
    return textResult({ data: withoutTokens(out.data) });
  },
};

export const markNoShowTool: McpTool = {
  name: "booking.no_show",
  description:
    "Mark a booking as a no-show. Distinct from a cancellation: the slot was held and the time " +
    "was spent, and a workspace that bills for it has to tell the two apart.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id } = args as { id: string };
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/bookings/${encodeURIComponent(id)}/no-show`, {
          method: "POST",
        }),
      ),
    );
  },
};

export const recordBookingTool: McpTool = {
  name: "booking.record",
  description:
    "Record a booking into its collection again after a failure. Recording is best-effort on the " +
    "write path — the slot is already held, so a renamed collection must not turn a confirmed " +
    "appointment into an error for the customer — and the reason is kept on the booking's " +
    "`mirrorError`. This retries it and answers with that reason when it still cannot.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const { id } = args as { id: string };
    return textResult(
      await readJson<unknown>(
        await ctx.fetchInternal(`${BASE}/bookings/${encodeURIComponent(id)}/record`, {
          method: "POST",
        }),
      ),
    );
  },
};

export const bookingTools: McpTool[] = [
  listBookingResourcesTool,
  getBookingResourceTool,
  createBookingResourceTool,
  updateBookingResourceTool,
  bookingSlotsTool,
  listBookingsTool,
  bookTool,
  confirmBookingTool,
  cancelBookingTool,
  rescheduleBookingTool,
  markNoShowTool,
  recordBookingTool,
];
