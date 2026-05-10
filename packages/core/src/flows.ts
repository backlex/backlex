import { z } from "zod";
import type { Condition } from "./permission";

const HttpMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HttpMethods)[number];

export type Operation =
  | { type: "log"; message: string; onSuccess?: Operation[]; onError?: Operation[] }
  | {
      type: "webhook";
      url: string;
      method?: HttpMethod;
      headers?: Record<string, string>;
      body?: unknown;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  | {
      type: "request";
      url: string;
      method?: HttpMethod;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: unknown;
      timeoutMs?: number;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  | {
      type: "email";
      to: string;
      /** When set, the email body is rendered from the matching `email_templates`
       *  row (tenant override → global). `subject` / `html` / `text` then act as
       *  fallback if no template row is found. */
      templateKey?: string;
      /** Extra vars merged into the render context on top of the flow `data`
       *  payload. Values may be templates themselves (`{{ data.author.email }}`). */
      vars?: Record<string, unknown>;
      subject?: string;
      html?: string;
      text?: string;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  | {
      type: "transform";
      value?: unknown;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  | {
      type: "run-script";
      code: string;
      timeoutMs?: number;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  | {
      type: "condition";
      filter: Condition;
      then?: Operation[];
      else?: Operation[];
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /** Drop a row into the `notifications` table. `userId` may be a literal
   *  user id, a `{{ data.author }}` template, or null to broadcast to admins. */
  | {
      type: "notification";
      title: string;
      body?: string;
      url?: string;
      userId?: string | null;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /** Invoke a saved workeros function by name, tenant-scoped. The
   *  function's stored `code` is run in the same sandbox as `run-script`
   *  but the body lives in the `functions` table so it's reusable across
   *  flows and the HTTP `/api/functions/:name/invoke` endpoint. */
  | {
      type: "function";
      name: string;
      input?: unknown;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /** Insert a row into a dynamic collection. Tenant-scoped via the running
   *  flow's auth context. Permission checks are bypassed — flows are
   *  admin-authored, so the trust boundary lives at flow creation time. */
  | {
      type: "item.create";
      collection: string;
      data: Record<string, unknown> | string;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /** Patch an existing row in a dynamic collection by id. Same trust
   *  boundary as item.create. */
  | {
      type: "item.update";
      collection: string;
      id: string;
      data: Record<string, unknown> | string;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /** Pause execution. Short delays (≤ 30s) sleep inline; longer ones are
   *  persisted to `scheduled_tasks` and resumed by the scheduler tick. */
  | {
      type: "delay";
      durationMs: number;
      onSuccess?: Operation[];
      onError?: Operation[];
    };

export type OperationType = Operation["type"];

export const OPERATION_TYPES: OperationType[] = [
  "log",
  "request",
  "webhook",
  "email",
  "transform",
  "run-script",
  "condition",
  "notification",
  "function",
  "item.create",
  "item.update",
  "delay",
];

export const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ $and: z.array(ConditionSchema) }),
    z.object({ $or: z.array(ConditionSchema) }),
    z.object({ $not: ConditionSchema }),
    z.record(
      z.string(),
      z.record(z.string(), z.unknown()),
    ) as z.ZodType<Condition>,
  ]),
);

const HeadersSchema = z.record(z.string(), z.string());
const QuerySchema = z.record(z.string(), z.string());

export const OperationSchema: z.ZodType<Operation> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("log"),
      message: z.string(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("webhook"),
      url: z.string().url(),
      method: z.enum(HttpMethods).optional(),
      headers: HeadersSchema.optional(),
      body: z.unknown().optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("request"),
      url: z.string().url(),
      method: z.enum(HttpMethods).optional(),
      headers: HeadersSchema.optional(),
      query: QuerySchema.optional(),
      body: z.unknown().optional(),
      timeoutMs: z.number().int().positive().max(60_000).optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("email"),
      to: z.string(),
      templateKey: z.string().optional(),
      vars: z.record(z.string(), z.unknown()).optional(),
      subject: z.string().optional(),
      html: z.string().optional(),
      text: z.string().optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("transform"),
      value: z.unknown(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("run-script"),
      code: z.string().min(1),
      timeoutMs: z.number().int().positive().max(30_000).optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("condition"),
      filter: ConditionSchema,
      then: z.array(OperationSchema).optional(),
      else: z.array(OperationSchema).optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("notification"),
      title: z.string().min(1),
      body: z.string().optional(),
      url: z.string().optional(),
      userId: z.string().nullable().optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("function"),
      name: z.string().min(1),
      input: z.unknown().optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("item.create"),
      collection: z.string().min(1),
      // Accept the raw object OR a template string that interpolates to JSON
      // — the executor parses strings at run time.
      data: z.union([z.record(z.string(), z.unknown()), z.string()]),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("item.update"),
      collection: z.string().min(1),
      id: z.string().min(1),
      data: z.union([z.record(z.string(), z.unknown()), z.string()]),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("delay"),
      // Cap at 30 days — anything longer is almost certainly a typo.
      durationMs: z.number().int().nonnegative().max(30 * 24 * 60 * 60 * 1000),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
  ]),
);

export const OperationsSchema = z.array(OperationSchema).min(1);

export const FlowTriggerKinds = ["event", "manual", "cron"] as const;
export type FlowTriggerKind = (typeof FlowTriggerKinds)[number];
