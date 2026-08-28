import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { KeyRoundIcon, Loader2Icon, MailCheckIcon, ShieldIcon } from "lucide-react";
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
import { withWebAuthnDeadline } from "../webauthn-deadline";

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

/**
 * True when a rejected request was aborted rather than genuinely failed — the
 * shape the auth client's own `fetchOptions.timeout` produces (better-fetch
 * calls `controller.abort()` with no reason, so the browser rejects with a
 * bare "signal is aborted without reason" `DOMException` / `AbortError`).
 * That string must never reach a user; it also usually means the server
 * committed the write before we stopped waiting, which is what makes the
 * recovery sign-in worth attempting. */
const isAbortError = (err: unknown): boolean => {
  if (err instanceof DOMException) return err.name === "AbortError" || err.name === "TimeoutError";
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return true;
    return /\baborted?\b|\btimed?\s*out\b|\btimeout\b/i.test(err.message);
  }
  return false;
};

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
  /** Shown when the sign-up request was aborted (the client-level fetch
   *  timeout firing on a slow instance) AND the recovery sign-in could not
   *  confirm the account — a human message in place of the raw, cryptic
   *  "signal is aborted". Optional: falls back to `signUpFailed`. */
  signUpTimedOut?: string;
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
  /** When set, the email field is pre-filled and locked (read-only). Used for
   *  the managed-cloud first-admin claim, where only the pinned owner address
   *  may register. */
  forcedEmail?: string;
  /** Whether to render the Terms/Privacy consent checkbox (and require it
   *  before submit). Pass `false` when the instance has no legal URLs
   *  configured — asking users to agree to documents that don't exist is
   *  meaningless. Defaults to `true`. */
  showConsent?: boolean;
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
  forcedEmail,
  showConsent = true,
}: SignUpPageProps) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState(forcedEmail ?? "");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [supportsPasskey] = useState(() => passkeysSupported());
  const [enrollPasskey, setEnrollPasskey] = useState(supportsPasskey);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<
    "form" | "creating" | "enrolling" | "verify"
  >("form");
  // True once getSession has resolved with NO session (the session-present
  // path navigates away instead), OR the probe stalled past the hard cap.
  // Claim mode holds its first paint on this.
  const [sessionChecked, setSessionChecked] = useState(false);
  // After a short grace we swap the held-blank paint for a lightweight loader
  // so a slow session probe reads as "connecting", not a dead black screen.
  const [holdLoader, setHoldLoader] = useState(false);

  const claim = searchParam("claim") === "1";
  const isFirst = surface?.firstUserMode === true && claim;
  // A claim deep-link on an already-claimed instance (the cloud panel's
  // claimed-probe is best-effort and can link here stale) — never show the
  // claim/sign-up form for it; bounce to sign-in instead.
  const staleClaim = claim && surface != null && surface.firstUserMode !== true;
  const openSignup = surface ? surface.openSignup !== false : true;
  const requireVerify = surface
    ? surface.requireEmailVerification !== false
    : false;
  const blocked = surface != null && !openSignup && !isFirst;
  // Only offer passkey enrolment when the browser supports WebAuthn AND the
  // server actually has the passkey plugin enabled — otherwise `addPasskey`
  // hits an endpoint that doesn't exist and fails with "unknown". `surface`
  // may be null while loading; fall back to browser support only.
  const passkeyOffered = supportsPasskey && surface?.passkey !== false;

  useEffect(() => {
    // Only claim mode holds its paint on the probe; the normal sign-up form
    // renders immediately, so skip the timers/loader machinery entirely.
    if (!claim) return;
    let cancelled = false;
    const timers: number[] = [];
    // Reveal the loader once the probe is visibly slow (same 700ms grace as the
    // admin AuthGate — the fast path never flashes it).
    timers.push(
      window.setTimeout(() => {
        if (!cancelled) setHoldLoader(true);
      }, 700),
    );
    // Hard cap: `getSession` takes no abort signal, so a stalled
    // /api/auth/get-session (a slow or flaky instance) used to hold the claim
    // paint on `null` forever — a permanent black screen. After the cap, stop
    // holding and fall through to the form / sign-in redirect. A late-resolving
    // probe still navigates away below (or the page has already unmounted).
    timers.push(
      window.setTimeout(() => {
        if (!cancelled) setSessionChecked(true);
      }, 9000),
    );
    Promise.resolve(authClient.getSession())
      .then((res) => {
        if (cancelled) return;
        const session = (res as { data?: { session?: unknown } })?.data
          ?.session;
        if (session) navigate("/", { replace: true });
        else setSessionChecked(true);
      })
      .catch(() => {
        if (!cancelled) setSessionChecked(true);
      });
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [authClient, navigate, claim]);

  useEffect(() => {
    if (staleClaim && sessionChecked) navigate("/sign-in", { replace: true });
  }, [staleClaim, sessionChecked, navigate]);

  // `forcedEmail` may arrive after first paint (it rides the async auth
  // surface); sync it into the field once it's known.
  useEffect(() => {
    if (forcedEmail) setEmail(forcedEmail);
  }, [forcedEmail]);

  const strength = useMemo(() => computeStrength(password), [password]);

  /** Leave the auth flow the same way a successful sign-up does. */
  const redirectAfterAuth = () => {
    if (onSignedUp) onSignedUp();
    else if (typeof window !== "undefined") window.location.href = "/";
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password || (showConsent && !agreed)) return;
    setBusy(true);
    setStage("creating");

    let res: Awaited<ReturnType<typeof authClient.signUp.email>>;
    try {
      res = await authClient.signUp.email({ email, password, name });
    } catch (err) {
      // The sign-up request was aborted before its response arrived — most
      // often the auth client's own `fetchOptions.timeout` firing on a cold or
      // freshly-provisioned instance whose first-admin create legitimately runs
      // long (cold Worker + DB provisioning + template seed). Crucially the
      // server may well have COMMITTED the account before we stopped waiting:
      // the write is durable, only our confirmation was lost. So the raw
      // "signal is aborted" is both cryptic AND usually wrong.
      //
      // Recover by signing in with the very credentials just submitted. If the
      // aborted create did land, these are now valid and we carry straight
      // through — collapsing the "error → retry → user already exists → sign
      // in" dance the user otherwise does by hand into one seamless step. A
      // sign-in with those exact credentials only succeeds when that same
      // sign-up created the account, so it leaks nothing the user didn't type.
      if (isAbortError(err)) {
        try {
          const recovery = await authClient.signIn.email({ email, password });
          if (!recovery.error) {
            onInvalidateSurface?.();
            redirectAfterAuth();
            return;
          }
        } catch {
          // fall through to the human timeout message below
        }
      }
      // Either not an abort, or the create truly never happened. Re-enable the
      // form and surface a clean message — never the raw abort string.
      setBusy(false);
      setStage("form");
      notify?.(
        isAbortError(err)
          ? (copy.signUpTimedOut ?? copy.signUpFailed)
          : err instanceof Error
            ? err.message
            : copy.signUpFailed,
      );
      return;
    }
    if (res.error) {
      setBusy(false);
      setStage("form");
      notify?.(res.error.message ?? copy.signUpFailed);
      return;
    }

    onInvalidateSurface?.();

    if (enrollPasskey && passkeyOffered) {
      setStage("enrolling");
      try {
        const fn = authClient.passkey?.addPasskey;
        if (fn) {
          // Bounded: the account is already durable at this point, so a
          // ceremony that never settles must not be what decides whether the
          // person ever reaches the app. See `withWebAuthnDeadline`.
          const pk = await withWebAuthnDeadline(
            fn({
              name: name || email.split("@")[0] || "primary",
              authenticatorAttachment: "platform",
            }),
          );
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
          }. Add one in Settings → Passkeys.`,
        );
      }
    }

    if (requireVerify && !isFirst) {
      setStage("verify");
      setBusy(false);
      return;
    }

    redirectAfterAuth();
  };

  // Claim mode: don't paint anything until we know there's no session — the
  // common way to land here is the cloud panel's stale claim deep-link while
  // already signed in as the admin, and painting the "create admin" form for
  // the round-trip reads as a scary flash before the redirect to "/". Same
  // grace-window pattern as the admin AuthGate. `staleClaim` keeps the hold
  // through the sign-in redirect above. Once the probe is visibly slow we swap
  // the blank for a spinner so a stalled instance never looks like a dead black
  // screen (the effect's hard cap also releases the hold after 9s).
  if (claim && (!sessionChecked || staleClaim)) {
    if (!holdLoader) return null;
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2Icon
          className="size-6 animate-spin text-muted-foreground"
          aria-label="Loading"
        />
      </div>
    );
  }

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
              readOnly={Boolean(forcedEmail)}
              disabled={Boolean(forcedEmail)}
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
                        "h-[3px] flex-1 rounded-sm",
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

          {passkeyOffered && (
            <label className="flex cursor-pointer items-start gap-2 rounded-surface border border-primary/30 bg-primary/8 px-3 py-2.5 text-[12.5px]">
              <Checkbox
                checked={enrollPasskey}
                onCheckedChange={(v) => setEnrollPasskey(!!v)}
                className="mt-0.5"
              />
              <span className="flex-1">
                <span className="flex items-center gap-1.5 font-medium text-foreground">
                  <KeyRoundIcon className="size-3.5 text-primary" />
                  {copy.passkeyEnrol}
                  <span className="rounded-sm border border-primary/30 bg-card px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-primary">
                    {copy.passkeyRecommended}
                  </span>
                </span>
                <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                  {copy.passkeyDescription}
                </span>
              </span>
            </label>
          )}

          {showConsent && (
            <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-muted-foreground">
              <Checkbox
                checked={agreed}
                onCheckedChange={(v) => setAgreed(!!v)}
                className="mt-0.5"
              />
              <span>{copy.termsAgreement}</span>
            </label>
          )}

          <AuthSubmit
            type="submit"
            disabled={!email || !password || (showConsent && !agreed) || busy}
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
