import { useState, type FormEvent, type ReactNode } from "react";
import { MailIcon } from "lucide-react";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import { Button } from "@backlex/ui/components/button";
import {
  AuthCard,
  AuthCardHeader,
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

/** Copy strings the MagicLink page needs (besides the shared shell copy). */
export interface MagicLinkCopy {
  title: ReactNode;
  description: ReactNode;
  /** Card after the link is sent. `displayEmail` is the user-typed email (or
   *  the `yourAddress` fallback string when empty). */
  sentTitle: ReactNode;
  sentBody: (displayEmail: ReactNode) => ReactNode;
  yourAddress: string;
  /** Buttons inside the success card. */
  useDifferentEmail: ReactNode;
  backToSignIn: ReactNode;
  /** Form. */
  emailLabel: ReactNode;
  emailPlaceholder: string;
  submit: ReactNode;
  submitBusy: ReactNode;
  /** Foot link prefix + label. */
  footPrefix: string;
  footLabel: string;
  /** Errors. */
  notEnabled: string;
  sendFailed: string;
  sendContext: string;
}

export interface MagicLinkPageProps extends AuthWiring {
  copy: MagicLinkCopy;
  shellCopy: AuthShellCopy;
  branding: AuthBranding;
  surface?: AuthSurfaceFlags | null;
  appVersion?: string;
  themeToggle?: ReactNode;
}

/**
 * Magic-link sign-in screen — calls `authClient.signIn.magicLink` and parks
 * the user on a success card while the email is on its way.
 */
export const MagicLinkPage = ({
  authClient,
  Link,
  notify,
  copy,
  shellCopy,
  branding,
  surface,
  appVersion,
  themeToggle,
}: MagicLinkPageProps) => {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      const fn = authClient.signIn.magicLink;
      if (!fn) {
        notify?.(copy.notEnabled);
        setBusy(false);
        return;
      }
      const res = await fn({ email, callbackURL: "/" });
      if (res?.error) {
        notify?.(res.error.message ?? copy.sendFailed);
        setBusy(false);
        return;
      }
      setSent(true);
    } catch (err) {
      notify?.(
        err instanceof Error ? err.message : String(err),
        copy.sendContext,
      );
    } finally {
      setBusy(false);
    }
  };

  const displayEmail: ReactNode = email ? (
    <span className="font-mono">{email}</span>
  ) : (
    <span className="font-mono">{copy.yourAddress}</span>
  );

  return (
    <AuthShell
      mode="magic"
      branding={branding}
      copy={shellCopy}
      surface={surface}
      appVersion={appVersion}
      Link={Link}
      themeToggle={themeToggle}
    >
      <AuthCard>
        <AuthCardHeader title={copy.title} description={copy.description} />

        {sent ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-primary/50 bg-primary/12 p-4">
            <div className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
              <MailIcon size={18} />
            </div>
            <div className="text-sm font-medium">{copy.sentTitle}</div>
            <div className="text-[12.5px] text-muted-foreground">
              {copy.sentBody(displayEmail)}
            </div>
            <div className="mt-2 flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSent(false)}
              >
                {copy.useDifferentEmail}
              </Button>
              <Button asChild type="button" variant="ghost" size="sm">
                <Link to="/sign-in">{copy.backToSignIn}</Link>
              </Button>
            </div>
          </div>
        ) : (
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

            <AuthSubmit type="submit" disabled={busy}>
              {busy ? copy.submitBusy : copy.submit}
            </AuthSubmit>
          </form>
        )}

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
