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
      subject: string;
      text: string;
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
      subject: z.string(),
      text: z.string(),
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
  ]),
);

export const OperationsSchema = z.array(OperationSchema).min(1);

export const FlowTriggerKinds = ["event", "manual", "cron"] as const;
export type FlowTriggerKind = (typeof FlowTriggerKinds)[number];
