import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { MailIcon } from "lucide-react";
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
        notifyError("Password reset is not enabled on this instance");
        setBusy(false);
        return;
      }
      const res = await c.forgetPassword({
        email,
        redirectTo: "/sign-in",
      });
      // For privacy, treat unknown emails as success (email enumeration
      // protection) — the server returns ok regardless.
      if (res?.error) {
        notifyError(res.error.message ?? "Failed to send reset link");
        setBusy(false);
        return;
      }
      setSent(true);
    } catch (err) {
      notifyError(err, "Sending reset link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell mode="forgot">
      <AuthCard>
        <AuthCardHeader
          title="Reset your password"
          description="Enter the email you signed up with — we'll send a reset link."
        />

        {sent ? (
          <div className="flex flex-col gap-2 rounded-2xl border border-primary/50 bg-primary/12 p-4">
            <div className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground">
              <MailIcon size={18} />
            </div>
            <div className="text-sm font-medium">Reset link sent</div>
            <div className="text-[12.5px] text-muted-foreground">
              Click the link in your inbox to set a new password. The token
              expires in 1 hour. Your existing password still works in the
              meantime.
            </div>
            <Button asChild type="button" variant="ghost" size="sm" className="self-start">
              <Link to="/sign-in">Back to sign in</Link>
            </Button>
          </div>
        ) : (
          <form className="space-y-4" onSubmit={submit}>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="h-10"
              />
            </div>

            <AuthSubmit type="submit" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
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
