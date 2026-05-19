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
import { Skeleton } from "@workeros/ui/components/skeleton";

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
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
      <div
        className="card"
        style={{
          padding: 20,
          display: "grid",
          gridTemplateColumns: "160px 1fr",
          gap: 22,
          alignItems: "center",
        }}
      >
        <div style={{ position: "relative", width: 140, height: 140 }}>
          <ScoreRing score={score} />
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
            <div>
              <div className="font-mono tabular-nums" style={{ fontSize: 36, fontWeight: 600, letterSpacing: "-0.02em" }}>
                {score}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--muted-foreground)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                health
              </div>
            </div>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
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
        <TabsList variant="line">
          <TabsTrigger value="security">
            <I.ShieldAlert size={13} />Security
            <span className="count">{counts.security.error + counts.security.warn + counts.security.info}</span>
          </TabsTrigger>
          <TabsTrigger value="performance">
            <I.Cpu size={13} />Performance
            <span className="count">{counts.performance.error + counts.performance.warn + counts.performance.info}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Findings */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {isLoading ? (
          <>
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </>
        ) : isError ? (
          <div className="card empty">
            <div className="ico"><I.AlertTriangle size={18} /></div>
            <h4>Couldn't load advisor findings</h4>
            <p>The advisor endpoint returned an error. Re-run to try again.</p>
          </div>
        ) : list.length === 0 ? (
          <div className="card empty">
            <div className="ico"><I.CheckCircle size={18} /></div>
            <h4>All clear in this category</h4>
            <p>No outstanding findings. Re-run after a schema or permission change.</p>
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
    <button type="button" onClick={onClick} className={`summary-card ${active ? "on" : ""}`}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <IconComp size={15} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ display: "flex", gap: 16 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span className="dot-error" />
          <span className="font-mono tabular-nums">{counts.error}</span>
          <span style={{ color: "var(--muted-foreground)" }}>err</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span className="dot-warn" />
          <span className="font-mono tabular-nums">{counts.warn}</span>
          <span style={{ color: "var(--muted-foreground)" }}>warn</span>
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <span className="dot-info" />
          <span className="font-mono tabular-nums">{counts.info}</span>
          <span style={{ color: "var(--muted-foreground)" }}>info</span>
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
  return (
    <div className={`advisor-row advisor-${c.level}`}>
      <button type="button" className="advisor-head" onClick={() => setOpen((v) => !v)}>
        <span className={`advisor-ico advisor-ico-${c.level}`}><Icon size={14} /></span>
        <span className="advisor-title">{c.title}</span>
        <span className="advisor-resource font-mono">{c.resource}</span>
        <span className="advisor-time">{c.detected}</span>
        <I.ChevronDown size={12} className="advisor-chev" data-open={open} />
      </button>
      {open && (
        <div className="advisor-body">
          <p style={{ margin: 0, fontSize: 13, color: "var(--foreground)" }}>{c.body}</p>
          <div>
            <div
              style={{
                fontSize: 11,
                color: "var(--muted-foreground)",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                marginBottom: 6,
              }}
            >
              suggested fix
            </div>
            <pre className="code-block">{c.fix}</pre>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="outline" size="sm" icon={I.Copy} onClick={onCopy}>
              Copy fix
            </Button>
            <Button variant="ghost" size="sm" onClick={onDismiss}>
              Dismiss
            </Button>
            <div className="spacer" />
            <Button variant="ghost" size="sm" iconRight={I.ExternalLink}>
              Open resource
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
