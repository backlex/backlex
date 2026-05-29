import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { auth } from "@/lib/auth";

type State = "checking" | "authed" | "anon";

interface SessionResp {
  data?: { session?: unknown } | null;
}

/**
 * Gates the admin layout — until we know the session state we render
 * nothing, then either show the children (signed in) or redirect to
 * /sign-in (signed out). Without this guard, the layout rendered eagerly
 * and every API call surfaced 401 toasts before the user was forced
 * through sign-in.
 *
 * Listens for `backlex:session-expired` so any 401 from `api()` can ask
 * the gate to recheck/redirect mid-session.
 */
export const AuthGate = ({ children }: { children: ReactNode }) => {
  const [state, setState] = useState<State>("checking");
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = (await auth.getSession()) as SessionResp;
        if (cancelled) return;
        const session = res?.data?.session;
        setState(session ? "authed" : "anon");
      } catch {
        if (!cancelled) setState("anon");
      }
    };
    void check();

    const onExpired = () => {
      setState("anon");
    };
    window.addEventListener("backlex:session-expired", onExpired);

    return () => {
      cancelled = true;
      window.removeEventListener("backlex:session-expired", onExpired);
    };
  }, []);

  if (state === "checking") {
    // The session check is fast — render nothing rather than flash a
    // full-screen loader before the layout (or the redirect) takes over.
    return null;
  }
  if (state === "anon") {
    const next = location.pathname + location.search;
    return (
      <Navigate
        to={`/sign-in${next && next !== "/" ? `?next=${encodeURIComponent(next)}` : ""}`}
        replace
      />
    );
  }
  return <>{children}</>;
};
