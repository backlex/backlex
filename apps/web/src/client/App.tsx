import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { Toaster } from "@workeros/ui/components/sonner";
import { AuthGate } from "@/components/auth-gate";
import { AdminApp } from "@/admin/app";
import { auth } from "@/lib/auth";
import { Forgot } from "@/pages/forgot";
import { MagicLink } from "@/pages/magic-link";
import { SignIn } from "@/pages/sign-in";
import { SignUp } from "@/pages/sign-up";

const AUTH_ROUTES = new Set([
  "/sign-in",
  "/sign-up",
  "/magic-link",
  "/forgot",
]);

export const App = () => {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  if (AUTH_ROUTES.has(pathname)) {
    return (
      <>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/sign-up" element={<SignUp />} />
          <Route path="/magic-link" element={<MagicLink />} />
          <Route path="/forgot" element={<Forgot />} />
        </Routes>
        <Toaster richColors closeButton position="top-right" />
      </>
    );
  }
  const onSignOut = async () => {
    try {
      await auth.signOut();
    } catch {
      // ignore
    }
    navigate("/sign-in", { replace: true });
  };
  return (
    <AuthGate>
      <AdminApp onSignOut={onSignOut} />
      <Toaster richColors closeButton position="top-right" />
    </AuthGate>
  );
};
