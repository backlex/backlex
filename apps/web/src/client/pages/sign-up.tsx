import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { KeyRoundIcon, MailCheckIcon, ShieldIcon } from "lucide-react";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Checkbox } from "@workeros/ui/components/checkbox";
import {
  AuthCallout,
  AuthCard,
  AuthCardHeader,
  AuthDivider,
  AuthFootLink,
  AuthShell,
  AuthSubmit,
} from "@/components/auth-shell";
import { SocialButtons, useHasSocialProviders } from "@/components/social-buttons";
import { notifyError } from "@/lib/error";
import { auth, invalidateAuthSurface, useAuthSurface } from "@/lib/auth";
import { cn } from "@workeros/ui/lib/utils";

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

interface PasskeyClient {
  passkey?: {
    addPasskey?: (opts: {
      name: string;
      authenticatorAttachment?: "platform" | "cross-platform";
    }) => Promise<{ error?: { message?: string } }>;
  };
}

export const SignUp = () => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  // Computed once on mount — `passkeysSupported()` is environment-stable.
  const [supportsPasskey] = useState(() => passkeysSupported());
  const [enrollPasskey, setEnrollPasskey] = useState(supportsPasskey);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<
    "form" | "creating" | "enrolling" | "verify"
  >("form");
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { surface } = useAuthSurface();
  const hasSocials = useHasSocialProviders();

  // The server is the source of truth — `?claim=1` only matters when the
  // instance still has zero users. Anyone landing on the link after an
  // admin exists gets the normal sign-up copy.
  const isFirst = surface?.firstUserMode === true && params.get("claim") === "1";
  const openSignup = surface ? surface.policy.openSignup !== false : true;
  const requireVerify = surface
    ? surface.policy.requireEmailVerification !== false
    : false;
  // Block the form when sign-up is closed AND we're not bootstrapping the
  // first admin. While the surface is still loading, render normally so the
  // form doesn't flash an error before we know the policy.
  const blocked = surface != null && !openSignup && !isFirst;

  useEffect(() => {
    let cancelled = false;
    auth
      .getSession()
      .then((res) => {
        if (cancelled) return;
        const session = (res as { data?: { session?: unknown } })?.data?.session;
        if (session) navigate("/", { replace: true });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const strength = useMemo(() => computeStrength(password), [password]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email || !password || !agreed) return;
    setBusy(true);
    setStage("creating");

    const res = await auth.signUp.email({ email, password, name });
    if (res.error) {
      setBusy(false);
      setStage("form");
      notifyError(res.error.message ?? "Sign-up failed");
      return;
    }

    // Invalidate the cached surface so the next render picks up
    // `firstUserMode = false` (the page just consumed the claim).
    invalidateAuthSurface();

    // Optional passkey enrolment in the same flow. signUp.email sets the
    // session cookie, so addPasskey runs as the freshly-created user.
    if (enrollPasskey && supportsPasskey) {
      setStage("enrolling");
      try {
        const c = auth as unknown as PasskeyClient;
        const fn = c.passkey?.addPasskey;
        if (fn) {
          const pk = await fn({
            name: name || email.split("@")[0] || "primary",
            authenticatorAttachment: "platform",
          });
          if (pk?.error) {
            // Account is created; surface but don't block redirect.
            notifyError(
              `Account created but passkey enrolment failed: ${
                pk.error.message ?? "unknown"
              }. Add one in Settings → Passkeys.`,
            );
          }
        }
      } catch (err) {
        notifyError(
          `Account created. Passkey enrolment skipped: ${
            (err as Error).message ?? "cancelled"
          }`,
        );
      }
    }

    // When email verification is required AND we're not the first user
    // (the first user is auto-admin and skips verification), park them on
    // a "check your inbox" panel instead of redirecting into a 401 loop.
    if (requireVerify && !isFirst) {
      setStage("verify");
      setBusy(false);
      return;
    }

    window.location.href = "/";
  };

  if (blocked) {
    return (
      <AuthShell mode="sign-up">
        <AuthCard>
          <AuthCardHeader
            title="Sign-up is disabled"
            description="An admin has turned off public sign-up for this instance. Ask for an invite, or sign in if you already have an account."
          />
          <AuthCallout icon={<ShieldIcon size={16} />}>
            <strong>Closed instance.</strong> Set{" "}
            <span className="font-mono">openSignup</span> to <em>true</em> in
            admin → Auth Settings to re-open.
          </AuthCallout>
          <AuthFootLink to="/sign-in" prefix="Have an account?" label="Sign in" />
        </AuthCard>
      </AuthShell>
    );
  }

  if (stage === "verify") {
    return (
      <AuthShell mode="sign-up">
        <AuthCard>
          <AuthCardHeader
            title="Check your inbox"
            description={`We sent a verification link to ${email}. Click it to finish creating your account.`}
          />
          <AuthCallout icon={<MailCheckIcon size={16} />}>
            <strong>Verification required.</strong> Until you confirm your
            email, sign-in won't work. Didn't get it? Check spam, or wait a
            minute and try sign-in — we'll re-send on demand.
          </AuthCallout>
          <AuthFootLink to="/sign-in" prefix="Already verified?" label="Sign in" />
        </AuthCard>
      </AuthShell>
    );
  }

  return (
    <AuthShell mode={isFirst ? "claim" : "sign-up"}>
      <AuthCard>
        <AuthCardHeader
          title={isFirst ? "Create your admin account" : "Create an account"}
          description={
            isFirst
              ? "This is the first user on this instance."
              : "You'll get the authenticated role by default."
          }
        />

        {isFirst && (
          <AuthCallout icon={<ShieldIcon size={16} />}>
            <strong>First-user policy.</strong> The first account on a fresh
            instance is provisioned as{" "}
            <span className="font-mono">admin</span> automatically. You can
            demote yourself later.
          </AuthCallout>
        )}

        <SocialButtons />

        {hasSocials && <AuthDivider>or with email</AuthDivider>}

        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="name" className="flex items-center gap-1">
              Display name{" "}
              <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="name"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Rana"
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="h-10"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
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
              Hashed with argon2id · stored in{" "}
              <span className="font-mono">users.password_hash</span>.
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
                  Enrol a passkey now
                  <span className="rounded-md border border-primary/30 bg-card px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wide text-primary">
                    recommended
                  </span>
                </span>
                <span className="mt-0.5 block text-[11.5px] text-muted-foreground">
                  Faster, phishing-resistant sign-in. Your device will prompt
                  for biometric or PIN after the account is created. You can
                  add or remove passkeys later in Settings.
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
            <span>
              I agree to the{" "}
              <span className="font-medium text-foreground">Terms</span> and{" "}
              <span className="font-medium text-foreground">Privacy</span>.
            </span>
          </label>

          <AuthSubmit
            type="submit"
            disabled={!email || !password || !agreed || busy}
          >
            {stage === "enrolling"
              ? "Setting up passkey…"
              : stage === "creating"
                ? isFirst
                  ? "Claiming…"
                  : "Creating account…"
                : isFirst
                  ? "Claim this instance"
                  : "Create account"}
          </AuthSubmit>
        </form>

        <AuthFootLink
          to="/sign-in"
          prefix="Already have an account?"
          label="Sign in"
        />
      </AuthCard>
    </AuthShell>
  );
};
