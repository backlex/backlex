// Shared types, constants, and leaf components for the Ask-AI page tabs.
// Split out of the former 2100-line pages/ask-ai.tsx god-file.
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
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { type ApiActivity } from "../../api";
import { I } from "../../icons";
import { Badge, } from "../../ui";
import { Skeleton } from "@backlex/ui/components/skeleton";
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

export interface PlanResponse {
  data: {
    rationale: string;
    tool: string;
    args: Record<string, unknown>;
    model: string;
    usage?: unknown;
  };
}

export interface RunResponse {
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
export const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
export const DEFAULT_PROMPT =
  "top customers by total spent in the last 30 days, limit 10";

// Mirrors the planner's whitelist on the server. Auto-run only fires when
// the proposed tool is one of these read-leaning surfaces.
export const AUTO_RUN_PATTERN =
  /^(collections\.list|collections\.read|collections\.aggregate|storage\.list|vector\.search|schema\.|permissions\.simulate)/;
export const DESTRUCTIVE_PATTERN = /\b(delete|drop|revoke|suspend)\b/;
export const WRITE_PATTERN =
  /\b(insert|update|delete|drop|create|upload|grant|revoke|invoke|suspend|activate|assign|unassign|send|test)\b/;

// Bumping these only matters when the catalog grows; the badge in the page
// header surfaces the total so the docs page can stay accurate. Source of
// truth: apps/web/src/server/mcp/tools/index.ts::allTools.length.
export const MCP_TOOL_COUNT = 74;

/** Lightweight JSON syntax highlighter — ported verbatim from the design's
 *  `JsonBlock` (ai-mcp.jsx:257). Avoids pulling a code-editor dependency
 *  for pretty-printing static args. */
export function JsonBlock({ value }: { value: unknown }) {
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

export interface ModelOption {
  id: string;
  label: string;
  hint: string;
  default?: boolean;
}

export function useIsMobile(breakpoint = 640) {
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

export function ModelPickerList({
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
              className={`flex w-full cursor-pointer items-start gap-2.5 rounded-surface border-0 bg-transparent px-2.5 py-2 text-left hover:bg-accent ${value === m.id ? "bg-accent" : ""}`}
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

export function ModelPicker({
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

export function ToolKindBadge({
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

export function RunStatusIcon({ status }: { status: RunStatus }) {
  if (status === "ok") return <I.CheckCircle size={12} className="text-primary" />;
  if (status === "blocked") return <I.Lock size={12} className="text-muted-foreground" />;
  if (status === "review") return <I.Brain size={12} className="text-amber-600 dark:text-amber-300" />;
  return <I.XCircle size={12} className="text-destructive" />;
}

export function relativeWhen(input: string | number): string {
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

export function summariseArgs(args: unknown): string {
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

export interface ApiKeyRow {
  id: string;
  prefix: string;
  name: string;
  expiresAt: string | number | null;
  revokedAt: string | number | null;
  mcpTools: string[] | null;
  mcpReadOnly: boolean;
}

export interface McpToolDescriptor {
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

export const STORAGE_AUTO_RUN = "backlex.askai.autoRun";
export const STORAGE_MODEL = "backlex.askai.model";

export const readBoolPref = (key: string, fallback: boolean): boolean => {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return raw === "1" || raw === "true";
  } catch {
    return fallback;
  }
};

export const readStringPref = (key: string, fallback: string): string => {
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
export const readModelPref = (fallback: string): string => {
  const raw = readStringPref(STORAGE_MODEL, fallback);
  return raw.includes("/") ? raw : `anthropic/${raw}`;
};

export const writePref = (key: string, value: string): void => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // localStorage unavailable — silent
  }
};

export function KeyPicker({
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
      <div className="flex flex-col gap-2">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }
  if (keys.length === 0) {
    return (
      <div className="rounded-surface border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">
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
