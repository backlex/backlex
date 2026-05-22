import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { MailIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Button } from "@workeros/ui/components/button";
import {
  AuthCard,
  AuthCardHeader,
  AuthShell,
  AuthSubmit,
} from "@/components/auth-shell";
import { notifyError } from "@/lib/error";
import { auth } from "@/lib/auth";

interface ForgetPasswordClient {
  forgetPassword?: (opts: {
    email: string;
    redirectTo?: string;
  }) => Promise<{ error?: { message?: string } }>;
}

export const Forgot = () => {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      const c = auth as unknown as ForgetPasswordClient;
      if (!c.forgetPassword) {
        notifyError(t`Password reset is not enabled on this instance`);
        setBusy(false);
        return;
      }
      const res = await c.forgetPassword({
        email,
        redirectTo: "/reset-password",
      });
      // For privacy, treat unknown emails as success (email enumeration
      // protection) — the server returns ok regardless.
      if (res?.error) {
        notifyError(res.error.message ?? t`Failed to send reset link`);
        setBusy(false);
        return;
      }
      setSent(true);
    } catch (err) {
      notifyError(err, t`Sending reset link`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell mode="forgot">
      <AuthCard>
        <AuthCardHeader
          title={<Trans>Reset your password</Trans>}
          description={<Trans>Enter the email you signed up with — we'll send a reset link.</Trans>}
        />

        {sent ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-primary/50 bg-primary/12 p-4">
            <div className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
              <MailIcon size={18} />
            </div>
            <div className="text-sm font-medium"><Trans>Reset link sent</Trans></div>
            <div className="text-[12.5px] text-muted-foreground">
              <Trans>Click the link in your inbox to set a new password. The token
              expires in 1 hour. Your existing password still works in the
              meantime.</Trans>
            </div>
            <Button asChild type="button" variant="ghost" size="sm" className="self-start">
              <Link to="/sign-in"><Trans>Back to sign in</Trans></Link>
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="email"><Trans>Email</Trans></Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t`you@example.com`}
                className="h-10"
              />
            </div>

            <AuthSubmit type="submit" disabled={busy}>
              {busy ? <Trans>Sending…</Trans> : <Trans>Send reset link</Trans>}
            </AuthSubmit>
          </form>
        )}

        <p className="text-center text-[12.5px] text-muted-foreground">
          <Link
            to="/sign-in"
            className="font-medium text-foreground hover:underline"
          >
            <Trans>← Back to sign in</Trans>
          </Link>
        </p>
      </AuthCard>
    </AuthShell>
  );
};
