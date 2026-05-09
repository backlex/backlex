import { Route, Routes, useNavigate } from "react-router-dom";
import { Toaster } from "@workeros/ui/components/sonner";
import { AuthGate } from "@/components/auth-gate";
import { AdminApp } from "@/admin/app";
import { auth } from "@/lib/auth";
import { Forgot } from "@/pages/forgot";
import { MagicLink } from "@/pages/magic-link";
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
    <>
      <Routes>
        <Route path="/sign-in" element={<SignIn />} />
        <Route path="/sign-up" element={<SignUp />} />
        <Route path="/magic-link" element={<MagicLink />} />
        <Route path="/forgot" element={<Forgot />} />
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
    </>
  );
};
