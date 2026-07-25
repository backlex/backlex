// Agents page — AI agent definitions + a chat playground that streams each
// reason→act step live over the `agent:thread:<id>` realtime channel.
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, EmptyState, PageHeader, Switch } from "../ui";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Label } from "@backlex/ui/components/label";
import { Checkbox } from "@backlex/ui/components/checkbox";
import { Select } from "../select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { api } from "@/lib/api";
import { useMcpTools, type ToolDescriptor } from "@/components/mcp-guards-fields";
import { fetchSafely } from "./_shared";
import { useMe } from "../queries";
import { collabColor } from "../collab";
import { useAgentThreadLive, type AgentPeer } from "../agent-thread-live";

interface Agent {
  id: string;
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  tools: string[];
  maxSteps: number;
  memory: boolean;
  active: boolean;
}

interface Thread {
  id: string;
  /** Server-derived label: the first line of the opening prompt (a raw id is
   *  meaningless in the picker). Null only for a thread with no messages yet. */
  title?: string | null;
  status: string;
  updatedAt?: string | number | null;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Team member who asked — threads are workspace-wide, so a transcript can
   *  mix several people. Null on assistant/tool rows. */
  userId?: string | null;
  toolName?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/** A teammate who appears in a transcript, shipped alongside the messages. */
interface Author {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

/** Display handle for an author: their name, else the email's local part. */
const authorLabel = (a: Author | undefined): string | null => {
  if (!a) return null;
  if (a.name?.trim()) return a.name.trim();
  if (!a.email) return null;
  const at = a.email.indexOf("@");
  return at > 0 ? a.email.slice(0, at) : a.email;
};

interface RunStep {
  thought?: string;
  tool: string;
  observation: string;
  isError: boolean;
}

/** Curated model dropdown. The runner accepts any `provider/model` string, so
 *  "Custom…" keeps a free-text escape hatch. Claude ids need the workspace to
 *  bring its own key (or a self-host key); the `@cf/*` Cloudflare Workers AI ids
 *  are what managed-cloud projects run within their metered plan allowance —
 *  a managed agent left on "Default" runs Llama 3.1 70B. */
const MODEL_OPTIONS = [
  { value: "", label: "Default", hint: "Claude w/ your key · else GLM 5.2 (managed)" },
  // Cloudflare Workers AI — run on managed cloud within your plan, no key needed.
  { value: "@cf/qwen/qwen3-30b-a3b-fp8", label: "Qwen3 30B", hint: "Cloudflare AI · managed · balanced" },
  { value: "@cf/google/gemma-4-26b-a4b-it", label: "Gemma 4 26B", hint: "Cloudflare AI · managed · thinking" },
  { value: "@cf/openai/gpt-oss-120b", label: "GPT-OSS 120B", hint: "Cloudflare AI · managed · strong" },
  { value: "@cf/zai-org/glm-5.2", label: "GLM 5.2", hint: "Cloudflare AI · managed · flagship coding" },
  { value: "@cf/moonshotai/kimi-k2.7-code", label: "Kimi K2.7", hint: "Cloudflare AI · managed · coding" },
  { value: "@cf/meta/llama-3.1-70b-instruct-fp8-fast", label: "Llama 3.1 70B", hint: "Cloudflare AI · managed" },
  { value: "@cf/meta/llama-3.1-8b-instruct-fp8", label: "Llama 3.1 8B", hint: "Cloudflare AI · managed · fast/cheap" },
  // Bring-your-own-key models — Anthropic Claude, needs a key in Settings · AI.
  // (GLM / Kimi above are Cloudflare-hosted @cf models, so they need no key.)
  { value: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8", hint: "your key · most capable" },
  { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", hint: "your key · balanced" },
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "your key · fast/cheap" },
  { value: "openai/gpt-5", label: "GPT-5", hint: "your key · AI Gateway" },
  { value: "openai/gpt-5-mini", label: "GPT-5 mini", hint: "your key · AI Gateway · fast/cheap" },
] as const;

/** Managed default (mirrors the runner's CLOUD_DEFAULT_AGENT_MODEL). */
const MANAGED_DEFAULT_MODEL = "@cf/zai-org/glm-5.2";

/** A model that isn't a Cloudflare `@cf/*` id needs the workspace to bring an
 *  AI key (Anthropic / AI Gateway) — otherwise it can't run as picked. */
const modelNeedsKey = (v?: string | null): boolean => !!v && !v.startsWith("@cf/");

/** Human label for a model id. */
const modelLabel = (m?: string | null): string => {
  if (!m) return "Default";
  const known = MODEL_OPTIONS.find((o) => o.value === m);
  if (known) return known.label.replace(/^Claude /, "");
  return m.includes("/") ? m.split("/").pop()! : m;
};

/** Workspace AI config (subset of GET /api/admin/ai-config). */
interface AiCfg {
  provider: string;
  secretsSet: { gatewayKey: boolean; anthropicKey: boolean };
  env: { cloud: boolean; hasGatewayKey: boolean; hasAnthropicKey: boolean };
}

/** Does the workspace/deployment effectively have a direct AI key, so BYO
 *  (Claude / Kimi / GLM) models actually run instead of falling back? */
const hasEffectiveKey = (c: AiCfg | null): boolean =>
  !!c &&
  ((c.provider === "gateway" && c.secretsSet.gatewayKey) ||
    (c.provider === "anthropic" && c.secretsSet.anthropicKey) ||
    c.env.hasGatewayKey ||
    c.env.hasAnthropicKey);

/** BYO models silently fall back to Workers AI on managed cloud when no key. */
const keylessManaged = (c: AiCfg | null): boolean =>
  !!c && !hasEffectiveKey(c) && c.env.cloud;

/** The model that ACTUALLY runs for an agent given the key situation — so the
 *  UI can show the effective model, not a misleading configured-but-ignored one. */
const effectiveModelValue = (
  agentModel: string | null | undefined,
  c: AiCfg | null,
): string => {
  const m = agentModel || "anthropic/claude-sonnet-5"; // runner's DEFAULT_MODEL
  if (!c || hasEffectiveKey(c)) return m; // configured model runs as picked
  if (c.env.cloud) return m.startsWith("@cf/") ? m : MANAGED_DEFAULT_MODEL;
  return m; // self-host, no key — configured (may error until a key is set)
};

/** Compact a token count for the header chip (1234 → "1.2k"). */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
/** Mirror of the server's thread label (`threadTitleFrom`) so the optimistic
 *  history row reads the same as the one that comes back from the API. */
const previewTitle = (message: string, max = 64): string => {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** Short "when" stamp for a history row — recency is what picks a thread apart,
 *  so minutes/hours/days beat a full timestamp at this width. */
const fmtWhen = (v: string | number | null | undefined): string => {
  if (v === null || v === undefined) return "";
  const ms = typeof v === "number" ? v : Date.parse(v);
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ms).toISOString().slice(5, 10);
};

const MODEL_CUSTOM = "__custom__";
const isKnownModel = (m: string) => MODEL_OPTIONS.some((o) => o.value === m);

const EMPTY_DRAFT: Agent = {
  id: "",
  name: "",
  description: "",
  systemPrompt: "",
  model: "",
  tools: [],
  maxSteps: 8,
  memory: false,
  active: true,
};

export function AgentsPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const { t } = useLingui();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [active, setActive] = useState<string | null>(null);

  // Editor dialog
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<Agent>(EMPTY_DRAFT);
  // Shared MCP catalog hook (same one the API-key guard editor uses) — lazy
  // fetches `tools/list` the first time the editor opens.
  const { tools: toolCatalog, loading: toolsLoading } = useMcpTools(editorOpen);
  const [toolFilter, setToolFilter] = useState("");
  const [saving, setSaving] = useState(false);
  // Whether the Model picker is in free-text ("Custom…") mode.
  const [modelCustom, setModelCustom] = useState(false);
  // Workspace AI config — drives the effective-model chip + the "needs your key"
  // hints so the picker is honest about what actually runs.
  const [aiCfg, setAiCfg] = useState<AiCfg | null>(null);

  const reload = useCallback(async () => {
    const r = await fetchSafely<{ data: Agent[] }>("/api/agents");
    setAgents(r?.data ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    void (async () => {
      const r = await fetchSafely<{ data: AiCfg }>("/api/admin/ai-config");
      if (r?.data) setAiCfg(r.data);
    })();
  }, []);

  const agent = agents.find((a) => a.id === active) ?? null;

  // ── editor ────────────────────────────────────────────────────────────────
  const openEditor = useCallback((a?: Agent) => {
    setDraft(a ? { ...a, description: a.description ?? "", systemPrompt: a.systemPrompt ?? "", model: a.model ?? "" } : EMPTY_DRAFT);
    setModelCustom(!!(a?.model && !isKnownModel(a.model)));
    setToolFilter("");
    setEditorOpen(true);
  }, []);

  const saveDraft = useCallback(async () => {
    if (!draft.name.trim()) {
      pushToast(t`Name is required.`, "error");
      return;
    }
    setSaving(true);
    const payload = {
      name: draft.name.trim(),
      description: draft.description || null,
      systemPrompt: draft.systemPrompt || null,
      model: draft.model || null,
      tools: draft.tools,
      maxSteps: draft.maxSteps,
      memory: draft.memory,
      active: draft.active,
    };
    try {
      if (draft.id) {
        await api(`/api/agents/${draft.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        pushToast(t`Agent saved.`);
      } else {
        const res = await api<{ data: { id: string } }>("/api/agents", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setActive(res.data.id);
        pushToast(t`Agent created.`);
      }
      setEditorOpen(false);
      await reload();
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  }, [draft, pushToast, reload, t]);

  const deleteAgent = useCallback(async (id: string) => {
    try {
      await api(`/api/agents/${id}`, { method: "DELETE" });
      if (active === id) setActive(null);
      setEditorOpen(false);
      pushToast(t`Agent deleted.`);
      await reload();
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  }, [active, pushToast, reload, t]);

  const toggleTool = (name: string) =>
    setDraft((d) => ({
      ...d,
      tools: d.tools.includes(name) ? d.tools.filter((x) => x !== name) : [...d.tools, name],
    }));

  /** Group-header checkbox: all-on → clear the group, otherwise select it whole. */
  const toggleGroup = (tools: ToolDescriptor[]) =>
    setDraft((d) => {
      const names = tools.map((x) => x.name);
      const allOn = names.every((n) => d.tools.includes(n));
      return {
        ...d,
        tools: allOn
          ? d.tools.filter((n) => !names.includes(n))
          : [...new Set([...d.tools, ...names])],
      };
    });

  if (!loaded) {
    return (
      <div className="flex flex-col gap-4.5">
        <PageHeader title={t`Agents`} description={t`AI agents that reason, call your tools, and answer — built on your collections.`} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex flex-col gap-3 p-4">
              <Skeleton className="h-5 w-32" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-2/3" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Filtered catalog grouped by namespace (`schema.*`, `collections.*`, …) so
  // the ~130-tool roster stays browsable. The filter matches the tool name or
  // its namespace.
  const q = toolFilter.trim().toLowerCase();
  const groupedTools = (() => {
    const groups = new Map<string, ToolDescriptor[]>();
    for (const tool of toolCatalog ?? []) {
      const dot = tool.name.indexOf(".");
      const namespace = dot < 0 ? "other" : tool.name.slice(0, dot);
      if (q && !tool.name.toLowerCase().includes(q) && !namespace.includes(q)) continue;
      const bucket = groups.get(namespace) ?? [];
      bucket.push(tool);
      groups.set(namespace, bucket);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([namespace, tools]) => ({ namespace, tools }));
  })();
  // Master select-all operates on the currently-visible (filtered) tools, so it
  // reads "select these 8 matches" rather than the whole 132-tool catalog.
  const visibleTools = groupedTools.flatMap((g) => g.tools);
  const allVisibleSelected =
    visibleTools.length > 0 && visibleTools.every((tt) => draft.tools.includes(tt.name));

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Agents`}
        description={t`AI agents that reason, call your tools, and answer — built on your collections.`}
        actions={<Button variant="primary" icon={I.Plus} onClick={() => openEditor()}><Trans>New agent</Trans></Button>}
      />

      <div className="grid grid-cols-[320px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
        <Card className="py-0 gap-0">
          {agents.length === 0 && (
            <EmptyState size="sm" title={<Trans>No agents yet — click + New agent.</Trans>} />
          )}
          {agents.map((a) => (
            <div
              key={a.id}
              onClick={() => setActive(a.id)}
              className={`grid cursor-pointer grid-cols-[24px_1fr_auto] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 ${active === a.id ? "bg-accent" : ""}`}
            >
              <span><I.Sparkles size={14} /></span>
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] font-medium">{a.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{(a.tools ?? []).length} {t`tools`}{a.memory ? ` · ${t`memory`}` : ""}</span>
              </div>
              <Badge variant={a.active ? "default" : "secondary"}>{a.active ? t`active` : t`off`}</Badge>
            </div>
          ))}
        </Card>

        <Card className="gap-4.5 p-[22px]">
          {!agent ? (
            <EmptyState
              bare
              icon={I.Sparkles}
              title={<Trans>No agent selected</Trans>}
              description={<Trans>Pick an agent on the left, or click <strong>+ New agent</strong>.</Trans>}
            />
          ) : (
            <AgentDetail
              key={agent.id}
              agent={agent}
              aiCfg={aiCfg}
              pushToast={pushToast}
              onEdit={() => openEditor(agent)}
            />
          )}
        </Card>
      </div>

      {editorOpen && (
        <Dialog open onOpenChange={(o) => { if (!o) setEditorOpen(false); }}>
          <DialogContent className="flex max-h-[min(88vh,760px)] w-[680px] max-w-[92vw] flex-col overflow-hidden [&>*]:min-w-0">
            <DialogHeader>
              <DialogTitle>{draft.id ? <Trans>Edit agent</Trans> : <Trans>New agent</Trans>}</DialogTitle>
              <DialogDescription>
                <Trans>System prompt shapes the persona; the tool allow-list is what it can do.</Trans>
              </DialogDescription>
            </DialogHeader>

            <ScrollArea className="min-h-0 flex-1" viewportClassName="max-h-[calc(88vh-13rem)] max-[640px]:max-h-[calc(88vh-15rem)]">
              <div className="flex flex-col gap-4 px-0.5 py-1">
                <div className="flex flex-col gap-1.5">
                  <Label><Trans>Name</Trans></Label>
                  <Input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t`Support agent`} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label><Trans>Description</Trans></Label>
                  <Input value={draft.description ?? ""} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={t`What this agent is for`} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label><Trans>System prompt</Trans></Label>
                  <Textarea className="min-h-[90px] text-[13px]" value={draft.systemPrompt ?? ""} onChange={(e) => setDraft({ ...draft, systemPrompt: e.target.value })} placeholder={t`You are a helpful assistant for our workspace…`} />
                  <span className="text-[11.5px] text-muted-foreground"><Trans>The agent's standing instructions — its persona, tone, and rules. Sent to the model before every user message.</Trans></span>
                </div>
                <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label><Trans>Model</Trans></Label>
                    <Select
                      value={modelCustom ? MODEL_CUSTOM : (draft.model ?? "")}
                      onChange={(v) => {
                        if (v === MODEL_CUSTOM) {
                          setModelCustom(true);
                        } else {
                          setModelCustom(false);
                          setDraft({ ...draft, model: v });
                        }
                      }}
                      options={[
                        ...MODEL_OPTIONS.map((o) => ({
                          value: o.value,
                          label: o.label,
                          hint:
                            keylessManaged(aiCfg) && modelNeedsKey(o.value)
                              ? `🔒 ${o.hint}`
                              : o.hint,
                        })),
                        { value: MODEL_CUSTOM, label: t`Custom…`, hint: t`any provider/model id` },
                      ]}
                    />
                    {modelCustom && (
                      <Input
                        className="mt-1 font-mono text-[12.5px]"
                        value={draft.model ?? ""}
                        onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                        placeholder="anthropic/claude-haiku-4-5"
                      />
                    )}
                    {keylessManaged(aiCfg) && modelNeedsKey(draft.model) && (
                      <span className="text-[11.5px] text-amber-600 dark:text-amber-500">
                        <Trans>
                          🔒 Needs your own API key — without one this falls back to{" "}
                          {modelLabel(MANAGED_DEFAULT_MODEL)} on managed cloud. Add a key in
                          Settings · AI.
                        </Trans>
                      </span>
                    )}
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label><Trans>Max steps</Trans></Label>
                    <Input type="number" min={1} max={25} value={draft.maxSteps} onChange={(e) => setDraft({ ...draft, maxSteps: Math.max(1, Math.min(25, Number(e.target.value) || 1)) })} />
                  </div>
                </div>
                <div className="flex items-center justify-between rounded-control border border-border px-3 py-2.5">
                  <div className="flex flex-col">
                    <span className="text-[13px] font-medium"><Trans>Memory</Trans></span>
                    <span className="text-[11.5px] text-muted-foreground"><Trans>Recall relevant past turns (needs an embedding provider).</Trans></span>
                  </div>
                  <Switch checked={draft.memory} onChange={(next) => setDraft({ ...draft, memory: next })} />
                </div>
                <div className="flex items-center justify-between rounded-control border border-border px-3 py-2.5">
                  <span className="text-[13px] font-medium"><Trans>Active</Trans></span>
                  <Switch checked={draft.active} onChange={(next) => setDraft({ ...draft, active: next })} />
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="shrink-0"><Trans>Tools</Trans> <span className="text-[11px] tabular-nums text-muted-foreground">({draft.tools.length}/{toolCatalog?.length ?? 0})</span></Label>
                    <div className="flex min-w-0 items-center gap-2">
                      {visibleTools.length > 0 && (
                        <button
                          type="button"
                          onClick={() => toggleGroup(visibleTools)}
                          className="shrink-0 text-[11px] font-medium text-muted-foreground hover:text-foreground"
                        >
                          {allVisibleSelected ? <Trans>Clear all</Trans> : <Trans>Select all</Trans>}
                        </button>
                      )}
                      <Input className="h-7 w-40 min-w-0 text-[12px] max-[380px]:w-28" value={toolFilter} onChange={(e) => setToolFilter(e.target.value)} placeholder={t`Filter tools…`} />
                    </div>
                  </div>
                  <div className="overflow-hidden rounded-control border border-border">
                    <ScrollArea type="auto" className="reserve-scrollbar-gutter" viewportClassName="max-h-[260px]">
                      <div className="flex flex-col">
                        {toolsLoading && (
                          <div className="flex flex-col gap-2.5 p-3">
                            {[0, 1, 2, 3, 4].map((i) => (
                              <div key={i} className="flex items-center gap-2.5">
                                <Skeleton className="size-4 rounded-sm" />
                                <Skeleton className="h-3.5 w-44" />
                              </div>
                            ))}
                          </div>
                        )}
                        {!toolsLoading && groupedTools.length === 0 && (
                          <span className="px-3 py-3 text-[12px] text-muted-foreground"><Trans>No tools match.</Trans></span>
                        )}
                        {groupedTools.map((group) => {
                          const onCount = group.tools.filter((x) => draft.tools.includes(x.name)).length;
                          return (
                            <div key={group.namespace} className="flex flex-col">
                              <label className="sticky top-0 z-10 flex cursor-pointer items-center gap-2.5 border-b border-border bg-muted px-3 py-1.5 hover:bg-accent/70">
                                <Checkbox checked={onCount === group.tools.length} onCheckedChange={() => toggleGroup(group.tools)} />
                                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group.namespace}</span>
                                <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{onCount}/{group.tools.length}</span>
                              </label>
                              {group.tools.map((tool) => (
                                <label key={tool.name} className="flex cursor-pointer items-start gap-2.5 border-b border-border px-3 py-2 last:border-b-0 hover:bg-accent/50">
                                  <Checkbox checked={draft.tools.includes(tool.name)} onCheckedChange={() => toggleTool(tool.name)} className="mt-0.5" />
                                  <div className="flex min-w-0 flex-col">
                                    <span className="font-mono text-[12px]">{tool.name}</span>
                                    <span className="truncate text-[11px] text-muted-foreground">{tool.description}</span>
                                  </div>
                                </label>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </ScrollArea>
                  </div>
                </div>
              </div>
            </ScrollArea>

            <DialogFooter className="sm:justify-between">
              {draft.id ? (
                <Button variant="ghost" size="sm" icon={I.Trash} onClick={() => deleteAgent(draft.id)}><Trans>Delete</Trans></Button>
              ) : <span />}
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEditorOpen(false)}><Trans>Cancel</Trans></Button>
                <Button variant="primary" size="sm" disabled={saving} onClick={saveDraft}>{saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}</Button>
              </div>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Detail + chat playground ──────────────────────────────────────────────────
function AgentDetail({
  agent,
  aiCfg,
  pushToast,
  onEdit,
}: {
  agent: Agent;
  aiCfg: AiCfg | null;
  pushToast: (m: string, type?: "success" | "error") => void;
  onEdit: () => void;
}) {
  const { t } = useLingui();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [authors, setAuthors] = useState<Record<string, Author>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [liveSteps, setLiveSteps] = useState<RunStep[]>([]);
  // A turn a TEAMMATE started, seen over the channel — the composer locks for
  // everyone while it runs, since the API rejects a concurrent turn anyway.
  const [remoteRun, setRemoteRun] = useState<{ userId: string | null } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const meQuery = useMe();
  const meId = meQuery.data?.data?.id ?? null;

  const loadThreads = useCallback(async () => {
    const r = await fetchSafely<{ data: Thread[] }>(`/api/agents/${agent.id}/threads`);
    setThreads(r?.data ?? []);
  }, [agent.id]);

  const loadMessages = useCallback(async (tid: string) => {
    const r = await fetchSafely<{ data: { messages: Message[]; authors?: Author[] } }>(
      `/api/agents/threads/${tid}`,
    );
    setMessages(r?.data?.messages ?? []);
    setAuthors(Object.fromEntries((r?.data?.authors ?? []).map((a) => [a.id, a])));
  }, []);

  useEffect(() => {
    void loadThreads();
    setThreadId(null);
    setMessages([]);
  }, [loadThreads]);

  useEffect(() => {
    // Selecting "New conversation" (threadId=null) must clear the transcript —
    // otherwise the previously-opened thread's messages linger.
    if (threadId) void loadMessages(threadId);
    else setMessages([]);
  }, [threadId, loadMessages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, liveSteps]);

  // ── team sync ──────────────────────────────────────────────────────────────
  // Everything below arrives on the thread's channel for EVERY viewer, so a
  // teammate's question, its tool steps, and the answer land on your screen the
  // same way your own do. Own frames are skipped where the local optimistic
  // path already handled them.
  const onLiveEvent = useCallback(
    (e: { event: string; data: any }) => {
      const mine = e.data?.userId && meId && e.data.userId === meId;
      switch (e.event) {
        case "agent.message": {
          if (mine) return; // already on screen optimistically
          const { id, role, content, userId } = e.data ?? {};
          if (!id || !content) return;
          setMessages((m) =>
            m.some((x) => x.id === id) ? m : [...m, { id, role: role ?? "user", content, userId }],
          );
          return;
        }
        case "agent.start":
          if (!mine) setRemoteRun({ userId: e.data?.userId ?? null });
          return;
        case "agent.step":
          if (!mine) setLiveSteps((s) => [...s, e.data as RunStep]);
          return;
        case "agent.final":
        case "agent.error":
          if (mine) return;
          setRemoteRun(null);
          setLiveSteps([]);
          // Pull the persisted transcript rather than trusting the frame: it
          // carries the tool rows and token counts too.
          if (threadId) void loadMessages(threadId);
          return;
        default:
      }
    },
    [meId, threadId, loadMessages],
  );
  const { peers, notifyTyping } = useAgentThreadLive(threadId, meId, onLiveEvent);

  // "New conversation" is purely local — the thread row is created on the first
  // send. Creating it up front left untitled ghost rows in the history list for
  // every abandoned chat.
  const newThread = useCallback(() => {
    setThreadId(null);
    setMessages([]);
    setLiveSteps([]);
    setRemoteRun(null);
  }, []);

  const activeThread = threads.find((th) => th.id === threadId);
  const activeThreadLabel = threadId
    ? activeThread?.title || t`Conversation`
    : t`New conversation`;
  // Busy because a TEAMMATE is running a turn — either seen live, or read off a
  // thread you opened mid-turn. The API rejects a concurrent turn, so the
  // composer says who's holding it instead of letting you hit a 409.
  const runningElsewhere =
    !sending && (!!remoteRun || activeThread?.status === "running");
  // Name a teammate from the transcript's authors, falling back to the live
  // roster — a message that arrives over the channel is on screen before the
  // authors list that names its writer catches up.
  const nameFor = useCallback(
    (userId: string): string =>
      authorLabel(authors[userId]) ??
      peers.find((p) => p.id === userId)?.name ??
      userId.slice(0, 6),
    [authors, peers],
  );
  const runnerName = remoteRun?.userId ? nameFor(remoteRun.userId) : null;
  const typingPeers = peers.filter((p) => p.typing);

  const send = useCallback(async () => {
    const message = input.trim();
    // Guard against a double-send: a turn runs synchronously inside the POST, so
    // a second send while one is in flight would 409 ("A turn is already running").
    if (!message || sending) return;
    let tid = threadId;
    if (!tid) {
      try {
        const res = await api<{ data: Thread }>(`/api/agents/${agent.id}/threads`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        tid = res.data.id;
        setThreadId(tid);
        // Show it in the history list right away, labelled the way the server
        // will label it once the turn lands (first line of this prompt).
        setThreads((prev) => [
          { id: tid as string, title: previewTitle(message), status: "running", updatedAt: Date.now() },
          ...prev,
        ]);
      } catch (e) {
        pushToast((e as Error).message, "error");
        return;
      }
    }
    setInput("");
    setSending(true);
    setLiveSteps([]);
    // Optimistically show the user message.
    const tmpId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tmpId, role: "user", content: message, userId: meId }]);

    // Own-turn step stream. The team subscription (useAgentThreadLive) is
    // already open for an existing thread, but on a brand-new one it attaches a
    // render later — this one is guaranteed live before the POST, so your own
    // steps never race. Teammate frames are ignored here; the hook has them.
    let es: EventSource | null = null;
    try {
      es = new EventSource(
        `/api/realtime/${encodeURIComponent(`agent:thread:${tid}`)}/subscribe`,
        { withCredentials: true },
      );
      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as { event?: string; data?: any };
          if (parsed.event === "agent.step" && parsed.data) {
            setLiveSteps((s) => [...s, parsed.data as RunStep]);
          }
        } catch {
          /* ignore non-JSON frames */
        }
      };
    } catch {
      /* streaming unsupported — the final transcript refetch still works */
    }

    try {
      await api(`/api/agents/threads/${tid}/messages`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      await loadMessages(tid);
    } catch (e) {
      // Drop the optimistic bubble and RESTORE the typed text so it isn't lost.
      setMessages((m) => m.filter((x) => x.id !== tmpId));
      setInput((cur) => cur || message);
      const msg = (e as Error).message;
      pushToast(
        /already running/i.test(msg)
          ? t`A turn is still running on this thread — wait for it to finish.`
          : msg,
        "error",
      );
    } finally {
      es?.close();
      setSending(false);
      setLiveSteps([]);
      // Reconcile the optimistic history row either way: the server names an
      // untitled thread after its opening prompt and bumps status/updatedAt.
      void loadThreads();
    }
  }, [agent.id, input, sending, threadId, meId, loadMessages, loadThreads, pushToast, t]);

  const totalTokens = messages.reduce(
    (sum, m) => sum + (m.tokensIn ?? 0) + (m.tokensOut ?? 0),
    0,
  );
  // The model that actually runs (managed cloud may map a keyless Claude pick
  // down to its Workers AI default), plus a human source for the chip tooltip.
  const effModel = modelLabel(effectiveModelValue(agent.model, aiCfg));
  const modelSrc = hasEffectiveKey(aiCfg)
    ? t`your API key`
    : aiCfg?.env.cloud
      ? t`Cloudflare Workers AI · managed`
      : t`no AI key configured`;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-base font-semibold">{agent.name}</span>
        <Badge variant={agent.active ? "default" : "secondary"}>{agent.active ? t`active` : t`off`}</Badge>
        {agent.memory && <Badge variant="secondary"><Trans>memory</Trans></Badge>}
        <span title={t`Running on ${modelSrc}`} className="inline-flex">
          <Badge variant="secondary" className="gap-1 font-normal">
            <I.Sparkles size={11} /> {effModel}
          </Badge>
        </span>
        <span className="text-xs text-muted-foreground">· {agent.tools.length} {t`tools`}</span>
        {totalTokens > 0 && (
          <span className="text-xs text-muted-foreground">· {fmtTokens(totalTokens)} {t`tokens`}</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <PresenceChips peers={peers} nameFor={nameFor} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" icon={I.History} className="max-w-[45vw] sm:max-w-[220px]">
                <span className="truncate">{activeThreadLabel}</span>
                <I.ChevronDown size={12} className="shrink-0 opacity-60" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[min(22rem,calc(100vw-2rem))]">
              <DropdownMenuLabel className="flex items-center justify-between">
                <span><Trans>History</Trans></span>
                <span className="font-mono text-[10.5px] text-muted-foreground">{threads.length}</span>
              </DropdownMenuLabel>
              {threads.length === 0 ? (
                <div className="px-3 py-3 text-[12px] text-muted-foreground">
                  <Trans>No conversations yet.</Trans>
                </div>
              ) : (
                <ScrollArea viewportClassName="max-h-[280px]">
                  {threads.map((th) => (
                    <DropdownMenuItem
                      key={th.id}
                      className="items-start gap-2.5"
                      onSelect={() => setThreadId(th.id)}
                    >
                      <I.MessageSquare size={13} className="mt-0.5 shrink-0 text-muted-foreground" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[13px] font-normal">
                          {th.title || t`Empty conversation`}
                        </span>
                        <span className="text-[11px] font-normal text-muted-foreground">
                          {fmtWhen(th.updatedAt)}
                          {th.status === "running" ? ` · ${t`running`}` : ""}
                        </span>
                      </span>
                      {th.id === threadId && <I.Check size={12} className="mt-0.5 shrink-0" />}
                    </DropdownMenuItem>
                  ))}
                </ScrollArea>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={newThread}>
                <I.Plus size={12} /> <Trans>New conversation</Trans>
                {threadId === null && <I.Check size={12} className="ml-auto" />}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="primary" size="sm" icon={I.Pencil} onClick={onEdit}><Trans>Edit</Trans></Button>
        </div>
      </div>

      {agent.tools.length === 0 && (
        <div className="rounded-surface border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">
          <Trans>This agent has no tools — it answers from the model alone. Add tools in Edit to let it read your data.</Trans>
        </div>
      )}

      <div className="flex h-[440px] flex-col overflow-hidden rounded-control border border-border">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex min-w-0 flex-col gap-3 p-4">
            {messages.length === 0 && liveSteps.length === 0 && (
              <div className="py-10 text-center text-[13px] text-muted-foreground">
                <Trans>Send a message to start the conversation.</Trans>
              </div>
            )}
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                label={m.userId ? nameFor(m.userId) : null}
                isMine={!m.userId || m.userId === meId}
              />
            ))}
            {liveSteps.map((s, i) => (
              <div key={`live-${i}`} className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-muted/40 px-3 py-2 text-[12px]">
                <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                  <I.Zap size={12} /> {s.tool}
                </span>
                {s.thought && <span className="whitespace-pre-wrap break-words text-muted-foreground">{s.thought}</span>}
                <span className={`whitespace-pre-wrap break-all font-mono text-[11px] ${s.isError ? "text-destructive" : "text-muted-foreground"}`}>{s.observation.slice(0, 280)}</span>
              </div>
            ))}
            {(sending || runningElsewhere) && (
              <div className="flex flex-col gap-2 px-1 py-1.5">
                <div className="agent-sweep-track" aria-hidden />
                <span className="text-[12px] text-muted-foreground">
                  {sending
                    ? liveSteps.length > 0
                      ? t`Working…`
                      : t`Thinking…`
                    : runnerName
                      ? t`${runnerName} is asking…`
                      : t`A teammate is asking…`}
                </span>
              </div>
            )}
            <div ref={endRef} />
          </div>
        </ScrollArea>
        <div className="flex flex-col gap-1.5 border-t border-border p-2.5">
          {typingPeers.length > 0 && (
            <span className="px-1 text-[11px] text-muted-foreground">
              {typingPeers.length === 1
                ? t`${nameFor(typingPeers[0]!.id)} is typing…`
                : t`${typingPeers.length} teammates are typing…`}
            </span>
          )}
          <div className="flex items-end gap-2">
          <Textarea
            className="min-h-[40px] flex-1 resize-none text-[13px]"
            value={input}
            disabled={sending || runningElsewhere}
            onChange={(e) => {
              setInput(e.target.value);
              notifyTyping();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={
              runningElsewhere
                ? runnerName
                  ? t`${runnerName} is running a turn…`
                  : t`A teammate is running a turn…`
                : t`Ask the agent…`
            }
          />
          <Button
            variant="primary"
            size="sm"
            icon={I.ArrowRight}
            disabled={sending || runningElsewhere || !input.trim()}
            onClick={send}
          >
            {sending ? <Trans>Working…</Trans> : <Trans>Send</Trans>}
          </Button>
          </div>
        </div>
      </div>
    </>
  );
}

/** Who else has this thread open, as overlapping initials. Threads are
 *  workspace-wide, so knowing a teammate is here (and typing) is the difference
 *  between a shared conversation and two people talking over each other. */
function PresenceChips({
  peers,
  nameFor,
}: {
  peers: AgentPeer[];
  /** Prefers the transcript's author name (real name) over the presence
   *  frame's handle (email local-part), so one person reads one way. */
  nameFor: (userId: string) => string;
}) {
  const { t } = useLingui();
  if (peers.length === 0) return null;
  const shown = peers.slice(0, 3);
  return (
    <span
      className="flex items-center -space-x-1.5"
      title={peers
        .map((p) => (p.typing ? `${nameFor(p.id)} (${t`typing`})` : nameFor(p.id)))
        .join(", ")}
    >
      {shown.map((p) => (
        <span
          key={p.id}
          className={`inline-flex size-6 items-center justify-center rounded-full border-2 border-background text-[10px] font-semibold uppercase text-white ${p.typing ? "animate-pulse" : ""}`}
          style={{ backgroundColor: p.color }}
        >
          {nameFor(p.id).charAt(0)}
        </span>
      ))}
      {peers.length > shown.length && (
        <span className="inline-flex size-6 items-center justify-center rounded-full border-2 border-background bg-muted text-[10px] font-semibold text-muted-foreground">
          +{peers.length - shown.length}
        </span>
      )}
    </span>
  );
}

function MessageRow({
  message,
  label: authorName,
  isMine,
}: {
  message: Message;
  /** Display name of the teammate who wrote it, when it isn't yours. */
  label: string | null;
  isMine: boolean;
}) {
  if (message.role === "tool") {
    return (
      <div className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-muted/40 px-3 py-2 text-[12px]">
        <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
          <I.Zap size={12} /> {message.toolName}
        </span>
        <span className="whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{message.content.slice(0, 400)}</span>
      </div>
    );
  }
  const isUser = message.role === "user";
  // A tool-call assistant step carries a toolName — render it like a step note.
  if (message.role === "assistant" && message.toolName) {
    return (
      <div className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-muted/40 px-3 py-2 text-[12px]">
        <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
          <I.Sparkles size={12} /> {message.toolName}
        </span>
        {message.content && <span className="whitespace-pre-wrap break-words text-muted-foreground">{message.content}</span>}
      </div>
    );
  }
  // A teammate's question keeps the user-side alignment but drops the "mine"
  // fill and gains a byline — otherwise a shared transcript reads as if one
  // person asked everything.
  const label = isMine ? null : authorName;
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      {label && (
        <span className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <span
            className="inline-flex size-4 items-center justify-center rounded-full text-[9px] font-semibold uppercase text-white"
            style={{ backgroundColor: collabColor(message.userId ?? label) }}
          >
            {label.charAt(0)}
          </span>
          {label}
        </span>
      )}
      <div className={`max-w-[80%] overflow-hidden whitespace-pre-wrap break-words rounded-surface px-3.5 py-2 text-[13px] ${isUser ? (isMine ? "bg-primary text-primary-foreground" : "border border-border bg-background") : "bg-muted"}`}>
        {message.content}
      </div>
    </div>
  );
}
