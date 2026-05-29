import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { KeyRoundIcon, MailCheckIcon, ShieldIcon } from "lucide-react";
import { cn } from "@backlex/ui/lib/utils";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import { Checkbox } from "@backlex/ui/components/checkbox";
import {
  AuthCallout,
  AuthCard,
  AuthCardHeader,
  AuthDivider,
  AuthFootLink,
  AuthShell,
  AuthSubmit,
} from "../components/auth-shell";
import type {
  AuthBranding,
  AuthShellCopy,
  AuthSurfaceFlags,
  AuthWiring,
} from "../types";

const computeStrength = (pw: string): number => {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  return s;
};

const passkeysSupported = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.PublicKeyCredential !== "undefined";

/** Copy strings the SignUp page needs (besides the shared shell copy). */
export interface SignUpCopy {
  // ── Blocked state ──
  /** "Sign-up is disabled" */
  blockedTitle: ReactNode;
  /** "An admin has turned off public sign-up …" */
  blockedDescription: ReactNode;
  /** Inner closed-instance callout body (incl. <strong>). */
  blockedCallout: ReactNode;
  /** "Have an account?" */
  blockedFootPrefix: string;
  /** "Sign in" */
  blockedFootLabel: string;

  // ── Verify state ──
  /** "Check your inbox" */
  verifyTitle: ReactNode;
  /** "We sent a verification link to {email}…" — pass a function that
   *  receives the email string and returns the description ReactNode. */
  verifyDescription: (email: string) => ReactNode;
  /** Inner verification-required callout body (incl. <strong>). */
  verifyCallout: ReactNode;
  /** "Already verified?" */
  verifyFootPrefix: string;
  /** "Sign in" */
  verifyFootLabel: string;

  // ── Form state ──
  /** Title — varies by claim-mode. */
  titleNormal: ReactNode;
  titleClaim: ReactNode;
  /** Description — varies by claim-mode. */
  descriptionNormal: ReactNode;
  descriptionClaim: ReactNode;
  /** First-user callout body (incl. <strong>). */
  firstUserCallout: ReactNode;
  /** "or with email" divider. */
  orWithEmail: ReactNode;
  /** Display name label (incl. "(optional)"). */
  displayNameLabel: ReactNode;
  displayNamePlaceholder: string;
  emailLabel: ReactNode;
  emailPlaceholder: string;
  passwordLabel: ReactNode;
  passwordPlaceholder: string;
  /** Hash note under the password field. */
  passwordHashNote: ReactNode;
  /** Passkey opt-in card content. */
  passkeyEnrol: ReactNode;
  passkeyRecommended: ReactNode;
  passkeyDescription: ReactNode;
  /** Terms/privacy consent body. */
  termsAgreement: ReactNode;
  /** Submit button labels. */
  submitNormal: ReactNode;
  submitClaim: ReactNode;
  submitCreatingNormal: ReactNode;
  submitCreatingClaim: ReactNode;
  submitEnrollingPasskey: ReactNode;
  /** Foot link. */
  footPrefix: string;
  footLabel: string;

  /** Fallback when the auth client returns an error without a message. */
  signUpFailed: string;
}

export interface SignUpPageProps extends AuthWiring {
  copy: SignUpCopy;
  shellCopy: AuthShellCopy;
  branding: AuthBranding;
  surface?: AuthSurfaceFlags | null;
  appVersion?: string;
  themeToggle?: ReactNode;
  /** Render-prop for social-provider buttons. */
  socialButtons?: ReactNode;
  /** Whether socials are present — drives the "or with email" divider. */
  hasSocials?: boolean;
  /** Called when the surface needs to be refreshed (e.g. after first sign-up
   *  to clear the claim banner). The OSS admin calls `invalidateAuthSurface`. */
  onInvalidateSurface?: () => void;
  /** Called after a successful sign-up (post-verify if applicable). */
  onSignedUp?: () => void;
}

/**
 * Sign-up screen — display name + email + password, optional passkey enrol,
 * with three distinct render branches:
 *   - `blocked`: openSignup=false and not first-user → "sign-up disabled"
 *   - `verify`:  requireEmailVerification=true → "check your inbox"
 *   - `form`:    everything else
 */
export const SignUpPage = ({
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
  onInvalidateSurface,
  onSignedUp,
}: SignUpPageProps) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [supportsPasskey] = useState(() => passkeysSupported());
  const [enrollPasskey, setEnrollPasskey] = useState(supportsPasskey);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<
    "form" | "creating" | "enrolling" | "verify"
  >("form");

  const claim = searchParam("claim") === "1";
  const isFirst = surface?.firstUserMode === true && claim;
  const openSignup = surface ? surface.openSignup !== false : true;
  const requireVerify = surface
    ? surface.requireEmailVerification !== false
    : false;
  const blocked = surface != null && !openSignup && !isFirst;

  useEffect(() => {
    let cancelled = false;
    Promise.resolve(authClient.getSession())
      .then((res) => {
        if (cancelled) return;
        const session = (res as { data?: { session?: unknown } })?.data
          ?.session;
        if (session) navigate("/", { replace: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [authClient, navigate]);

  const strength = useMemo(() => computeStrength(password), [password]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password || !agreed) return;
    setBusy(true);
    setStage("creating");

    const res = await authClient.signUp.email({ email, password, name });
    if (res.error) {
      setBusy(false);
      setStage("form");
      notify?.(res.error.message ?? copy.signUpFailed);
      return;
    }

    onInvalidateSurface?.();

    if (enrollPasskey && supportsPasskey) {
      setStage("enrolling");
      try {
        const fn = authClient.passkey?.addPasskey;
        if (fn) {
          const pk = await fn({
            name: name || email.split("@")[0] || "primary",
            authenticatorAttachment: "platform",
          });
          if (pk?.error) {
            // Account is created; surface but don't block redirect.
            notify?.(
              `Account created but passkey enrolment failed: ${
                pk.error.message ?? "unknown"
              }. Add one in Settings → Passkeys.`,
            );
          }
        }
      } catch (err) {
        notify?.(
          `Account created. Passkey enrolment skipped: ${
            err instanceof Error ? err.message : "cancelled"
          }`,
        );
      }
    }

    if (requireVerify && !isFirst) {
      setStage("verify");
      setBusy(false);
      return;
    }

    if (onSignedUp) {
      onSignedUp();
    } else if (typeof window !== "undefined") {
      window.location.href = "/";
    }
  };

  if (blocked) {
    return (
      <AuthShell
        mode="sign-up"
        branding={branding}
        copy={shellCopy}
        surface={surface}
        appVersion={appVersion}
        Link={Link}
        themeToggle={themeToggle}
      >
        <AuthCard>
          <AuthCardHeader
            title={copy.blockedTitle}
            description={copy.blockedDescription}
          />
          <AuthCallout icon={<ShieldIcon size={16} />}>
            {copy.blockedCallout}
          </AuthCallout>
          <AuthFootLink
            to="/sign-in"
            prefix={copy.blockedFootPrefix}
            label={copy.blockedFootLabel}
            Link={Link}
          />
        </AuthCard>
      </AuthShell>
    );
  }

  if (stage === "verify") {
    return (
      <AuthShell
        mode="sign-up"
        branding={branding}
        copy={shellCopy}
        surface={surface}
        appVersion={appVersion}
        Link={Link}
        themeToggle={themeToggle}
      >
        <AuthCard>
          <AuthCardHeader
            title={copy.verifyTitle}
            description={copy.verifyDescription(email)}
          />
          <AuthCallout icon={<MailCheckIcon size={16} />}>
            {copy.verifyCallout}
          </AuthCallout>
          <AuthFootLink
            to="/sign-in"
            prefix={copy.verifyFootPrefix}
            label={copy.verifyFootLabel}
            Link={Link}
          />
        </AuthCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      mode={isFirst ? "claim" : "sign-up"}
      branding={branding}
      copy={shellCopy}
      surface={surface}
      appVersion={appVersion}
      Link={Link}
      themeToggle={themeToggle}
    >
      <AuthCard>
        <AuthCardHeader
          title={isFirst ? copy.titleClaim : copy.titleNormal}
          description={
            isFirst ? copy.descriptionClaim : copy.descriptionNormal
          }
        />

        {isFirst && (
          <AuthCallout icon={<ShieldIcon size={16} />}>
            {copy.firstUserCallout}
          </AuthCallout>
        )}

        {socialButtons}

        {hasSocials && <AuthDivider>{copy.orWithEmail}</AuthDivider>}

        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="name" className="flex items-center gap-1">
              {copy.displayNameLabel}
            </Label>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={copy.displayNamePlaceholder}
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">{copy.emailLabel}</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={copy.emailPlaceholder}
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">{copy.passwordLabel}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={copy.passwordPlaceholder}
              className="h-10"
            />
            {password && (
              <div className="mt-1 flex gap-1">
                {[1, 2, 3, 4].map((i) => {
                  const filled = i <= strength;
                  const weak = strength <= 2;
                  return (
                    <div
                      key={i}
                      className={cn(
                        "h-[3px] flex-1 rounded",
                        !filled && "bg-muted",
                        filled && weak && "bg-amber-500",
                        filled && !weak && "bg-primary",
                      )}
                    />
                  );
                })}
              </div>
            )}
            <p className="text-[11.5px] text-muted-foreground">
              {copy.passwordHashNote}
            </p>
          </div>

          {supportsPasskey && (
            <label className="flex cursor-pointer items-start gap-2 rounded-2xl border border-primary/30 bg-primary/8 px-3 py-2.5 text-[12.5px]">
              <Checkbox
                checked={enrollPasskey}
                onCheckedChange={(v) => setEnrollPasskey(!!v)}
                className="mt-0.5"
              />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <KeyRoundIcon className="size-3.5 text-primary" />
                  {copy.passkeyEnrol}
                  <span className="rounded-md border border-primary/30 bg-card px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-primary">
                    {copy.passkeyRecommended}
                  </span>
                </span>
                <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                  {copy.passkeyDescription}
                </span>
              </span>
            </label>
          )}

          <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-muted-foreground">
            <Checkbox
              checked={agreed}
              onCheckedChange={(v) => setAgreed(!!v)}
              className="mt-0.5"
            />
            <span>{copy.termsAgreement}</span>
          </label>

          <AuthSubmit
            type="submit"
            disabled={!email || !password || !agreed || busy}
          >
            {stage === "enrolling"
              ? copy.submitEnrollingPasskey
              : stage === "creating"
                ? isFirst
                  ? copy.submitCreatingClaim
                  : copy.submitCreatingNormal
                : isFirst
                  ? copy.submitClaim
                  : copy.submitNormal}
          </AuthSubmit>
        </form>

        <AuthFootLink
          to="/sign-in"
          prefix={copy.footPrefix}
          label={copy.footLabel}
          Link={Link}
        />
      </AuthCard>
    </AuthShell>
  );
};
