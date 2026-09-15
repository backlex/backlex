/**
 * The emails backlex sends through a stored template, and what each one is
 * rendered with.
 *
 * A template's `{{ … }}` placeholders resolve against whatever object the
 * SENDER hands `sendTemplatedEmail` as `vars`. Nothing checks a placeholder
 * against anything: one naming a variable the sender does not pass renders as
 * an empty string, silently. So the admin cannot write a template without the
 * variable list, and the only honest source for that list is the send site.
 * This module is where it is written down, in a form both ends are held to:
 *
 *   - every built-in send site checks its `vars` literal with
 *     `satisfies BuiltInEmailVars["<key>"]`, so adding, renaming or dropping a
 *     variable there is a type error until the interface below agrees;
 *   - the admin's variable list is DERIVED from each `sample`, which is typed
 *     as that same interface — it cannot offer a name the sender does not pass.
 *
 * Subpath, not barrel: the samples and starter bodies exist for the admin UI.
 * The server imports only TYPES from here, which are erased, so none of this
 * reaches the worker's eager module graph.
 *
 * Deliberately NOT listed: `verify`, `reset`, `magic`, `invite` and
 * `change_email`. Those rows are seeded (`services/seed.ts`), but no sender
 * resolves them — sign-in, verification, password-reset and invite mail is
 * composed inline (`packages/auth`, `routes/tenants.ts`,
 * `services/app-user-invites.ts`). Listing them would promise variables that
 * nothing supplies.
 */
import { TEMPLATE_PLACEHOLDER } from "./email";

export type BuiltInEmailFeature = "forms" | "signatures" | "approvals" | "booking";

interface FormLinkEmailVars {
  form: string;
  url: string;
  recipient: { email: string; name: string };
}

interface ApprovalOutcomeEmailVars {
  title: string;
  outcome: string;
  reason: string;
  approvers: Array<{ email: string; name: string; role: string; status: string; reason: string }>;
}

interface BookingEmailVars {
  resource: string;
  when: string;
  manageUrl: string;
  customerName: string;
  confirmationMessage: string;
}

/** Exactly what each built-in sender passes as `vars`, keyed by template key. */
export interface BuiltInEmailVars {
  form_invite: FormLinkEmailVars;
  form_reminder: FormLinkEmailVars;
  signature_request: {
    title: string;
    message: string;
    url: string;
    signer: { email: string; name: string; role: string };
    expiresAt: string;
  };
  signature_completed: {
    title: string;
    signers: Array<{ email: string; name: string }>;
    documentHash: string;
  };
  approval_request: {
    title: string;
    message: string;
    url: string;
    approver: { email: string; name: string; role: string };
    summary: unknown[];
    summaryHtml: string;
    expiresAt: string;
  };
  approval_approved: ApprovalOutcomeEmailVars;
  approval_rejected: ApprovalOutcomeEmailVars;
  approval_expired: ApprovalOutcomeEmailVars;
  approval_cancelled: ApprovalOutcomeEmailVars;
  "booking.confirmed": BookingEmailVars;
  "booking.cancelled": BookingEmailVars;
  "booking.rescheduled": BookingEmailVars;
}

export type BuiltInEmailKey = keyof BuiltInEmailVars;

export interface BuiltInEmailTemplate<K extends BuiltInEmailKey = BuiltInEmailKey> {
  feature: BuiltInEmailFeature;
  /** A realistic render context, shaped exactly like the sender's `vars`. */
  sample: BuiltInEmailVars[K];
  /**
   * Where an admin starts from. NOT the built-in wording itself: the sender
   * composes that inline with every value HTML-escaped, and keeps sending it
   * until the workspace saves a template under this key.
   */
  starter: { subject: string; bodyHtml: string };
}

const formLink = (form: string): FormLinkEmailVars => ({
  form,
  url: "https://app.example.com/f/frm_4Xn8Qd?i=inv_7Kq2mX9pL4",
  recipient: { email: "ada@example.com", name: "Ada Lovelace" },
});

const approvalOutcome = (outcome: string, reason: string): ApprovalOutcomeEmailVars => ({
  title: "Refund of €480 for order 10482",
  outcome,
  reason,
  approvers: [
    {
      email: "grace@example.com",
      name: "Grace Hopper",
      role: "Finance",
      // An approver's own status is only ever a decision or `pending` — a
      // request that expired or was withdrawn left its approvers undecided.
      status: outcome === "approved" || outcome === "rejected" ? outcome : "pending",
      reason,
    },
  ],
});

const booking: BookingEmailVars = {
  resource: "Initial consultation",
  when: "Thursday 18 September 2026 at 14:30",
  manageUrl: "https://app.example.com/b/bkm_2Lr9Tq5vW1",
  customerName: "Ada Lovelace",
  confirmationMessage: "Please arrive ten minutes early.",
};

const bookingBody =
  `<p>Hello {{ customerName }},</p>\n` +
  `<p>Your booking for <strong>{{ resource }}</strong> is confirmed for <strong>{{ when }}</strong>.</p>\n` +
  `<p>{{ confirmationMessage }}</p>\n` +
  `<p><a href="{{ manageUrl }}">Change or cancel this booking</a></p>`;

const outcomeBody = (verb: string) =>
  `<p>“{{ title }}” ${verb}.</p>\n<p>{{ reason }}</p>`;

export const BUILT_IN_EMAIL_TEMPLATES: { readonly [K in BuiltInEmailKey]: BuiltInEmailTemplate<K> } = {
  form_invite: {
    feature: "forms",
    sample: formLink("Customer satisfaction survey"),
    starter: {
      subject: "You're invited: {{ form }}",
      bodyHtml:
        `<p>Hello {{ recipient.name }},</p>\n` +
        `<p>You've been invited to answer <strong>{{ form }}</strong>.</p>\n` +
        `<p><a href="{{ url }}">Answer the form</a></p>\n` +
        `<p>This link works once and is yours alone.</p>`,
    },
  },
  form_reminder: {
    feature: "forms",
    sample: formLink("Customer satisfaction survey"),
    starter: {
      subject: "Reminder: {{ form }}",
      bodyHtml:
        `<p>Hello {{ recipient.name }},</p>\n` +
        `<p>You haven't answered <strong>{{ form }}</strong> yet.</p>\n` +
        `<p><a href="{{ url }}">Answer the form</a></p>\n` +
        `<p>This link works once and is yours alone. Any earlier link we sent you still works too.</p>`,
    },
  },
  signature_request: {
    feature: "signatures",
    sample: {
      title: "Master services agreement",
      message: "Please review section 4 before signing.",
      url: "https://app.example.com/sign/sig_9Hc3Wm2nB6",
      signer: { email: "ada@example.com", name: "Ada Lovelace", role: "Client" },
      expiresAt: "2026-10-15 09:00:00 UTC",
    },
    starter: {
      subject: "Please sign: {{ title }}",
      bodyHtml:
        `<p>Hello {{ signer.name }},</p>\n` +
        `<p>You have been asked to sign <strong>{{ title }}</strong>.</p>\n` +
        `<p>{{ message }}</p>\n` +
        `<p><a href="{{ url }}">Review and sign</a></p>\n` +
        `<p style="color:#666;font-size:12px">This link is personal to you and expires {{ expiresAt }}.</p>`,
    },
  },
  signature_completed: {
    feature: "signatures",
    sample: {
      title: "Master services agreement",
      signers: [
        { email: "ada@example.com", name: "Ada Lovelace" },
        { email: "grace@example.com", name: "Grace Hopper" },
      ],
      documentHash: "3f7a9c1e5b2d8f4a6c0e9b1d7f3a5c8e2b4d6f0a1c3e5b7d9f2a4c6e8b0d1f3a",
    },
    starter: {
      subject: "Signed: {{ title }}",
      bodyHtml:
        `<p>“{{ title }}” has been signed by everyone.</p>\n` +
        `<p>A copy is attached.</p>\n` +
        `<p style="color:#666;font-size:12px">Document hash (SHA-256): {{ documentHash }}</p>`,
    },
  },
  approval_request: {
    feature: "approvals",
    sample: {
      title: "Refund of €480 for order 10482",
      message: "The customer was double-charged in August.",
      url: "https://app.example.com/approve/apv_5Tg8Kp1zR3",
      approver: { email: "grace@example.com", name: "Grace Hopper", role: "Finance" },
      summary: [
        { label: "Order", value: "10482" },
        { label: "Amount", value: "€480.00" },
      ],
      summaryHtml:
        `<table style="border-collapse:collapse;margin:12px 0"><tr><td style="padding:4px 12px 4px 0;color:#666">Order</td><td style="padding:4px 0">10482</td></tr>` +
        `<tr><td style="padding:4px 12px 4px 0;color:#666">Amount</td><td style="padding:4px 0">€480.00</td></tr></table>`,
      expiresAt: "2026-09-18 09:00:00 UTC",
    },
    starter: {
      subject: "Approval needed: {{ title }}",
      bodyHtml:
        `<p>Hello {{ approver.name }},</p>\n` +
        `<p>You have been asked to approve <strong>{{ title }}</strong>.</p>\n` +
        `<p>{{ message }}</p>\n` +
        `{{ summaryHtml }}\n` +
        `<p><a href="{{ url }}">Review and decide</a></p>\n` +
        `<p style="color:#666;font-size:12px">This link is personal to you and expires {{ expiresAt }}.</p>`,
    },
  },
  approval_approved: {
    feature: "approvals",
    sample: approvalOutcome("approved", "Within the refund policy."),
    starter: { subject: "Approved: {{ title }}", bodyHtml: outcomeBody("was approved") },
  },
  approval_rejected: {
    feature: "approvals",
    sample: approvalOutcome("rejected", "Outside the 30-day window."),
    starter: { subject: "Not approved: {{ title }}", bodyHtml: outcomeBody("was rejected") },
  },
  approval_expired: {
    feature: "approvals",
    sample: approvalOutcome("expired", ""),
    starter: { subject: "Expired: {{ title }}", bodyHtml: outcomeBody("expired before anyone decided") },
  },
  approval_cancelled: {
    feature: "approvals",
    sample: approvalOutcome("cancelled", "Raised by mistake."),
    starter: { subject: "Withdrawn: {{ title }}", bodyHtml: outcomeBody("was withdrawn") },
  },
  "booking.confirmed": {
    feature: "booking",
    sample: booking,
    starter: { subject: "Confirmed: {{ resource }} — {{ when }}", bodyHtml: bookingBody },
  },
  "booking.cancelled": {
    feature: "booking",
    sample: booking,
    starter: {
      subject: "Cancelled: {{ resource }} — {{ when }}",
      bodyHtml: `<p>Hello {{ customerName }},</p>\n<p>Your booking for <strong>{{ resource }}</strong> on {{ when }} has been cancelled.</p>`,
    },
  },
  "booking.rescheduled": {
    feature: "booking",
    sample: booking,
    starter: { subject: "Moved: {{ resource }} — {{ when }}", bodyHtml: bookingBody },
  },
};

export const BUILT_IN_EMAIL_KEYS = Object.keys(BUILT_IN_EMAIL_TEMPLATES) as BuiltInEmailKey[];

export const isBuiltInEmailKey = (key: string): key is BuiltInEmailKey =>
  Object.hasOwn(BUILT_IN_EMAIL_TEMPLATES, key);

/**
 * What a template reached by an arbitrary key is rendered with, per caller.
 * A custom template has no fixed variable set — it gets whatever its caller
 * passes — but the two callers in this repo pass a known base, and the flow
 * executor and the report service each `satisfies` their half.
 */
export interface EmailRenderContexts {
  /** A flow `email` step: the step's own `vars` are merged on top of this. */
  flow: {
    data: Record<string, unknown>;
    $user: { id: string | null; email: string | null; roles: string[] };
    $last: unknown;
  };
  /** A scheduled report's covering message. */
  report: {
    dashboard: { id: string; name: string; description: string | null };
    report: { filename: string; panels: number; generatedAt: string };
  };
}

export const EMAIL_RENDER_CONTEXT_SAMPLES: { readonly [K in keyof EmailRenderContexts]: EmailRenderContexts[K] } = {
  flow: {
    // Only `id`: every other field of `data` is the triggering row's own, and a
    // sample that invented one would read as a promise the flow cannot keep.
    data: { id: "rec_01J9Z8Q4" },
    $user: { id: "usr_01J9Z8Q4", email: "ops@example.com", roles: ["admin"] },
    $last: {},
  },
  report: {
    dashboard: { id: "dsh_01J9Z8Q4", name: "Monthly revenue", description: "Revenue by plan and region" },
    report: { filename: "monthly-revenue-2026-09-15.pdf", panels: 6, generatedAt: "2026-09-15T08:00:00.000Z" },
  },
};

/** Every distinct `{{ path }}` the given texts use, in first-seen order. */
export const templateVariableRefs = (...texts: string[]): string[] => {
  const out = new Set<string>();
  for (const text of texts) {
    for (const m of text.matchAll(new RegExp(TEMPLATE_PLACEHOLDER.source, "g"))) out.add(m[1]!);
  }
  return [...out];
};

/**
 * The dotted paths a render context offers, one per leaf.
 *
 * Arrays and empty objects are leaves: `renderTemplate` prints them as JSON, and
 * an array's length is not something a sample can promise.
 */
export const variablePathsOf = (vars: Record<string, unknown>, prefix = ""): string[] => {
  const out: string[] = [];
  for (const [k, v] of Object.entries(vars)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length > 0) {
      out.push(...variablePathsOf(v as Record<string, unknown>, path));
    } else {
      out.push(path);
    }
  }
  return out;
};
