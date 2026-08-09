/**
 * `passwordLogin` — whether an email + password may be exchanged for a session,
 * and on which plane.
 *
 * Once a workspace has SSO or a passkey, the password is the weakest surviving
 * way in, and turning SSO on never turned the password off. The risk in the
 * feature itself is the mirror image: an admin flips it with nothing else
 * configured and locks everyone out of their own instance with no path back
 * except a manual DB write. So the assertions come in pairs — what each mode
 * blocks, and what it must NOT block.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  isPasswordLoginMode,
  PASSWORD_LOGIN_DEFAULT,
  SIGN_IN_BRANDING_KEYS,
} from "../src/server/services/settings";
import { applyPasswordLoginMode } from "../src/server/services/auth-config";
import { type TestHarness, makeHarness, seedAdmin } from "./setup";

const JSON_HEADERS = { "Content-Type": "application/json" };
const PASSWORD = "correct-horse-battery";

describe("mode parsing", () => {
  test("only the three modes are accepted", () => {
    for (const m of ["enabled", "app-only", "disabled"]) expect(isPasswordLoginMode(m)).toBe(true);
    for (const m of ["ENABLED", "off", "", null, undefined, 1, {}])
      expect(isPasswordLoginMode(m)).toBe(false);
  });

  test("the default is permissive — an unreadable setting must not lock anyone out", () => {
    expect(PASSWORD_LOGIN_DEFAULT).toBe("enabled");
  });

  test("the key is routed to the instance-global row, like the branding keys", () => {
    expect([...SIGN_IN_BRANDING_KEYS]).toContain("passwordLogin");
  });
});

describe("applyPasswordLoginMode — what the sign-in screen is told", () => {
  const surface = () =>
    ({
      providers: [
        { id: "email", kind: "credential", label: "Email & password", enabled: true },
        { id: "passkey", kind: "passkey", label: "Passkey", enabled: true },
      ],
    }) as never;

  const credential = (s: { providers: Array<{ kind: string; enabled: boolean }> }) =>
    s.providers.find((p) => p.kind === "credential");

  test("enabled leaves both planes alone", () => {
    expect(credential(applyPasswordLoginMode(surface(), "enabled", "platform"))?.enabled).toBe(true);
    expect(credential(applyPasswordLoginMode(surface(), "enabled", "app"))?.enabled).toBe(true);
  });

  test("app-only turns it off for the dashboard and leaves customers alone", () => {
    expect(credential(applyPasswordLoginMode(surface(), "app-only", "platform"))?.enabled).toBe(false);
    expect(credential(applyPasswordLoginMode(surface(), "app-only", "app"))?.enabled).toBe(true);
  });

  test("disabled turns it off on both", () => {
    expect(credential(applyPasswordLoginMode(surface(), "disabled", "platform"))?.enabled).toBe(false);
    expect(credential(applyPasswordLoginMode(surface(), "disabled", "app"))?.enabled).toBe(false);
  });

  test("other providers are never touched", () => {
    const out = applyPasswordLoginMode(surface(), "disabled", "platform") as {
      providers: Array<{ kind: string; enabled: boolean }>;
    };
    expect(out.providers.find((p) => p.kind === "passkey")?.enabled).toBe(true);
  });
});

describe("enforcement on the platform plane", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  /** A harness whose admin sign-in offers a passkey, so the lock-out guard is
   *  satisfied and the mode can actually be set. */
  const harnessWithAlternative = async () => {
    h = makeHarness({ AUTH_PLUGINS: "passkey" });
    const creds = await seedAdmin(h);
    return creds;
  };

  const setMode = async (mode: string) =>
    await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ passwordLogin: mode }),
    });

  const signIn = async (email: string) =>
    await h.fetch("/api/auth/sign-in/email", {
      method: "POST",
      headers: { ...JSON_HEADERS, Origin: "http://localhost:5173" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });

  test("password sign-in works while the mode is enabled", async () => {
    const { email } = await harnessWithAlternative();
    expect((await signIn(email)).status).toBe(200);
  });

  test("disabled refuses the admin password sign-in", async () => {
    const { email } = await harnessWithAlternative();
    expect((await setMode("disabled")).status).toBe(200);
    const res = await signIn(email);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/[Pp]assword sign-in is disabled/);
  });

  test("app-only also refuses it — the dashboard is the platform plane", async () => {
    const { email } = await harnessWithAlternative();
    expect((await setMode("app-only")).status).toBe(200);
    expect((await signIn(email)).status).toBe(403);
  });

  test("sign-up and password reset are blocked too, not just sign-in", async () => {
    await harnessWithAlternative();
    await setMode("disabled");
    for (const path of ["/api/auth/sign-up/email", "/api/auth/forget-password"]) {
      const res = await h.fetch(path, {
        method: "POST",
        headers: { ...JSON_HEADERS, Origin: "http://localhost:5173" },
        body: JSON.stringify({ email: "someone@example.test", password: PASSWORD }),
      });
      expect(res.status).toBe(403);
    }
  });

  test("non-password auth traffic is untouched", async () => {
    await harnessWithAlternative();
    await setMode("disabled");
    // Session lookup is not a password path; blocking it would sign everyone out.
    expect((await h.fetch("/api/auth/get-session")).status).toBe(200);
  });

  test("the provider list reports the password as off, so the form can hide", async () => {
    await harnessWithAlternative();
    const credentialOf = async () => {
      const res = await h.fetch("/api/auth/providers");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: { providers: Array<{ kind: string; enabled: boolean }> };
      };
      const cred = body.data.providers.find((p) => p.kind === "credential");
      // Present in BOTH states — the settings screen has to know the password
      // exists in order to say it is off. Asserting it here is what stops the
      // "enabled: false" check below from passing because the entry vanished.
      expect(cred).toBeDefined();
      return cred!;
    };
    expect((await credentialOf()).enabled).toBe(true);
    await setMode("disabled");
    expect((await credentialOf()).enabled).toBe(false);
  });

  test("the mode round-trips through the settings read", async () => {
    await harnessWithAlternative();
    await setMode("app-only");
    const res = await h.fetch("/api/admin/settings");
    const body = (await res.json()) as { data: { passwordLogin?: string } };
    expect(body.data.passwordLogin).toBe("app-only");
  });
});

describe("the lock-out guard", () => {
  let h: TestHarness;
  afterEach(() => h?.cleanup());

  test("turning the password off with nothing else configured is refused", async () => {
    // No AUTH_PLUGINS, no SSO — the password is the only way in.
    h = makeHarness();
    await seedAdmin(h);
    const res = await h.fetch("/api/admin/settings", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ passwordLogin: "disabled" }),
    });
    expect(res.status).toBe(422);
    expect(await res.text()).toMatch(/another way in/i);

    // And it really did not take effect.
    const after = await h.fetch("/api/admin/settings");
    const body = (await after.json()) as { data: { passwordLogin?: string } };
    expect(body.data.passwordLogin).toBe("enabled");
  });

  test("returning to enabled is always allowed — the way back is never gated", async () => {
    h = makeHarness({ AUTH_PLUGINS: "passkey" });
    await seedAdmin(h);
    expect(
      (
        await h.fetch("/api/admin/settings", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ passwordLogin: "disabled" }),
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await h.fetch("/api/admin/settings", {
          method: "PATCH",
          headers: JSON_HEADERS,
          body: JSON.stringify({ passwordLogin: "enabled" }),
        })
      ).status,
    ).toBe(200);
  });
});
