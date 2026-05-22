import { Route, Routes, useNavigate } from "react-router-dom";
import { I18nProvider } from "@lingui/react";
import { Toaster } from "@workeros/ui/components/sonner";
import { i18n } from "@/admin/i18n";
import { AuthGate } from "@/components/auth-gate";
import { AdminApp } from "@/admin/app";
import { auth } from "@/lib/auth";
import { Forgot } from "@/pages/forgot";
import { ResetPassword } from "@/pages/reset-password";
import { MagicLink } from "@/pages/magic-link";
import { SharedRecord } from "@/pages/shared-record";
import { SignIn } from "@/pages/sign-in";
import { SignUp } from "@/pages/sign-up";

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
        {/* Public record-share view — outside AuthGate, no session needed. */}
        <Route path="/s/:token" element={<SharedRecord />} />
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
