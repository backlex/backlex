import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  SignInPage as BaseSignInPage,
  type AuthBranding,
  type AuthShellCopy,
  type SignInCopy,
} from "@backlex/auth-ui";
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
  const next = params.get("next") || "/";
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
    footPrefix: t`Don't have an account?`,
    footLabel: t`Sign up`,
  };

  return (
    <BaseSignInPage
      authClient={auth}
      navigate={(to, opts) => navigate(to, opts)}
      searchParam={(k) => params.get(k)}
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
      socialButtons={<SocialButtons callbackURL={next} />}
      hasSocials={hasSocials}
      ssoButtons={<PlatformSso callbackURL={next} />}
      hasSso={hasSso}
    />
  );
};
