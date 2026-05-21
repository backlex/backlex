import { useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { AlertTriangleIcon } from "lucide-react";
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

interface ResetPasswordClient {
  resetPassword?: (opts: {
    newPassword: string;
    token: string;
  }) => Promise<{ error?: { message?: string } }>;
}

export const ResetPassword = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get("token");
  const error = params.get("error");

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  // The emailed link is bad — no token, or better-auth bounced back an error.
  const linkInvalid = !token || !!error;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (password.length < 8) {
      notifyError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      notifyError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      const c = auth as unknown as ResetPasswordClient;
      if (!c.resetPassword) {
        notifyError("Password reset is not enabled on this instance");
        setBusy(false);
        return;
      }
      const res = await c.resetPassword({ newPassword: password, token });
      if (res?.error) {
        notifyError(res.error.message ?? "Failed to reset password");
        setBusy(false);
        return;
      }
      navigate("/sign-in", { replace: true });
    } catch (err) {
      notifyError(err, "Resetting password");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell mode="forgot">
      <AuthCard>
        <AuthCardHeader
          title="Choose a new password"
          description="Set a new password for your account — at least 8 characters."
        />

        {linkInvalid ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-destructive/40 bg-destructive/10 p-4">
            <div className="grid size-9 place-items-center rounded-full bg-destructive text-destructive-foreground">
              <AlertTriangleIcon size={18} />
            </div>
            <div className="text-sm font-medium">Reset link invalid</div>
            <div className="text-[12.5px] text-muted-foreground">
              This password reset link is missing its token or has expired.
              Request a new one and try again.
            </div>
            <Button asChild type="button" variant="ghost" size="sm" className="self-start">
              <Link to="/forgot">Request a new link</Link>
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="password">New password</Label>
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
              <Label htmlFor="confirm">Confirm password</Label>
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
              {busy ? "Saving…" : "Set new password"}
            </AuthSubmit>
          </form>
        )}

        <p className="text-center text-[12.5px] text-muted-foreground">
          <Link
            to="/sign-in"
            className="font-medium text-foreground hover:underline"
          >
            ← Back to sign in
          </Link>
        </p>
      </AuthCard>
    </AuthShell>
  );
};
