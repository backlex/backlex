import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  EyeIcon,
  EyeOffIcon,
  InfoIcon,
  KeyRoundIcon,
  MailIcon,
} from "lucide-react";
import { Button } from "@workeros/ui/components/button";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
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
  onSignedIn,
}: SignInPageProps) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"email" | "passkey" | null>(null);
  const next = searchParam("next") || "/";

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
    const res = await authClient.signIn.email({ email, password });
    if (res.error) {
      setError(res.error.message ?? copy.signInFailed);
      setBusy(null);
      return;
    }
    if (onSignedIn) {
      onSignedIn(next);
    } else if (typeof window !== "undefined") {
      window.location.href = next;
    }
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
      if (onSignedIn) {
        onSignedIn(next);
      } else if (typeof window !== "undefined") {
        window.location.href = next;
      }
    } catch (err) {
      notify?.(err instanceof Error ? err.message : String(err));
      setBusy(null);
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
        <AuthCardHeader title={copy.title} description={copy.description} />

        {socialButtons}

        <AuthDivider>{copy.orWithEmail}</AuthDivider>

        {error && (
          <AuthError>
            <InfoIcon size={14} className="shrink-0" />
            <span>{error}</span>
          </AuthError>
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
      </AuthCard>
    </AuthShell>
  );
};
