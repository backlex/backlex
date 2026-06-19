import { AppError } from "@backlex/core";
import type { PushAdapter, PushMessage, PushSendResult } from "@backlex/core/adapters";
import type { Env } from "../env";
import { cloudPost } from "../lib/cloud-report";

/**
 * Managed-cloud push adapter. On a provisioned cloud project the customer
 * brings no FCM/APNs/VAPID keys and the worker is injected with no `PUSH_*`
 * vars, so {@link selectPushSpec} resolves to `console` (nothing leaves the
 * box). Instead, this posts to the control-plane gateway
 * (`/api/internal/push/send`, HMAC-signed via `cloud-report`), which delivers
 * through the platform's push providers. Mirrors {@link cloudEmailAdapter}.
 *
 * A per-workspace `push_config` row still takes precedence — this is only the
 * fallback used when nothing else is configured (see `context.ts`).
 */
export function cloudPushAdapter(env: Env): PushAdapter {
  return {
    async send(msg: PushMessage): Promise<PushSendResult> {
      let res: Response;
      try {
        res = await cloudPost(env, "/api/internal/push/send", {
          tokens: msg.tokens,
          title: msg.title,
          body: msg.body,
          url: msg.url,
          icon: msg.icon,
          badge: msg.badge,
          data: msg.data,
        });
      } catch (e) {
        throw new AppError(
          "INTERNAL",
          `Cloud push gateway unreachable: ${e instanceof Error ? e.message : "error"}`,
        );
      }
      if (!res.ok) {
        let message = `Cloud push gateway returned ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j?.error?.message) message = j.error.message;
        } catch {
          // keep the status-based message
        }
        throw new AppError(res.status === 429 ? "VALIDATION" : "INTERNAL", message);
      }
      // The gateway returns the aggregate result; default to "all sent" when the
      // body is absent so callers don't treat a 200 as a failure.
      const body = (await res.json().catch(() => ({}))) as Partial<PushSendResult>;
      return {
        sent: body.sent ?? msg.tokens.length,
        failed: body.failed ?? 0,
        invalidTokens: body.invalidTokens ?? [],
      };
    },
  };
}
