// Advisor page — security + performance checks.
//
// Findings come from GET /api/admin/advisor (services/advisor.ts) — every
// check is computed from live DB / env state. Dismiss stays client-side
// (a local Set) since there's no dismiss endpoint.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { I, type IconComponent } from "../icons";
import { Button, PageHeader } from "../ui";
import { useAdvisor, queryKeys } from "../queries";
import { Tabs, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@workeros/ui/components/collapsible";
import { AdvisorSkeleton } from "../page-skeletons";

type CheckKind = "security" | "performance";
type CheckLevel = "error" | "warn" | "info";

interface AdvisorCheck {
  id: string;
  kind: CheckKind;
  level: CheckLevel;
  title: string;
  body: string;
  fix: string;
  resource: string;
  detected: string;
}

type LevelCounts = { error: number; warn: number; info: number };

export function AdvisorPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const [tab, setTab] = useState<CheckKind>("security");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const qc = useQueryClient();
  const { data, isLoading, isError, isFetching } = useAdvisor();
  const checks = useMemo<AdvisorCheck[]>(() => data?.data ?? [], [data]);

  const all = useMemo(
    () => checks.filter((c) => !dismissed.has(c.id)),
    [checks, dismissed],
  );
  const list = useMemo(() => all.filter((c) => c.kind === tab), [all, tab]);

  const counts = useMemo(() => {
    const out: Record<CheckKind, LevelCounts> = {
      security: { error: 0, warn: 0, info: 0 },
      performance: { error: 0, warn: 0, info: 0 },
    };
    for (const c of all) out[c.kind][c.level]++;
    return out;
  }, [all]);

  const score = useMemo(() => {
    const errs = all.filter((c) => c.level === "error").length;
    const warns = all.filter((c) => c.level === "warn").length;
    return Math.max(0, 100 - errs * 18 - warns * 7);
  }, [all]);

  const countCls = "rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground";

  // First whole-page fetch — advisor findings haven't landed yet.
  if (isLoading) return <AdvisorSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title="Advisor"
        description="Automated lint over schema, permissions, indexes, and traffic shape. Refreshes hourly — re-runs after every collection change."
        actions={
          <Button
            variant="outline"
            icon={I.Refresh}
            disabled={isFetching}
            onClick={() => {
              void qc
                .invalidateQueries({ queryKey: queryKeys.advisor() })
                .then(() => pushToast("Advisor re-ran."));
            }}
          >
            {isFetching ? "Re-running…" : "Re-run all"}
          </Button>
        }
      />

      {/* Score card */}
      <div className="grid grid-cols-[160px_1fr] max-[640px]:grid-cols-1 max-[640px]:justify-items-center items-center gap-[22px] overflow-hidden rounded-2xl border border-border bg-card p-5 text-card-foreground">
        <div className="relative size-[140px]">
          <ScoreRing score={score} />
          <div className="absolute inset-0 grid place-items-center text-center">
            <div>
              <div className="font-mono text-[36px] font-semibold tabular-nums tracking-[-0.02em]">
                {score}
              </div>
              <div className="text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
                health
              </div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3.5">
          <SummaryCard
            counts={counts.security}
            active={tab === "security"}
            onClick={() => setTab("security")}
            icon={I.ShieldAlert}
            label="Security"
          />
          <SummaryCard
            counts={counts.performance}
            active={tab === "performance"}
            onClick={() => setTab("performance")}
            icon={I.Cpu}
            label="Performance"
          />
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as CheckKind)}>
        <TabsList>
          <TabsTrigger value="security">
            <I.ShieldAlert size={13} />Security{" "}
            <span className={countCls}>{counts.security.error + counts.security.warn + counts.security.info}</span>
          </TabsTrigger>
          <TabsTrigger value="performance">
            <I.Cpu size={13} />Performance{" "}
            <span className={countCls}>{counts.performance.error + counts.performance.warn + counts.performance.info}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Findings */}
      <div className="flex flex-col gap-2.5">
        {isError ? (
          <div className="flex flex-col items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card px-6 py-12 text-center text-card-foreground">
            <div className="grid size-10 place-items-center rounded-xl bg-muted text-primary"><I.AlertTriangle size={18} /></div>
            <h4 className="m-0 text-[15px] font-semibold">Couldn't load advisor findings</h4>
            <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">The advisor endpoint returned an error. Re-run to try again.</p>
          </div>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card px-6 py-12 text-center text-card-foreground">
            <div className="grid size-10 place-items-center rounded-xl bg-muted text-primary"><I.CheckCircle size={18} /></div>
            <h4 className="m-0 text-[15px] font-semibold">All clear in this category</h4>
            <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">No outstanding findings. Re-run after a schema or permission change.</p>
          </div>
        ) : (
          list.map((c) => (
            <AdvisorRow
              key={c.id}
              c={c}
              onDismiss={() => {
                setDismissed((s) => new Set([...s, c.id]));
                pushToast(`Dismissed "${c.title}".`);
              }}
              onCopy={() => {
                try {
                  void navigator.clipboard.writeText(c.fix);
                  pushToast("Fix copied to clipboard.");
                } catch {
                  pushToast("Could not copy fix.", "error");
                }
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  counts,
  active,
  onClick,
  icon: IconComp,
  label,
}: {
  counts: LevelCounts;
  active: boolean;
  onClick: () => void;
  icon: IconComponent;
  label: string;
}) {
  return (
    <button type="button" onClick={onClick} className={`flex cursor-pointer flex-col rounded-xl border px-4 py-3.5 text-left hover:bg-accent ${active ? "border-[color-mix(in_oklch,var(--foreground)_30%,var(--border))] bg-accent" : "border-border bg-card"}`}>
      <div className="mb-2.5 flex items-center gap-2">
        <IconComp size={15} />
        <span className="text-[13px] font-medium">{label}</span>
      </div>
      <div className="flex gap-4">
        <span className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-2 rounded-full bg-destructive" />
          <span className="font-mono tabular-nums">{counts.error}</span>
          <span className="text-muted-foreground">err</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-2 rounded-full bg-[oklch(0.7_0.18_70)]" />
          <span className="font-mono tabular-nums">{counts.warn}</span>
          <span className="text-muted-foreground">warn</span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-2 rounded-full bg-muted-foreground" />
          <span className="font-mono tabular-nums">{counts.info}</span>
          <span className="text-muted-foreground">info</span>
        </span>
      </div>
    </button>
  );
}

function ScoreRing({ score }: { score: number }) {
  const R = 60;
  const C = 2 * Math.PI * R;
  const off = C - (C * score) / 100;
  const color = score >= 80 ? "var(--primary)" : score >= 50 ? "oklch(0.75 0.18 70)" : "var(--destructive)";
  return (
    <svg width={140} height={140} viewBox="0 0 140 140">
      <circle cx="70" cy="70" r={R} fill="none" stroke="var(--muted)" strokeWidth="10" />
      <circle
        cx="70"
        cy="70"
        r={R}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={C}
        strokeDashoffset={off}
        transform="rotate(-90 70 70)"
      />
    </svg>
  );
}

function AdvisorRow({ c, onDismiss, onCopy }: { c: AdvisorCheck; onDismiss: () => void; onCopy: () => void }) {
  const [open, setOpen] = useState(false);
  const Icon = c.level === "error" ? I.AlertTriangle : c.level === "warn" ? I.AlertCircle : I.Info;
  const rowBorder = c.level === "error"
    ? "border-[color-mix(in_oklch,var(--destructive)_28%,var(--border))]"
    : c.level === "warn"
      ? "border-[color-mix(in_oklch,oklch(0.7_0.18_70)_30%,var(--border))]"
      : "border-border";
  const icoCls = c.level === "error"
    ? "bg-[color-mix(in_oklch,var(--destructive)_16%,var(--card))] text-destructive"
    : c.level === "warn"
      ? "bg-[color-mix(in_oklch,oklch(0.75_0.18_70)_18%,var(--card))] text-[oklch(0.55_0.18_70)] dark:text-[oklch(0.85_0.18_70)]"
      : "bg-muted text-muted-foreground";
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={`overflow-hidden rounded-2xl border bg-card ${rowBorder}`}>
      <CollapsibleTrigger asChild>
        <button type="button" className="grid w-full cursor-pointer grid-cols-[32px_1fr_auto_auto_16px] max-[640px]:grid-cols-[32px_1fr_16px] items-center gap-3 border-0 bg-transparent px-4 py-3 text-left hover:bg-accent">
          <span className={`grid size-7 place-items-center rounded-lg ${icoCls}`}><Icon size={14} /></span>
          <span className="min-w-0 truncate text-[13.5px] font-medium">{c.title}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground max-[640px]:hidden">{c.resource}</span>
          <span className="text-[11px] text-muted-foreground max-[640px]:hidden">{c.detected}</span>
          <I.ChevronDown size={12} className="text-muted-foreground transition-transform data-[open=true]:rotate-180" data-open={open} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t border-dashed border-border px-4 pb-4 pl-[60px] pt-1">
          <p className="m-0 text-[13px] text-foreground">{c.body}</p>
          <div>
            <div className="mb-1.5 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
              suggested fix
            </div>
            <pre className="m-0 overflow-x-auto whitespace-pre rounded-lg bg-muted px-3 py-2.5 font-mono text-[11.5px]">{c.fix}</pre>
          </div>
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" icon={I.Copy} onClick={onCopy}>
              Copy fix
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" iconRight={I.ExternalLink}>
              Open resource
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
