import type { ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  SignUpPage as BaseSignUpPage,
  type AuthBranding,
  type AuthShellCopy,
  type SignUpCopy,
} from "@backlex/auth-ui";
import { SocialButtons, useHasSocialProviders } from "@/components/social-buttons";
import { notifyError } from "@/lib/error";
import { auth, invalidateAuthSurface, toSurfaceFlags, useAuthSurface } from "@/lib/auth";
import { useWorkspaceBranding } from "@/lib/branding";
import { version as appVersion } from "../../../package.json";

/** Sign-up consent link — renders a real anchor when the instance owner has
 *  configured a Terms/Privacy URL in Settings, otherwise plain emphasis (so the
 *  consent line never shows a dead link). The tag index is preserved, so the
 *  Lingui message id is unchanged and existing translations keep matching. */
const LegalLink = ({ href, children }: { href?: string; children: ReactNode }) =>
  href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-foreground underline underline-offset-2"
    >
      {children}
    </a>
  ) : (
    <span className="font-medium text-foreground">{children}</span>
  );

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
      <Trans>I agree to the <LegalLink href={surface?.branding?.termsUrl || undefined}>Terms</LegalLink> and <LegalLink href={surface?.branding?.privacyUrl || undefined}>Privacy</LegalLink>.</Trans>
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
      surface={toSurfaceFlags(surface)}
      appVersion={appVersion}
      socialButtons={<SocialButtons />}
      hasSocials={hasSocials}
      onInvalidateSurface={invalidateAuthSurface}
      forcedEmail={isFirst ? surface?.ownerEmail || undefined : undefined}
    />
  );
};
