/**
 * What each variable of an email template means, in the admin's language, and
 * the panel that lists them.
 *
 * The variable NAMES are not here: they come from `@backlex/core/email-templates`,
 * which the send sites are type-checked against. This file only describes them,
 * because a description is chrome and has to go through Lingui — and the macro
 * only runs in a `.tsx` that renders JSX. A name with no description still
 * lists (just without a sentence), so a variable added to a sender can never
 * go missing from the panel because nobody wrote its line here.
 */
import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import {
  BUILT_IN_EMAIL_TEMPLATES,
  EMAIL_RENDER_CONTEXT_SAMPLES,
  variablePathsOf,
  type BuiltInEmailFeature,
  type BuiltInEmailKey,
} from "@backlex/core/email-templates";
import { I } from "../../icons";
import { Select } from "../../select";
import { Button } from "../../ui";
import { contextOf, type RenderContext, type TemplateEntry, type VariableWarning } from "./email-template-model";

export const FEATURE_LABELS: Record<BuiltInEmailFeature, MessageDescriptor> = {
  forms: msg`Forms`,
  signatures: msg`Signatures`,
  approvals: msg`Approvals`,
  booking: msg`Booking`,
};

export const BUILT_IN_EMAIL_LABELS: Record<BuiltInEmailKey, { name: MessageDescriptor; when: MessageDescriptor }> = {
  form_invite: {
    name: msg`Form invitation`,
    when: msg`Sent to each person invited to answer a form, with their personal link.`,
  },
  form_reminder: {
    name: msg`Form reminder`,
    when: msg`Sent to invitees who have not answered yet, with a fresh link.`,
  },
  signature_request: {
    name: msg`Signature request`,
    when: msg`Sent to each signer when it is their turn to sign.`,
  },
  signature_completed: {
    name: msg`Document signed`,
    when: msg`Sent to every signer once everyone has signed, with the signed PDF attached.`,
  },
  approval_request: {
    name: msg`Approval request`,
    when: msg`Sent to each approver whose turn it is to decide.`,
  },
  approval_approved: {
    name: msg`Approval: approved`,
    when: msg`Sent to the request's notify list when it is approved.`,
  },
  approval_rejected: {
    name: msg`Approval: rejected`,
    when: msg`Sent to the request's notify list when it is rejected.`,
  },
  approval_expired: {
    name: msg`Approval: expired`,
    when: msg`Sent to the request's notify list when nobody decided in time.`,
  },
  approval_cancelled: {
    name: msg`Approval: withdrawn`,
    when: msg`Sent to the request's notify list when the request is withdrawn.`,
  },
  "booking.confirmed": {
    name: msg`Booking confirmed`,
    when: msg`Sent to the customer when a booking is made, with a calendar invite attached.`,
  },
  "booking.cancelled": {
    name: msg`Booking cancelled`,
    when: msg`Sent to the customer when a booking is cancelled.`,
  },
  "booking.rescheduled": {
    name: msg`Booking moved`,
    when: msg`Sent to the customer when a booking moves to another time.`,
  },
};

const formLink: Record<string, MessageDescriptor> = {
  form: msg`The form's name.`,
  "recipient.email": msg`The recipient's email address.`,
  "recipient.name": msg`The recipient's name, if the invitation has one.`,
};

const approvalOutcome: Record<string, MessageDescriptor> = {
  title: msg`What was up for approval.`,
  outcome: msg`How it ended: approved, rejected, expired or cancelled.`,
  reason: msg`The reason given with the outcome, if any.`,
  approvers: msg`Every approver with their decision. A list — it prints as JSON.`,
};

const booking: Record<string, MessageDescriptor> = {
  resource: msg`What was booked.`,
  when: msg`The booked time, in the resource's time zone.`,
  manageUrl: msg`The customer's link to change or cancel the booking.`,
  customerName: msg`The name the customer booked under.`,
  confirmationMessage: msg`The resource's confirmation message, if it has one.`,
};

const VARIABLE_DESCRIPTIONS: Record<BuiltInEmailKey, Record<string, MessageDescriptor>> = {
  form_invite: { ...formLink, url: msg`This recipient's personal link. It works once.` },
  form_reminder: { ...formLink, url: msg`A fresh personal link. Links sent earlier keep working.` },
  signature_request: {
    title: msg`The document's title.`,
    message: msg`The note written when the request was sent, if any.`,
    url: msg`This signer's personal signing link.`,
    "signer.email": msg`The signer's email address.`,
    "signer.name": msg`The signer's name, if known.`,
    "signer.role": msg`The signer's role on the document, if set.`,
    expiresAt: msg`When the link expires, in UTC.`,
  },
  signature_completed: {
    title: msg`The document's title.`,
    signers: msg`Everyone who signed. A list — it prints as JSON.`,
    documentHash: msg`The SHA-256 hash of the signed document.`,
  },
  approval_request: {
    title: msg`What is up for approval.`,
    message: msg`The note written when approval was requested, if any.`,
    url: msg`This approver's personal decision link.`,
    "approver.email": msg`The approver's email address.`,
    "approver.name": msg`The approver's name, if known.`,
    "approver.role": msg`The approver's role, if set.`,
    summary: msg`The request's label and value rows. A list — it prints as JSON.`,
    summaryHtml: msg`The same summary as a ready-made HTML table.`,
    expiresAt: msg`When the request expires, in UTC.`,
  },
  approval_approved: approvalOutcome,
  approval_rejected: approvalOutcome,
  approval_expired: approvalOutcome,
  approval_cancelled: approvalOutcome,
  "booking.confirmed": booking,
  "booking.cancelled": booking,
  "booking.rescheduled": booking,
};

const CONTEXT_DESCRIPTIONS: Record<RenderContext, Record<string, MessageDescriptor>> = {
  flow: {
    "data.id": msg`The id of the row that triggered the flow. Any other field works the same way: data.field_name.`,
    "$user.id": msg`The id of the user the flow runs as.`,
    "$user.email": msg`That user's email address.`,
    "$user.roles": msg`That user's roles. A list — it prints as JSON.`,
    $last: msg`The result of the step before this one.`,
  },
  report: {
    "dashboard.id": msg`The dashboard's id.`,
    "dashboard.name": msg`The dashboard's name.`,
    "dashboard.description": msg`The dashboard's description, if it has one.`,
    "report.filename": msg`The attached PDF's file name.`,
    "report.panels": msg`How many panels the report has.`,
    "report.generatedAt": msg`When the report was generated, as an ISO timestamp.`,
  },
};

type Group = "sample" | RenderContext;

interface Row {
  path: string;
  description: string | null;
  context?: RenderContext;
}

/**
 * The variables a template can use, each a button that inserts its placeholder
 * at the caret of the field last focused.
 *
 * `onMouseDown` is prevented on the buttons so a click does not take focus from
 * the field — the caret is still where the author left it when the insert lands.
 *
 * Mount it with `key={entry.id}`: which caller's list a custom template opens
 * on is decided once per template, not on every keystroke.
 */
export function VariablesPanel({
  entry,
  sample,
  usedPaths,
  onInsert,
}: {
  entry: TemplateEntry;
  sample: Record<string, unknown> | null;
  usedPaths: string[];
  onInsert: (path: string, context?: RenderContext) => void;
}) {
  const { t, i18n } = useLingui();
  const builtIn = entry.isNew ? null : entry.builtIn;

  // A custom template has no fixed variables, so which list is useful depends
  // on who sends it. Start on the caller its own placeholders already point at.
  const [group, setGroup] = useState<Group>(() => {
    for (const p of usedPaths) {
      const ctx = contextOf(p);
      if (ctx) return ctx;
    }
    return "sample";
  });

  const rows: Row[] = builtIn
    ? variablePathsOf(BUILT_IN_EMAIL_TEMPLATES[builtIn].sample as Record<string, unknown>).map((path) => {
        const d = VARIABLE_DESCRIPTIONS[builtIn][path];
        return { path, description: d ? i18n._(d) : null };
      })
    : group === "sample"
      ? variablePathsOf(sample ?? {})
          .filter((path) => contextOf(path) === null)
          .map((path) => ({ path, description: null }))
      : variablePathsOf(EMAIL_RENDER_CONTEXT_SAMPLES[group] as Record<string, unknown>).map((path) => {
          const d = CONTEXT_DESCRIPTIONS[group][path];
          return { path, description: d ? i18n._(d) : null, context: group };
        });

  return (
    <div className="flex flex-col gap-2 rounded-control border border-border p-3" data-testid="email-variables">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>Available variables</Trans>
        </span>
        {!builtIn && (
          <Select
            size="sm"
            value={group}
            onChange={(v) => setGroup(v as Group)}
            className="ml-auto min-w-0"
            options={[
              { value: "sample", label: t`From your sample data` },
              { value: "flow", label: t`Sent from a flow step` },
              { value: "report", label: t`Sent with a scheduled report` },
            ]}
          />
        )}
      </div>
      <span className="text-[11.5px] text-muted-foreground">
        {builtIn ? (
          <Trans>Every one of these is sent with this email. Click one to insert it where your cursor is.</Trans>
        ) : (
          <Trans>A custom template receives whatever its sender passes. Click a variable to insert it where your cursor is.</Trans>
        )}
      </span>
      {rows.length === 0 ? (
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>Add values to the sample data to list them here.</Trans>
        </span>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {rows.map((row) => {
            const placeholder = `{{ ${row.path} }}`;
            return (
              <li key={row.path} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onInsert(row.path, row.context)}
                  aria-label={t`Insert ${placeholder}`}
                  className="inline-flex h-6 max-w-full cursor-pointer items-center gap-1 truncate rounded-control border border-border bg-card px-2 font-mono text-[11.5px] text-foreground hover:bg-accent"
                >
                  <I.Code size={11} />
                  {placeholder}
                </button>
                {row.description && (
                  <span className="min-w-0 text-[11.5px] text-muted-foreground">{row.description}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Placeholders the template uses that will render empty, said before saving —
 *  a typo like `usr.email` otherwise surfaces as a blank in someone's inbox. */
export function VariableWarnings({
  warnings,
  onAddToSample,
}: {
  warnings: VariableWarning[];
  /** Offered for `no-sample` warnings: puts the missing paths in the sample data. */
  onAddToSample?: () => void;
}) {
  if (warnings.length === 0) return null;
  const noSample = warnings.some((w) => w.reason === "no-sample");
  return (
    <div
      role="status"
      className="flex flex-col gap-1.5 rounded-control border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11.5px]"
    >
      <ul className="flex flex-col gap-1">
        {warnings.map((w) => {
          const placeholder = `{{ ${w.path} }}`;
          return (
            <li key={w.path} className="flex min-w-0 items-start gap-1.5">
              <I.AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="min-w-0 break-words">
                {w.reason === "not-sent" ? (
                  <Trans>
                    <span className="font-mono">{placeholder}</span> is not sent with this email, so it will always
                    be empty.
                  </Trans>
                ) : (
                  <Trans>
                    <span className="font-mono">{placeholder}</span> has no sample value, so the preview and the test
                    email show it empty.
                  </Trans>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {noSample && onAddToSample && (
        <div>
          <Button size="xs" variant="outline" onClick={onAddToSample}>
            <Trans>Add them to the sample data</Trans>
          </Button>
        </div>
      )}
    </div>
  );
}
