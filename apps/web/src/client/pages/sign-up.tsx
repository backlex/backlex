import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { MoonIcon, SunIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import {
  SignUpPage as BaseSignUpPage,
  type AuthBranding,
  type AuthShellCopy,
  type SignUpCopy,
} from "@backlex/auth-ui";
import { SocialButtons, useHasSocialProviders } from "@/components/social-buttons";
import { useTheme } from "@/components/theme-provider";
import { notifyError } from "@/lib/error";
import { auth, invalidateAuthSurface, useAuthSurface } from "@/lib/auth";
import { useWorkspaceBranding } from "@/lib/branding";
import { version as appVersion } from "../../../package.json";

/**
 * Thin wrapper that wires the OSS admin's Lingui copy, React Router, the
 * workspace branding/surface stores, and the social-button slot into the
 * generic `<SignUpPage>` from `@backlex/auth-ui`.
 */
export const SignUp = () => {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { surface } = useAuthSurface();
  const wsBranding = useWorkspaceBranding();
  const hasSocials = useHasSocialProviders();
  const { theme, setTheme } = useTheme();
  const dark = theme === "dark";

  const isFirstParam = params.get("claim") === "1";
  const isFirst = surface?.firstUserMode === true && isFirstParam;

  const branding: AuthBranding = {
    name: wsBranding?.workspaceName?.trim() || "backlex",
    logoUrl: wsBranding?.logoUrl ?? null,
  };

  const shellCopy: AuthShellCopy = {
    headline: isFirst ? (
      <Trans>You're the <em>first</em>. Claim this instance.</Trans>
    ) : (
      <Trans>Create your <em>backlex</em> account.</Trans>
    ),
    lede: isFirst ? (
      <Trans>Detected an empty users table. The first account on a fresh instance is provisioned as admin automatically.</Trans>
    ) : (
      <Trans>Email is the only required field. Roles assigned post-signup — first user gets admin.</Trans>
    ),
    signInLabel: t`Sign in`,
    signUpLabel: t`Sign up`,
    magicLinkLabel: t`Magic link`,
    claimInstanceLabel: t`Claim instance`,
    toggleTheme: t`Toggle theme`,
  };

  const copy: SignUpCopy = {
    // Blocked state
    blockedTitle: <Trans>Sign-up is disabled</Trans>,
    blockedDescription: (
      <Trans>An admin has turned off public sign-up for this instance. Ask for an invite, or sign in if you already have an account.</Trans>
    ),
    blockedCallout: (
      <>
        <strong><Trans>Closed instance.</Trans></strong>{" "}
        <Trans>Set <span className="font-mono">openSignup</span> to <em>true</em> in admin → Auth Settings to re-open.</Trans>
      </>
    ),
    blockedFootPrefix: t`Have an account?`,
    blockedFootLabel: t`Sign in`,

    // Verify state
    verifyTitle: <Trans>Check your inbox</Trans>,
    verifyDescription: (email: string) => (
      <Trans>We sent a verification link to {email}. Click it to finish creating your account.</Trans>
    ),
    verifyCallout: (
      <>
        <strong><Trans>Verification required.</Trans></strong>{" "}
        <Trans>Until you confirm your email, sign-in won't work. Didn't get it? Check spam, or wait a minute and try sign-in — we'll re-send on demand.</Trans>
      </>
    ),
    verifyFootPrefix: t`Already verified?`,
    verifyFootLabel: t`Sign in`,

    // Form state
    titleNormal: <Trans>Create an account</Trans>,
    titleClaim: <Trans>Create your admin account</Trans>,
    descriptionNormal: <Trans>You'll get the authenticated role by default.</Trans>,
    descriptionClaim: <Trans>This is the first user on this instance.</Trans>,
    firstUserCallout: (
      <>
        <strong><Trans>First-user policy.</Trans></strong>{" "}
        <Trans>The first account on a fresh instance is provisioned as <span className="font-mono">admin</span> automatically. You can demote yourself later.</Trans>
      </>
    ),
    orWithEmail: <Trans>or with email</Trans>,
    displayNameLabel: (
      <Trans>Display name <span className="text-muted-foreground font-normal">(optional)</span></Trans>
    ),
    displayNamePlaceholder: t`Rana`,
    emailLabel: <Trans>Email</Trans>,
    emailPlaceholder: t`you@example.com`,
    passwordLabel: <Trans>Password</Trans>,
    passwordPlaceholder: t`At least 8 characters`,
    passwordHashNote: (
      <Trans>Hashed with argon2id · stored in <span className="font-mono">users.password_hash</span>.</Trans>
    ),
    passkeyEnrol: <Trans>Enrol a passkey now</Trans>,
    passkeyRecommended: <Trans>recommended</Trans>,
    passkeyDescription: (
      <Trans>Faster, phishing-resistant sign-in. Your device will prompt for biometric or PIN after the account is created. You can add or remove passkeys later in Settings.</Trans>
    ),
    termsAgreement: (
      <Trans>I agree to the <span className="font-medium text-foreground">Terms</span> and <span className="font-medium text-foreground">Privacy</span>.</Trans>
    ),
    submitNormal: <Trans>Create account</Trans>,
    submitClaim: <Trans>Claim this instance</Trans>,
    submitCreatingNormal: <Trans>Creating account…</Trans>,
    submitCreatingClaim: <Trans>Claiming…</Trans>,
    submitEnrollingPasskey: <Trans>Setting up passkey…</Trans>,
    footPrefix: t`Already have an account?`,
    footLabel: t`Sign in`,
    signUpFailed: t`Sign-up failed`,
  };

  const themeToggle = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={shellCopy.toggleTheme}
      title={shellCopy.toggleTheme}
      className="text-muted-foreground"
    >
      {dark ? <SunIcon size={14} /> : <MoonIcon size={14} />}
    </Button>
  );

  return (
    <BaseSignUpPage
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
      surface={surface ?? null}
      appVersion={appVersion}
      themeToggle={themeToggle}
      socialButtons={<SocialButtons />}
      hasSocials={hasSocials}
      onInvalidateSurface={invalidateAuthSurface}
    />
  );
};
