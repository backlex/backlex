/**
 * The admin "this provider bypasses 2FA" warning fires for exactly the right
 * toggles. Pure-logic guard for the decision behind the confirm dialog in
 * auth-settings.tsx (the component itself can't load in a DOM-less runner).
 */
import { describe, expect, test } from "bun:test";
import {
  shouldWarnTwoFactorBypass,
  TWO_FACTOR_BYPASS_PROVIDERS,
} from "../src/client/admin/parity/mfa-bypass";

describe("shouldWarnTwoFactorBypass", () => {
  test("warns when ENABLING magic-link", () => {
    expect(shouldWarnTwoFactorBypass("magic", true)).toBe(true);
  });

  test("warns when ENABLING email-OTP", () => {
    expect(shouldWarnTwoFactorBypass("emailOtp", true)).toBe(true);
  });

  test("does NOT warn when disabling a bypass provider", () => {
    expect(shouldWarnTwoFactorBypass("magic", false)).toBe(false);
    expect(shouldWarnTwoFactorBypass("emailOtp", false)).toBe(false);
  });

  test("does NOT warn for providers that respect 2FA", () => {
    for (const id of ["google", "github", "apple", "passkey", "email"]) {
      expect(shouldWarnTwoFactorBypass(id, true)).toBe(false);
    }
  });

  test("the bypass set is exactly magic + emailOtp", () => {
    expect([...TWO_FACTOR_BYPASS_PROVIDERS].sort()).toEqual(["emailOtp", "magic"]);
  });
});
