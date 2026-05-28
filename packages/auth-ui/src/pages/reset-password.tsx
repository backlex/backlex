import { useState, type FormEvent, type ReactNode } from "react";
import { AlertTriangleIcon } from "lucide-react";
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

/** Copy strings the ResetPassword page needs. */
export interface ResetPasswordCopy {
  title: ReactNode;
  description: ReactNode;
  /** Invalid-link card. */
  invalidTitle: ReactNode;
  invalidDescription: ReactNode;
  requestNewLink: ReactNode;
  /** Form. */
  newPasswordLabel: ReactNode;
  confirmPasswordLabel: ReactNode;
  submit: ReactNode;
  submitBusy: ReactNode;
  /** Bottom link. */
  backLink: ReactNode;
  /** Errors. */
  passwordTooShort: string;
  passwordsDoNotMatch: string;
  notEnabled: string;
  resetFailed: string;
  resetContext: string;
}

export interface ResetPasswordPageProps extends AuthWiring {
  copy: ResetPasswordCopy;
  shellCopy: AuthShellCopy;
  branding: AuthBranding;
  surface?: AuthSurfaceFlags | null;
  appVersion?: string;
  themeToggle?: ReactNode;
}

/**
 * Password-reset screen — reads the `token` and optional `error` from the URL
 * via `searchParam`, posts to `authClient.resetPassword`, then redirects to
 * `/sign-in`. When the token is missing/invalid, renders an error card with a
 * "Request a new link" CTA pointing at `/forgot`.
 */
export const ResetPasswordPage = ({
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
}: ResetPasswordPageProps) => {
  const token = searchParam("token");
  const error = searchParam("error");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  const linkInvalid = !token || !!error;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (password.length < 8) {
      notify?.(copy.passwordTooShort);
      return;
    }
    if (password !== confirm) {
      notify?.(copy.passwordsDoNotMatch);
      return;
    }
    setBusy(true);
    try {
      const fn = authClient.resetPassword;
      if (!fn) {
        notify?.(copy.notEnabled);
        setBusy(false);
        return;
      }
      const res = await fn({ newPassword: password, token });
      if (res?.error) {
        notify?.(res.error.message ?? copy.resetFailed);
        setBusy(false);
        return;
      }
      navigate("/sign-in", { replace: true });
    } catch (err) {
      notify?.(
        err instanceof Error ? err.message : String(err),
        copy.resetContext,
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

        {linkInvalid ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 p-4">
            <div className="grid size-9 place-items-center rounded-full bg-destructive text-destructive-foreground">
              <AlertTriangleIcon size={18} />
            </div>
            <div className="text-sm font-medium">{copy.invalidTitle}</div>
            <div className="text-[12.5px] text-muted-foreground">
              {copy.invalidDescription}
            </div>
            <Button
              asChild
              type="button"
              variant="ghost"
              size="sm"
              className="self-start"
            >
              <Link to="/forgot">{copy.requestNewLink}</Link>
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="password">{copy.newPasswordLabel}</Label>
              <Input
                id="password"
                type="password"
                autoComplete="new-password"
                autoFocus
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="h-10"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="confirm">{copy.confirmPasswordLabel}</Label>
              <Input
                id="confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="••••••••"
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
