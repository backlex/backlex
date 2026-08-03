import { z } from "zod";
import { MAX_APPROVERS, MAX_EXPIRY_HOURS } from "./approvals";
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
      /**
       * Storage keys to attach, usually produced by an earlier
       * `document.render` op (`attach: ["{{ $last.key }}"]`). Templated.
       *
       * Keys only — never a URL. A caller-supplied URL would make the mail
       * sender fetch whatever it was pointed at and post the bytes onward,
       * which is a request forgery with an email as the exfiltration channel.
       */
      attach?: string[];
      /**
       * Attach a calendar invite.
       *
       * Eight of the schema templates model a scheduled thing, and this is the
       * write-back that needs no account connected anywhere: an `.ics` reaches
       * Google, Outlook, Apple Calendar and everything else, from the
       * confirmation email the booking was already going to send.
       *
       * Every field is interpolated, so the usual shape is
       * `{ summary: "{{ data.service }}", start: "{{ data.starts_at }}" }`.
       * `start` is required; the rest have defaults.
       */
      ics?: {
        summary: string;
        /** ISO instant, epoch ms, or `YYYY-MM-DD` for an all-day event. */
        start: string;
        /** Defaults to an hour after `start` (a day, for an all-day). */
        end?: string;
        description?: string;
        location?: string;
        url?: string;
        /** Makes it an invitation rather than a plain event. */
        organizerEmail?: string;
        organizerName?: string;
        /** Comma-separated. Defaults to the message's own recipient. */
        attendees?: string;
        /**
         * Stable identity for THIS booking, so a second send updates the
         * calendar entry instead of creating another one. Defaults to the
         * triggering row's id; set it explicitly when the flow is not
         * row-scoped.
         */
        uid?: string;
        /** Raise on each re-send of the same `uid`; `cancel` withdraws it. */
        sequence?: number;
        method?: "REQUEST" | "PUBLISH" | "CANCEL";
        filename?: string;
      };
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /**
   * Render a stored HTML document template against the triggering row and put
   * the PDF in storage.
   *
   * Fourteen of the schema templates carry documents — contracts, quotes,
   * invoices, agreements — and this is what turns the row that holds one into
   * the artefact somebody can sign or pay. The result lands on `{{ $last }}` as
   * `{ key, filename, size, renderer }`, so the usual next step is an `email`
   * op with `attach: ["{{ $last.key }}"]`.
   */
  | {
      type: "document.render";
      /** A stored template's key. Omit when passing `html`. */
      templateKey?: string;
      /** A complete HTML document, for a one-off that needs no stored template. */
      html?: string;
      /** Extra values on top of `data` / `$user` / `$last`. */
      vars?: Record<string, unknown>;
      /** Overrides the template's suggested name. Templated. */
      filename?: string;
      /** Write the stored key onto a row once it renders. */
      writeBack?: { collection: string; id: string; field: string };
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /**
   * Freeze a document and send it out for signature.
   *
   * The step after `document.render` for the five templates that end in a
   * signature — rental `agreements`, field-service `contracts`, real-estate
   * `offers`. The document is interpolated and snapshot NOW, so an edit to the
   * template or the row afterwards cannot change what the signer reads.
   *
   * `{{ $last }}` carries `{ id, status, signers: [{ id, email, status }] }`.
   * It carries NO signing links: everything on `$last` is readable by every op
   * after this one — a `webhook` posting it onward, a `log` writing it to the
   * server log — and a link is a bearer credential for somebody else's
   * signature. The invitation email is sent by the op itself and its wording
   * is customised through the `signature_request` email template.
   */
  | {
      type: "document.sign";
      /** A stored document template's key. Omit when passing `html`. */
      templateKey?: string;
      /** A complete HTML document, for a one-off. */
      html?: string;
      /** Extra values on top of `data` / `$user` / `$last`. */
      vars?: Record<string, unknown>;
      /** What the signer is told they are signing. Templated. */
      title?: string;
      /** A note carried into the invitation email. Templated. */
      message?: string;
      /** Overrides the template's suggested name. Templated. */
      filename?: string;
      /**
       * Who signs. `email` is templated (`{{ data.customer_email }}`); the
       * whole list may also be a template resolving to an array, for a row
       * that carries its own counterparties.
       */
      signers:
        | Array<{ email: string; name?: string; role?: string }>
        | string;
      /** Each link only opens once the one before it has signed. */
      ordered?: boolean;
      expiresInDays?: number;
      /** Where the SIGNED document's storage key lands, once everyone signs. */
      writeBack?: { collection: string; id: string; field: string };
      /** Extra addresses that receive the completed copy. Templated. */
      notifyEmails?: string[] | string;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /**
   * Print a dashboard and, optionally, mail it.
   *
   * The op every schema template wanted and none of them had. Panels, a PDF
   * renderer and mail with attachments all existed separately, so the numbers
   * were always one login away from whoever needed them; on a `cron` trigger
   * this is what walks them the rest of the way. "First of the month, 08:00,
   * the revenue dashboard to the accountant" is a flow with one op.
   *
   * `to` is optional on purpose. Omitted, the op renders and stores, and
   * `{{ $last.key }}` is attachable by a following `email` op — for the flow
   * that wants to say something of its own around the file. Given, the op mails
   * it itself, one message per recipient.
   *
   * The dashboard runs with the FLOW's identity, so a panel reading a
   * collection the flow's user cannot read comes back as an error printed on
   * the page rather than data. `{{ $last }}` carries
   * `{ key, filename, size, renderer, panels, failedPanels, sentTo }`.
   */
  | {
      type: "report.deliver";
      /** The dashboard to print. Templated, for a flow that picks one per row. */
      dashboardId: string;
      /** Overrides `<dashboard-name>-<date>.pdf`. Templated. */
      filename?: string;
      /** One address or a comma-separated list. Templated. Omit to render only. */
      to?: string;
      /** Templated. Defaults to the dashboard's name. */
      subject?: string;
      /** An `email_templates` key for the covering message. */
      templateKey?: string;
      /** Page setup for the PDF — format, orientation, margins. */
      pageOptions?: {
        format?: "A4" | "Letter" | "Legal" | "A3" | "A5";
        landscape?: boolean;
        printBackground?: boolean;
      };
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /**
   * Stop, and wait for a person.
   *
   * The only op that suspends a flow on something other than the clock.
   * Everything after it at the TOP LEVEL of the flow is the "once approved"
   * branch: it is checkpointed onto the approval request and resumed when the
   * decision lands, exactly the way `delay` checkpoints onto `scheduled_tasks`.
   * `onRejected` is the other branch — a rejection (or an expiry, which is a
   * rejection nobody bothered to type) runs it and the flow ends there.
   *
   * Because the continuation is "the rest of the flow", this op cannot appear
   * inside `onSuccess` / `onError` / an `if` branch: there is no checkpoint
   * scope there, and unlike a long `delay` it cannot degrade to waiting inline.
   * The compiler rejects a nested one rather than silently creating a request
   * that nothing will ever resume.
   *
   * `{{ $last }}` on resume carries `{ requestId, outcome, decidedBy, reason,
   * approvals, rejections }`.
   */
  | {
      type: "approval.request";
      /** What the approver is told they are deciding. Templated. */
      title: string;
      /** A note carried into the invitation email. Templated. */
      message?: string;
      /**
       * Who decides. `email` is templated (`{{ data.manager_email }}`); the
       * whole list may also be a template resolving to an array, for a row
       * that carries its own approvers.
       */
      approvers:
        | Array<{ email: string; name?: string; role?: string }>
        | string;
      /** all (default) | any | quorum. */
      policy?: "all" | "any" | "quorum";
      /** Only read when `policy` is `quorum`. */
      quorum?: number;
      /** Each link only opens once the one before it has decided. */
      ordered?: boolean;
      /** Defaults to 72. The request expires — and so rejects — after this. */
      expiresInHours?: number;
      /** The row the decision is about; defaults to the triggering row. */
      subject?: { collection: string; id: string };
      /** `[{ label, value }]` shown to the approver, frozen at send time. */
      summary?: Array<{ label: string; value: string }> | string;
      /** What is patched onto the subject row once the outcome is known. */
      writeBack?: {
        collection?: string;
        id?: string;
        field: string;
        approvedValue?: unknown;
        rejectedValue?: unknown;
      };
      /** Extra addresses that receive the outcome. Templated. */
      notifyEmails?: string[] | string;
      /** Runs on a rejection or an expiry. The rest of the flow does not. */
      onRejected?: Operation[];
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
      /** Also fan out to the target user's registered push devices. Ignored
       *  for broadcasts (`userId` null) — push needs a concrete recipient. */
      push?: boolean;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /** Send a native push notification to a user's registered devices. `userId`
   *  may be a literal id or a `{{ data.author }}` template; users with no active
   *  devices are a silent no-op. Distinct from `notification` (in-app feed). */
  | {
      type: "push";
      title: string;
      body: string;
      url?: string;
      userId: string;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /** Send an SMS through the workspace's configured transport (Twilio / SNS /
   *  NetGSM / İletimerkezi). Two addressing modes, exactly one per op:
   *
   *  - `to` — a literal or templated E.164 number. This is the mode the
   *    reminder use case needs: an appointment's recipient is a *customer*
   *    carried on the row (`{{ data.phone }}`), not a platform user, so there
   *    is no `phone_numbers` registration to look up. Mirrors `email.to`.
   *  - `userId` — a platform user's registered, active numbers. Mirrors
   *    `push.userId`; a user with none is a silent no-op.
   */
  | {
      type: "sms";
      body: string;
      to?: string;
      userId?: string;
      /** Sender override (provider sender id / alphanumeric). Falls back to
       *  the transport's configured sender. */
      from?: string;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /**
   * Open a hosted checkout with a connected payment provider and (optionally)
   * write the link back onto the row that triggered the flow.
   *
   * This is the automation the payments feature was missing: fifteen of the
   * schema templates model money arriving — invoices, quotes, donations,
   * rental orders — and until now a row landing in one of them could be
   * emailed about but never actually billed. With this op, "an invoice was
   * created" produces a payment link on the invoice.
   *
   * `amount` is in MINOR units, matching `payment_transactions.amount`, and is
   * usually a template (`{{ data.amount_due }}`). The `reference` that travels
   * out with the checkout comes back on the settlement event, so the payment
   * that eventually arrives is tied to this row rather than floating free.
   */
  | {
      type: "payment.checkout";
      /** Provider name (`stripe`, `paytr`, …). Omit when `providerId` is set. */
      provider?: string;
      /** A specific connection, for a workspace with more than one. */
      providerId?: string;
      /** MINOR units. A template is interpolated then parsed as an integer. */
      amount: string | number;
      currency: string;
      description?: string;
      /** Required by PayTR and iyzico. Usually `{{ data.email }}`. */
      email?: string;
      customerName?: string;
      successUrl?: string;
      cancelUrl?: string;
      /** Overrides the reference derived from `writeBack.itemId`. */
      reference?: string;
      /** Store the link (and optionally the reference) on a row. */
      writeBack?: {
        collection: string;
        itemId: string;
        urlField: string;
        referenceField?: string;
      };
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /**
   * Give money back.
   *
   * The mirror of `payment.checkout`, and the automation that pairs with a
   * status changing: an order row moving to `cancelled` or a return being
   * approved is exactly the moment a refund should go out, and until now that
   * meant an operator remembering to open the PSP's dashboard.
   *
   * Say which payment with ONE of `paymentRowId`, `externalId` or `reference`.
   * `reference` is usually the right one in a flow — the row that was billed
   * knows what reference it was billed under and nothing else about the
   * payment. Omit `amount` to give back everything still refundable.
   */
  | {
      type: "payment.refund";
      /** Provider name (`stripe`, `klarna`, …). Omit when `providerId` is set. */
      provider?: string;
      /** A specific connection, for a workspace with more than one. */
      providerId?: string;
      /** The `payment_transactions` row. A template is interpolated first. */
      paymentRowId?: string;
      /** The provider's own id for the payment. */
      externalId?: string;
      /** The reference the checkout travelled out with. */
      reference?: string;
      /** MINOR units. Omitted refunds the whole remaining balance. */
      amount?: string | number;
      reason?: "duplicate" | "fraudulent" | "requested_by_customer" | "other";
      description?: string;
      onSuccess?: Operation[];
      onError?: Operation[];
    }
  /** Invoke a saved backlex function by name, tenant-scoped. The
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
  /** Send a message through one of the workspace's connected integrations,
   *  addressed by provider `kind` (there is one row per (workspace, kind)).
   *  Turns every provider in the registry into a flow step: post to Slack,
   *  open a Jira issue, index into Algolia. Credentials stay server-side —
   *  the flow only names the provider, never its secrets. Delivery is logged
   *  and folded into the same circuit breaker as event fan-out. */
  | {
      type: "integration";
      kind: string;
      /** One-line human text — what chat sinks render. */
      text: string;
      /** Event label recorded in the delivery log; defaults to `flow.run`. */
      event?: string;
      /** Machine payload for structured sinks (GitHub dispatch, Algolia doc). */
      payload?: Record<string, unknown> | string;
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
    }
  /**
   * Run `do` once per row of a collection, with the row bound to `{{ $item.* }}`
   * and standing in as the run's subject.
   *
   * The loop is bounded by `limit` and runs the body inline, which is why the
   * body may not contain anything that suspends: a `foreach` is the one place
   * where "park the rest of the flow and come back" has no answer, since the
   * rest of the flow includes the remaining iterations. Those are refused at
   * save time (`findForeachViolation`) rather than discovered as a loop that
   * silently ran once.
   */
  | {
      type: "foreach";
      collection: string;
      filter?: Condition;
      /** Comma-separated, `-` prefix for DESC — same grammar as a collection's
       *  default sort. */
      sort?: string;
      limit?: number;
      do: Operation[];
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
  "push",
  "sms",
  "document.render",
  "document.sign",
  "report.deliver",
  "approval.request",
  "payment.checkout",
  "payment.refund",
  "function",
  "integration",
  "item.create",
  "item.update",
  "delay",
  "foreach",
];

/**
 * Ceiling on how many rows one `foreach` may walk, and the default when the op
 * names no `limit`.
 *
 * The default is the ceiling on purpose. A loop that quietly stopped at 50
 * would report success having skipped the rest, which is the failure mode that
 * matters here — the operator asked for "every overdue invoice" and got some of
 * them. The runner logs when a loop actually hits the cap, so a collection that
 * outgrew it is visible rather than silently truncated.
 */
export const FOREACH_MAX_ROWS = 500;

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
      attach: z.array(z.string().min(1).max(500)).max(5).optional(),
      ics: z
        .object({
          summary: z.string().min(1).max(300),
          // Not date-validated here: it is almost always a `{{ … }}` template
          // that only resolves at run time, so the parse lives in the executor
          // against the interpolated value — same reasoning as `sms.to`.
          start: z.string().min(1),
          end: z.string().optional(),
          description: z.string().max(4000).optional(),
          location: z.string().max(300).optional(),
          url: z.string().max(2000).optional(),
          organizerEmail: z.string().min(1).optional(),
          organizerName: z.string().max(200).optional(),
          attendees: z.string().max(2000).optional(),
          uid: z.string().max(200).optional(),
          sequence: z.number().int().min(0).max(1_000_000).optional(),
          method: z.enum(["REQUEST", "PUBLISH", "CANCEL"]).optional(),
          filename: z.string().max(120).optional(),
        })
        .optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z
      .object({
        type: z.literal("document.render"),
        templateKey: z.string().min(1).max(200).optional(),
        html: z.string().min(1).optional(),
        vars: z.record(z.string(), z.unknown()).optional(),
        filename: z.string().min(1).max(200).optional(),
        writeBack: z
          .object({
            collection: z.string().min(1),
            id: z.string().min(1),
            field: z.string().min(1),
          })
          .optional(),
        onSuccess: z.array(OperationSchema).optional(),
        onError: z.array(OperationSchema).optional(),
      })
      // One source of HTML, not none and not both. Neither is a run that
      // renders nothing; both is a template silently losing to an inline body.
      .refine((op) => (op.templateKey == null) !== (op.html == null), {
        message: "document.render needs exactly one of `templateKey` or `html`",
      }),
    z
      .object({
        type: z.literal("document.sign"),
        templateKey: z.string().min(1).max(200).optional(),
        html: z.string().min(1).optional(),
        vars: z.record(z.string(), z.unknown()).optional(),
        title: z.string().min(1).max(200).optional(),
        message: z.string().max(2000).optional(),
        filename: z.string().min(1).max(200).optional(),
        // Either a literal list or one template that resolves to an array —
        // a row that carries its own counterparties cannot be written out
        // statically. Emails are NOT validated here: they are almost always
        // `{{ … }}` at save time, so the check lives where the value is real.
        signers: z.union([
          z
            .array(
              z.object({
                email: z.string().min(1).max(320),
                name: z.string().max(120).optional(),
                role: z.string().max(80).optional(),
              }),
            )
            .min(1)
            .max(10),
          z.string().min(1).max(500),
        ]),
        ordered: z.boolean().optional(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
        writeBack: z
          .object({
            collection: z.string().min(1),
            id: z.string().min(1),
            field: z.string().min(1),
          })
          .optional(),
        notifyEmails: z.union([z.array(z.string().max(320)).max(10), z.string().max(500)]).optional(),
        onSuccess: z.array(OperationSchema).optional(),
        onError: z.array(OperationSchema).optional(),
      })
      .refine((op) => (op.templateKey == null) !== (op.html == null), {
        message: "document.sign needs exactly one of `templateKey` or `html`",
      }),
    z.object({
      type: z.literal("report.deliver"),
      dashboardId: z.string().min(1).max(200),
      filename: z.string().min(1).max(200).optional(),
      // Not email-validated here: `to` is almost always a template at save
      // time. The check lives in `parseRecipients`, where the value is real.
      to: z.string().min(1).max(2000).optional(),
      subject: z.string().min(1).max(300).optional(),
      templateKey: z.string().min(1).max(200).optional(),
      pageOptions: z
        .object({
          format: z.enum(["A4", "Letter", "Legal", "A3", "A5"]).optional(),
          landscape: z.boolean().optional(),
          printBackground: z.boolean().optional(),
        })
        .optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z
      .object({
        type: z.literal("approval.request"),
        title: z.string().min(1).max(300),
        message: z.string().max(2000).optional(),
        // Same reasoning as `document.sign`'s signers: a row that carries its
        // own approvers cannot be written out statically, and the addresses
        // are almost always `{{ … }}` at save time, so they are validated
        // where the value is real rather than here.
        approvers: z.union([
          z
            .array(
              z.object({
                email: z.string().min(1).max(320),
                name: z.string().max(120).optional(),
                role: z.string().max(80).optional(),
              }),
            )
            .min(1)
            .max(MAX_APPROVERS),
          z.string().min(1).max(500),
        ]),
        policy: z.enum(["all", "any", "quorum"]).optional(),
        quorum: z.number().int().min(1).max(MAX_APPROVERS).optional(),
        ordered: z.boolean().optional(),
        expiresInHours: z.number().int().min(1).max(MAX_EXPIRY_HOURS).optional(),
        subject: z
          .object({ collection: z.string().min(1), id: z.string().min(1) })
          .optional(),
        summary: z
          .union([
            z.array(z.object({ label: z.string().max(120), value: z.string().max(2000) })).max(40),
            z.string().min(1).max(500),
          ])
          .optional(),
        writeBack: z
          .object({
            collection: z.string().min(1).optional(),
            id: z.string().min(1).optional(),
            field: z.string().min(1),
            approvedValue: z.unknown().optional(),
            rejectedValue: z.unknown().optional(),
          })
          .optional(),
        notifyEmails: z
          .union([z.array(z.string().max(320)).max(10), z.string().max(500)])
          .optional(),
        onRejected: z.array(OperationSchema).optional(),
        onError: z.array(OperationSchema).optional(),
      })
      // A quorum with no number is the one mistake that silently changes the
      // meaning of the op — it would fall back to 1 and approve on the first
      // yes, which is `any` wearing a different name.
      .refine((op) => op.policy !== "quorum" || typeof op.quorum === "number", {
        message: "approval.request with `policy: \"quorum\"` needs `quorum`",
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
      push: z.boolean().optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("push"),
      title: z.string().min(1),
      body: z.string().min(1),
      url: z.string().optional(),
      userId: z.string().min(1),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z
      .object({
        type: z.literal("sms"),
        body: z.string().min(1).max(1600),
        to: z.string().min(1).optional(),
        userId: z.string().min(1).optional(),
        from: z.string().min(1).optional(),
        onSuccess: z.array(OperationSchema).optional(),
        onError: z.array(OperationSchema).optional(),
      })
      // Exactly one addressing mode. Both set is ambiguous (which recipient
      // wins?); neither is a silent no-op that looks like a working flow.
      // `to` isn't regex-checked here — it is usually a `{{ ... }}` template
      // that only resolves at run time, so the E.164 check lives in the
      // executor, against the interpolated value.
      .refine((op) => (op.to == null) !== (op.userId == null), {
        message: "sms needs exactly one of `to` or `userId`",
      }),
    z
      .object({
        type: z.literal("payment.checkout"),
        provider: z.string().min(1).optional(),
        providerId: z.string().min(1).optional(),
        // Either a literal integer or a `{{ … }}` template that renders to
        // one; the executor parses and rejects a non-integer render, because
        // a checkout for `NaN` minor units is worse than a failed run.
        amount: z.union([z.string().min(1), z.number().int().positive()]),
        currency: z.string().min(3).max(3),
        description: z.string().max(200).optional(),
        email: z.string().min(1).optional(),
        customerName: z.string().min(1).optional(),
        successUrl: z.string().min(1).optional(),
        cancelUrl: z.string().min(1).optional(),
        reference: z.string().min(1).optional(),
        writeBack: z
          .object({
            collection: z.string().min(1),
            itemId: z.string().min(1),
            urlField: z.string().min(1),
            referenceField: z.string().min(1).optional(),
          })
          .optional(),
        onSuccess: z.array(OperationSchema).optional(),
        onError: z.array(OperationSchema).optional(),
      })
      // Naming both is contradictory rather than redundant — `providerId`
      // silently wins and the `provider` the author wrote is ignored, which
      // reads as a working flow charging through the wrong connection.
      .refine((op) => !(op.provider && op.providerId), {
        message: "payment.checkout takes `provider` or `providerId`, not both",
      }),
    z
      .object({
        type: z.literal("payment.refund"),
        provider: z.string().min(1).optional(),
        providerId: z.string().min(1).optional(),
        paymentRowId: z.string().min(1).optional(),
        externalId: z.string().min(1).optional(),
        reference: z.string().min(1).optional(),
        // Omitted means "everything still refundable", so this is optional in a
        // way `payment.checkout`'s amount is not.
        amount: z.union([z.string().min(1), z.number().int().positive()]).optional(),
        reason: z.enum(["duplicate", "fraudulent", "requested_by_customer", "other"]).optional(),
        description: z.string().max(200).optional(),
        onSuccess: z.array(OperationSchema).optional(),
        onError: z.array(OperationSchema).optional(),
      })
      .refine((op) => !(op.provider && op.providerId), {
        message: "payment.refund takes `provider` or `providerId`, not both",
      })
      // Caught at SAVE time rather than at run time, because a refund op that
      // names no payment is not a flow that sometimes fails — it is one that
      // can never do anything, and the author should hear about it while they
      // are still looking at the builder.
      .refine(
        (op) => Boolean(op.paymentRowId || op.externalId || op.reference),
        {
          message:
            "payment.refund needs one of `paymentRowId`, `externalId` or `reference` to say " +
            "which payment to refund",
        },
      ),
    z.object({
      type: z.literal("function"),
      name: z.string().min(1),
      input: z.unknown().optional(),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
    z.object({
      type: z.literal("integration"),
      kind: z.string().min(1),
      text: z.string().min(1),
      event: z.string().min(1).optional(),
      payload: z.union([z.record(z.string(), z.unknown()), z.string()]).optional(),
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
    z.object({
      type: z.literal("foreach"),
      collection: z.string().min(1).max(120),
      filter: ConditionSchema.optional(),
      sort: z.string().max(200).optional(),
      // Hard-capped rather than unbounded: the body runs inline inside one
      // tick/request, so a loop over an unbounded collection is a timeout with
      // an arbitrary amount of the work already done and no record of where it
      // stopped. An operator who needs more reaches for a narrower filter.
      limit: z.number().int().positive().max(FOREACH_MAX_ROWS).optional(),
      do: z.array(OperationSchema).min(1),
      onSuccess: z.array(OperationSchema).optional(),
      onError: z.array(OperationSchema).optional(),
    }),
  ]),
);

export const OperationsSchema = z.array(OperationSchema).min(1);

/** Threshold below which a `delay` sleeps inline instead of checkpointing to
 *  `scheduled_tasks`. Shared so the save-time `foreach` check and the runner
 *  agree on which delays actually suspend. */
export const INLINE_DELAY_MS = 30_000;

/**
 * Why a `foreach` body cannot be saved, or null if the tree is fine.
 *
 * A `foreach` runs its body inline, so anything that suspends the flow has
 * nowhere to come back to: the continuation machinery parks "every operation
 * after this one at the top level", which is not the same thing as "the rest of
 * this iteration, then the remaining rows". Parking it would silently drop the
 * loop, and the symptom — a flow that ran once and reported success — looks
 * nothing like the cause.
 *
 * A nested `foreach` is refused for the neighbouring reason: the row bound to
 * `{{ $item }}` would be shadowed with no way to reach the outer one, so the
 * inner loop reads as working while quietly addressing the wrong rows.
 *
 * `approval.request` is NOT checked here — `findNestedApproval` already covers
 * it across every branch, `do` included, and one message per offence is enough.
 *
 * Takes `unknown` because callers hand it freshly-parsed JSON.
 */
export const findForeachViolation = (
  operations: unknown,
  path = "operations",
  insideForeach = false,
): string | null => {
  if (!Array.isArray(operations)) return null;
  const BRANCHES = ["onSuccess", "onError", "then", "else", "onRejected", "do"] as const;
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i] as Record<string, unknown> | null;
    if (!op || typeof op !== "object") continue;
    const here = `${path}[${i}]`;
    if (insideForeach) {
      if (op.type === "foreach") {
        return `${here}: a foreach cannot contain another foreach — the inner loop would shadow {{ $item }} with no way to reach the outer row.`;
      }
      if (
        op.type === "delay" &&
        typeof op.durationMs === "number" &&
        op.durationMs > INLINE_DELAY_MS
      ) {
        return `${here}: a delay longer than ${INLINE_DELAY_MS / 1000}s cannot run inside a foreach — it would suspend the flow and abandon the remaining rows.`;
      }
    }
    for (const branch of BRANCHES) {
      const nested = op[branch];
      if (!Array.isArray(nested)) continue;
      // Everything below a `foreach`'s own `do` is inside the loop; every other
      // branch just inherits whatever context this op is already in.
      const nowInside = insideForeach || (op.type === "foreach" && branch === "do");
      const deeper = findForeachViolation(nested, `${here}.${branch}`, nowInside);
      if (deeper) return deeper;
    }
  }
  return null;
};

export const FlowTriggerKinds = ["event", "manual", "cron", "schedule"] as const;
export type FlowTriggerKind = (typeof FlowTriggerKinds)[number];
