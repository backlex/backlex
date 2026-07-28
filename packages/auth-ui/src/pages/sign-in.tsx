import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  KeyRoundIcon,
  MailIcon,
} from "lucide-react";
import { Button } from "@backlex/ui/components/button";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import {
  AuthCard,
  AuthCardHeader,
  AuthDivider,
  AuthError,
  AuthFootLink,
  AuthOutline,
  AuthShell,
  AuthSubmit,
} from "../components/auth-shell";
import type {
  AuthBranding,
  AuthShellCopy,
  AuthSurfaceFlags,
  AuthWiring,
} from "../types";

const passkeysSupported = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential !== "undefined";

/** Copy strings the SignIn page needs (besides the shared shell copy). */
export interface SignInCopy {
  /** "Welcome back" */
  title: ReactNode;
  /** "Sign in with your email and password, or use a provider." */
  description: ReactNode;
  /** "or with email" — divider above the email form. */
  orWithEmail: ReactNode;
  /** "Enter your email and password." (validation) */
  missingFields: string;
  /** Fallback when the auth client returns an error without a message. */
  signInFailed: string;
  /** Email label + placeholder. */
  emailLabel: ReactNode;
  emailPlaceholder: string;
  /** Password label + show/hide aria-labels. */
  passwordLabel: ReactNode;
  showPassword: string;
  hidePassword: string;
  /** "Forgot?" link in the password row. */
  forgot: ReactNode;
  /** Primary submit — idle + busy text. */
  submit: ReactNode;
  submitBusy: ReactNode;
  /** Magic-link alt CTA. */
  magicLinkCta: ReactNode;
  /** Passkey CTA — idle + busy. */
  passkeyCta: ReactNode;
  passkeyBusy: ReactNode;
  passkeyNotEnabled: string;
  passkeyFailed: string;
  /** Two-factor (TOTP) challenge screen, shown after a correct password when
   *  the account has an authenticator enrolled. */
  twoFactorTitle: ReactNode;
  twoFactorDescription: ReactNode;
  twoFactorCodeLabel: ReactNode;
  twoFactorCodePlaceholder: string;
  twoFactorVerify: ReactNode;
  twoFactorVerifying: ReactNode;
  twoFactorUseBackup: ReactNode;
  twoFactorUseAuthenticator: ReactNode;
  twoFactorBackupLabel: ReactNode;
  twoFactorBackupPlaceholder: string;
  twoFactorMissingCode: string;
  twoFactorFailed: string;
  twoFactorBack: ReactNode;
  /** Shown when sign-in is rejected because the email isn't verified yet. */
  emailNotVerified: string;
  resendVerification: ReactNode;
  verificationResent: string;
  /** "Don't have an account?" + "Sign up". */
  footPrefix: string;
  footLabel: string;
}

export interface SignInPageProps extends AuthWiring {
  copy: SignInCopy;
  shellCopy: AuthShellCopy;
  branding: AuthBranding;
  surface?: AuthSurfaceFlags | null;
  appVersion?: string;
  themeToggle?: ReactNode;
  /** Render-prop for social-provider buttons. The consumer decides which
   *  providers to show and how (the OSS admin reads the auth surface). */
  socialButtons?: ReactNode;
  /** Whether any social provider is actually rendered. Gates the
   *  "or with email" divider so it doesn't strand above the email form when
   *  there are no social buttons (e.g. the control-plane sign-in, which ships
   *  no social providers). Mirrors `sign-up.tsx`. */
  hasSocials?: boolean;
  /** Render-prop slot for enterprise SSO entry points (SAML buttons + an LDAP
   *  form). The control-plane sign-in fills this from the auth surface. */
  ssoButtons?: ReactNode;
  /** Whether `ssoButtons` actually renders anything — also gates the divider. */
  hasSso?: boolean;
  /** Called after a successful sign-in. Default: `window.location.href = next`. */
  onSignedIn?: (next: string) => void;
}

/**
 * Sign-in screen — email/password + optional social + optional passkey. The
 * page reads `?next=…` from the URL via `searchParam` and redirects there on
 * success.
 */
export const SignInPage = ({
  authClient,
  navigate,
  searchParam,
  Link,
  notify,
  copy,
  shellCopy,
  branding,
  surface,
  appVersion,
  themeToggle,
  socialButtons,
  hasSocials = false,
  ssoButtons,
  hasSso = false,
  onSignedIn,
}: SignInPageProps) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"email" | "passkey" | "twofactor" | null>(null);
  // "form" = email/password screen; "twofactor" = OTP challenge after a correct
  // password for a 2FA-enabled account.
  const [stage, setStage] = useState<"form" | "twofactor">("form");
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  // Email-verification gate: set when sign-in is rejected as unverified, so the
  // form can offer a "resend link" action.
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resent, setResent] = useState(false);
  const next = searchParam("next") || "/";

  const finishSignIn = () => {
    if (onSignedIn) {
      onSignedIn(next);
    } else if (typeof window !== "undefined") {
      window.location.href = next;
    }
  };

  // Already signed in? Skip the form entirely.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(authClient.getSession())
      .then((res) => {
        if (cancelled) return;
        const session = (res as { data?: { session?: unknown } })?.data
          ?.session;
        if (session) navigate(next, { replace: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authClient, navigate, next]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError(copy.missingFields);
      return;
    }
    setError(null);
    setBusy("email");
    let res: Awaited<ReturnType<typeof authClient.signIn.email>>;
    try {
      res = await authClient.signIn.email({ email, password });
    } catch (err) {
      // A rejected sign-in (network failure or the client-level fetch timeout
      // aborting a stalled instance) must re-enable the button instead of
      // leaving it frozen on "Signing in…".
      setError(err instanceof Error ? err.message : copy.signInFailed);
      setBusy(null);
      return;
    }
    if (res.error) {
      // Unverified email → don't show a generic error; offer to resend the
      // verification link instead. better-auth returns 403 / EMAIL_NOT_VERIFIED.
      if (res.error.status === 403 || res.error.code === "EMAIL_NOT_VERIFIED") {
        setNeedsVerify(true);
        setResent(false);
        setError(copy.emailNotVerified);
        setBusy(null);
        return;
      }
      setError(res.error.message ?? copy.signInFailed);
      setBusy(null);
      return;
    }
    // 2FA-enabled accounts get no session yet — better-auth signals the OTP
    // step via `twoFactorRedirect`. Swap to the challenge screen instead of
    // redirecting.
    const data = res.data as { twoFactorRedirect?: boolean } | null | undefined;
    if (data?.twoFactorRedirect) {
      setBusy(null);
      setCode("");
      setUseBackup(false);
      setStage("twofactor");
      return;
    }
    finishSignIn();
  };

  const verifyTwoFactor = async (e: FormEvent) => {
    e.preventDefault();
    const value = code.trim();
    if (!value) {
      setError(copy.twoFactorMissingCode);
      return;
    }
    setError(null);
    setBusy("twofactor");
    const fn = useBackup
      ? authClient.twoFactor?.verifyBackupCode
      : authClient.twoFactor?.verifyTotp;
    if (!fn) {
      setError(copy.twoFactorFailed);
      setBusy(null);
      return;
    }
    const res = await fn({ code: value });
    if (res?.error) {
      setError(res.error.message ?? copy.twoFactorFailed);
      setBusy(null);
      return;
    }
    finishSignIn();
  };

  const passkey = async () => {
    setError(null);
    setBusy("passkey");
    try {
      const fn = authClient.signIn.passkey;
      if (!fn) {
        setError(copy.passkeyNotEnabled);
        setBusy(null);
        return;
      }
      const res = await fn({ autoFill: false });
      if (res?.error) {
        setError(res.error.message ?? copy.passkeyFailed);
        setBusy(null);
        return;
      }
      finishSignIn();
    } catch (err) {
      notify?.(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const resendVerification = async () => {
    const fn = authClient.sendVerificationEmail;
    if (!fn || !email) return;
    try {
      await fn({ email, callbackURL: next });
      setResent(true);
    } catch (err) {
      notify?.(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <AuthShell
      mode="sign-in"
      branding={branding}
      copy={shellCopy}
      surface={surface}
      appVersion={appVersion}
      Link={Link}
      themeToggle={themeToggle}
    >
      <AuthCard>
        {stage === "twofactor" ? (
          <>
            <AuthCardHeader
              title={copy.twoFactorTitle}
              description={copy.twoFactorDescription}
            />

            {error && (
              <AuthError>
                <InfoIcon size={14} className="shrink-0" />
                <span>{error}</span>
              </AuthError>
            )}

            <form className="space-y-4" onSubmit={verifyTwoFactor}>
              <div className="space-y-1.5">
                <Label htmlFor="twofactor-code">
                  {useBackup ? copy.twoFactorBackupLabel : copy.twoFactorCodeLabel}
                </Label>
                <Input
                  id="twofactor-code"
                  inputMode={useBackup ? "text" : "numeric"}
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={
                    useBackup
                      ? copy.twoFactorBackupPlaceholder
                      : copy.twoFactorCodePlaceholder
                  }
                  className="h-10"
                />
              </div>

              <AuthSubmit type="submit" disabled={busy !== null}>
                {busy === "twofactor" ? copy.twoFactorVerifying : copy.twoFactorVerify}
              </AuthSubmit>

              <div className="flex items-center justify-between">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-0 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setStage("form");
                    setError(null);
                    setCode("");
                  }}
                >
                  {copy.twoFactorBack}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="px-0 text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setUseBackup((v) => !v);
                    setError(null);
                    setCode("");
                  }}
                >
                  {useBackup ? copy.twoFactorUseAuthenticator : copy.twoFactorUseBackup}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <>
            <AuthCardHeader title={copy.title} description={copy.description} />

            {socialButtons}

            {ssoButtons}

            {(hasSocials || hasSso) && <AuthDivider>{copy.orWithEmail}</AuthDivider>}

            {error && (
              <AuthError>
                <InfoIcon size={14} className="shrink-0" />
                <span>{error}</span>
              </AuthError>
            )}

            {needsVerify && (
              <div className="-mt-2 text-[12px] text-muted-foreground">
                {resent ? (
                  <span>{copy.verificationResent}</span>
                ) : (
                  <button
                    type="button"
                    onClick={resendVerification}
                    className="text-foreground underline-offset-2 hover:underline"
                  >
                    {copy.resendVerification}
                  </button>
                )}
              </div>
            )}

            <form className="space-y-4" onSubmit={submit}>
              <div className="space-y-1.5">
                <Label htmlFor="email">{copy.emailLabel}</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={copy.emailPlaceholder}
                  className="h-10"
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor="password">{copy.passwordLabel}</Label>
                  <Link
                    to="/forgot"
                    className="text-[11.5px] text-muted-foreground hover:text-foreground hover:underline"
                  >
                    {copy.forgot}
                  </Link>
                </div>
                <div className="relative">
                  <Input
                    id="password"
                    type={show ? "text" : "password"}
                    autoComplete="current-password webauthn"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="h-10 pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => setShow((s) => !s)}
                    aria-label={show ? copy.hidePassword : copy.showPassword}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  >
                    {show ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                  </Button>
                </div>
              </div>

              <AuthSubmit type="submit" disabled={busy !== null}>
                {busy === "email" ? copy.submitBusy : copy.submit}
              </AuthSubmit>

              <AuthOutline asChild>
                <Link to="/magic-link">
                  <MailIcon /> {copy.magicLinkCta}
                </Link>
              </AuthOutline>

              {passkeysSupported() && (
                <AuthOutline
                  type="button"
                  onClick={passkey}
                  disabled={busy !== null}
                >
                  <KeyRoundIcon />
                  {busy === "passkey" ? copy.passkeyBusy : copy.passkeyCta}
                </AuthOutline>
              )}
            </form>

            <AuthFootLink
              to="/sign-up"
              prefix={copy.footPrefix}
              label={copy.footLabel}
              Link={Link}
            />
          </>
        )}
      </AuthCard>
    </AuthShell>
  );
};
