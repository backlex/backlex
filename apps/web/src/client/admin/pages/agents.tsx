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
  title?: string | null;
  status: string;
}

interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolName?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

interface RunStep {
  thought?: string;
  tool: string;
  observation: string;
  isError: boolean;
}

/** Curated model dropdown. The runner accepts any `provider/model` string
 *  (gateway / direct / managed), so "Custom…" keeps the free-text escape hatch
 *  for models not in this list. Keep IDs in sync with the latest Claude lineup. */
const MODEL_OPTIONS = [
  { value: "", label: "Default", hint: "Sonnet 5 — balanced" },
  { value: "anthropic/claude-opus-4-8", label: "Claude Opus 4.8", hint: "most capable" },
  { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", hint: "balanced" },
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "fast & cheap" },
] as const;

/** Human label for the agent's configured model (or the default). */
const modelLabel = (m?: string | null): string => {
  if (!m) return "Sonnet 5";
  const known = MODEL_OPTIONS.find((o) => o.value === m);
  if (known) return known.label.replace(/^Claude /, "");
  return m.includes("/") ? m.split("/")[1]! : m;
};

/** Compact a token count for the header chip (1234 → "1.2k"). */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
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

  const reload = useCallback(async () => {
    const r = await fetchSafely<{ data: Agent[] }>("/api/agents");
    setAgents(r?.data ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

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
                        ...MODEL_OPTIONS.map((o) => ({ value: o.value, label: o.label, hint: o.hint })),
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
  pushToast,
  onEdit,
}: {
  agent: Agent;
  pushToast: (m: string, type?: "success" | "error") => void;
  onEdit: () => void;
}) {
  const { t } = useLingui();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [liveSteps, setLiveSteps] = useState<RunStep[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    const r = await fetchSafely<{ data: Thread[] }>(`/api/agents/${agent.id}/threads`);
    setThreads(r?.data ?? []);
  }, [agent.id]);

  const loadMessages = useCallback(async (tid: string) => {
    const r = await fetchSafely<{ data: { messages: Message[] } }>(`/api/agents/threads/${tid}`);
    setMessages(r?.data?.messages ?? []);
  }, []);

  useEffect(() => {
    void loadThreads();
    setThreadId(null);
    setMessages([]);
  }, [loadThreads]);

  useEffect(() => {
    if (threadId) void loadMessages(threadId);
  }, [threadId, loadMessages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, liveSteps]);

  const newThread = useCallback(async () => {
    try {
      const res = await api<{ data: Thread }>(`/api/agents/${agent.id}/threads`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      await loadThreads();
      setThreadId(res.data.id);
      setMessages([]);
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  }, [agent.id, loadThreads, pushToast]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message) return;
    let tid = threadId;
    if (!tid) {
      try {
        const res = await api<{ data: Thread }>(`/api/agents/${agent.id}/threads`, {
          method: "POST",
          body: JSON.stringify({}),
        });
        tid = res.data.id;
        setThreadId(tid);
        await loadThreads();
      } catch (e) {
        pushToast((e as Error).message, "error");
        return;
      }
    }
    setInput("");
    setSending(true);
    setLiveSteps([]);
    // Optimistically show the user message.
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: "user", content: message }]);

    // Subscribe to live step events for this turn.
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
      pushToast((e as Error).message, "error");
      // Reload so the persisted user message + any error state is reflected.
      await loadMessages(tid);
    } finally {
      es?.close();
      setSending(false);
      setLiveSteps([]);
    }
  }, [agent.id, input, threadId, loadMessages, loadThreads, pushToast]);

  const totalTokens = messages.reduce(
    (sum, m) => sum + (m.tokensIn ?? 0) + (m.tokensOut ?? 0),
    0,
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-base font-semibold">{agent.name}</span>
        <Badge variant={agent.active ? "default" : "secondary"}>{agent.active ? t`active` : t`off`}</Badge>
        {agent.memory && <Badge variant="secondary"><Trans>memory</Trans></Badge>}
        <Badge variant="secondary" className="gap-1 font-normal">
          <I.Sparkles size={11} /> {modelLabel(agent.model)}
        </Badge>
        <span className="text-xs text-muted-foreground">· {agent.tools.length} {t`tools`}</span>
        {totalTokens > 0 && (
          <span className="text-xs text-muted-foreground">· {fmtTokens(totalTokens)} {t`tokens`}</span>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          <select
            className="h-8 rounded-control border border-border bg-background px-2 text-[12.5px]"
            value={threadId ?? ""}
            onChange={(e) => setThreadId(e.target.value || null)}
          >
            <option value="">{t`New conversation`}</option>
            {threads.map((th) => (
              <option key={th.id} value={th.id}>{th.title || th.id.slice(0, 8)}</option>
            ))}
          </select>
          <Button variant="outline" size="sm" icon={I.Plus} onClick={newThread}><Trans>New chat</Trans></Button>
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
          <div className="flex flex-col gap-3 p-4">
            {messages.length === 0 && liveSteps.length === 0 && (
              <div className="py-10 text-center text-[13px] text-muted-foreground">
                <Trans>Send a message to start the conversation.</Trans>
              </div>
            )}
            {messages.map((m) => (
              <MessageRow key={m.id} message={m} />
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
            {sending && liveSteps.length === 0 && (
              <div className="text-[12px] text-muted-foreground"><Trans>Thinking…</Trans></div>
            )}
            <div ref={endRef} />
          </div>
        </ScrollArea>
        <div className="flex items-end gap-2 border-t border-border p-2.5">
          <Textarea
            className="min-h-[40px] flex-1 resize-none text-[13px]"
            value={input}
            disabled={sending}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t`Ask the agent…`}
          />
          <Button variant="primary" size="sm" icon={I.ArrowRight} disabled={sending || !input.trim()} onClick={send}>
            <Trans>Send</Trans>
          </Button>
        </div>
      </div>
    </>
  );
}

function MessageRow({ message }: { message: Message }) {
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
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] whitespace-pre-wrap rounded-surface px-3.5 py-2 text-[13px] ${isUser ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
        {message.content}
      </div>
    </div>
  );
}
