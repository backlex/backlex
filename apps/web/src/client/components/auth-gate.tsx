import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { auth } from "@/lib/auth";
import { BootScreen } from "./boot-screen";

type Phase = "checking" | "slow" | "unreachable" | "authed" | "anon";

interface SessionResp {
  data?: { session?: unknown } | null;
}

/**
 * Show the cosmos "connecting" screen only once the check is visibly slow, so
 * the common fast path never flashes a loader. Escalate to the "unreachable"
 * retry screen when the session endpoint stalls (e.g. a transient D1 outage on
 * the instance) instead of leaving a bare black void — then keep retrying so a
 * recovered backend lands the user in without a manual refresh.
 */
const SLOW_MS = 700;
const TIMEOUT_MS = 9000;
const RETRY_MS = 6000;

/**
 * Gates the admin layout — until we know the session state we render nothing
 * (brief grace window), then either show the children (signed in) or redirect
 * to /sign-in (signed out). Without this guard, the layout rendered eagerly and
 * every API call surfaced 401 toasts before the user was forced through
 * sign-in.
 *
 * The session check has no hard timeout of its own (better-auth's `getSession`
 * doesn't take a signal), so a hung `/api/auth/get-session` — the exact shape
 * of a transient instance-DB outage — used to leave the gate stuck rendering
 * `null` (a black screen) across every refresh. We now surface a branded
 * cosmos boot screen once the check is slow and an auto-retrying "unreachable"
 * screen once it stalls, so a backend blip degrades gracefully instead of
 * looking like a hard crash.
 *
 * Listens for `backlex:session-expired` so any 401 from `api()` can ask the
 * gate to recheck/redirect mid-session.
 */
export const AuthGate = ({ children }: { children: ReactNode }) => {
  const [phase, setPhase] = useState<Phase>("checking");
  const location = useLocation();
  // Monotonic attempt id so a stale in-flight getSession (which we can't abort)
  // can't clobber the state once a newer attempt has taken over.
  const attemptRef = useRef(0);
  const timersRef = useRef<number[]>([]);

  const clearTimers = () => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
  };

  const runCheck = useCallback(() => {
    const attempt = ++attemptRef.current;
    clearTimers();
    // Reveal the connecting screen only if still pending after the grace
    // window; escalate to the retry screen if it stalls past the timeout.
    timersRef.current.push(
      window.setTimeout(() => setPhase((p) => (p === "checking" ? "slow" : p)), SLOW_MS),
    );
    timersRef.current.push(
      window.setTimeout(() => {
        setPhase((p) => (p === "checking" || p === "slow" ? "unreachable" : p));
        // Auto-retry on a cadence so a recovered backend lets the user through
        // without touching the page.
        timersRef.current.push(window.setTimeout(() => runCheck(), RETRY_MS));
      }, TIMEOUT_MS),
    );

    void (async () => {
      try {
        const res = (await auth.getSession()) as SessionResp;
        if (attempt !== attemptRef.current) return; // superseded by a newer attempt
        clearTimers();
        setPhase(res?.data?.session ? "authed" : "anon");
      } catch {
        if (attempt !== attemptRef.current) return;
        clearTimers();
        setPhase("anon");
      }
    })();
  }, []);

  useEffect(() => {
    runCheck();
    const onExpired = () => {
      attemptRef.current++; // invalidate any in-flight check
      clearTimers();
      setPhase("anon");
    };
    window.addEventListener("backlex:session-expired", onExpired);
    return () => {
      attemptRef.current++; // invalidate on unmount
      clearTimers();
      window.removeEventListener("backlex:session-expired", onExpired);
    };
  }, [runCheck]);

  if (phase === "checking") {
    // Grace window — render nothing rather than flash a loader before the
    // layout (or the redirect) takes over on the fast path.
    return null;
  }
  if (phase === "slow") {
    return <BootScreen variant="connecting" />;
  }
  if (phase === "unreachable") {
    return (
      <BootScreen
        variant="unreachable"
        onRetry={() => {
          setPhase("slow");
          runCheck();
        }}
      />
    );
  }
  if (phase === "anon") {
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
