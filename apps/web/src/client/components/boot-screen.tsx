import { Trans } from "@lingui/react/macro";
import { CosmosStars } from "./cosmos-stars";

/**
 * Full-screen cosmos boot screen shown by <AuthGate> while the session check
 * is in flight (`connecting`) or after it has stalled past the timeout
 * (`unreachable`). Reuses the admin's <CosmosStars> backdrop so a slow/degraded
 * instance boots into the branded starfield instead of a bare black void.
 *
 * The container paints its own #06050d cosmos base (not relying on `html.dark`)
 * so it reads correctly under any theme — a brief full-screen takeover during
 * boot is intentional and consistent light or dark.
 */
export function BootScreen({
  variant,
  onRetry,
}: {
  variant: "connecting" | "unreachable";
  onRetry?: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden"
      style={{
        backgroundColor: "#06050d",
        backgroundImage:
          "radial-gradient(1200px 800px at 78% -5%, rgba(124, 92, 255, 0.16), transparent 60%), radial-gradient(900px 700px at 10% 8%, rgba(255, 122, 89, 0.07), transparent 55%)",
      }}
    >
      <CosmosStars />
      <div
        className="relative z-10 mx-4 w-full max-w-sm rounded-surface border border-white/10 p-8 text-center shadow-2xl"
        style={{ background: "rgba(12, 10, 22, 0.6)", backdropFilter: "blur(20px)" }}
      >
        {variant === "connecting" ? (
          <>
            <div
              aria-hidden="true"
              className="mx-auto mb-5 h-8 w-8 animate-spin rounded-full border-2 border-white/15"
              style={{ borderTopColor: "rgba(179, 156, 255, 0.9)" }}
            />
            <p className="text-sm font-medium text-white/90">
              <Trans>Connecting to your workspace…</Trans>
            </p>
            <p className="mt-1.5 text-xs text-white/45">
              <Trans>One moment while we get things ready.</Trans>
            </p>
          </>
        ) : (
          <>
            <div
              aria-hidden="true"
              className="mx-auto mb-5 flex h-9 w-9 items-center justify-center rounded-full"
              style={{
                background: "rgba(255, 122, 89, 0.14)",
                border: "1px solid rgba(255, 122, 89, 0.35)",
                color: "rgb(255, 148, 120)",
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 8v5m0 3h.01"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <p className="text-sm font-medium text-white/90">
              <Trans>Can't reach your workspace</Trans>
            </p>
            <p className="mt-1.5 text-xs leading-relaxed text-white/45">
              <Trans>
                This usually clears on its own in a moment. We'll keep trying
                automatically.
              </Trans>
            </p>
            {onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="mt-5 inline-flex items-center justify-center rounded-control px-4 py-2 text-sm font-medium text-white transition-colors"
                style={{ background: "rgba(139, 108, 255, 0.9)" }}
              >
                <Trans>Try again</Trans>
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
