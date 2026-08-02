import { Route, Routes, useNavigate } from "react-router";
import { I18nProvider } from "@lingui/react";
import { Toaster } from "@backlex/ui/components/sonner";
import { i18n } from "@/admin/i18n";
import { AuthGate } from "@/components/auth-gate";
import { AdminApp } from "@/admin/app";
import { auth } from "@/lib/auth";
import { Forgot } from "@/pages/forgot";
import { ResetPassword } from "@/pages/reset-password";
import { MagicLink } from "@/pages/magic-link";
import { SharedRecord } from "@/pages/shared-record";
import { EmbedDashboard } from "@/pages/embed-dashboard";
import { PublicForm } from "@/pages/public-form";
import { Book, ManageBooking } from "@/pages/book";
import { SignDocument } from "@/pages/sign-document";
import { SignIn } from "@/pages/sign-in";
import { SignUp } from "@/pages/sign-up";
import { Invite } from "@/pages/invite";
import { OAuthConsent } from "@/pages/oauth-consent";

export const App = () => {
  const navigate = useNavigate();
  const onSignOut = async () => {
    try {
      await auth.signOut();
    } catch {
      // ignore
    }
    navigate("/sign-in", { replace: true });
  };
  return (
    <I18nProvider i18n={i18n}>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/sign-up" element={<SignUp />} />
        <Route path="/magic-link" element={<MagicLink />} />
        <Route path="/forgot" element={<Forgot />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        {/* Public invite-acceptance — outside AuthGate; the invitee has no
            account yet. Resolves the token, then signs up + binds membership. */}
        <Route path="/invite" element={<Invite />} />
        {/* MCP OAuth consent — outside AuthGate so it renders the auth shell;
            the flow only lands here with a live session (authorize redirects
            unauthenticated users to /sign-in first). */}
        <Route path="/oauth/consent" element={<OAuthConsent />} />
        {/* Public record-share view — outside AuthGate, no session needed. */}
        <Route path="/s/:token" element={<SharedRecord />} />
        {/* Public BI dashboard embed — outside AuthGate; iframe-friendly. */}
        <Route path="/embed/d/:token" element={<EmbedDashboard />} />
        {/* Public form — outside AuthGate; /embed variant is iframe-friendly. */}
        <Route path="/f/:token" element={<PublicForm />} />
        <Route path="/embed/f/:token" element={<PublicForm embed />} />
        {/* Public signing page — outside AuthGate; the signer has no account
            and the link token is the whole grant. */}
        <Route path="/sign/:token" element={<SignDocument />} />
        {/* Public booking — outside AuthGate for the same reason: the page
            token is the grant to see a calendar, and the manage token the
            grant to change one appointment.

            The manage page lives at `/b/`, NOT at `/booking/`, even though
            `booking` is the admin nav id it would otherwise pair with. The
            admin router reads `segs[1]` as a sub-route (as `collections` and
            `flows` already do), so a future `/booking/<id>` detail view would
            be swallowed by this route instead. A short prefix is also kinder
            in an email. */}
        <Route path="/book/:token" element={<Book />} />
        <Route path="/b/:token" element={<ManageBooking />} />
        <Route
          path="/*"
          element={
            <AuthGate>
              <AdminApp onSignOut={onSignOut} />
            </AuthGate>
          }
        />
      </Routes>
      <Toaster richColors closeButton position="top-right" />
    </I18nProvider>
  );
};
