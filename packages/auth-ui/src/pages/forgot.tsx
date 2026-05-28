import { useState, type FormEvent, type ReactNode } from "react";
import { MailIcon } from "lucide-react";
import { Input } from "@workeros/ui/components/input";
import { Label } from "@workeros/ui/components/label";
import { Button } from "@workeros/ui/components/button";
import {
  AuthCard,
  AuthCardHeader,
  AuthShell,
  AuthSubmit,
} from "../components/auth-shell";
import type {
  AuthBranding,
  AuthShellCopy,
  AuthSurfaceFlags,
  AuthWiring,
} from "../types";

/** Copy strings the Forgot page needs (besides the shared shell copy). */
export interface ForgotCopy {
  title: ReactNode;
  description: ReactNode;
  /** Card after the link is sent. */
  sentTitle: ReactNode;
  sentDescription: ReactNode;
  backToSignIn: ReactNode;
  /** Form. */
  emailLabel: ReactNode;
  emailPlaceholder: string;
  submit: ReactNode;
  submitBusy: ReactNode;
  /** Bottom link. */
  backLink: ReactNode;
  /** Errors. */
  notEnabled: string;
  sendFailed: string;
  sendContext: string;
}

export interface ForgotPageProps extends AuthWiring {
  copy: ForgotCopy;
  shellCopy: AuthShellCopy;
  branding: AuthBranding;
  surface?: AuthSurfaceFlags | null;
  appVersion?: string;
  themeToggle?: ReactNode;
}

/**
 * "Forgot your password?" screen — calls `authClient.forgetPassword`. The
 * server side enforces email-enumeration protection (any email = "sent"),
 * so the success card renders on the client without leaking existence.
 */
export const ForgotPage = ({
  authClient,
  Link,
  notify,
  copy,
  shellCopy,
  branding,
  surface,
  appVersion,
  themeToggle,
}: ForgotPageProps) => {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    try {
      const fn = authClient.forgetPassword;
      if (!fn) {
        notify?.(copy.notEnabled);
        setBusy(false);
        return;
      }
      const res = await fn({
        email,
        redirectTo: "/reset-password",
      });
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

  return (
    <AuthShell
      mode="forgot"
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
              {copy.sentDescription}
            </div>
            <Button
              asChild
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
            >
              <Link to="/sign-in">{copy.backToSignIn}</Link>
            </Button>
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

        <p className="text-center text-[12.5px] text-muted-foreground">
          <Link
            to="/sign-in"
            className="font-medium text-foreground hover:underline"
          >
            {copy.backLink}
          </Link>
        </p>
      </AuthCard>
    </AuthShell>
  );
};
