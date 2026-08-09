// Row-level security — this workspace's permission rules, pushed into Postgres.
//
// The card leads with the two sentences an operator has to believe before they
// press the button: applying cannot change anything the API does (row security
// exempts the table owner, and backlex is the owner), and it only affects other
// connections. Everything else on the card is consequences.
//
// The omissions list is not a footnote. It is the parts of the model a policy
// cannot carry, and an operator who applies without reading it walks away
// believing the database enforces something it does not — so it renders as a
// warning block, above the statements, not below them.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { rlsApi, type RlsPlanResult, type RlsStatusResult } from "../../api";
import { fetchSafely } from "../_shared";

export function RlsCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [status, setStatus] = useState<RlsStatusResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [plan, setPlan] = useState<RlsPlanResult | null>(null);
  const [busy, setBusy] = useState<"plan" | "apply" | "disable" | null>(null);

  const load = async () => {
    const res = await fetchSafely<RlsStatusResult>("/api/admin/rls/status");
    setStatus(res ?? null);
    setLoaded(true);
  };

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<RlsStatusResult>("/api/admin/rls/status");
      if (!live) return;
      setStatus(res ?? null);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const showPlan = async () => {
    setBusy("plan");
    try {
      setPlan(await rlsApi.plan());
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    setBusy("apply");
    try {
      const res = await rlsApi.apply();
      pushToast(t`${res.applied} policies installed across ${res.tables.length} tables.`);
      setPlan(null);
      await load();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const disable = async () => {
    setBusy("disable");
    try {
      const res = await rlsApi.disable();
      pushToast(t`${res.dropped} policies removed.`);
      setPlan(null);
      await load();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const omissions = plan?.omissions ?? status?.omissions ?? [];
  const drifted = (status?.stale.length ?? 0) + (status?.missing.length ?? 0);

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-col gap-2 border-b border-border px-4 py-3.5 sm:flex-row sm:items-center">
        <div className="flex min-w-0 items-center gap-2">
          <I.Shield size={13} />
          <span className="text-[13px] font-medium">
            <Trans>Row-level security</Trans>
          </span>
          {status?.supported && status.installed.length > 0 && (
            <Badge variant="default">{t`${status.installed.length} policies`}</Badge>
          )}
          {drifted > 0 && (
            <Badge variant="destructive">
              <Trans>out of date</Trans>
            </Badge>
          )}
        </div>
        <div className="flex-1" />
        {status?.supported && (
          // Right-hugging on mobile, like every other action row.
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void showPlan()}>
              {busy === "plan" ? <Trans>Planning…</Trans> : <Trans>Preview</Trans>}
            </Button>
            {status.installed.length > 0 && (
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => void disable()}>
                {busy === "disable" ? <Trans>Removing…</Trans> : <Trans>Remove</Trans>}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void apply()}>
              {busy === "apply" ? <Trans>Applying…</Trans> : <Trans>Apply</Trans>}
            </Button>
          </div>
        )}
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          Your permission rules are enforced by the API. A BI tool, psql or a warehouse connector
          reads the tables directly and sees none of them. Applying compiles the same rules into
          Postgres policies — it cannot change anything the API does, because row security exempts
          the table owner and backlex is the owner.
        </Trans>
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : !status?.supported ? (
        <div className="px-4 py-6">
          <EmptyState
            bare
            size="sm"
            icon={I.Database}
            title={<Trans>Postgres only</Trans>}
            description={
              <Trans>
                This instance runs on SQLite/D1, where there is nothing to compile policies into.
                The API remains the only enforcement point.
              </Trans>
            }
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 border-b border-border px-4 py-3 text-[12px] sm:grid-cols-4">
            <Stat label={t`Applies to`} value={status.appliesTo} />
            <Stat label={t`Installed`} value={String(status.installed.length)} />
            {/* The two that mean "the database and the API disagree right now". */}
            <Stat label={t`Out of date`} value={String(status.stale.length)} warn={status.stale.length > 0} />
            <Stat label={t`Not yet applied`} value={String(status.missing.length)} warn={status.missing.length > 0} />
          </div>

          {status.notOwned.length > 0 && (
            <div className="border-b border-border px-4 py-3 text-[12px] text-destructive">
              <Trans>
                backlex does not own these tables, so applying is refused — enabling row security
                there would filter backlex's own queries:
              </Trans>{" "}
              <span className="font-mono">{status.notOwned.join(", ")}</span>
            </div>
          )}

          {omissions.length > 0 && (
            <div className="border-b border-border px-4 py-3">
              <div className="mb-1.5 text-[12px] font-medium text-destructive">
                <Trans>
                  These parts of your rules cannot be carried by a policy — a direct database reader
                  sees a coarser view than the API here.
                </Trans>
              </div>
              <ScrollArea viewportClassName="max-h-[180px]" className="w-full">
                <div className="flex flex-col gap-1.5 pr-2">
                  {omissions.map((o, i) => (
                    <div key={`${o.collection}-${o.role}-${o.action}-${i}`} className="text-[11.5px]">
                      <span className="font-mono">
                        {o.collection} · {o.role} · {o.action}
                      </span>
                      <div className="text-muted-foreground">{o.reason}</div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}

          {plan && (
            <div className="px-4 py-3">
              <div className="mb-1.5 text-[12px] font-medium">
                <Trans>Statements</Trans>
              </div>
              <ScrollArea viewportClassName="max-h-[260px]" className="w-full rounded-control border border-border">
                <pre className="p-3 font-mono text-[11px] whitespace-pre-wrap">
                  {[
                    ...plan.helpers,
                    ...plan.enables,
                    ...plan.policies.flatMap((p) => p.statements),
                  ]
                    .map((s) => `${s};`)
                    .join("\n")}
                </pre>
              </ScrollArea>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className={`truncate font-mono text-[12.5px] ${warn ? "text-destructive" : ""}`}>
        {value}
      </div>
    </div>
  );
}
