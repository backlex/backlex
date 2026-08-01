import { AppError } from "@backlex/core";
import type { EmailAdapter, EmailMessage } from "@backlex/core/adapters";
import type { Env } from "../env";
import { cloudPost } from "../lib/cloud-report";

/**
 * Managed-cloud email adapter. On a provisioned cloud project the customer
 * doesn't bring their own SMTP/provider key, and the worker is injected with no
 * `EMAIL_*` vars, so {@link selectEmailAdapter} would fall through to the console
 * adapter (mail never leaves the box). Instead, this posts the message to the
 * control-plane gateway (`/api/internal/email/send`, HMAC-signed via
 * `cloud-report`), which sends it through the platform mailer (CF Email Service →
 * Resend) from the platform sender. Mirrors {@link cloudEmbeddingAdapter}.
 *
 * A per-workspace `email_config` row still takes precedence — this is only the
 * fallback used when nothing else is configured (see `context.ts`).
 */
export function cloudEmailAdapter(env: Env): EmailAdapter {
  return {
    /**
     * Declared UNSUPPORTED, and the field is forwarded anyway.
     *
     * A `.ics` sent through here would otherwise be dropped between two
     * services that both reported success — the exact failure this flag exists
     * to name. Saying so lets the caller tell the operator the invite did not
     * travel, instead of the recipient finding out.
     *
     * **The gateway side is written and waiting** on
     * `feat/gateway-email-attachments` in the control-plane repo. Flip this to
     * `true` once that branch is merged and DEPLOYED — not when it is merged.
     * Until the running gateway accepts the field, `true` here is a claim the
     * live system does not honour, which is worse than the current answer.
     */
    attachments: false,
    async send(msg: EmailMessage): Promise<void> {
      let res: Response;
      try {
        res = await cloudPost(env, "/api/internal/email/send", {
          to: msg.to,
          subject: msg.subject,
          text: msg.text,
          html: msg.html,
          from: msg.from,
          ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
        });
      } catch (e) {
        throw new AppError(
          "INTERNAL",
          `Cloud email gateway unreachable: ${e instanceof Error ? e.message : "error"}`,
        );
      }
      if (!res.ok) {
        let message = `Cloud email gateway returned ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j?.error?.message) message = j.error.message;
        } catch {
          // keep the status-based message
        }
        // 429 = per-project send throttle; surface as a validation error so it
        // isn't retried as a transient infra failure.
        throw new AppError(res.status === 429 ? "VALIDATION" : "INTERNAL", message);
      }
    },
  };
}
