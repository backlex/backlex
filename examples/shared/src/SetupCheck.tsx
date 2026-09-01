import { type ReactNode, useEffect, useState } from "react";
import type { BacklexClient } from "backlex";
import { ENV, type EnvSpec, WORKSPACE } from "./env";

type Phase =
  | { kind: "checking" }
  | { kind: "env-missing" }
  | { kind: "unreachable"; detail: string }
  | { kind: "ok" };

/**
 * Gate that renders `children` only once the example is correctly configured.
 *
 * Otherwise it says exactly which env var to set (and why), or that the
 * backend/workspace is not reachable — so a misconfigured `.env` explains
 * itself instead of showing a blank screen.
 *
 * The client is a PROP rather than an import: each example builds its own,
 * against its own workspace, and a shared component that reached for one
 * particular app's module would only be shareable by accident.
 */
export function SetupCheck({
  client,
  extraEnv = [],
  children,
}: {
  client: BacklexClient;
  /** Variables only THIS example reads, listed alongside the shared ones. The
   *  shared list stays a description of what every example needs; an example
   *  with a demo of its own says so here rather than widening it for
   *  everybody. */
  extraEnv?: EnvSpec[];
  children: ReactNode;
}) {
  const env = [...ENV, ...extraEnv];
  const [phase, setPhase] = useState<Phase>({ kind: "checking" });
  // Env values are replaced at build time, so "is anything required missing"
  // has one answer for the life of the page. Computed outside the effect so
  // the effect depends on the client alone.
  const envIncomplete = env.some((e) => e.required && !e.value);

  useEffect(() => {
    if (envIncomplete) {
      setPhase({ kind: "env-missing" });
      return;
    }
    // Env looks complete — confirm the API is reachable and the workspace
    // exists by reading its public auth surface (no credentials needed).
    let cancelled = false;
    client.auth
      .providers()
      .then(() => {
        if (!cancelled) setPhase({ kind: "ok" });
      })
      .catch((e) => {
        if (!cancelled)
          setPhase({ kind: "unreachable", detail: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [client, envIncomplete]);

  if (phase.kind === "ok") return <>{children}</>;
  if (phase.kind === "checking") return <Center>Checking configuration…</Center>;

  return (
    <Center>
      <div className="w-full max-w-lg space-y-4 rounded-surface border border-warn/40 bg-warn/10 p-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink">
          {phase.kind === "env-missing" ? "Finish the setup" : "Can't reach the backend"}
        </h1>

        {phase.kind === "unreachable" && (
          <p className="text-sm text-ink-muted">
            The API didn't answer for workspace{" "}
            <code className="rounded-sm bg-warn/15 px-1 font-mono text-[0.9em]">{WORKSPACE || "(unset)"}</code>. Is{" "}
            <code className="rounded-sm bg-warn/15 px-1 font-mono text-[0.9em]">bun run dev</code> running at the repo root,
            and does that workspace exist? <br />
            <span className="text-warn">({phase.detail})</span>
          </p>
        )}

        <ul className="space-y-3">
          {env.map((e) => {
            const ok = !!e.value;
            const blocking = e.required && !ok;
            return (
              <li key={e.key} className="text-sm">
                <div className="flex items-center gap-2">
                  <span
                    className={
                      "inline-block size-2 rounded-full " +
                      (ok ? "bg-ok" : e.required ? "bg-bad" : "bg-ink-dim")
                    }
                  />
                  <code className="font-medium">{e.key}</code>
                  <span className="text-ink-dim">{e.required ? "(required)" : "(optional)"}</span>
                  {blocking && <span className="text-bad">— not set</span>}
                </div>
                <p className="ml-4 text-ink-muted">{e.description}</p>
                <p className="ml-4 text-ink-dim">
                  e.g. <code>{e.example}</code>
                </p>
              </li>
            );
          })}
        </ul>

        <p className="text-sm text-ink-muted">
          Set these in <code className="rounded-sm bg-warn/15 px-1 font-mono text-[0.9em]">.env</code> (copy{" "}
          <code className="rounded-sm bg-warn/15 px-1 font-mono text-[0.9em]">.env.example</code>), then restart{" "}
          <code className="rounded-sm bg-warn/15 px-1 font-mono text-[0.9em]">bun run dev</code>. Full steps are in this
          folder's <code>README.md</code>.
        </p>
      </div>
    </Center>
  );
}

function Center({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-surface p-6 text-ink">
      {children}
    </div>
  );
}
