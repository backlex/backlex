import { api } from "@/lib/api";
import type { Envelope } from "./types";

/** Per-workspace email transport config (`/api/admin/email-config`). Secret
 *  values are never sent to the browser — only the `secretsSet` flags. */
export interface ApiEmailConfig {
  tenantId: string;
  /** inherit | console | resend | sendgrid | mailgun | ses | smtp */
  provider: string;
  fromAddress: string | null;
  /** Non-secret provider params (mailgun: domain/host; ses: region/accessKeyId;
   *  smtp: host/port/secure/user). */
  config: Record<string, unknown>;
  secretsSet: { apiKey: boolean; secretAccessKey: boolean; pass: boolean };
  updatedAt: number | string | null;
  /** Deployment-level fallback, for context in the UI. */
  env: { provider: string | null; from: string | null };
  providerIds: readonly string[];
}

export interface ApiEmailTemplate {
  id: string;
  tenantId: string | null;
  key: string;
  name: string;
  subject: string;
  fromAddress: string | null;
  bodyHtml: string;
  bodyText: string | null;
  variables: string[] | null;
}

export const emailTemplatesApi = {
  list: () => api<Envelope<ApiEmailTemplate[]>>(`/api/admin/email-templates`),
  get: (id: string) => api<Envelope<ApiEmailTemplate>>(`/api/admin/email-templates/${id}`),
  create: (body: Omit<ApiEmailTemplate, "id" | "tenantId">) =>
    api<Envelope<ApiEmailTemplate>>(`/api/admin/email-templates`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  patch: (id: string, body: Partial<ApiEmailTemplate>) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}`, { method: "DELETE" }),
  sendTest: (id: string, vars?: Record<string, string>) =>
    api<{ ok: true }>(`/api/admin/email-templates/${id}/send-test`, {
      method: "POST",
      body: JSON.stringify({ vars }),
    }),
};

export const emailConfigApi = {
  get: () => api<Envelope<ApiEmailConfig>>(`/api/admin/email-config`),
  put: (body: {
    provider: string;
    fromAddress?: string | null;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/email-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  sendTest: (to?: string) =>
    api<{ ok: true; to: string }>(`/api/admin/email-config/test`, {
      method: "POST",
      body: JSON.stringify({ to }),
    }),
};

export interface ApiPushConfig {
  tenantId: string;
  /** inherit | console | fcm | apns | web-push */
  provider: string;
  /** Non-secret provider params (fcm: projectId/clientEmail; apns:
   *  keyId/teamId/bundleId/production; web-push: subject/vapidPublicKey). */
  config: Record<string, unknown>;
  secretsSet: { privateKey: boolean; vapidPrivateKey: boolean };
  updatedAt: number | string | null;
  env: { provider: string | null };
  providerIds: readonly string[];
}

export const pushConfigApi = {
  get: () => api<Envelope<ApiPushConfig>>(`/api/admin/push-config`),
  put: (body: {
    provider: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/push-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  sendTest: () =>
    api<{ ok: true; sent: number; failed: number }>(`/api/admin/push-config/test`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

export interface ApiDeviceToken {
  id: string;
  platform: string;
  token: string;
  deviceName: string | null;
  isActive: boolean;
  createdAt: number | string;
  lastSeenAt: number | string | null;
}

export const deviceTokensApi = {
  list: () => api<Envelope<ApiDeviceToken[]>>(`/api/device-tokens`),
  register: (body: {
    platform: "fcm" | "apns" | "web-push";
    token: string;
    keys?: { p256dh: string; auth: string };
    deviceName?: string;
  }) =>
    api<Envelope<{ id: string }>>(`/api/device-tokens`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  remove: (id: string) =>
    api<{ ok: true }>(`/api/device-tokens/${id}`, { method: "DELETE" }),
};

export interface ApiSmsConfig {
  tenantId: string;
  /** inherit | console | twilio | sns */
  provider: string;
  /** Non-secret provider params (twilio: accountSid/from/messagingServiceSid;
   *  sns: region/accessKeyId/senderId). */
  config: Record<string, unknown>;
  secretsSet: { authToken: boolean; secretAccessKey: boolean };
  updatedAt: number | string | null;
  env: { provider: string | null };
  providerIds: readonly string[];
}

export const smsConfigApi = {
  get: () => api<Envelope<ApiSmsConfig>>(`/api/admin/sms-config`),
  put: (body: {
    provider: string;
    config?: Record<string, unknown>;
    secrets?: Record<string, string | null>;
  }) =>
    api<{ ok: true }>(`/api/admin/sms-config`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  sendTest: (to?: string) =>
    api<{ ok: true; sent: number; failed: number }>(`/api/admin/sms-config/test`, {
      method: "POST",
      body: JSON.stringify(to ? { to } : {}),
    }),
};

/** In-app notification row (`/api/notifications`). The real schema has no
 *  `kind`/`icon`/`who` columns — the bell derives an icon from `flowId`. */
export interface ApiNotification {
  id: string;
  userId: string | null;
  title: string;
  body: string | null;
  url: string | null;
  flowId: string | null;
  /** Unix-ms / ISO / null. `null` = unread. */
  readAt: unknown | null;
  createdAt: unknown;
}

export const notificationsApi = {
  list: (opts?: { unread?: boolean; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.unread) qs.set("unread", "1");
    if (opts?.limit != null) qs.set("limit", String(opts.limit));
    const tail = qs.toString();
    return api<Envelope<ApiNotification[]>>(
      `/api/notifications${tail ? `?${tail}` : ""}`,
    );
  },
  unreadCount: () =>
    api<Envelope<{ count: number }>>(`/api/notifications/_unread-count`),
  markRead: (id: string) =>
    api<{ ok: true }>(`/api/notifications/${id}/read`, { method: "POST" }),
  markAllRead: () =>
    api<{ ok: true }>(`/api/notifications/_read-all`, { method: "POST" }),
};
