import { useEffect, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { auth } from "@/lib/auth";

type State = "checking" | "authed" | "anon";

interface SessionResp {
  data?: { session?: unknown } | null;
}

/**
 * Gates the admin layout — until we know the session state we render a
 * minimal full-screen loader, then either show the children (signed in) or
 * redirect to /sign-in (signed out). Without this guard, the layout
 * rendered eagerly and every API call surfaced 401 toasts before the user
 * was forced through sign-in.
 *
 * Listens for `workeros:session-expired` so any 401 from `api()` can ask
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
    window.addEventListener("workeros:session-expired", onExpired);

    return () => {
      cancelled = true;
      window.removeEventListener("workeros:session-expired", onExpired);
    };
  }, []);

  if (state === "checking") {
    // Minimal full-screen placeholder while the session resolves — a small
    // skeleton card stands in for the workspace tile that's about to mount.
    return (
      <div className="grid min-h-svh place-items-center bg-background">
        <div className="flex w-64 flex-col items-center gap-3">
          <Skeleton className="size-9 rounded-xl" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    );
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
