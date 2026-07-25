// Agents page — the agent **definitions**: what an agent is, which model it
// runs on, and the tool allow-list bounding what it may do.
//
// Talking to one lives on the Chat page: an agent is configured rarely and
// used constantly, and rooms host several agents at once, so a conversation
// can no longer be one agent's detail panel.
import { useCallback, useEffect, useState } from "react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { api } from "@/lib/api";
import { useMcpTools, type ToolDescriptor } from "@/components/mcp-guards-fields";
import { AgentsSkeleton } from "../page-skeletons";
import { fetchSafely } from "./_shared";
import {
  EFFORT_OPTIONS,
  MANAGED_DEFAULT_MODEL,
  MODEL_CUSTOM,
  MODEL_OPTIONS,
  effectiveModelValue,
  hasEffectiveKey,
  isKnownModel,
  keylessManaged,
  modelLabel,
  modelNeedsKey,
  slugPreview,
  type Agent,
  type AiCfg,
} from "./_agents-shared";

const EMPTY_DRAFT: Agent = {
  id: "",
  name: "",
  description: "",
  systemPrompt: "",
  model: "",
  effort: "",
  tools: [],
  maxSteps: 8,
  memory: false,
  active: true,
};

export function AgentsPage({
  pushToast,
  setActiveNav,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
  /** Jumping straight into a conversation with the agent you just configured. */
  setActiveNav?: (id: string) => void;
}) {
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
    setDraft(a ? { ...a, description: a.description ?? "", systemPrompt: a.systemPrompt ?? "", model: a.model ?? "", effort: a.effort ?? "" } : EMPTY_DRAFT);
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
      // Empty = let the server derive one from the name (and de-dupe it).
      ...(draft.handle?.trim() ? { handle: draft.handle.trim() } : {}),
      description: draft.description || null,
      systemPrompt: draft.systemPrompt || null,
      model: draft.model || null,
      tools: draft.tools,
      effort: draft.effort || null,
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

  if (!loaded) return <AgentsSkeleton />;

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
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {a.handle ? `@${a.handle} · ` : ""}{(a.tools ?? []).length} {t`tools`}{a.memory ? ` · ${t`memory`}` : ""}
                </span>
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
            <AgentSummary
              key={agent.id}
              agent={agent}
              aiCfg={aiCfg}
              onEdit={() => openEditor(agent)}
              onOpenChat={setActiveNav ? () => setActiveNav("chat") : undefined}
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
                <div className="grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label><Trans>Name</Trans></Label>
                    <Input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={t`Support agent`} />
                  </div>
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <Label><Trans>Mention handle</Trans></Label>
                    <Input
                      className="font-mono"
                      value={draft.handle ?? ""}
                      onChange={(e) => setDraft({ ...draft, handle: e.target.value })}
                      placeholder={draft.name ? slugPreview(draft.name) : "support-agent"}
                    />
                    <span className="text-[11.5px] text-muted-foreground">
                      <Trans>What teammates type after @ to address this agent in a room. Derived from the name when left blank.</Trans>
                    </span>
                  </div>
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
                  {/* Full-width row of its own: the helper below it is a
                      sentence, not a hint, and reads badly in a half column. */}
                  <div className="flex min-w-0 flex-col gap-1.5 max-[520px]:col-span-1 col-span-2">
                    <Label><Trans>Effort</Trans></Label>
                    <Select
                      value={draft.effort ?? ""}
                      onChange={(v) => setDraft({ ...draft, effort: v })}
                      options={EFFORT_OPTIONS}
                      className="min-w-0 sm:max-w-[50%]"
                    />
                    <span className="text-[11.5px] text-muted-foreground">
                      <Trans>
                        How hard the model thinks per step. Lower effort means fewer thinking
                        tokens and fewer tool calls — cheaper and faster, less thorough. Ignored
                        by models that don't support it.
                      </Trans>
                    </span>
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


/** What an agent IS, at a glance — the counterpart to the editor dialog. The
 *  conversation moved to the Chat page, so this panel answers "is this thing
 *  configured the way I think?" and hands you off to a room. */
function AgentSummary({
  agent,
  aiCfg,
  onEdit,
  onOpenChat,
}: {
  agent: Agent;
  aiCfg: AiCfg | null;
  onEdit: () => void;
  onOpenChat?: () => void;
}) {
  const { t } = useLingui();
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
        {agent.handle && (
          <Badge variant="secondary" className="font-mono font-normal">@{agent.handle}</Badge>
        )}
        <Badge variant={agent.active ? "default" : "secondary"}>{agent.active ? t`active` : t`off`}</Badge>
        {agent.memory && <Badge variant="secondary"><Trans>memory</Trans></Badge>}
        <span title={t`Running on ${modelSrc}`} className="inline-flex">
          <Badge variant="secondary" className="gap-1 font-normal">
            <I.Sparkles size={11} /> {effModel}
          </Badge>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {onOpenChat && (
            <Button variant="outline" size="sm" icon={I.MessageSquare} onClick={onOpenChat}>
              <Trans>Open chat</Trans>
            </Button>
          )}
          <Button variant="primary" size="sm" icon={I.Pencil} onClick={onEdit}><Trans>Edit</Trans></Button>
        </div>
      </div>

      {agent.description && (
        <p className="text-[13px] text-muted-foreground">{agent.description}</p>
      )}

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px] max-[560px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>Mention handle</Trans></dt>
          <dd className="truncate font-mono">{agent.handle ? `@${agent.handle}` : "—"}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>Max steps</Trans></dt>
          <dd className="font-mono">{agent.maxSteps}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>Reasoning effort</Trans></dt>
          <dd className="font-mono">{agent.effort || t`default`}</dd>
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>Tools</Trans></dt>
          <dd className="font-mono">{agent.tools.length}</dd>
        </div>
      </dl>

      {agent.tools.length === 0 ? (
        <div className="rounded-surface border border-dashed border-border px-3 py-2 text-[12px] text-muted-foreground">
          <Trans>This agent has no tools — it answers from the model alone. Add tools in Edit to let it read your data.</Trans>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>Tool allow-list</Trans></span>
          <ScrollArea viewportClassName="max-h-[180px]" className="w-full rounded-control border border-border">
            <div className="flex flex-wrap gap-1.5 p-2.5">
              {agent.tools.map((tool) => (
                <Badge key={tool} variant="secondary" className="font-mono text-[11px] font-normal">
                  {tool}
                </Badge>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}

      {agent.systemPrompt && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground"><Trans>System prompt</Trans></span>
          <ScrollArea viewportClassName="max-h-[200px]" className="w-full rounded-control border border-border">
            <div className="whitespace-pre-wrap break-words p-3 text-[12.5px] text-muted-foreground">
              {agent.systemPrompt}
            </div>
          </ScrollArea>
        </div>
      )}
    </>
  );
}
