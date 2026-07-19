import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  SignInPage as BaseSignInPage,
  type AuthBranding,
  type AuthShellCopy,
  type SignInCopy,
} from "@backlex/auth-ui";
import { DemoSignInButton } from "@/components/demo-banner";
import { SocialButtons, useHasSocialProviders } from "@/components/social-buttons";
import { PlatformSso, useHasPlatformSso } from "@/components/platform-sso";
import { notifyError } from "@/lib/error";
import { auth, toSurfaceFlags, useAuthSurface } from "@/lib/auth";
import { useWorkspaceBranding } from "@/lib/branding";
import { version as appVersion } from "../../../package.json";

/**
 * Thin wrapper that wires the OSS admin's Lingui copy, React Router, the
 * workspace branding/surface stores, and the social-button slot into the
 * generic `<SignInPage>` from `@backlex/auth-ui`.
 */
export const SignIn = () => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // MCP OAuth resume: the authorize endpoint bounces unauthenticated users
  // here with the ENTIRE OAuth query attached (client_id, redirect_uri,
  // code_challenge, …). When those markers are present, "next" is the
  // authorize endpoint itself so a successful sign-in re-enters the OAuth
  // flow — as a hard navigation, since it's an API URL, not an SPA route.
  const oauthResume =
    params.get("client_id") && params.get("redirect_uri") && params.get("response_type")
      ? `/api/auth/mcp/authorize?${params.toString()}`
      : null;
  const next = oauthResume ?? (params.get("next") || "/");
  useEffect(() => {
    // The mcp plugin's after-hook would otherwise hijack the sign-in XHR
    // response into a 302 chain toward the client callback (which fetch
    // follows invisibly, leaving the page stuck) — AND that in-hook authorize
    // re-run bypasses the server's forced-consent gate. The hook only fires
    // while its `oidc_login_prompt` cookie exists; it's not httpOnly, so we
    // clear it and own the resume via the hard navigation below instead.
    if (oauthResume) {
      document.cookie = "oidc_login_prompt=; Max-Age=0; path=/";
    }
  }, [oauthResume]);
  const { surface } = useAuthSurface();
  const hasSocials = useHasSocialProviders();
  const hasSso = useHasPlatformSso();
  const wsBranding = useWorkspaceBranding();

  const branding: AuthBranding = {
    name: wsBranding?.workspaceName?.trim() || "backlex",
    logoUrl: wsBranding?.logoUrl ?? null,
    signInHeadline: surface?.branding?.signInHeadline ?? null,
    signInTagline: surface?.branding?.signInTagline ?? null,
  };

  const shellCopy: AuthShellCopy = {
    headline: <Trans>Sign in to <em>backlex</em>.</Trans>,
    lede: (
      <Trans>Welcome back. Pick up where you left off — content, data, and APIs all in one place.</Trans>
    ),
    signInLabel: t`Sign in`,
    signUpLabel: t`Sign up`,
    magicLinkLabel: t`Magic link`,
    claimInstanceLabel: t`Claim instance`,
    toggleTheme: t`Toggle theme`,
  };

  const copy: SignInCopy = {
    title: <Trans>Welcome back</Trans>,
    description: (
      <Trans>Sign in with your email and password, or use a provider.</Trans>
    ),
    orWithEmail: <Trans>or with email</Trans>,
    missingFields: t`Enter your email and password.`,
    signInFailed: t`Sign-in failed`,
    emailLabel: <Trans>Email</Trans>,
    emailPlaceholder: t`you@example.com`,
    passwordLabel: <Trans>Password</Trans>,
    showPassword: t`Show password`,
    hidePassword: t`Hide password`,
    forgot: <Trans>Forgot?</Trans>,
    submit: <Trans>Sign in</Trans>,
    submitBusy: <Trans>Signing in…</Trans>,
    magicLinkCta: <Trans>Send a magic link instead</Trans>,
    passkeyCta: <Trans>Sign in with passkey</Trans>,
    passkeyBusy: <Trans>Signing in…</Trans>,
    passkeyNotEnabled: t`Passkey plugin not enabled`,
    passkeyFailed: t`Passkey sign-in failed`,
    twoFactorTitle: <Trans>Two-factor authentication</Trans>,
    twoFactorDescription: (
      <Trans>Enter the 6-digit code from your authenticator app to finish signing in.</Trans>
    ),
    twoFactorCodeLabel: <Trans>Authentication code</Trans>,
    twoFactorCodePlaceholder: t`123456`,
    twoFactorVerify: <Trans>Verify</Trans>,
    twoFactorVerifying: <Trans>Verifying…</Trans>,
    twoFactorUseBackup: <Trans>Use a backup code</Trans>,
    twoFactorUseAuthenticator: <Trans>Use authenticator app</Trans>,
    twoFactorBackupLabel: <Trans>Backup code</Trans>,
    twoFactorBackupPlaceholder: t`xxxxx-xxxxx`,
    twoFactorMissingCode: t`Enter your authentication code.`,
    twoFactorFailed: t`Invalid code. Try again.`,
    twoFactorBack: <Trans>Back</Trans>,
    emailNotVerified: t`Your email isn't verified yet. Check your inbox for the verification link.`,
    resendVerification: <Trans>Resend verification email</Trans>,
    verificationResent: t`Verification email sent.`,
    footPrefix: t`Don't have an account?`,
    footLabel: t`Sign up`,
  };

  return (
    <BaseSignInPage
      authClient={auth}
      navigate={(to, opts) => {
        // API destinations (the OAuth authorize resume) need a real browser
        // navigation — react-router would swallow them into the SPA catch-all.
        if (to.startsWith("/api/")) {
          window.location.href = to;
          return;
        }
        navigate(to, opts);
      }}
      searchParam={(k) => (k === "next" ? next : params.get(k))}
      Link={({ to, className, children }) => (
        <Link to={to} className={className}>
          {children}
        </Link>
      )}
      notify={(msg) => notifyError(msg)}
      copy={copy}
      shellCopy={shellCopy}
      branding={branding}
      surface={toSurfaceFlags(surface)}
      appVersion={appVersion}
      socialButtons={
        <>
          {surface?.demo && <DemoSignInButton demo={surface.demo} next={next} />}
          <SocialButtons callbackURL={next} />
        </>
      }
      hasSocials={hasSocials || Boolean(surface?.demo)}
      ssoButtons={<PlatformSso callbackURL={next} />}
      hasSso={hasSso}
    />
  );
};
