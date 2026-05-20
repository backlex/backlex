// Advisor page — security + performance checks.
//
// Visual + interaction parity with the design's parity-v2.jsx::AdvisorPage.
import { useMemo, useState } from "react";
import { I, type IconComponent } from "../icons";
import { Button, PageHeader } from "../ui";

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

// TODO(advisor): replace with /api/admin/advisor when the endpoint lands.
const ADVISOR_CHECKS: AdvisorCheck[] = [
  // security
  { id: "a_01", kind: "security", level: "error", title: "Public read on c_users", body: "Role public can read c_users with no condition — emails exposed to anonymous traffic.", fix: "Remove the public read permission on c_users, or scope to { is_public: { _eq: true } }.", resource: "permissions · c_users", detected: "14m ago" },
  { id: "a_02", kind: "security", level: "error", title: "Missing condition on owner-scoped collection", body: "c_comments has owner-scoped: true but no DSL condition on update — any signed-in user can edit any row.", fix: "Add { owner_id: { _eq: \"$user.id\" } } to the authenticated update permission.", resource: "permissions · c_comments", detected: "1h ago" },
  { id: "a_03", kind: "security", level: "warn", title: "API key without role scope", body: "pak_a4e2b9c1 (CI bot) inherits the owner's full admin permissions.", fix: "Bind the key to a narrower role via role_id, or rotate to a service account.", resource: "api_keys · pak_a4e2b9c1", detected: "2h ago" },
  { id: "a_04", kind: "security", level: "warn", title: "MFA disabled for 3 admins", body: "rana, priya, jules have admin role but no enrolled second factor.", fix: "Enforce MFA for the admin role in Authentication settings.", resource: "users · admin role", detected: "1d ago" },
  { id: "a_05", kind: "security", level: "info", title: "Email provider falls back to console", body: "No EMAIL_PROVIDER configured for production — verification mail logs to stdout.", fix: "Configure Resend, SendGrid, or SES in Authentication → Email.", resource: "env · EMAIL_PROVIDER", detected: "3d ago" },
  // performance
  { id: "a_06", kind: "performance", level: "warn", title: "Missing index on c_comments(post_id, created_at)", body: "Sequential scan detected · p95 740ms over the last 24h.", fix: "CREATE INDEX idx_comments_post_created ON c_comments (post_id, created_at DESC);", resource: "c_comments", detected: "30m ago" },
  { id: "a_07", kind: "performance", level: "warn", title: "N+1 on c_posts.author lookups", body: "Detected 184 sequential auth_users fetches per /api/items/posts request.", fix: "Use the relation expansion query param: fields=*,author.* (single JOIN).", resource: "route · /api/items/posts", detected: "45m ago" },
  { id: "a_08", kind: "performance", level: "info", title: "Unused index on c_tags(slug)", body: "Index seen 0 times in the last 14 days · 24kB on disk.", fix: "DROP INDEX idx_tags_slug;", resource: "c_tags", detected: "2d ago" },
  { id: "a_09", kind: "performance", level: "info", title: "Cold storage rate elevated", body: "R2 first-byte latency p95 380ms in eu-west · consider edge cache for /api/storage/*.", fix: "Set Cache-Control: max-age=86400 on immutable object keys.", resource: "storage · R2", detected: "2h ago" },
];

type LevelCounts = { error: number; warn: number; info: number };

export function AdvisorPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const [tab, setTab] = useState<CheckKind>("security");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const all = useMemo(() => ADVISOR_CHECKS.filter((c) => !dismissed.has(c.id)), [dismissed]);
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

  const tabCls = (id: string) =>
    `inline-flex cursor-pointer items-center gap-1.5 rounded-3xl border-0 px-3.5 py-[5px] text-[12.5px] font-medium ${tab === id ? "bg-card text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.06),0_1px_0_oklch(0_0_0/0.04)]" : "bg-transparent text-muted-foreground"}`;
  const countCls = (id: string) =>
    `rounded-sm border border-border px-[5px] py-px font-mono text-[11px] text-muted-foreground ${tab === id ? "bg-muted" : "bg-background"}`;
  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title="Advisor"
        description="Automated lint over schema, permissions, indexes, and traffic shape. Refreshes hourly — re-runs after every collection change."
        actions={
          <Button
            variant="outline"
            icon={I.Refresh}
            onClick={() => pushToast("Advisor re-ran · 9 checks · 0 new findings.")}
          >
            Re-run all
          </Button>
        }
      />

      {/* Score card */}
      <div className="grid grid-cols-[160px_1fr] items-center gap-[22px] overflow-hidden rounded-2xl border border-border bg-card p-5 text-card-foreground">
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

      <div className="flex w-fit gap-0.5 rounded-3xl bg-muted p-[3px]">
        <button className={tabCls("security")} onClick={() => setTab("security")}>
          <I.ShieldAlert size={13} />Security{" "}
          <span className={countCls("security")}>{counts.security.error + counts.security.warn + counts.security.info}</span>
        </button>
        <button className={tabCls("performance")} onClick={() => setTab("performance")}>
          <I.Cpu size={13} />Performance{" "}
          <span className={countCls("performance")}>{counts.performance.error + counts.performance.warn + counts.performance.info}</span>
        </button>
      </div>

      {/* Findings */}
      <div className="flex flex-col gap-2.5">
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-3 overflow-hidden rounded-2xl border border-border bg-card px-6 py-12 text-center text-card-foreground">
            <div className="grid size-10 place-items-center rounded-xl bg-muted text-primary"><I.CheckCircle size={18} /></div>
            <h4 className="m-0 text-[15px] font-semibold">All clear in this category</h4>
            <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">No outstanding findings. The advisor will re-check at the top of the hour.</p>
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
    <div className={`overflow-hidden rounded-2xl border bg-card ${rowBorder}`}>
      <button type="button" className="grid w-full cursor-pointer grid-cols-[32px_1fr_auto_auto_16px] items-center gap-3 border-0 bg-transparent px-4 py-3 text-left hover:bg-accent" onClick={() => setOpen((v) => !v)}>
        <span className={`grid size-7 place-items-center rounded-lg ${icoCls}`}><Icon size={14} /></span>
        <span className="text-[13.5px] font-medium">{c.title}</span>
        <span className="font-mono text-[11.5px] text-muted-foreground">{c.resource}</span>
        <span className="text-[11px] text-muted-foreground">{c.detected}</span>
        <I.ChevronDown size={12} className="text-muted-foreground transition-transform data-[open=true]:rotate-180" data-open={open} />
      </button>
      {open && (
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
      )}
    </div>
  );
}
