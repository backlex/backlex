import { AppError } from "@backlex/core";
import type { SMSAdapter, SMSMessage, SMSSendResult } from "@backlex/core/adapters";
import type { Env } from "../env";
import { cloudPost } from "../lib/cloud-report";

/**
 * Managed-cloud SMS adapter. On a provisioned cloud project the customer brings
 * no Twilio/SNS keys and the worker is injected with no `SMS_*` / `TWILIO_*`
 * vars, so {@link selectSmsSpec} resolves to `console` (nothing leaves the box).
 * Instead, this posts to the control-plane gateway (`/api/internal/sms/send`,
 * HMAC-signed via `cloud-report`), which delivers through the platform's SMS
 * provider. Mirrors {@link cloudPushAdapter}.
 *
 * A per-workspace `sms_config` row still takes precedence — this is only the
 * fallback used when nothing else is configured (see `context.ts`).
 */
export function cloudSmsAdapter(env: Env): SMSAdapter {
  return {
    async send(msg: SMSMessage): Promise<SMSSendResult> {
      let res: Response;
      try {
        res = await cloudPost(env, "/api/internal/sms/send", {
          to: msg.to,
          body: msg.body,
          from: msg.from,
        });
      } catch (e) {
        throw new AppError(
          "INTERNAL",
          `Cloud SMS gateway unreachable: ${e instanceof Error ? e.message : "error"}`,
        );
      }
      if (!res.ok) {
        let message = `Cloud SMS gateway returned ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j?.error?.message) message = j.error.message;
        } catch {
          // keep the status-based message
        }
        throw new AppError(res.status === 429 ? "VALIDATION" : "INTERNAL", message);
      }
      const body = (await res.json().catch(() => ({}))) as Partial<SMSSendResult>;
      return {
        sent: body.sent ?? msg.to.length,
        failed: body.failed ?? 0,
        invalidNumbers: body.invalidNumbers ?? [],
      };
    },
  };
}
