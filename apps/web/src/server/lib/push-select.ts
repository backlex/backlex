import type { PushAdapter } from "@backlex/core/adapters";
import { consolePush } from "../adapters/push.console";
import { fcmPush } from "../adapters/push.fcm";
import { apnsPush } from "../adapters/push.apns";
import { webPush } from "../adapters/push.web-push";
import { multiPush } from "../adapters/push.multi";
import type { Env } from "../env";

/**
 * Normalized push transport spec — the union both the env layer and the
 * per-workspace `push_config` layer compile down to before {@link buildPushAdapter}.
 * Unlike email (one provider per deployment), push commonly needs several at
 * once — Android via `fcm`, iOS via `apns`, browsers via `web-push` — so a
 * `multi` spec composes leaf specs into one fan-out adapter.
 */
export type PushLeafSpec =
  | { provider: "console" }
  | { provider: "fcm"; projectId: string; clientEmail: string; privateKey: string }
  | {
      provider: "apns";
      keyId: string;
      teamId: string;
      privateKey: string;
      bundleId: string;
      production?: boolean;
    }
  | { provider: "web-push"; subject: string; vapidPublicKey: string; vapidPrivateKey: string };

export type PushSpec = PushLeafSpec | { provider: "multi"; specs: PushLeafSpec[] };

export type PushLeafProviderId = PushLeafSpec["provider"];

/** Provider ids selectable in per-workspace config. `inherit` = "use the next
 *  level down" (the instance `_global` row, then the deployment env). */
export const PUSH_PROVIDER_IDS = [
  "inherit",
  "console",
  "fcm",
  "apns",
  "web-push",
] as const;
export type PushConfigProviderId = (typeof PUSH_PROVIDER_IDS)[number];

/** Build a single leaf adapter from a leaf spec. */
const buildLeaf = (spec: PushLeafSpec): PushAdapter => {
  switch (spec.provider) {
    case "console":
      return consolePush();
    case "fcm":
      return fcmPush(spec);
    case "apns":
      return apnsPush(spec);
    case "web-push":
      return webPush(spec);
  }
};

/** Turn a resolved {@link PushSpec} into a live adapter. */
export const buildPushAdapter = (spec: PushSpec): PushAdapter => {
  if (spec.provider === "multi") {
    const leaves = spec.specs.map(buildLeaf);
    return leaves.length === 1 ? (leaves[0] as PushAdapter) : multiPush(leaves);
  }
  return buildLeaf(spec);
};

/** Candidate leaf spec per provider, built from `Env` — `undefined` when its
 *  credentials aren't all present. */
const envLeaf = (
  env: Env,
): Record<Exclude<PushLeafProviderId, "console">, () => PushLeafSpec | undefined> => ({
  fcm: () =>
    env.FCM_PROJECT_ID && env.FCM_CLIENT_EMAIL && env.FCM_PRIVATE_KEY
      ? {
          provider: "fcm",
          projectId: env.FCM_PROJECT_ID,
          clientEmail: env.FCM_CLIENT_EMAIL,
          privateKey: env.FCM_PRIVATE_KEY,
        }
      : undefined,
  apns: () =>
    env.APNS_KEY_ID && env.APNS_TEAM_ID && env.APNS_PRIVATE_KEY && env.APNS_BUNDLE_ID
      ? {
          provider: "apns",
          keyId: env.APNS_KEY_ID,
          teamId: env.APNS_TEAM_ID,
          privateKey: env.APNS_PRIVATE_KEY,
          bundleId: env.APNS_BUNDLE_ID,
          production: env.APNS_PRODUCTION === "false" ? false : undefined,
        }
      : undefined,
  "web-push": () =>
    env.WEBPUSH_SUBJECT && env.WEBPUSH_VAPID_PUBLIC_KEY && env.WEBPUSH_VAPID_PRIVATE_KEY
      ? {
          provider: "web-push",
          subject: env.WEBPUSH_SUBJECT,
          vapidPublicKey: env.WEBPUSH_VAPID_PUBLIC_KEY,
          vapidPrivateKey: env.WEBPUSH_VAPID_PRIVATE_KEY,
        }
      : undefined,
});

/**
 * Resolve the deployment-level push spec from `Env`. `PUSH_PROVIDER` forces a
 * single transport; when unset we compose every provider that has complete
 * credentials into a `multi` spec (so one deploy can serve fcm + apns +
 * web-push together) and fall back to `console` when none is configured. The
 * result is the spec that would actually run, so `context.ts` can detect the
 * "nothing real configured" case (`console`) and swap in the managed-cloud
 * adapter — same signal email uses.
 */
export const selectPushSpec = (env: Env): PushSpec => {
  const leaves = envLeaf(env);
  const explicit = env.PUSH_PROVIDER?.trim().toLowerCase();
  if (explicit === "console") return { provider: "console" };
  if (explicit && explicit in leaves) {
    const spec = leaves[explicit as Exclude<PushLeafProviderId, "console">]();
    if (spec) return spec;
    console.warn(
      `[push] PUSH_PROVIDER=${explicit} but its credentials are incomplete — falling back to console adapter`,
    );
    return { provider: "console" };
  }
  if (explicit) {
    console.warn(`[push] unknown PUSH_PROVIDER=${explicit} — falling back to auto-detect`);
  }
  const configured: PushLeafSpec[] = [];
  for (const key of ["fcm", "apns", "web-push"] as const) {
    const spec = leaves[key]();
    if (spec) configured.push(spec);
  }
  if (configured.length === 0) return { provider: "console" };
  if (configured.length === 1) return configured[0] as PushLeafSpec;
  return { provider: "multi", specs: configured };
};

/** Resolve the deployment-level push adapter from `Env`. */
export const selectPushAdapter = (env: Env): PushAdapter =>
  buildPushAdapter(selectPushSpec(env));
