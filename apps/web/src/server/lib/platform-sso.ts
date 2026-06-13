/**
 * Feature gate for control-plane (admin) SAML/LDAP SSO. Enabled by default so
 * self-host is unrestricted; the cloud injects `PLATFORM_SSO_ENABLED=false` for
 * projects on plans without enterprise SSO. When disabled, the platform SSO
 * routes, admin CRUD, and discovery surface all behave as if the feature isn't
 * there.
 */
import type { Env } from "../env";

export const isPlatformSsoEnabled = (env: Pick<Env, "PLATFORM_SSO_ENABLED">): boolean => {
  const v = env.PLATFORM_SSO_ENABLED?.trim().toLowerCase();
  return v !== "false" && v !== "0";
};
