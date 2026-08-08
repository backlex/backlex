import type { DeviceToken, PhoneNumber } from "../types";
import type { ClientCore } from "../core";

/** Push + SMS device registration for the current user. See `createClient`. */
export interface MessagingClient {
  /** Register (or refresh) the current user's push device. */
  registerDevice(input: {
    platform: "fcm" | "apns" | "web-push";
    token: string;
    keys?: { p256dh: string; auth: string };
    deviceName?: string;
  }): Promise<{ data: { id: string } }>;
  /** Remove one of the caller's registered devices by id. */
  unregister(id: string): Promise<{ ok: boolean }>;
  /** List the caller's registered devices. */
  listDevices(): Promise<{ data: DeviceToken[] }>;
  /** Register (or refresh) the caller's E.164 phone number for SMS. */
  registerPhone(input: { phoneNumber: string }): Promise<{ data: { id: string } }>;
  /** Remove one of the caller's registered phone numbers by id. */
  unregisterPhone(id: string): Promise<{ ok: boolean }>;
  /** List the caller's registered phone numbers. */
  listPhones(): Promise<{ data: PhoneNumber[] }>;
  /** Send a push notification to a user's registered devices (dispatch-only —
   *  no in-app notification row). Admins may target any user; non-admins only
   *  themselves. */
  sendPush(input: {
    userId: string;
    title: string;
    body: string;
    url?: string;
    data?: Record<string, string>;
  }): Promise<{ ok: boolean; sent: number; failed: number }>;
  /** Send an SMS to a user's registered phone numbers. Admins may target any
   *  user; non-admins only themselves. */
  sendSms(input: {
    userId: string;
    body: string;
  }): Promise<{ ok: boolean; sent: number; failed: number }>;
}

export const makeMessaging = (core: ClientCore): MessagingClient => {
  const messaging: MessagingClient = {
    /** Register (or refresh) the current user's push device. Re-registering the
     *  same token reactivates it and updates last-seen, so call this on every
     *  app launch. `web-push` requires `keys` (the VAPID subscription keys). */
    registerDevice: (input: {
      platform: "fcm" | "apns" | "web-push";
      token: string;
      keys?: { p256dh: string; auth: string };
      deviceName?: string;
    }) => core.request<{ data: { id: string } }>("POST", "/api/device-tokens", input),
    /** Remove one of the caller's registered devices by id. */
    unregister: (id: string) =>
      core.request<{ ok: boolean }>("DELETE", `/api/device-tokens/${encodeURIComponent(id)}`),
    /** List the caller's registered devices. */
    listDevices: () => core.request<{ data: DeviceToken[] }>("GET", "/api/device-tokens"),
    /** Register (or refresh) the current user's phone number for SMS. Number
     *  must be E.164 (e.g. "+14155552671"). Re-registering reactivates it. */
    registerPhone: (input: { phoneNumber: string }) =>
      core.request<{ data: { id: string } }>("POST", "/api/phone-numbers", input),
    /** Remove one of the caller's registered phone numbers by id. */
    unregisterPhone: (id: string) =>
      core.request<{ ok: boolean }>("DELETE", `/api/phone-numbers/${encodeURIComponent(id)}`),
    /** List the caller's registered phone numbers. */
    listPhones: () => core.request<{ data: PhoneNumber[] }>("GET", "/api/phone-numbers"),
    /** Send a push to a user's registered devices — dispatch-only, no in-app
     *  row. Admins may target any user; non-admins only themselves. */
    sendPush: (input: {
      userId: string;
      title: string;
      body: string;
      url?: string;
      data?: Record<string, string>;
    }) =>
      core.request<{ ok: boolean; sent: number; failed: number }>(
        "POST",
        "/api/messaging/push",
        input,
      ),
    /** Send an SMS to a user's registered phone numbers. Admins may target any
     *  user; non-admins only themselves. */
    sendSms: (input: { userId: string; body: string }) =>
      core.request<{ ok: boolean; sent: number; failed: number }>(
        "POST",
        "/api/messaging/sms",
        input,
      ),
  };

  return messaging;
};
