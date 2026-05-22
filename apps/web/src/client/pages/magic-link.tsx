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
  AuthFootLink,
  AuthShell,
  AuthSubmit,
} from "@/components/auth-shell";
import { notifyError } from "@/lib/error";
import { auth } from "@/lib/auth";

interface MagicLinkClient {
  signIn: {
    magicLink?: (opts: {
      email: string;
      callbackURL?: string;
    }) => Promise<{ error?: { message?: string } }>;
  };
}

export const MagicLink = () => {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      const c = auth as unknown as MagicLinkClient;
      const fn = c.signIn.magicLink;
      if (!fn) {
        notifyError(t`Magic-link plugin not enabled on the server`);
        setBusy(false);
        return;
      }
      const res = await fn({ email, callbackURL: "/" });
      if (res?.error) {
        notifyError(res.error.message ?? t`Failed to send magic link`);
        setBusy(false);
        return;
      }
      setSent(true);
    } catch (err) {
      notifyError(err, t`Sending magic link`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell mode="magic">
      <AuthCard>
        <AuthCardHeader
          title={<Trans>Magic link</Trans>}
          description={<Trans>We'll email a single-use sign-in link. No password needed.</Trans>}
        />

        {sent ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-primary/50 bg-primary/12 p-4">
            <div className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
              <MailIcon size={18} />
            </div>
            <div className="text-sm font-medium"><Trans>Check your inbox</Trans></div>
            <div className="text-[12.5px] text-muted-foreground">
              <Trans>If <span className="font-mono">{email || t`your address`}</span>{" "}
              matches an account, a sign-in link is on its way. It expires in
              15 minutes.</Trans>
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSent(false)}
              >
                <Trans>Use a different email</Trans>
              </Button>
              <Button asChild type="button" variant="ghost" size="sm">
                <Link to="/sign-in"><Trans>Back to sign in</Trans></Link>
              </Button>
            </div>
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
              {busy ? <Trans>Sending…</Trans> : <Trans>Send link</Trans>}
            </AuthSubmit>
          </form>
        )}

        <AuthFootLink
          to="/sign-in"
          prefix={t`Prefer a password?`}
          label={t`Sign in`}
        />
      </AuthCard>
    </AuthShell>
  );
};
