import type { ClientCore } from "../core";

/** Which endpoints a captcha gates. A list rather than a switch, because the
 *  costs differ: a sign-up creates a row, a password reset mails somebody who
 *  did not ask, a form submission can be the abuse itself. */
export type CaptchaTarget = "sign-up" | "sign-in" | "password-reset" | "forms";

export interface CaptchaConfigView {
  provider: "turnstile" | "hcaptcha" | "recaptcha" | null;
  /** The public half — what a browser needs to render the widget. */
  siteKey: string;
  protect: CaptchaTarget[];
  /** What happens when the provider cannot answer. No safe default exists:
   *  `allow` means the gate stops working exactly when the provider is having
   *  a bad day; `deny` turns their outage into yours. */
  onError: "allow" | "deny";
  enabled: boolean;
  /** Presence only — the secret has no read-back path. */
  hasSecret: boolean;
}

export interface CaptchaInput {
  provider: "turnstile" | "hcaptcha" | "recaptcha";
  siteKey: string;
  /** Write-only. Omit on update to keep the stored one. */
  secretKey?: string;
  protect: CaptchaTarget[];
  onError: "allow" | "deny";
  enabled?: boolean;
}

/** An operator acting as one of the workspace's end-users. */
export interface Impersonation {
  id: string;
  actorUserId: string;
  actorEmail: string | null;
  subjectUserId: string;
  subjectEmail: string | null;
  reason: string;
  readOnly: boolean;
  expiresAt: number;
  endedAt: number | null;
  endedBy: string | null;
  createdAt: number | null;
  active: boolean;
}

export interface SupportClient {
  captcha: {
    get: () => Promise<{ data: CaptchaConfigView }>;
    set: (input: CaptchaInput) => Promise<{ data: CaptchaConfigView }>;
    remove: () => Promise<{ ok: boolean }>;
  };
  impersonation: {
    /** The audit trail: who acted as whom, why, and whether it is still live. */
    list: (opts?: { activeOnly?: boolean; limit?: number }) => Promise<{ data: Impersonation[] }>;
    /**
     * Act as an end-user. Returns a workspace access token for them; your own
     * session is untouched. Read-only unless you say otherwise, and every
     * request the token authenticates re-reads the audit row — so `end` takes
     * effect immediately.
     */
    start: (input: {
      subjectUserId: string;
      reason: string;
      readOnly?: boolean;
      minutes?: number;
    }) => Promise<{ data: Impersonation; token: string; expiresAt: number }>;
    end: (id: string) => Promise<{ data: Impersonation }>;
  };
}

export const makeSupport = (core: ClientCore): SupportClient => ({
  captcha: {
    get: () => core.request<{ data: CaptchaConfigView }>("GET", "/api/admin/captcha"),
    set: (input) => core.request<{ data: CaptchaConfigView }>("PUT", "/api/admin/captcha", input),
    remove: () => core.request<{ ok: boolean }>("DELETE", "/api/admin/captcha"),
  },
  impersonation: {
    list: (opts) => {
      const q = new URLSearchParams();
      if (opts?.activeOnly) q.set("activeOnly", "true");
      if (opts?.limit) q.set("limit", String(opts.limit));
      const qs = q.toString();
      return core.request<{ data: Impersonation[] }>(
        "GET",
        `/api/admin/impersonation${qs ? `?${qs}` : ""}`,
      );
    },
    start: (input) =>
      core.request<{ data: Impersonation; token: string; expiresAt: number }>(
        "POST",
        "/api/admin/impersonation",
        input,
      ),
    end: (id) =>
      core.request<{ data: Impersonation }>(
        "POST",
        `/api/admin/impersonation/${encodeURIComponent(id)}/end`,
        {},
      ),
  },
});
