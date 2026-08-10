// Ask-AI page shell (chat/plan/run) — tabs live in sibling modules.
// The directory preserves the historical ./pages/ask-ai import path.
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
import type { PushToast } from "../../types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@/lib/api";
import { activityApi, collectionsApi, type ApiCollection } from "../../api";
import { I } from "../../icons";
import { Badge, Button, EmptyState, PageHeader, Switch } from "../../ui";
import { useUrlTab } from "../../use-url-tab";
import { Card } from "@backlex/ui/components/card";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@backlex/ui/components/tabs";
import { ScrollArea } from "@backlex/ui/components/scroll-area";

import { ToolsTab } from "./tools-tab";
import { RunsTab } from "./runs-tab";
import { ConnectTab } from "./connect-tab";
import {
  AUTO_RUN_PATTERN,
  ApiKeyRow,
  DEFAULT_MODEL,
  DEFAULT_PROMPT,
  DESTRUCTIVE_PATTERN,
  JsonBlock,
  ModelOption,
  ModelPicker,
  PlanResponse,
  RunResponse,
  RunRow,
  RunStatusIcon,
  STORAGE_AUTO_RUN,
  STORAGE_MODEL,
  ToolKindBadge,
  WRITE_PATTERN,
  mapActivityToRun,
  readBoolPref,
  readModelPref,
  writePref,
} from "./shared";

// Primary gradient for the hero Run button — mirrors the Connect tab's copy
// button. Resolves from the `--primary` token so it tracks light + dark.
const PRIMARY_GRADIENT =
  "bg-[linear-gradient(135deg,var(--color-primary),color-mix(in_oklch,var(--color-primary)_78%,black))] text-primary-foreground";

const ASK_AI_TABS = ["ask", "tools", "runs", "connect"] as const;

export function AskAiPage({
  pushToast,
}: {
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  // Defined inside the component so the `t` macro picks them up at extract time.
  // Ids + labels are deliberately plain — model identifiers never localize;
  // only the per-row description (`hint`) goes through `t``.
  const MODELS = useMemo<ModelOption[]>(
    () => [
      {
        id: "anthropic/claude-opus-4-8",
        label: "claude-opus-4-8",
        hint: t`highest reasoning · slower · ~3x cost`,
      },
      {
        id: "anthropic/claude-sonnet-5",
        label: "claude-sonnet-5",
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
  // Collections feed the example chips — hard-coded ecommerce examples
  // ("top customers…") guaranteed a NOT_FOUND in any workspace without an
  // `orders` collection, so examples are derived from the live schema.
  const [exampleCollections, setExampleCollections] = useState<ApiCollection[]>([]);
  useEffect(() => {
    collectionsApi
      .list()
      .then((r) =>
        setExampleCollections(
          r.data.filter(
            (c) => (c.status ?? "active") === "active" && !c.hidden,
          ),
        ),
      )
      .catch(() => {
        // No collections → only the schema-draft chip renders.
      });
  }, []);

  // `prompt` strings stay English — the planner LLM consumes them, not the user.
  const EXAMPLES = useMemo(() => {
    const NUMERIC = new Set(["number", "integer"]);
    const pool = exampleCollections;
    const out: Array<{ label: string; prompt: string }> = [];

    // Top-N aggregate: first collection with a relation + a numeric metric.
    const aggC = pool.find(
      (c) =>
        c.fields.some((f) => f.type === "relation" && f.to) &&
        c.fields.some((f) => NUMERIC.has(f.type)),
    );
    const aggRel = aggC?.fields.find((f) => f.type === "relation" && f.to);
    const aggNum = aggC?.fields.find((f) => NUMERIC.has(f.type));
    if (aggC && aggRel && aggNum) {
      out.push({
        label: t`Top ${aggRel.name} by ${aggNum.name}`,
        prompt: `top ${aggRel.name} in ${aggC.slug} by total ${aggNum.name} in the last 30 days, limit 10`,
      });
    }

    // Grouped count: a status-shaped field (name or select interface).
    const statusC = pool.find((c) =>
      c.fields.some(
        (f) => /^(status|state|stage)$/.test(f.name) || f.interface === "select",
      ),
    );
    const statusF = statusC?.fields.find(
      (f) => /^(status|state|stage)$/.test(f.name) || f.interface === "select",
    );
    if (statusC && statusF) {
      out.push({
        label: t`${statusC.slug} by ${statusF.name}`,
        prompt: `count of ${statusC.slug} grouped by ${statusF.name}`,
      });
    }

    // Recent rows: prefer a collection not already used above.
    const recentC =
      pool.find(
        (c) => c.hasCreatedAt !== false && c !== aggC && c !== statusC,
      ) ?? pool.find((c) => c.hasCreatedAt !== false);
    if (recentC) {
      out.push({
        label: t`Recent ${recentC.slug}`,
        prompt: `${recentC.slug} created in the past 7 days, sorted by created_at desc, limit 10`,
      });
    }

    // Always valid — collection-independent.
    out.push({
      label: t`Draft support_tickets schema`,
      prompt:
        "design a support_tickets collection — subject, body, requester (relation to app_users), priority enum, status workflow, assigned_to",
    });
    return out;
  }, [exampleCollections, t]);
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
  const [tab, setTab] = useUrlTab(ASK_AI_TABS, "ask");
  // pak_* keys are fetched once at the page level so Tools (right rail
  // editor) and Connect (snippet picker) can share the selection — flipping
  // tabs doesn't refetch or reset which key is active.
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  // Live MCP tool count for the header badge — fetched so the number tracks the
  // real catalog instead of a hardcoded constant that silently drifts. `null`
  // while loading; the badge renders once it resolves.
  const [toolCount, setToolCount] = useState<number | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    api<{ data: { count: number } }>("/api/admin/mcp/count")
      .then((r) => setToolCount(r.data.count))
      .catch(() => {
        // Leave the badge count-less rather than showing a stale guess.
      });
  }, []);

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
      // A plan carrying a lingering validationError needs the operator's
      // eyes (and probably an edit) — never fire it automatically.
      if (
        autoRun &&
        AUTO_RUN_PATTERN.test(res.data.tool) &&
        !res.data.validationError
      ) {
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
      // Hand-edited args supersede the server's dry-run verdict — clear the
      // stale warning so the Run button reads clean again.
      setPlan({ ...plan, args: next, validationError: undefined });
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
            <Trans>MCP · {toolCount ?? "…"} tools</Trans>
          </Badge>
        }
        description={
          <Trans>
            Query your backend in natural language, browse the MCP tool catalog,
            and connect external clients over OAuth or an API key — every call
            scoped to your role and the per-key allowlist.
          </Trans>
        }
      />

      <div className="-mx-1 px-1">
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
          <Card className="py-0 gap-0">
            <div className="flex items-center gap-2 px-5 pt-4 pb-1">
              <I.Sparkles size={14} className="text-primary" />
              <span className="text-[13px] font-semibold">
                <Trans>Ask in natural language</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-3.5 px-5 pt-2 pb-4">
              {/* bordered input box */}
              <div className="rounded-control border border-border bg-muted/20 px-4 py-3.5 focus-within:border-primary/40 focus-within:ring-3 focus-within:ring-primary/15">
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
                  placeholder={t`Ask about your data — e.g. "list published posts from last week, newest first"`}
                  className="min-h-[64px] resize-none rounded-none border-0 bg-transparent p-0 text-[14px] leading-relaxed shadow-none placeholder:text-muted-foreground/70 focus-visible:ring-0"
                />
              </div>

              {/* example chips */}
              {phase === "idle" && !planError && EXAMPLES.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {EXAMPLES.map((e) => (
                    <button
                      key={e.label}
                      type="button"
                      onClick={() => {
                        setPrompt(e.prompt);
                        taRef.current?.focus();
                      }}
                      className="inline-flex h-[30px] cursor-pointer items-center rounded-full border border-border bg-card px-3.5 text-[12px] text-foreground/85 transition-colors hover:border-primary/35 hover:bg-primary/10 hover:text-foreground"
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              )}

              {/* controls: model + auto-run (left) · clear + run (right) */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <ModelPicker value={model} onChange={setModel} models={MODELS} />
                <span className="hidden items-center gap-1.5 text-[11.5px] text-muted-foreground sm:inline-flex">
                  <Trans>auto-run reads</Trans>
                  <Switch checked={autoRun} onChange={setAutoRun} />
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {(prompt.trim() || plan || result) && (
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
                  )}
                  <Button
                    variant="primary"
                    size="sm"
                    className={`h-9 rounded-control px-5 shadow-[0_8px_22px_-8px_color-mix(in_oklch,var(--color-primary)_70%,transparent)] hover:brightness-110 ${PRIMARY_GRADIENT}`}
                    icon={
                      phase === "thinking" || phase === "running"
                        ? I.Loader
                        : I.Sparkles
                    }
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
            <div className="border-t border-border px-5 py-2.5 text-[11.5px] text-muted-foreground">
              <Trans>
                Read-leaning tools auto-run. Writes wait for a click to confirm.
              </Trans>
            </div>
          </Card>

          {planError && (
            <div className="rounded-surface border border-destructive/40 bg-destructive/5 px-5 py-4 text-[12.5px] text-destructive">
              {planError}
            </div>
          )}

          {phase === "thinking" && (
            <Card className="py-0 gap-0">
              <div className="flex flex-col items-start gap-4 px-5 py-7">
                <div className="flex items-center gap-2.5 text-[13px] font-medium">
                  <I.Brain size={14} className="text-primary" />
                  <span><Trans>Planning the tool call…</Trans></span>
                </div>
                <div className="font-mono text-[11px] text-muted-foreground">
                  <Trans>asking {model}…</Trans>
                </div>
              </div>
            </Card>
          )}

          {plan && phase !== "thinking" && phase !== "idle" && (
            <Card className="py-0 gap-0">
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
              {plan.validationError && (
                <div className="mx-5 mt-2 flex items-start gap-2 rounded-control border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] text-amber-700 dark:text-amber-300">
                  <I.AlertTriangle size={13} className="mt-0.5 shrink-0" />
                  <span className="min-w-0">
                    <Trans>
                      This plan failed validation — review or edit the args
                      before running.
                    </Trans>{" "}
                    <span className="break-words font-mono text-[11px]">
                      {plan.validationError}
                    </span>
                  </span>
                </div>
              )}
              <div className="px-5 py-3">
                <div className="rounded-control border border-border bg-muted/40 p-4">
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
            </Card>
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
        <Card className="py-0 gap-0 xl:sticky xl:top-4">
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
            <div className="border-t border-border">
              <EmptyState
                bare
                size="sm"
                icon={I.History}
                title={<Trans>No runs yet</Trans>}
                description={<Trans>Your tool calls show up here.</Trans>}
              />
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
        </Card>
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
    <Card className="py-0 gap-0">
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
    </Card>
  );
}

// ─── Shared helpers (Tools + Connect right rails) ─────────────────────────

/** Per-API-key picker shared by the Tools right rail and the Connect tab.
 *  Renders a shadcn Select with the key's name + `pak_<prefix>` hint. The
 *  list is filtered at the page level (revoked / expired keys removed).  */

export * from "./shared";
