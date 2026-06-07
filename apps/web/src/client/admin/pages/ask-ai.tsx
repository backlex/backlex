// Ask AI — admin page.
//
// Ports the design's four-tab AI/MCP page (/tmp/design-bundle/backlex/project/ai-mcp.jsx)
// onto the canonical backlex UI primitives:
//   - Ask     — natural-language → MCP tool dispatcher (Phase 1)
//   - Tools   — searchable catalog + per-key guard editor (Phase 2)
//   - Runs    — filtered activity table with CSV export    (Phase 2)
//   - Connect — Claude Desktop / Cursor / curl snippets    (Phase 2)
//
// Backend hops the Ask tab still drives:
//   POST /api/admin/ai/plan  →  {rationale, tool, args, model, usage}
//   POST /api/admin/ai/run   →  executes one MCP tool + writes to `activity`
//
// Recent runs fetch /api/activity?action=mcp.&limit=10 — same wire we log
// into from the /run handler.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@/lib/api";
import { activityApi, type ApiActivity } from "../api";
import { I } from "../icons";
import { Badge, Button, PageHeader, Switch } from "../ui";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@backlex/ui/components/tabs";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@backlex/ui/components/popover";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@backlex/ui/components/drawer";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import { McpKeyModal } from "@/components/mcp-key-modal";
import {
  claudeDesktopSnippet,
  cursorSnippet,
  curlSnippet,
} from "@/lib/mcp-snippets";
import { exportToCsv } from "@/lib/csv-export";

interface PlanResponse {
  data: {
    rationale: string;
    tool: string;
    args: Record<string, unknown>;
    model: string;
    usage?: unknown;
  };
}

interface RunResponse {
  ok: boolean;
  tool: string;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  };
  rowCount?: number | null;
  durationMs: number;
  error?: string;
}

// Provider-prefixed model ids — these are the literal strings the AI
// Gateway accepts. Workspaces still on the legacy direct-Anthropic key
// also work because the server strips the `anthropic/` prefix when it
// falls back to that path. New providers (OpenAI / Google) only light up
// when the workspace ships `AI_GATEWAY_API_KEY` — otherwise the server
// returns UNAVAILABLE and the toast surfaces it.
const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const DEFAULT_PROMPT =
  "top customers by total spent in the last 30 days, limit 10";

// Mirrors the planner's whitelist on the server. Auto-run only fires when
// the proposed tool is one of these read-leaning surfaces.
const AUTO_RUN_PATTERN =
  /^(collections\.list|collections\.read|collections\.aggregate|storage\.list|vector\.search|schema\.)/;
const DESTRUCTIVE_PATTERN = /\b(delete|drop|revoke|suspend)\b/;
const WRITE_PATTERN =
  /\b(insert|update|delete|drop|create|upload|grant|revoke|invoke|suspend|activate|assign|unassign|send|test)\b/;

// Bumping these only matters when the catalog grows; the badge in the page
// header surfaces the total so the docs page can stay accurate. Source of
// truth: apps/web/src/server/mcp/tools/index.ts::allTools.length.
const MCP_TOOL_COUNT = 74;

/** Lightweight JSON syntax highlighter — ported verbatim from the design's
 *  `JsonBlock` (ai-mcp.jsx:257). Avoids pulling a code-editor dependency
 *  for pretty-printing static args. */
function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const tokens = useMemo(() => {
    const re =
      /("[^"\\]*(?:\\.[^"\\]*)*")(\s*:)?|(-?\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|(\$NOW\([^)]*\))|([[\]{},])|(\s+)|(.)/g;
    const out: React.ReactNode[] = [];
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(text)) !== null) {
      if (m[1] && m[2]) {
        out.push(
          <span
            key={i++}
            className="text-[oklch(0.45_0.14_70)] dark:text-[oklch(0.86_0.17_95)]"
          >
            {m[1]}
          </span>,
        );
        out.push(
          <span key={i++} className="text-muted-foreground">
            {m[2]}
          </span>,
        );
      } else if (m[1]) {
        out.push(
          <span
            key={i++}
            className="text-[oklch(0.42_0.14_130)] dark:text-[oklch(0.82_0.13_130)]"
          >
            {m[1]}
          </span>,
        );
      } else if (m[3] || m[4]) {
        out.push(
          <span
            key={i++}
            className="text-[oklch(0.45_0.13_240)] dark:text-[oklch(0.78_0.13_240)]"
          >
            {m[3] || m[4]}
          </span>,
        );
      } else if (m[5]) {
        out.push(
          <span key={i++} className="italic text-muted-foreground">
            {m[5]}
          </span>,
        );
      } else if (m[6]) {
        out.push(
          <span key={i++} className="text-muted-foreground">
            {m[6]}
          </span>,
        );
      } else {
        out.push(<span key={i++}>{m[7] || m[8]}</span>);
      }
    }
    return out;
  }, [text]);
  return (
    <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55]">
      {tokens}
    </pre>
  );
}

interface ModelOption {
  id: string;
  label: string;
  hint: string;
  default?: boolean;
}

function useIsMobile(breakpoint = 640) {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(`(max-width: ${breakpoint - 1}px)`).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const on = () => setIsMobile(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [breakpoint]);
  return isMobile;
}

function ModelPickerList({
  value,
  onSelect,
  grouped,
}: {
  value: string;
  onSelect: (id: string) => void;
  grouped: Array<{ provider: string; items: ModelOption[] }>;
}) {
  return (
    <div>
      {grouped.map((g, gi) => (
        <div key={g.provider} className={gi > 0 ? "mt-1 border-t border-border/60 pt-1" : ""}>
          <div className="px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground/80">
            {g.provider}
          </div>
          {g.items.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => onSelect(m.id)}
              className={`flex w-full cursor-pointer items-start gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left hover:bg-accent ${value === m.id ? "bg-accent" : ""}`}
            >
              <span
                className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${value === m.id ? "bg-primary" : "bg-border"}`}
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-center gap-1.5">
                  <span className="font-mono text-[12px] text-foreground">
                    {m.label}
                  </span>
                  {m.default && (
                    <Badge variant="secondary" mono>
                      default
                    </Badge>
                  )}
                </span>
                <span className="text-[10.5px] leading-snug text-muted-foreground">
                  {m.hint}
                </span>
              </span>
              {value === m.id && (
                <I.Check size={12} className="mt-1 shrink-0 text-primary" />
              )}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function ModelPicker({
  value,
  onChange,
  models,
}: {
  value: string;
  onChange: (next: string) => void;
  models: ModelOption[];
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useIsMobile();
  // Group adjacent ids that share a provider prefix so the dropdown shows
  // an "anthropic / openai / google" header per cluster. Order in `models`
  // dictates the visual order — we don't sort.
  const grouped = useMemo(() => {
    const out: Array<{ provider: string; items: ModelOption[] }> = [];
    for (const m of models) {
      const provider = m.id.includes("/") ? m.id.split("/")[0]! : "anthropic";
      const last = out[out.length - 1];
      if (last && last.provider === provider) last.items.push(m);
      else out.push({ provider, items: [m] });
    }
    return out;
  }, [models]);
  const shortLabel = value.includes("/") ? value.split("/").slice(1).join("/") : value;
  const handleSelect = (id: string) => {
    onChange(id);
    setOpen(false);
  };
  const trigger = (
    <button
      type="button"
      title={value}
      className="inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-transparent px-2 text-[11.5px] text-muted-foreground hover:bg-accent"
    >
      <span className="h-1.5 w-1.5 rounded-full bg-primary" />
      <span className="truncate whitespace-nowrap font-mono max-w-[140px] sm:max-w-none">
        {shortLabel}
      </span>
      <I.ChevronDown
        size={10}
        className={open ? "rotate-180 transition-transform" : "transition-transform"}
      />
    </button>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
        <DrawerContent className="max-h-[80vh]">
          <DrawerHeader className="text-left">
            <DrawerTitle>
              <Trans>Model</Trans>
            </DrawerTitle>
          </DrawerHeader>
          <ScrollArea viewportClassName="max-h-[55vh]">
            <ModelPickerList value={value} onSelect={handleSelect} grouped={grouped} />
          </ScrollArea>
          <div className="border-t border-border px-4 py-3 text-[11px] text-muted-foreground">
            <Trans>
              Configured via{" "}
              <span className="font-mono text-foreground">AI_GATEWAY_API_KEY</span>{" "}
              on the backlex deployment (or legacy{" "}
              <span className="font-mono text-foreground">ANTHROPIC_API_KEY</span>).
            </Trans>
          </div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-[300px] gap-0 p-1">
        <div className="px-3 pt-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <Trans>Model</Trans>
        </div>
        <ScrollArea viewportClassName="max-h-[360px]">
          <ModelPickerList value={value} onSelect={handleSelect} grouped={grouped} />
        </ScrollArea>
        <div className="mt-1 border-t border-border px-3 pt-2 pb-1 text-[10.5px] text-muted-foreground">
          <Trans>
            Configured via{" "}
            <span className="font-mono text-foreground">AI_GATEWAY_API_KEY</span>{" "}
            on the backlex deployment (or legacy{" "}
            <span className="font-mono text-foreground">ANTHROPIC_API_KEY</span>).
          </Trans>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ToolKindBadge({
  destructive,
  write,
}: {
  destructive: boolean;
  write: boolean;
}) {
  if (destructive) {
    return (
      <Badge variant="destructive" mono>
        destruct
      </Badge>
    );
  }
  if (write) {
    return (
      <Badge variant="outline" mono className="border-amber-500/40 text-amber-700 dark:text-amber-300">
        write
      </Badge>
    );
  }
  return (
    <Badge variant="outline" mono className="border-sky-500/40 text-sky-700 dark:text-sky-300">
      read
    </Badge>
  );
}

function RunStatusIcon({ status }: { status: RunStatus }) {
  if (status === "ok") return <I.CheckCircle size={12} className="text-primary" />;
  if (status === "blocked") return <I.Lock size={12} className="text-muted-foreground" />;
  if (status === "review") return <I.Brain size={12} className="text-amber-600 dark:text-amber-300" />;
  return <I.XCircle size={12} className="text-destructive" />;
}

function relativeWhen(input: string | number): string {
  const d = new Date(input);
  const diff = Date.now() - d.getTime();
  if (!Number.isFinite(diff)) return "";
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

function summariseArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "—";
  const a = args as Record<string, unknown>;
  if (typeof a.prompt === "string") return a.prompt.slice(0, 120);
  if (typeof a.collection === "string") {
    const filter = a.filter ? " · filter" : "";
    const sort = typeof a.sort === "string" ? ` · ${a.sort}` : "";
    return `${a.collection}${filter}${sort}`;
  }
  if (typeof a.description === "string") return a.description.slice(0, 120);
  return JSON.stringify(a).slice(0, 120);
}

interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  expiresAt: string | number | null;
  revokedAt: string | number | null;
  mcpTools: string[] | null;
  mcpReadOnly: boolean;
}

interface McpToolDescriptor {
  name: string;
  description: string;
  kind: "read" | "write" | "destruct";
  adminOnly?: boolean;
}

export type RunStatus = "ok" | "review" | "blocked" | "denied";

/** Row shape consumed by the side panel on the Ask tab and the table on
 *  the Runs tab. `query` is a one-line summary of the tool args (see
 *  `summariseArgs`); `rows` is `null` when the activity row doesn't carry
 *  a `rowCount`. */
export interface RunRow {
  id: string;
  tool: string;
  query: string;
  when: string;
  status: RunStatus;
  durationMs: number | null;
  rows: number | null;
  /** Raw ISO timestamp from `activity.createdAt`. The CSV export uses this
   *  unmodified instead of the relative `when` string so spreadsheets can
   *  sort the column as a date. */
  ts: string;
  /** Short error string (or `null` when the run succeeded). Surfaces in
   *  the Runs table next to the status icon. */
  error: string | null;
}

/** Project a raw `activity` row into the shape the Ask AI tabs render.
 *  Exported so the Runs tab (`RunsTab` below) can call it without going
 *  through the AskAiPage scope. Status derivation:
 *    - `ok` whenever `response.ok === true`
 *    - `blocked` if the error string mentions an MCP guard
 *      (`read-only` / `allowlist` / `mcp_read_only`)
 *    - `denied` for everything else
 *    - `review` is currently unreachable from server-recorded activity
 *      (the planner doesn't write "pending" rows) — the union still
 *      includes it so the Runs tab's filter chip can render a 0-count
 *      `Review` bucket without a type cast.
 */
export const mapActivityToRun = (row: ApiActivity): RunRow => {
  const action = row.action.startsWith("mcp.") ? row.action.slice(4) : row.action;
  const payload = row.payload as { args?: unknown; tool?: unknown } | null;
  const response = row.response as
    | { ok?: boolean; error?: unknown; rowCount?: number }
    | null;
  const errStr = typeof response?.error === "string" ? response.error : null;
  const status: RunStatus = response?.ok
    ? "ok"
    : errStr && /read-only|allowlist|mcp_read_only/i.test(errStr)
      ? "blocked"
      : "denied";
  return {
    id: row.id,
    tool: action,
    query: summariseArgs(payload?.args),
    when: relativeWhen(row.createdAt),
    status,
    durationMs: row.durationMs,
    rows: typeof response?.rowCount === "number" ? response.rowCount : null,
    ts: row.createdAt,
    error: errStr,
  };
};

const STORAGE_AUTO_RUN = "backlex.askai.autoRun";
const STORAGE_MODEL = "backlex.askai.model";

const readBoolPref = (key: string, fallback: boolean): boolean => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === "1" || raw === "true";
  } catch {
    return fallback;
  }
};

const readStringPref = (key: string, fallback: string): string => {
  if (typeof window === "undefined") return fallback;
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};

/** Bring a persisted model id forward from the pre-gateway era. Older
 *  installs stored bare Anthropic ids (`claude-haiku-4-5`); the gateway
 *  expects `anthropic/claude-haiku-4-5`. Silently rewrite when we see a
 *  prefix-less value so the dropdown highlights the right row on first
 *  paint instead of falling back to DEFAULT_MODEL. */
const readModelPref = (fallback: string): string => {
  const raw = readStringPref(STORAGE_MODEL, fallback);
  return raw.includes("/") ? raw : `anthropic/${raw}`;
};

const writePref = (key: string, value: string): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable — silent
  }
};

export function AskAiPage({
  pushToast,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  // Defined inside the component so the `t` macro picks them up at extract time.
  // Ids + labels are deliberately plain — model identifiers never localize;
  // only the per-row description (`hint`) goes through `t``.
  const MODELS = useMemo<ModelOption[]>(
    () => [
      {
        id: "anthropic/claude-opus-4-7",
        label: "claude-opus-4-7",
        hint: t`highest reasoning · slower · ~3x cost`,
      },
      {
        id: "anthropic/claude-sonnet-4-6",
        label: "claude-sonnet-4-6",
        hint: t`balanced — recommended for most queries`,
        default: true,
      },
      {
        id: "anthropic/claude-haiku-4-5",
        label: "claude-haiku-4-5",
        hint: t`fast · cheap · routine reads`,
      },
      {
        id: "openai/gpt-5",
        label: "gpt-5",
        hint: t`OpenAI flagship; comparable to Opus`,
      },
      {
        id: "google/gemini-2.5-pro",
        label: "gemini-2.5-pro",
        hint: t`long context · multimodal`,
      },
      {
        id: "xai/grok-4.3",
        label: "grok-4.3",
        hint: t`xAI flagship · 1M context`,
      },
      {
        id: "xai/grok-build-0.1",
        label: "grok-build-0.1",
        hint: t`xAI · optimized for code agents · cheap`,
      },
      {
        id: "deepseek/deepseek-v4-pro",
        label: "deepseek-v4-pro",
        hint: t`strong reasoning · 1M context · low cost`,
      },
      {
        id: "deepseek/deepseek-v4-flash",
        label: "deepseek-v4-flash",
        hint: t`fast · very cheap · routine reads`,
      },
      {
        id: "alibaba/qwen3.7-max",
        label: "qwen3.7-max",
        hint: t`Qwen flagship · 1M context · strong multilingual`,
      },
      {
        id: "alibaba/qwen3.6-plus",
        label: "qwen3.6-plus",
        hint: t`Qwen mid-tier · balanced pricing`,
      },
    ],
    [t],
  );
  // `prompt` strings stay English — the planner LLM consumes them, not the user.
  const EXAMPLES = useMemo(
    () => [
      {
        label: t`Top customers by spend`,
        prompt: "top customers by total spent in the last 30 days, limit 10",
      },
      {
        label: t`Orders by status`,
        prompt: "count of orders grouped by status",
      },
      {
        label: t`Published posts past week`,
        prompt:
          "posts published in the past 7 days, status published, sorted by view_count desc",
      },
      {
        label: t`Comments needing moderation`,
        prompt:
          "comments flagged for moderation older than 24h, include author email",
      },
      {
        label: t`Draft support_tickets schema`,
        prompt:
          "design a support_tickets collection — subject, body, requester (relation to app_users), priority enum, status workflow, assigned_to",
      },
    ],
    [t],
  );
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [phase, setPhase] = useState<
    "idle" | "thinking" | "plan" | "running" | "done"
  >("idle");
  const [plan, setPlan] = useState<PlanResponse["data"] | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [argsDraft, setArgsDraft] = useState("");
  const [argsError, setArgsError] = useState<string | null>(null);
  const [autoRun, setAutoRun] = useState(() =>
    readBoolPref(STORAGE_AUTO_RUN, true),
  );
  const [model, setModel] = useState(() => readModelPref(DEFAULT_MODEL));
  const [result, setResult] = useState<RunResponse | null>(null);
  const [recent, setRecent] = useState<RunRow[]>([]);
  const [tab, setTab] = useState<"ask" | "tools" | "runs" | "connect">("ask");
  // pak_* keys are fetched once at the page level so Tools (right rail
  // editor) and Connect (snippet picker) can share the selection — flipping
  // tabs doesn't refetch or reset which key is active.
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const refreshKeys = useCallback(async () => {
    try {
      const res = await api<{ data: ApiKeyRow[] }>("/api/api-keys");
      // Filter out revoked / expired keys — they can't authenticate MCP
      // calls so showing them in the picker would be misleading. The list
      // is already user-scoped server-side (non-admins only see their own;
      // admins see every key in the workspace) so no further filtering.
      const live = res.data.filter(
        (k) => !k.revokedAt && (!k.expiresAt || new Date(k.expiresAt).getTime() > Date.now()),
      );
      setKeys(live);
      setSelectedKeyId((prev) => prev ?? live[0]?.id ?? null);
    } catch {
      // Swallow — Tools/Connect right rails handle empty lists gracefully.
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshKeys();
  }, [refreshKeys]);

  useEffect(() => {
    writePref(STORAGE_AUTO_RUN, autoRun ? "1" : "0");
  }, [autoRun]);
  useEffect(() => {
    writePref(STORAGE_MODEL, model);
  }, [model]);

  const refreshRecent = useCallback(async () => {
    try {
      const r = await activityApi.list({ action: "mcp.", limit: 10 });
      setRecent(r.data.map(mapActivityToRun));
    } catch {
      // Quietly leave the list as-is — the panel just stays empty.
    }
  }, []);

  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  const isWrite = plan ? WRITE_PATTERN.test(plan.tool) : false;
  const isDestructive = plan ? DESTRUCTIVE_PATTERN.test(plan.tool) : false;

  const runPlan = useCallback(
    async (p: PlanResponse["data"]) => {
      setPhase("running");
      try {
        const res = await api<RunResponse>("/api/admin/ai/run", {
          method: "POST",
          body: JSON.stringify({ tool: p.tool, args: p.args }),
        });
        setResult(res);
        setPhase("done");
        if (res.ok) {
          const count =
            typeof res.rowCount === "number" ? res.rowCount : undefined;
          pushToast(
            count != null
              ? t`Tool ok — ${count} rows`
              : t`Tool ok`,
          );
        } else {
          pushToast(res.error ?? t`Tool failed`, "error");
        }
        void refreshRecent();
      } catch (e) {
        setPhase("plan");
        pushToast((e as Error).message, "error");
      }
    },
    [pushToast, refreshRecent, t],
  );

  const submit = useCallback(async () => {
    const value = prompt.trim();
    if (!value) return;
    setPhase("thinking");
    setPlan(null);
    setResult(null);
    setEditing(false);
    setArgsError(null);
    setPlanError(null);
    try {
      const res = await api<PlanResponse>("/api/admin/ai/plan", {
        method: "POST",
        body: JSON.stringify({ prompt: value, model }),
      });
      setPlan(res.data);
      setArgsDraft(JSON.stringify(res.data.args, null, 2));
      setPhase("plan");
      if (autoRun && AUTO_RUN_PATTERN.test(res.data.tool)) {
        await runPlan(res.data);
      }
    } catch (e) {
      setPhase("idle");
      setPlanError((e as Error).message);
      pushToast((e as Error).message, "error");
    }
  }, [autoRun, model, prompt, pushToast, runPlan]);

  const applyArgs = () => {
    if (!plan) return;
    try {
      const next = JSON.parse(argsDraft) as Record<string, unknown>;
      setPlan({ ...plan, args: next });
      setEditing(false);
      setArgsError(null);
      pushToast(t`Args updated`);
    } catch (e) {
      setArgsError((e as Error).message);
    }
  };

  const copyArgs = () => {
    if (!plan) return;
    try {
      navigator.clipboard.writeText(JSON.stringify(plan.args, null, 2));
      pushToast(t`Args copied`);
    } catch {
      // no clipboard — silent
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={<Trans>Ask AI</Trans>}
        badges={
          <Badge variant="default" mono>
            <Trans>MCP · {MCP_TOOL_COUNT} tools</Trans>
          </Badge>
        }
        description={
          <Trans>
            Translate natural language into Directus-shaped queries, draft schemas,
            and dispatch any MCP tool — scoped to your role and the per-key
            allowlist. The same surface Claude Desktop sees.
          </Trans>
        }
      />

      <div className="-mx-1 overflow-x-auto px-1">
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="whitespace-nowrap">
            <TabsTrigger value="ask">
              <I.Sparkles size={13} />
              <Trans>Ask</Trans>
            </TabsTrigger>
            <TabsTrigger value="tools">
              <I.Layers size={13} />
              <Trans>Tools</Trans>
            </TabsTrigger>
            <TabsTrigger value="runs">
              <I.History size={13} />
              <Trans>Runs</Trans>
            </TabsTrigger>
            <TabsTrigger value="connect">
              <I.Plug size={13} />
              <Trans>Connect</Trans>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === "tools" && (
        <ToolsTab
          pushToast={pushToast}
          keys={keys}
          keysLoading={keysLoading}
          selectedKeyId={selectedKeyId}
          setSelectedKeyId={setSelectedKeyId}
          refreshKeys={refreshKeys}
        />
      )}
      {tab === "runs" && <RunsTab pushToast={pushToast} />}
      {tab === "connect" && (
        <ConnectTab
          pushToast={pushToast}
          keys={keys}
          keysLoading={keysLoading}
          selectedKeyId={selectedKeyId}
          setSelectedKeyId={setSelectedKeyId}
        />
      )}

      {tab === "ask" && (
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center gap-2 px-5 pt-4 pb-2">
              <I.Sparkles size={14} className="text-primary" />
              <span className="text-[12px] font-medium">
                <Trans>Ask in natural language</Trans>
              </span>
              <div className="ml-auto flex items-center gap-3 text-[11.5px] text-muted-foreground">
                <ModelPicker value={model} onChange={setModel} models={MODELS} />
                <span className="hidden items-center gap-1.5 sm:inline-flex">
                  <Trans>auto-run reads</Trans>
                  <Switch checked={autoRun} onChange={setAutoRun} />
                </span>
              </div>
            </div>
            <div className="px-5 pb-3">
              <Textarea
                ref={taRef}
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void submit();
                  }
                }}
                placeholder={t`e.g. posts published in the past 7 days, sorted by view_count desc`}
                className="min-h-0 rounded-none border-0 bg-transparent p-0 text-[15px] placeholder:text-muted-foreground/70 focus-visible:ring-0"
              />
            </div>
            <div className="flex items-center gap-2 border-t border-border bg-card px-5 py-3">
              <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-muted-foreground">
                  ⌘
                </kbd>
                <kbd className="rounded-md border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px] leading-none text-muted-foreground">
                  ↵
                </kbd>
                <span><Trans>to run</Trans></span>
              </div>
              <div className="ml-auto flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  icon={I.X}
                  onClick={() => {
                    setPrompt("");
                    setPhase("idle");
                    setPlan(null);
                    setResult(null);
                    setPlanError(null);
                  }}
                >
                  <Trans>Clear</Trans>
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  icon={phase === "thinking" || phase === "running" ? I.Loader : I.Send}
                  disabled={
                    !prompt.trim() ||
                    phase === "thinking" ||
                    phase === "running"
                  }
                  onClick={() => {
                    void submit();
                  }}
                >
                  {phase === "thinking" ? (
                    <Trans>Planning…</Trans>
                  ) : phase === "running" ? (
                    <Trans>Running…</Trans>
                  ) : (
                    <Trans>Run</Trans>
                  )}
                </Button>
              </div>
            </div>
          </div>

          {phase === "idle" && !planError && (
            <div className="flex flex-wrap gap-2">
              <span className="mr-1 self-center text-[11.5px] uppercase tracking-wider text-muted-foreground">
                <Trans>Try</Trans>
              </span>
              {EXAMPLES.map((e) => (
                <Button
                  key={e.label}
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setPrompt(e.prompt);
                    taRef.current?.focus();
                  }}
                >
                  {e.label}
                </Button>
              ))}
            </div>
          )}

          {planError && (
            <div className="rounded-2xl border border-destructive/40 bg-destructive/5 px-5 py-4 text-[12.5px] text-destructive">
              {planError}
            </div>
          )}

          {phase === "thinking" && (
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="flex flex-col items-start gap-4 px-5 py-7">
                <div className="flex items-center gap-2.5 text-[13px] font-medium">
                  <I.Brain size={14} className="text-primary" />
                  <span><Trans>Planning the tool call…</Trans></span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  <Trans>asking {model}…</Trans>
                </div>
              </div>
            </div>
          )}

          {plan && phase !== "thinking" && phase !== "idle" && (
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2">
                <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-primary">
                  <I.Brain size={13} />
                </span>
                <span className="text-[13px] font-semibold">
                  <Trans>Plan</Trans>
                </span>
                <span className="font-mono text-[11.5px] text-muted-foreground">
                  →
                </span>
                <Badge variant="outline" mono>
                  {plan.tool}
                </Badge>
                <ToolKindBadge destructive={isDestructive} write={isWrite} />
                <div className="ml-auto flex items-center gap-1">
                  {!editing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={I.Pencil}
                      onClick={() => setEditing(true)}
                      title={t`Edit args`}
                    >
                      <span className="sr-only"><Trans>Edit args</Trans></span>
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={I.Copy}
                    onClick={copyArgs}
                    title={t`Copy JSON`}
                  >
                    <span className="sr-only"><Trans>Copy JSON</Trans></span>
                  </Button>
                </div>
              </div>
              <div className="px-5 pt-2 pb-1 text-[12.5px] leading-relaxed text-muted-foreground">
                {plan.rationale}
              </div>
              <div className="px-5 py-3">
                <div className="rounded-xl border border-border bg-muted/40 p-4">
                  {editing ? (
                    <>
                      <Textarea
                        value={argsDraft}
                        onChange={(e) => setArgsDraft(e.target.value)}
                        rows={Math.min(20, argsDraft.split("\n").length + 1)}
                        className="font-mono text-[12px]"
                      />
                      {argsError && (
                        <div className="mt-2 font-mono text-[11.5px] text-destructive">
                          {argsError}
                        </div>
                      )}
                      <div className="mt-3 flex gap-2">
                        <Button
                          variant="primary"
                          size="sm"
                          icon={I.Check}
                          onClick={applyArgs}
                        >
                          <Trans>Apply</Trans>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setEditing(false);
                            setArgsDraft(JSON.stringify(plan.args, null, 2));
                            setArgsError(null);
                          }}
                        >
                          <Trans>Cancel</Trans>
                        </Button>
                      </div>
                    </>
                  ) : (
                    <JsonBlock value={plan.args} />
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-3">
                <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <I.Eye size={12} />
                    <Trans>Permissions DSL will filter rows</Trans>
                  </span>
                  {isWrite && (
                    <span className="inline-flex items-center gap-1.5 text-[oklch(0.48_0.13_70)] dark:text-[oklch(0.82_0.14_70)]">
                      <I.AlertTriangle size={12} />
                      <Trans>Mutation — requires confirmation</Trans>
                    </span>
                  )}
                </div>
                <div className="ml-auto flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setPlan(null);
                      setResult(null);
                      setPhase("idle");
                    }}
                  >
                    <Trans>Reject</Trans>
                  </Button>
                  <Button
                    variant={isDestructive ? "destructive" : "primary"}
                    size="sm"
                    icon={
                      phase === "running"
                        ? I.Loader
                        : isDestructive
                          ? I.AlertTriangle
                          : I.Play
                    }
                    disabled={phase === "running" || editing}
                    onClick={() => {
                      void runPlan(plan);
                    }}
                  >
                    {phase === "running" ? (
                      <Trans>Running…</Trans>
                    ) : isDestructive ? (
                      <Trans>Confirm & run</Trans>
                    ) : isWrite ? (
                      <Trans>Approve & run</Trans>
                    ) : (
                      <Trans>Run</Trans>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {result && (phase === "done" || phase === "running") && (
            <ResultCard
              tool={result.tool}
              ok={result.ok}
              rowCount={result.rowCount ?? null}
              durationMs={result.durationMs}
              result={result.result ?? null}
              error={result.error ?? null}
              pending={phase === "running"}
            />
          )}
        </div>

        {/* Recent runs side panel */}
        <div className="overflow-hidden rounded-2xl border border-border bg-card xl:sticky xl:top-4">
          <div className="flex items-center gap-2 px-5 pt-4 pb-3">
            <I.History size={13} className="text-muted-foreground" />
            <span className="text-[13px] font-semibold">
              <Trans>Recent runs</Trans>
            </span>
            <Badge variant="secondary" mono>
              {recent.length}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              icon={I.Refresh}
              className="ml-auto"
              onClick={() => {
                void refreshRecent();
              }}
              title={t`Refresh`}
            >
              <span className="sr-only"><Trans>Refresh</Trans></span>
            </Button>
          </div>
          {recent.length === 0 ? (
            <div className="border-t border-border px-5 py-8 text-center text-[12.5px] text-muted-foreground">
              <Trans>No runs yet — your tool calls will show up here.</Trans>
            </div>
          ) : (
            <ScrollArea className="border-t border-border" viewportClassName="max-h-[480px]">
              <div>
                {recent.map((r) => (
                  <div
                    key={r.id}
                    className="flex flex-col gap-1.5 border-b border-border/60 px-4 py-3 last:border-b-0"
                  >
                    <div className="flex items-center gap-2 text-[12px]">
                      <RunStatusIcon status={r.status} />
                      <span className="flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        {r.tool}
                      </span>
                      <span className="font-mono text-[10.5px] text-muted-foreground">
                        {r.when}
                      </span>
                    </div>
                    <div className="truncate text-[12.5px] text-foreground/85">
                      {r.query}
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[10.5px] tabular-nums text-muted-foreground">
                      {r.rows != null && r.rows > 0 && (
                        <span>{r.rows} <Trans>rows</Trans></span>
                      )}
                      {r.durationMs != null && <span>{r.durationMs}ms</span>}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function ResultCard({
  tool,
  ok,
  rowCount,
  durationMs,
  result,
  error,
  pending,
}: {
  tool: string;
  ok: boolean;
  rowCount: number | null;
  durationMs: number;
  result: {
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  } | null;
  error: string | null;
  pending: boolean;
}) {
  const text = useMemo(() => {
    if (!ok || !result) return null;
    if (result.structuredContent !== undefined) {
      return JSON.stringify(result.structuredContent, null, 2);
    }
    return (result.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text!)
      .join("\n");
  }, [ok, result]);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-3">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-primary/15 text-primary">
          {ok ? <I.CheckCircle size={13} /> : <I.AlertTriangle size={13} />}
        </span>
        <span className="text-[13px] font-semibold">
          {pending ? <Trans>Running…</Trans> : ok ? <Trans>Result</Trans> : <Trans>Error</Trans>}
        </span>
        <Badge variant="secondary" mono>
          {tool}
        </Badge>
        <div className="ml-auto flex items-center gap-3 text-[11.5px] text-muted-foreground">
          {rowCount != null && (
            <span>
              <span className="text-muted-foreground/80"><Trans>rows</Trans></span>{" "}
              <span className="font-mono tabular-nums">{rowCount}</span>
            </span>
          )}
          <span>
            <span className="text-muted-foreground/80"><Trans>latency</Trans></span>{" "}
            <span className="font-mono tabular-nums">{durationMs}ms</span>
          </span>
        </div>
      </div>
      <ScrollArea className="border-t border-border" viewportClassName="max-h-[480px]">
        <div className="p-4">
          {ok ? (
            text ? (
              <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-foreground">
                {text}
              </pre>
            ) : (
              <div className="text-[12px] text-muted-foreground">
                <Trans>(no body)</Trans>
              </div>
            )
          ) : (
            <pre className="m-0 whitespace-pre-wrap break-words font-mono text-[12px] leading-[1.55] text-destructive">
              {error ?? "Tool failed"}
            </pre>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ─── Shared helpers (Tools + Connect right rails) ─────────────────────────

/** Per-API-key picker shared by the Tools right rail and the Connect tab.
 *  Renders a shadcn Select with the key's name + `pak_<prefix>` hint. The
 *  list is filtered at the page level (revoked / expired keys removed).  */
function KeyPicker({
  keys,
  keysLoading,
  selectedKeyId,
  setSelectedKeyId,
}: {
  keys: ApiKeyRow[];
  keysLoading: boolean;
  selectedKeyId: string | null;
  setSelectedKeyId: (id: string) => void;
}) {
  const { t } = useLingui();
  if (keysLoading) {
    return (
      <div className="text-[12px] text-muted-foreground">
        <Trans>Loading keys…</Trans>
      </div>
    );
  }
  if (keys.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">
        <Trans>
          No live keys — create one on the{" "}
          <a className="font-mono underline" href="/api-keys">
            API Keys
          </a>{" "}
          page first.
        </Trans>
      </div>
    );
  }
  return (
    <Select value={selectedKeyId ?? undefined} onValueChange={setSelectedKeyId}>
      <SelectTrigger className="w-full" aria-label={t`Active API key`}>
        <SelectValue placeholder={t`Pick a key`} />
      </SelectTrigger>
      <SelectContent>
        {keys.map((k) => (
          <SelectItem key={k.id} value={k.id}>
            <span className="flex items-center gap-2">
              <span>{k.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {k.prefix}_…
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ─── Tools tab ────────────────────────────────────────────────────────────

function ToolKindPill({ kind }: { kind: "read" | "write" | "destruct" }) {
  if (kind === "destruct") {
    return (
      <Badge variant="destructive" mono>
        destruct
      </Badge>
    );
  }
  if (kind === "write") {
    return (
      <Badge
        variant="outline"
        mono
        className="border-amber-500/40 text-amber-700 dark:text-amber-300"
      >
        write
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      mono
      className="border-sky-500/40 text-sky-700 dark:text-sky-300"
    >
      read
    </Badge>
  );
}

function ToolsTab({
  pushToast,
  keys,
  keysLoading,
  selectedKeyId,
  setSelectedKeyId,
  refreshKeys,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
  keys: ApiKeyRow[];
  keysLoading: boolean;
  selectedKeyId: string | null;
  setSelectedKeyId: (id: string) => void;
  refreshKeys: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [tools, setTools] = useState<McpToolDescriptor[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [q, setQ] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set<string>());
  const [modalOpen, setModalOpen] = useState(false);
  // Optimistic shadow of the selected key's `mcpTools` field so per-tool
  // switches feel instant. `undefined` means "use the server-side value";
  // we only populate it once the user toggles something, and reset when
  // the selection changes or the parent refreshes the key list.
  const [pendingAllowlist, setPendingAllowlist] = useState<string[] | null | undefined>(
    undefined,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setToolsLoading(true);
    (async () => {
      try {
        const body = await api<{
          result?: { tools: McpToolDescriptor[] };
        }>("/api/admin/mcp", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        setTools(body.result?.tools ?? []);
      } catch (e) {
        pushToast((e as Error).message, "error");
        setTools([]);
      } finally {
        setToolsLoading(false);
      }
    })();
  }, [pushToast]);

  // Group by namespace prefix (`collections.*`, `schema.*`, …). Tools
  // without a dot (none today) fall into an "other" bucket.
  const groups = useMemo(() => {
    if (!tools) return [] as Array<{ id: string; tools: McpToolDescriptor[] }>;
    const term = q.trim().toLowerCase();
    const filtered = term
      ? tools.filter(
          (t) =>
            t.name.toLowerCase().includes(term) ||
            t.description.toLowerCase().includes(term),
        )
      : tools;
    const byNs = new Map<string, McpToolDescriptor[]>();
    for (const t of filtered) {
      const dot = t.name.indexOf(".");
      const ns = dot < 0 ? "other" : t.name.slice(0, dot);
      const bucket = byNs.get(ns) ?? [];
      bucket.push(t);
      byNs.set(ns, bucket);
    }
    return [...byNs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, tools]) => ({ id, tools }));
  }, [tools, q]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedKey = keys.find((k) => k.id === selectedKeyId) ?? null;
  const totalTools = tools?.length ?? 0;
  // Pending state takes precedence so the UI never flickers back to the
  // server value between an optimistic toggle and the debounced PATCH.
  const effectiveAllowlist: string[] | null =
    pendingAllowlist !== undefined ? pendingAllowlist : selectedKey?.mcpTools ?? null;
  const allowlistSize = effectiveAllowlist === null ? null : effectiveAllowlist.length;

  // Drop optimistic state whenever the picker switches to a different key,
  // otherwise the previous key's pending changes would bleed onto the next
  // key's switches until the user toggles something.
  useEffect(() => {
    setPendingAllowlist(undefined);
  }, [selectedKeyId]);

  // Same idea after a successful refetch — the parent has the up-to-date
  // server value and our optimistic shadow is no longer needed.
  useEffect(() => {
    setPendingAllowlist(undefined);
  }, [selectedKey?.mcpTools]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const patchGuard = async (patch: {
    mcpReadOnly?: boolean;
    mcpTools?: string[] | null;
  }) => {
    if (!selectedKey) return;
    try {
      await api(`/api/api-keys/${selectedKey.id}/mcp-guards`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      pushToast(t`Guards updated`);
      void refreshKeys();
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  };

  // Per-row switch handler. Semantics:
  //   - server `null`  → every switch shows ON (permissive). Flipping a
  //     row OFF activates allowlist mode with every other tool included.
  //   - server `[]`    → every switch shows OFF. Flipping ON adds X.
  //   - server `[…]`   → membership; flip adds/removes the name.
  // Local state updates immediately; the actual PATCH is debounced 200ms
  // so a quick burst of toggles collapses into one network round-trip.
  const toggleTool = (name: string, next: boolean) => {
    if (!selectedKey) return;
    if (totalTools === 0) return;
    const allToolNames = tools?.map((t) => t.name) ?? [];
    const current = effectiveAllowlist;
    let nextAllowlist: string[];
    if (current === null) {
      if (next) return;
      nextAllowlist = allToolNames.filter((n) => n !== name);
    } else if (next) {
      if (current.includes(name)) return;
      nextAllowlist = [...current, name];
    } else {
      if (!current.includes(name)) return;
      nextAllowlist = current.filter((n) => n !== name);
    }
    setPendingAllowlist(nextAllowlist);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          await api(`/api/api-keys/${selectedKey.id}/mcp-guards`, {
            method: "PATCH",
            body: JSON.stringify({ mcpTools: nextAllowlist }),
          });
          void refreshKeys();
        } catch (e) {
          // Revert the optimistic edit and surface the error — the user
          // sees the switch snap back so they know the change didn't land.
          setPendingAllowlist(undefined);
          pushToast((e as Error).message, "error");
        }
      })();
    }, 200);
  };

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_340px]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-3 px-5 pt-4 pb-3">
            <I.Layers size={14} />
            <span className="text-[13px] font-semibold">
              <Trans>MCP tool catalog</Trans>
            </span>
            <Badge variant="secondary" mono>
              {totalTools} <Trans>tools</Trans>
            </Badge>
            <div className="relative ml-auto w-72">
              <I.Search
                size={13}
                className="absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t`Filter tools…`}
                aria-label={t`Filter tools`}
                className="h-8 w-full rounded-full border border-border bg-card pr-3 pl-9 text-[12.5px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
              />
            </div>
          </div>
          <div className="border-t border-border">
            {toolsLoading ? (
              <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground">
                <Trans>Loading tool catalog…</Trans>
              </div>
            ) : groups.length === 0 ? (
              <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground">
                <Trans>No tools match this filter.</Trans>
              </div>
            ) : (
              groups.map((g) => {
                const open = openGroups.has(g.id);
                return (
                  <div key={g.id} className="border-b border-border/60 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.id)}
                      className="flex h-11 w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-5 text-left hover:bg-accent/40"
                    >
                      <I.ChevronRight
                        size={12}
                        className={
                          open
                            ? "rotate-90 text-muted-foreground transition-transform"
                            : "text-muted-foreground transition-transform"
                        }
                      />
                      <I.Database size={13} className="text-muted-foreground" />
                      <span className="text-[13px] font-medium uppercase tracking-wider">
                        {g.id}
                      </span>
                      <Badge variant="secondary" mono>
                        {g.tools.length}
                      </Badge>
                    </button>
                    {open && (
                      <div className="border-t border-border/60 bg-muted/30">
                        {g.tools.map((tool) => {
                          // Switch state: null effective allowlist ⇒ everything
                          // ON (permissive); array ⇒ membership check.
                          const enabled =
                            effectiveAllowlist === null
                              ? true
                              : effectiveAllowlist.includes(tool.name);
                          return (
                            <div
                              key={tool.name}
                              className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border/40 px-5 py-3 last:border-b-0"
                            >
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-[12.5px]">
                                    {tool.name}
                                  </span>
                                  <ToolKindPill kind={tool.kind} />
                                  {tool.adminOnly && (
                                    <Badge
                                      variant="outline"
                                      mono
                                      className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                                    >
                                      admin
                                    </Badge>
                                  )}
                                  {tool.name.startsWith("ai.") && (
                                    <Badge
                                      variant="outline"
                                      mono
                                      className="border-sky-500/40 text-sky-700 dark:text-sky-300"
                                    >
                                      ai
                                    </Badge>
                                  )}
                                </div>
                                <p className="m-0 truncate text-[11.5px] text-muted-foreground">
                                  {tool.description}
                                </p>
                              </div>
                              <Switch
                                checked={enabled}
                                disabled={!selectedKey}
                                aria-label={tool.name}
                                onChange={(next) => toggleTool(tool.name, next)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="flex flex-col gap-4 xl:sticky xl:top-4">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center gap-2 px-5 pt-4 pb-3">
              <I.Key size={13} />
              <span className="text-[13px] font-semibold">
                <Trans>Active key guards</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-3 px-5 pt-2 pb-4">
              <KeyPicker
                keys={keys}
                keysLoading={keysLoading}
                selectedKeyId={selectedKeyId}
                setSelectedKeyId={setSelectedKeyId}
              />
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-[12.5px] font-medium">
                    <Trans>Read-only mode</Trans>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>Blocks every write tool at the dispatcher.</Trans>
                  </span>
                </div>
                <Switch
                  checked={selectedKey?.mcpReadOnly === true}
                  disabled={!selectedKey}
                  onChange={(next) => {
                    void patchGuard({ mcpReadOnly: next });
                  }}
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-[12.5px] font-medium">
                    <Trans>Tool allowlist</Trans>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {selectedKey === null ? (
                      <Trans>Pick a key to manage its allowlist.</Trans>
                    ) : allowlistSize === null ? (
                      <Trans>All {totalTools} tools allowed.</Trans>
                    ) : (
                      <Trans>{allowlistSize} of {totalTools} tools enabled.</Trans>
                    )}
                  </span>
                  {selectedKey !== null && (
                    <span className="mt-1 text-[11px] text-muted-foreground">
                      <Trans>Toggle tools below to edit the allowlist.</Trans>
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!selectedKey}
                  onClick={() => setModalOpen(true)}
                >
                  <Trans>Customize…</Trans>
                </Button>
              </div>
            </div>
            <div className="border-t border-border bg-muted/40 px-5 py-4">
              <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                PATCH
              </div>
              <pre className="m-0 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {`curl -X PATCH $BACKLEX_URL/api/api-keys/<id>/mcp-guards \\
  -H "Authorization: Bearer pak_<admin>" \\
  -H "Content-Type: application/json" \\
  -d '{"mcpReadOnly": ${selectedKey?.mcpReadOnly === true ? "true" : "false"}}'`}
              </pre>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="flex items-center gap-2 px-5 pt-4 pb-3">
              <I.Globe size={13} />
              <span className="text-[13px] font-semibold">
                <Trans>Endpoints</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-2.5 px-5 pb-4 text-[12px]">
              <div className="flex items-start gap-3">
                <Badge variant="outline" mono>
                  POST
                </Badge>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[12px]">/mcp</span>
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>Tenant agents. DSL-filtered.</Trans>
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Badge variant="outline" mono>
                  POST
                </Badge>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[12px]">/api/admin/mcp</span>
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>Ops bots — admin role required.</Trans>
                  </span>
                </div>
              </div>
              <div className="mt-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
                <Trans>
                  Stateless Streamable HTTP. No{" "}
                  <span className="font-mono">GET /mcp</span> (resumable SSE) yet.
                </Trans>
              </div>
            </div>
          </div>
        </div>
      </div>

      {selectedKey && (
        <McpKeyModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          keyId={selectedKey.id}
          keyPrefix={selectedKey.prefix}
          keyName={selectedKey.name}
          initialSecret={null}
          initialAllowlist={selectedKey.mcpTools}
          initialReadOnly={selectedKey.mcpReadOnly}
          onSaved={() => {
            void refreshKeys();
          }}
        />
      )}
    </>
  );
}

// ─── Runs tab ─────────────────────────────────────────────────────────────

type RunFilter = "all" | "ok" | "review" | "denied";

function RunsTab({
  pushToast,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const [rows, setRows] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<RunFilter>("all");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await activityApi.list({ action: "mcp.", limit: 200 });
      setRows(r.data.map(mapActivityToRun));
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const counts = useMemo(
    () => ({
      all: rows.length,
      ok: rows.filter((r) => r.status === "ok").length,
      review: rows.filter((r) => r.status === "review").length,
      denied: rows.filter((r) => r.status === "denied" || r.status === "blocked").length,
    }),
    [rows],
  );

  const visible = useMemo(() => {
    if (filter === "all") return rows;
    if (filter === "denied")
      return rows.filter((r) => r.status === "denied" || r.status === "blocked");
    return rows.filter((r) => r.status === filter);
  }, [rows, filter]);

  const exportCsv = () => {
    if (visible.length === 0) {
      pushToast(t`Nothing to export — the current view is empty.`, "error");
      return;
    }
    try {
      const out = visible.map((r) => ({
        when: r.ts,
        tool: r.tool,
        query: r.query,
        status: r.status,
        rows: r.rows ?? "",
        durationMs: r.durationMs ?? "",
        error: r.error ?? "",
      }));
      exportToCsv(out, "mcp-runs.csv", [
        "when",
        "tool",
        "query",
        "status",
        "rows",
        "durationMs",
        "error",
      ]);
      pushToast(t`Exported ${visible.length} rows as mcp-runs.csv.`);
    } catch {
      pushToast(t`Could not export runs.`, "error");
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="-mx-1 overflow-x-auto px-1">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as RunFilter)}>
            <TabsList className="whitespace-nowrap">
              <TabsTrigger value="all">
                <Trans>All</Trans>
                <Badge variant="secondary" mono>
                  {counts.all}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="ok">
                <Trans>Success</Trans>
                <Badge variant="secondary" mono>
                  {counts.ok}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="review">
                <Trans>Review</Trans>
                <Badge variant="secondary" mono>
                  {counts.review}
                </Badge>
              </TabsTrigger>
              <TabsTrigger value="denied">
                <Trans>Denied</Trans>
                <Badge variant="secondary" mono>
                  {counts.denied}
                </Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <Button
            variant="ghost"
            size="sm"
            icon={I.Refresh}
            onClick={() => {
              void refresh();
            }}
            title={t`Refresh`}
          >
            <span className="sr-only">
              <Trans>Refresh</Trans>
            </span>
          </Button>
          <Button variant="outline" size="sm" icon={I.Download} onClick={exportCsv}>
            <Trans>Export CSV</Trans>
          </Button>
        </div>
      </div>
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        {loading ? (
          <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground">
            <Trans>Loading runs…</Trans>
          </div>
        ) : visible.length === 0 ? (
          <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground">
            <Trans>No runs in this bucket yet.</Trans>
          </div>
        ) : (
          <ScrollArea viewportClassName="max-h-[640px]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] border-collapse text-[13px]">
                <thead>
                  <tr className="border-b border-border">
                    {[
                      t`When`,
                      t`Tool`,
                      t`Query`,
                      t`Result`,
                      t`Latency`,
                    ].map((h) => (
                      <th
                        key={h}
                        className="h-9 px-3 text-left text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground md:px-4"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr
                      key={r.id}
                      className="border-b border-border/60 last:border-b-0 hover:bg-accent/40"
                    >
                      <td className="h-12 px-3 align-middle font-mono text-[11.5px] text-muted-foreground md:px-4">
                        {r.when}
                      </td>
                      <td className="px-3 align-middle md:px-4">
                        <span className="font-mono text-[12px]">{r.tool}</span>
                      </td>
                      <td
                        className="max-w-md truncate px-3 align-middle text-foreground/85 md:px-4"
                        title={r.query}
                      >
                        {r.query}
                      </td>
                      <td className="px-3 align-middle md:px-4">
                        <span className="inline-flex items-center gap-1.5 text-[12px]">
                          <RunStatusIcon status={r.status} />
                          {r.status === "ok" && r.rows != null ? (
                            <span className="font-mono tabular-nums">
                              {r.rows} <Trans>rows</Trans>
                            </span>
                          ) : r.status === "ok" ? (
                            <Trans>ok</Trans>
                          ) : r.status === "blocked" ? (
                            <span className="text-muted-foreground">
                              <Trans>blocked</Trans>
                              {r.error ? (
                                <>
                                  {" · "}
                                  <span className="font-mono">{r.error}</span>
                                </>
                              ) : null}
                            </span>
                          ) : r.status === "review" ? (
                            <Trans>pending review</Trans>
                          ) : (
                            <span className="text-destructive">
                              {r.error ?? <Trans>denied</Trans>}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="px-3 align-middle font-mono tabular-nums text-muted-foreground md:px-4">
                        {r.durationMs != null ? `${r.durationMs}ms` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

// ─── Connect tab ──────────────────────────────────────────────────────────

type ConnectClient = "claude-desktop" | "cursor" | "curl";

function ConnectTab({
  pushToast,
  keys,
  keysLoading,
  selectedKeyId,
  setSelectedKeyId,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
  keys: ApiKeyRow[];
  keysLoading: boolean;
  selectedKeyId: string | null;
  setSelectedKeyId: (id: string) => void;
}) {
  const { t } = useLingui();
  const [client, setClient] = useState<ConnectClient>("claude-desktop");

  const mcpUrl = useMemo(() => {
    if (typeof window === "undefined") return "https://your-backlex.example.com/mcp";
    return `${window.location.origin}/mcp`;
  }, []);

  const selectedKey = keys.find((k) => k.id === selectedKeyId) ?? null;

  // The plaintext secret is unrecoverable after key creation; the snippet
  // bakes in `<prefix>_••••••••` so an admin pasting the config still has
  // a clear "replace this" placeholder. `prefix` already starts with `pak_`.
  const secretForSnippet = selectedKey
    ? `${selectedKey.prefix}_••••••••`
    : "pak_<prefix>_<paste-secret-here>";

  const snippet = useMemo(() => {
    if (client === "claude-desktop") return claudeDesktopSnippet(mcpUrl, secretForSnippet);
    if (client === "cursor") return cursorSnippet(mcpUrl, secretForSnippet);
    return curlSnippet(mcpUrl, secretForSnippet);
  }, [client, mcpUrl, secretForSnippet]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      pushToast(t`Snippet copied`);
    } catch {
      pushToast(t`Could not copy snippet — clipboard blocked.`, "error");
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_340px]">
      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-3">
          <I.Plug size={13} />
          <span className="text-[13px] font-semibold">
            <Trans>Connect an MCP client</Trans>
          </span>
          <div className="ml-auto">
            <Tabs
              value={client}
              onValueChange={(v) => setClient(v as ConnectClient)}
            >
              <TabsList>
                <TabsTrigger value="claude-desktop">
                  <Trans>Claude Desktop</Trans>
                </TabsTrigger>
                <TabsTrigger value="cursor">
                  <Trans>Cursor</Trans>
                </TabsTrigger>
                <TabsTrigger value="curl">
                  <Trans>curl</Trans>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
        <div className="border-t border-border bg-muted/30 px-5 py-3">
          <span className="mr-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Trans>API key</Trans>
          </span>
          <div className="mt-1 max-w-md">
            <KeyPicker
              keys={keys}
              keysLoading={keysLoading}
              selectedKeyId={selectedKeyId}
              setSelectedKeyId={setSelectedKeyId}
            />
          </div>
        </div>
        <div className="relative border-t border-border bg-[oklch(0.18_0.01_130)] text-[oklch(0.95_0.02_130)]">
          <button
            type="button"
            onClick={() => {
              void copy();
            }}
            className="absolute top-3 right-3 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-white/10 px-3 text-[11.5px] font-medium text-[oklch(0.95_0.02_130)] hover:bg-white/20"
          >
            <I.Copy size={12} />
            <Trans>Copy</Trans>
          </button>
          <ScrollArea viewportClassName="max-h-[420px]">
            <pre className="m-0 px-5 py-5 font-mono text-[12px] leading-[1.6] whitespace-pre">
              {snippet}
            </pre>
          </ScrollArea>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <span className="text-[11.5px] text-muted-foreground">
            {client === "claude-desktop" && (
              <Trans>
                Add to{" "}
                <span className="font-mono">
                  ~/Library/Application Support/Claude/claude_desktop_config.json
                </span>{" "}
                (macOS), restart Claude Desktop, then look under the plug icon.
              </Trans>
            )}
            {client === "cursor" && (
              <Trans>
                Settings → MCP → Add. Same JSON shape Claude Desktop uses.
              </Trans>
            )}
            {client === "curl" && (
              <Trans>
                Direct Streamable HTTP — useful for CI agents and smoke tests.
              </Trans>
            )}
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card">
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <I.Sparkles size={13} className="text-primary" />
          <span className="text-[13px] font-semibold">
            <Trans>Hosted Claude</Trans>
          </span>
          <Badge
            variant="outline"
            mono
            className="ml-1 border-amber-500/40 text-amber-700 dark:text-amber-300"
          >
            roadmap
          </Badge>
        </div>
        <div className="px-5 pb-4 text-[12.5px] text-muted-foreground">
          <Trans>
            OAuth-flow for hosted Claude (no paste-the-key step) is tracked as a
            separate epic.
          </Trans>
          <ul className="m-0 mt-2 list-disc space-y-1 pl-4 text-[12px]">
            <li>
              <Trans>
                Resumable SSE on{" "}
                <span className="font-mono text-foreground">GET /mcp</span>
              </Trans>
            </li>
            <li>
              <Trans>
                <span className="font-mono text-foreground">
                  resources/subscribe
                </span>{" "}
                for live tail
              </Trans>
            </li>
            <li>
              <Trans>OAuth scope mapping → backlex roles</Trans>
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
