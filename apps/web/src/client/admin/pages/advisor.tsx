// Advisor page — security + performance checks.
//
// Findings come from GET /api/admin/advisor (services/advisor.ts) — every
// check is computed from live DB / env state, the score is server-computed,
// and `generatedAt` is one honest per-run timestamp. The page runs the check
// on demand (there is no server cron/cache). Dismiss is persisted to
// localStorage (there is no dismiss endpoint).
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent } from "../icons";
import { Button, PageHeader } from "../ui";
import { useAdvisor, queryKeys } from "../queries";
import { Card } from "@backlex/ui/components/card";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@backlex/ui/components/collapsible";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { AdvisorSkeleton } from "../page-skeletons";

type CheckKind = "security" | "performance";
type CheckLevel = "error" | "warn" | "info";

interface AdvisorCheck {
  id: string;
  kind: CheckKind;
  level: CheckLevel;
  rule: string;
  groupTitle: string;
  title: string;
  body: string;
  fix: string;
  resource: string;
  link?: string;
}

type LevelCounts = { error: number; warn: number; info: number };

const DISMISSED_KEY = "backlex.advisor.dismissed";

/** error → warn → info, for severity ordering. */
const LEVEL_RANK: Record<CheckLevel, number> = { error: 0, warn: 1, info: 2 };

/** Read the dismissed-finding id set from localStorage (best-effort). */
function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.filter((v) => typeof v === "string"));
  } catch {
    // localStorage unavailable / malformed — start empty.
  }
  return new Set();
}

/** Persist the dismissed-finding id set to localStorage (best-effort). */
function saveDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids]));
  } catch {
    // localStorage unavailable — dismiss stays in-memory for this session.
  }
}

/** A run-level local time string, e.g. "14:32 · May 22". */
function formatGeneratedAt(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${hh}:${mm} · ${date}`;
}

export function AdvisorPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const { t } = useLingui();
  const [tab, setTab] = useState<CheckKind>("security");
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data, isLoading, isError, isFetching } = useAdvisor();
  const checks = useMemo<AdvisorCheck[]>(() => data?.data ?? [], [data]);
  const score = data?.score ?? 100;
  const generatedAt = data?.generatedAt ?? null;

  const dismiss = (id: string, title: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissed(next);
      return next;
    });
    pushToast(t`Dismissed "${title}".`);
  };

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

  // Group the visible findings by `rule`, preserving severity order: each
  // group inherits the rank of its worst finding so groups + singletons sort
  // together. Individual findings still drive every count.
  const groups = useMemo(() => {
    const byRule = new Map<string, AdvisorCheck[]>();
    for (const c of list) {
      const arr = byRule.get(c.rule);
      if (arr) arr.push(c);
      else byRule.set(c.rule, [c]);
    }
    const result = [...byRule.values()].map((items) => {
      const sorted = [...items].sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
      const worst = sorted[0]!;
      return { rule: worst.rule, items: sorted, worst };
    });
    result.sort((a, b) => LEVEL_RANK[a.worst.level] - LEVEL_RANK[b.worst.level]);
    return result;
  }, [list]);

  const countCls = "rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground";

  const onCopy = (fix: string) => {
    try {
      void navigator.clipboard.writeText(fix);
      pushToast(t`Fix copied to clipboard.`);
    } catch {
      pushToast(t`Could not copy fix.`, "error");
    }
  };

  // First whole-page fetch — advisor findings haven't landed yet.
  if (isLoading) return <AdvisorSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Advisor`}
        description={t`Automated lint over schema, permissions, and configuration. Runs on demand against live workspace state.`}
        actions={
          <Button
            variant="outline"
            icon={I.Refresh}
            disabled={isFetching}
            onClick={() => {
              void qc
                .invalidateQueries({ queryKey: queryKeys.advisor() })
                .then(() => pushToast(t`Advisor re-ran.`));
            }}
          >
            {isFetching ? <Trans>Re-running…</Trans> : <Trans>Re-run all</Trans>}
          </Button>
        }
      />

      {/* Score card */}
      <Card className="grid grid-cols-[160px_1fr] max-[640px]:grid-cols-1 max-[640px]:justify-items-center items-center gap-[22px] p-5">
        <div className="relative size-[140px]">
          <ScoreRing score={score} />
          <div className="absolute inset-0 grid place-items-center text-center">
            <div>
              <div className="font-mono text-[36px] font-semibold tabular-nums tracking-[-0.02em]">
                {score}
              </div>
              <div className="text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
                <Trans>health</Trans>
              </div>
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-3.5">
          <div className="grid grid-cols-2 gap-3.5">
            <SummaryCard
              counts={counts.security}
              active={tab === "security"}
              onClick={() => setTab("security")}
              icon={I.ShieldAlert}
              label={t`Security`}
            />
            <SummaryCard
              counts={counts.performance}
              active={tab === "performance"}
              onClick={() => setTab("performance")}
              icon={I.Cpu}
              label={t`Performance`}
            />
          </div>
          {generatedAt && (
            <div className="text-[11.5px] text-muted-foreground">
              <Trans>Last run: {formatGeneratedAt(generatedAt)}</Trans>
            </div>
          )}
        </div>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as CheckKind)}>
        <TabsList>
          <TabsTrigger value="security">
            <I.ShieldAlert size={13} /><Trans>Security</Trans>{" "}
            <span className={countCls}>{counts.security.error + counts.security.warn + counts.security.info}</span>
          </TabsTrigger>
          <TabsTrigger value="performance">
            <I.Cpu size={13} /><Trans>Performance</Trans>{" "}
            <span className={countCls}>{counts.performance.error + counts.performance.warn + counts.performance.info}</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Findings */}
      <div className="flex flex-col gap-2.5">
        {isError ? (
          <Card className="items-center gap-3 px-6 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-xl bg-muted text-primary"><I.AlertTriangle size={18} /></div>
            <h4 className="m-0 text-[15px] font-semibold"><Trans>Couldn't load advisor findings</Trans></h4>
            <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground"><Trans>The advisor endpoint returned an error. Re-run to try again.</Trans></p>
          </Card>
        ) : list.length === 0 ? (
          <Card className="items-center gap-3 px-6 py-12 text-center">
            <div className="grid size-10 place-items-center rounded-xl bg-muted text-primary"><I.CheckCircle size={18} /></div>
            <h4 className="m-0 text-[15px] font-semibold"><Trans>All clear in this category</Trans></h4>
            <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground"><Trans>No outstanding findings. Re-run after a schema or permission change.</Trans></p>
          </Card>
        ) : (
          groups.map((g) =>
            g.items.length === 1 ? (
              <AdvisorRow
                key={g.items[0]!.id}
                c={g.items[0]!}
                onDismiss={() => dismiss(g.items[0]!.id, g.items[0]!.title)}
                onCopy={() => onCopy(g.items[0]!.fix)}
                onOpen={g.items[0]!.link ? () => navigate(g.items[0]!.link!) : undefined}
              />
            ) : (
              <AdvisorGroup
                key={g.rule}
                title={g.worst.groupTitle}
                level={g.worst.level}
                items={g.items}
                onDismiss={dismiss}
                onCopy={onCopy}
                onOpen={(link) => navigate(link)}
              />
            ),
          )
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
          <span className="text-muted-foreground"><Trans>err</Trans></span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-2 rounded-full bg-[oklch(0.7_0.18_70)]" />
          <span className="font-mono tabular-nums">{counts.warn}</span>
          <span className="text-muted-foreground"><Trans>warn</Trans></span>
        </span>
        <span className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-2 rounded-full bg-muted-foreground" />
          <span className="font-mono tabular-nums">{counts.info}</span>
          <span className="text-muted-foreground"><Trans>info</Trans></span>
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

/** Severity-driven icon + border/icon tints, shared by rows and groups. */
function levelStyles(level: CheckLevel) {
  const Icon = level === "error" ? I.AlertTriangle : level === "warn" ? I.AlertCircle : I.Info;
  const border = level === "error"
    ? "border-[color-mix(in_oklch,var(--destructive)_28%,var(--border))]"
    : level === "warn"
      ? "border-[color-mix(in_oklch,oklch(0.7_0.18_70)_30%,var(--border))]"
      : "border-border";
  const ico = level === "error"
    ? "bg-[color-mix(in_oklch,var(--destructive)_16%,var(--card))] text-destructive"
    : level === "warn"
      ? "bg-[color-mix(in_oklch,oklch(0.75_0.18_70)_18%,var(--card))] text-[oklch(0.55_0.18_70)] dark:text-[oklch(0.85_0.18_70)]"
      : "bg-muted text-muted-foreground";
  return { Icon, border, ico };
}

/** The expanded detail body of a single finding — shared by the standalone
 *  row and the per-finding entries inside a group. */
function FindingDetail({
  c,
  onDismiss,
  onCopy,
  onOpen,
}: {
  c: AdvisorCheck;
  onDismiss: () => void;
  onCopy: () => void;
  onOpen?: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 border-t border-dashed border-border px-4 pb-4 pl-[60px] pt-1">
      <p className="m-0 text-[13px] text-foreground">{c.body}</p>
      <div>
        <div className="mb-1.5 text-[11px] uppercase tracking-[0.05em] text-muted-foreground">
          <Trans>suggested fix</Trans>
        </div>
        <ScrollArea className="rounded-lg"><pre className="m-0 whitespace-pre rounded-lg bg-muted px-3 py-2.5 font-mono text-[11.5px]">{c.fix}</pre></ScrollArea>
      </div>
      <div className="flex gap-1.5">
        <Button variant="outline" size="sm" icon={I.Copy} onClick={onCopy}>
          <Trans>Copy fix</Trans>
        </Button>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          <Trans>Dismiss</Trans>
        </Button>
        <div className="flex-1" />
        {onOpen && (
          <Button variant="ghost" size="sm" iconRight={I.ExternalLink} onClick={onOpen}>
            <Trans>Open resource</Trans>
          </Button>
        )}
      </div>
    </div>
  );
}

function AdvisorRow({
  c,
  onDismiss,
  onCopy,
  onOpen,
}: {
  c: AdvisorCheck;
  onDismiss: () => void;
  onCopy: () => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, border, ico } = levelStyles(c.level);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={`overflow-hidden rounded-2xl border bg-card ${border}`}>
      <CollapsibleTrigger asChild>
        <button type="button" className="grid w-full cursor-pointer grid-cols-[32px_1fr_auto_16px] max-[640px]:grid-cols-[32px_1fr_16px] items-center gap-3 border-0 bg-transparent px-4 py-3 text-left hover:bg-accent">
          <span className={`grid size-7 place-items-center rounded-lg ${ico}`}><Icon size={14} /></span>
          <span className="min-w-0 truncate text-[13.5px] font-medium">{c.title}</span>
          <span className="font-mono text-[11.5px] text-muted-foreground max-[640px]:hidden">{c.resource}</span>
          <I.ChevronDown size={12} className="text-muted-foreground transition-transform data-[open=true]:rotate-180" data-open={open} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FindingDetail c={c} onDismiss={onDismiss} onCopy={onCopy} onOpen={onOpen} />
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A collapsible group of findings that share a `rule`. The header shows the
 *  category label + a count badge + the worst severity icon; expanding lists
 *  each individual finding. */
function AdvisorGroup({
  title,
  level,
  items,
  onDismiss,
  onCopy,
  onOpen,
}: {
  title: string;
  level: CheckLevel;
  items: AdvisorCheck[];
  onDismiss: (id: string, title: string) => void;
  onCopy: (fix: string) => void;
  onOpen: (link: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, border, ico } = levelStyles(level);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={`overflow-hidden rounded-2xl border bg-card ${border}`}>
      <CollapsibleTrigger asChild>
        <button type="button" className="grid w-full cursor-pointer grid-cols-[32px_1fr_auto_16px] items-center gap-3 border-0 bg-transparent px-4 py-3 text-left hover:bg-accent">
          <span className={`grid size-7 place-items-center rounded-lg ${ico}`}><Icon size={14} /></span>
          <span className="min-w-0 truncate text-[13.5px] font-medium">{title}</span>
          <span className="rounded-sm border border-border bg-muted px-[6px] py-px font-mono text-[11px] text-muted-foreground">{items.length}</span>
          <I.ChevronDown size={12} className="text-muted-foreground transition-transform data-[open=true]:rotate-180" data-open={open} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col border-t border-dashed border-border">
          {items.map((c) => (
            <GroupedFinding
              key={c.id}
              c={c}
              onDismiss={() => onDismiss(c.id, c.title)}
              onCopy={() => onCopy(c.fix)}
              onOpen={c.link ? () => onOpen(c.link!) : undefined}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A single finding rendered inside a group — its own nested collapsible so
 *  each finding's specific title / resource / body / fix stays addressable. */
function GroupedFinding({
  c,
  onDismiss,
  onCopy,
  onOpen,
}: {
  c: AdvisorCheck;
  onDismiss: () => void;
  onCopy: () => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { Icon, ico } = levelStyles(c.level);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-b border-dashed border-border last:border-b-0">
      <CollapsibleTrigger asChild>
        <button type="button" className="grid w-full cursor-pointer grid-cols-[32px_1fr_auto_16px] max-[640px]:grid-cols-[32px_1fr_16px] items-center gap-3 border-0 bg-transparent px-4 py-2.5 pl-7 text-left hover:bg-accent">
          <span className={`grid size-6 place-items-center rounded-md ${ico}`}><Icon size={12} /></span>
          <span className="min-w-0 truncate text-[13px]">{c.title}</span>
          <span className="font-mono text-[11px] text-muted-foreground max-[640px]:hidden">{c.resource}</span>
          <I.ChevronDown size={11} className="text-muted-foreground transition-transform data-[open=true]:rotate-180" data-open={open} />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <FindingDetail c={c} onDismiss={onDismiss} onCopy={onCopy} onOpen={onOpen} />
      </CollapsibleContent>
    </Collapsible>
  );
}
