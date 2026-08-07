/**
 * A second mail to whoever hasn't answered.
 *
 * Minting the fresh links is `form-invites.ts`'s job; deciding that a reminder
 * is allowed at all, and putting it in an envelope, is this one's. It lives
 * beside them rather than inside the REST handler so the GraphQL twin runs the
 * same guard and sends the same mail — a surface that re-implements either ends
 * up with its own opinion about when a form is still open.
 */
import { AppError } from "@backlex/core";
import type { Ctx } from "../context";
import { sendTemplatedEmail } from "./email";
import { formAvailability, type FormRow } from "./forms";
import { markInviteSent, remindFormInvites, type MintedInvite } from "./form-invites";
import { escapeHtml } from "./signatures";

export interface RemindOptions {
  /** Narrow to specific invites; absent ⇒ everyone still outstanding. */
  inviteIds?: string[];
  /** The form's own plaintext token, so the links come back ready-made. */
  formToken?: string | null;
  /** Put the fresh links in the post. Without it they are only in the
   *  response — which is what a workshop reprinting them wants. */
  send?: boolean;
  /** Hours to leave between two reminders to one person. Default 24. */
  minIntervalHours?: number;
  /** Remind anyway, however recently the last one went out. */
  force?: boolean;
}

export interface RemindResult {
  minted: MintedInvite[];
  sent: number;
  skipped: number;
}

/**
 * Remind the people a form is still waiting on.
 *
 * Refuses outright when the form cannot be answered — paused, not open yet,
 * closed, or full. A reminder that sends someone to a form which turns them
 * away is worse than no reminder: it is a support ticket with an apology
 * attached.
 */
export const sendFormReminders = async (
  ctx: Ctx,
  tenantId: string | null,
  form: FormRow,
  opts: RemindOptions = {},
): Promise<RemindResult> => {
  if (!form.active) {
    throw new AppError("VALIDATION", "This form is paused — nobody can answer it right now");
  }
  const availability = formAvailability(form, Date.now());
  if (!availability.open) {
    throw new AppError(
      "VALIDATION",
      `This form is not taking answers (${availability.reason}) — reminding people would send them to a closed form`,
    );
  }

  const { minted, skipped } = await remindFormInvites(
    ctx,
    tenantId,
    form,
    opts.formToken ?? null,
    {
      ...(opts.inviteIds ? { inviteIds: opts.inviteIds } : {}),
      ...(opts.minIntervalHours !== undefined
        ? { minIntervalHours: opts.minIntervalHours }
        : {}),
      ...(opts.force ? { force: true } : {}),
    },
  );

  let sent = 0;
  if (opts.send) {
    const origin = ctx.env.APP_URL?.replace(/\/$/, "") ?? "";
    for (const invite of minted) {
      if (!invite.email || !invite.url) continue;
      try {
        await sendTemplatedEmail(ctx, {
          to: invite.email,
          templateKey: "form_reminder",
          tenantId,
          vars: {
            form: form.name,
            url: `${origin}${invite.url}`,
            recipient: { email: invite.email, name: invite.name ?? "" },
          },
          fallback: {
            subject: `Reminder: ${form.name}`,
            // Escaped for the same reason the invite mailer is: the form name
            // and the recipient name are operator input, and this body is
            // delivered to a third party.
            html:
              `<p>${escapeHtml(invite.name || invite.email)},</p>` +
              `<p>You haven't answered <strong>${escapeHtml(form.name)}</strong> yet.</p>` +
              `<p><a href="${escapeHtml(`${origin}${invite.url}`)}">Answer the form</a></p>` +
              `<p>This link works once and is yours alone. Any earlier link we sent you still works too.</p>`,
          },
        });
        await markInviteSent(ctx, invite.id);
        sent++;
      } catch {
        // One address the transport refuses must not lose the other links —
        // they are minted, they work, and they are in the response.
      }
    }
  }

  return { minted, sent, skipped };
};
