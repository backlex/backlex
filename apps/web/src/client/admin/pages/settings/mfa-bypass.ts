/**
 * Pure decision logic for the "this provider bypasses 2FA" admin warning.
 *
 * Kept free of React / UI imports so it can be unit-tested under bun:test
 * (the component that uses it pulls in the whole admin UI tree, which can't
 * load in a DOM-less test runner). The rule it encodes is security-relevant:
 * better-auth only gates *password* sign-in behind TOTP, so magic-link and
 * email-OTP both let a 2FA-enrolled user in without their authenticator code.
 *
 * Authenticator-app 2FA is always available on this instance (the two-factor
 * plugin is loaded unconditionally; users opt in from Account → Security), so
 * enabling a bypassing provider is *always* a 2FA-weakening action — there's no
 * "is 2FA on?" condition to check.
 */

/** Sign-in methods that skip the TOTP second factor (better-auth's two-factor
 *  matcher only covers `/sign-in/email|username|phone-number`). */
export const TWO_FACTOR_BYPASS_PROVIDERS = new Set(["magic", "emailOtp"]);

/**
 * Whether enabling a provider should prompt the "this weakens 2FA" confirm
 * dialog. True only when the admin is turning ON a 2FA-bypassing provider.
 *
 * @param id        provider key being toggled (`magic`, `emailOtp`, `google`, …)
 * @param enabling  the target state — `true` = turning on, `false` = turning off
 */
export const shouldWarnTwoFactorBypass = (
  id: string,
  enabling: boolean,
): boolean => enabling && TWO_FACTOR_BYPASS_PROVIDERS.has(id);
