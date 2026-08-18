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
     * Supported since the control-plane gateway learned to carry the field
     * (cloud `af2bdc8`, deployed 2026-08-18). Verified against the running
     * bundle, not the merge: the deployed worker contains the gateway's own
     * refusal strings.
     *
     * The two sides agree on one shape — `{ filename, content, contentType? }`
     * with `content` base64 — so nothing is translated in between.
     *
     * What the gateway will NOT do is trim: over 5 attachments, or past ~3M
     * base64 characters total, it fails the send with a 400 rather than
     * quietly dropping the overflow. That is deliberate, and it is what lets
     * this flag say `true` honestly — the promise here is not "attachments
     * always arrive", it is "if they do not, you are told".
     */
    attachments: true,
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
