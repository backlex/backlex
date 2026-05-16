/**
 * Selection layer for the auth-related adapters. Lives alongside
 * `email-select.ts` and `image-select.ts`. Right now this is just SAML; LDAP
 * lands in Phase 2.
 *
 * The factory is intentionally argument-less — picking a runtime-specific
 * SAML adapter (e.g. a Web-Crypto-only verifier for non-`nodejs_compat`
 * environments) would dispatch here based on `onCloudflareWorkers()` etc.
 * For now samlify works under Workers via `nodejs_compat` (confirmed by
 * `apps/web/scripts/saml-spike.ts`), so there's nothing to choose.
 */
import type { SamlAdapter } from "@workeros/core/adapters";
import { samlifySamlAdapter } from "../adapters/saml.samlify";

export const buildSamlAdapter = (): SamlAdapter => samlifySamlAdapter();
