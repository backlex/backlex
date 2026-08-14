// Chat — rooms where the team and its agents talk in one shared transcript.
//
// A room is workspace-wide: any admin sees the same conversations, and several
// agents can sit in one. Address an agent with `@handle` and it answers; two
// mentions run two turns in parallel (each agent holds its own lock). A room
// that addresses nobody is still a perfectly good human-to-human thread.
//
// Turns run in the background (`async: true`) and stream back over
// `agent:thread:<id>`, which is also how a teammate's question and its steps
// reach your screen. Presence + typing ride the same channel.
import type { PushToast } from "../../types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, PageHeader } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Label } from "@backlex/ui/components/label";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Select } from "../../select";
import { ConfirmDialog } from "../../sheet";
import { api } from "@/lib/api";
import { fetchSafely } from "../_shared";
import { useMe } from "../../queries";
import { collabColor } from "../../lib/collab";
import { useAgentThreadLive } from "../../lib/agent-thread-live";
import { ChatSkeleton } from "../../page-skeletons";
import {
  MessageRow,
  PresenceChips,
  useRoutingOptions,
  StepNote,
  agentColor,
  agentLabel,
  authorLabel,
  fmtTokens,
  fmtWhen,
  previewTitle,
  type Agent,
  type AgentRun,
  type Author,
  type Message,
  type Room,
  type RunStep,
  type Routing,
  type Speaker,
} from "./_agents-shared";

/** A turn in flight, as the room sees it. Several can be live at once, so the
 *  transcript shows one working strip per agent rather than a global "busy". */
interface LiveRun {
  runId: string;
  agentId: string;
  steps: RunStep[];
  startedBy?: string | null;
}

/** Where the composer's mention picker is anchored: the `@` that opened it and
 *  the partial handle typed since. */
interface MentionQuery {
  at: number;
  query: string;
}

/** What may NOT precede a mention's `@` — mirrors the server's `WORD_CHAR` in
 *  `services/agents/mentions`, so the picker opens exactly where a mention
 *  would actually resolve. */
const WORD_CHAR = /[\p{L}\p{N}._+@-]/u;

/** Find the mention being typed at the caret, or null. Only an `@` that starts
 *  a word counts, so an email address doesn't open the picker. */
const mentionAtCaret = (value: string, caret: number): MentionQuery | null => {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && WORD_CHAR.test(upto[at - 1] as string)) return null;
  const query = upto.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { at, query };
};

export function ChatPage({
  pushToast,
  setActiveNav,
}: {
  pushToast: PushToast;
  setActiveNav?: (id: string) => void;
}) {
  const { t } = useLingui();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const meQuery = useMe();
  const meId = meQuery.data?.data?.id ?? null;

  const loadAll = useCallback(async () => {
    const [a, r] = await Promise.all([
      fetchSafely<{ data: Agent[] }>("/api/agents"),
      fetchSafely<{ data: Room[] }>("/api/agents/threads"),
    ]);
    setAgents(a?.data ?? []);
    setRooms(r?.data ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const room = rooms.find((r) => r.id === roomId) ?? null;

  const createRoom = useCallback(
    async (input: {
      title: string;
      agentIds: string[];
      routing: Routing;
      defaultAgentId: string | null;
    }) => {
      // Optimistic: the room appears (and is selected) before the round-trip,
      // then reconciles to the server's id.
      const tempId = `tmp-${Date.now()}`;
      const optimistic: Room = {
        id: tempId,
        title: input.title || t`New room`,
        status: "idle",
        routing: input.routing,
        defaultAgentId: input.defaultAgentId,
        agentIds: input.agentIds,
        updatedAt: Date.now(),
      };
      setRooms((prev) => [optimistic, ...prev]);
      setRoomId(tempId);
      setNewOpen(false);
      try {
        const res = await api<{ data: Room }>("/api/agents/threads", {
          method: "POST",
          body: JSON.stringify({
            ...(input.title ? { title: input.title } : {}),
            agentIds: input.agentIds,
            routing: input.routing,
            ...(input.defaultAgentId ? { defaultAgentId: input.defaultAgentId } : {}),
          }),
        });
        setRooms((prev) =>
          prev.map((r) =>
            r.id === tempId ? { ...res.data, agentIds: input.agentIds } : r,
          ),
        );
        setRoomId(res.data.id);
      } catch (e) {
        setRooms((prev) => prev.filter((r) => r.id !== tempId));
        setRoomId(null);
        pushToast((e as Error).message, "error");
      }
    },
    [pushToast, t],
  );

  const deleteRoom = useCallback(
    async (id: string) => {
      const snapshot = rooms;
      setRooms((prev) => prev.filter((r) => r.id !== id));
      if (roomId === id) setRoomId(null);
      try {
        await api(`/api/agents/threads/${id}`, { method: "DELETE" });
        pushToast(t`Room deleted.`);
      } catch (e) {
        setRooms(snapshot);
        pushToast((e as Error).message, "error");
      }
    },
    [rooms, roomId, pushToast, t],
  );

  /** Patch one room in place — used by the detail pane's optimistic edits so
   *  the list and the header never disagree. */
  const patchRoom = useCallback((id: string, patch: Partial<Room>) => {
    setRooms((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }, []);

  if (!loaded) return <ChatSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Chat`}
        description={t`Shared rooms where your team and its agents talk. Type @ to address an agent.`}
        actions={
          <Button
            variant="primary"
            icon={I.Plus}
            disabled={agents.length === 0}
            onClick={() => setNewOpen(true)}
          >
            <Trans>New room</Trans>
          </Button>
        }
      />

      {agents.length === 0 && (
        <Card className="gap-3 p-[22px]">
          <EmptyState
            bare
            icon={I.Sparkles}
            title={<Trans>No agents yet</Trans>}
            description={
              <Trans>A room needs at least one agent to talk to. Create one on the Agents page first.</Trans>
            }
          />
          {setActiveNav && (
            <div className="flex justify-center">
              <Button variant="outline" size="sm" onClick={() => setActiveNav("agents")}>
                <Trans>Go to Agents</Trans>
              </Button>
            </div>
          )}
        </Card>
      )}

      {agents.length > 0 && (
        <div className="grid grid-cols-[300px_minmax(0,1fr)] items-start gap-3.5 max-[900px]:grid-cols-[minmax(0,1fr)]">
          <Card className="gap-0 py-0">
            {rooms.length === 0 && (
              <EmptyState size="sm" title={<Trans>No rooms yet — click + New room.</Trans>} />
            )}
            {rooms.map((r) => (
              <div
                key={r.id}
                onClick={() => setRoomId(r.id)}
                className={`grid cursor-pointer grid-cols-[20px_1fr_auto] items-center gap-2.5 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 ${roomId === r.id ? "bg-accent" : ""}`}
              >
                <span><I.MessageSquare size={14} /></span>
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] font-medium">
                    {r.title || t`Empty room`}
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {(r.agentIds ?? []).length} {t`agents`} · {fmtWhen(r.updatedAt)}
                  </span>
                </div>
                {r.status === "running" && (
                  <Badge variant="secondary" className="font-normal"><Trans>live</Trans></Badge>
                )}
              </div>
            ))}
          </Card>

          <Card className="gap-4 p-[22px]">
            {!room ? (
              <EmptyState
                bare
                icon={I.MessageSquare}
                title={<Trans>No room selected</Trans>}
                description={<Trans>Pick a room on the left, or click <strong>+ New room</strong>.</Trans>}
              />
            ) : (
              <RoomView
                key={room.id}
                room={room}
                agents={agents}
                meId={meId}
                pushToast={pushToast}
                onPatch={(patch) => patchRoom(room.id, patch)}
                onDelete={() => deleteRoom(room.id)}
                onActivity={() => patchRoom(room.id, { updatedAt: Date.now() })}
              />
            )}
          </Card>
        </div>
      )}

      {newOpen && (
        <NewRoomDialog
          agents={agents}
          onCancel={() => setNewOpen(false)}
          onCreate={createRoom}
        />
      )}
    </div>
  );
}

function NewRoomDialog({
  agents,
  onCancel,
  onCreate,
}: {
  agents: Agent[];
  onCancel: () => void;
  onCreate: (input: {
    title: string;
    agentIds: string[];
    routing: Routing;
    defaultAgentId: string | null;
  }) => void;
}) {
  const { t } = useLingui();
  const routingOptions = useRoutingOptions();
  const [title, setTitle] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [routing, setRouting] = useState<Routing>("mention");
  const [defaultAgentId, setDefaultAgentId] = useState<string>("");
  // "A chosen agent answers" needs to know WHICH one. Default to the first
  // agent in the room and drop the pick if that agent is unchecked again, so
  // the mode can never be saved pointing at nobody.
  const pickedAgents = picked
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is Agent => !!a);
  const effectiveDefault =
    defaultAgentId && picked.includes(defaultAgentId) ? defaultAgentId : (picked[0] ?? "");

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="w-[560px] max-w-[92vw] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle><Trans>New room</Trans></DialogTitle>
          <DialogDescription>
            <Trans>Pick who's in the room. You can add or remove agents later.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4 px-0.5 py-1">
            <div className="flex flex-col gap-1.5">
              <Label><Trans>Name</Trans></Label>
              <Input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t`Weekly numbers`}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Optional — a room with no name is labelled after its first message.</Trans>
              </span>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label><Trans>Agents in the room</Trans></Label>
              <div className="flex flex-col gap-1 rounded-control border border-border p-1.5">
                {agents.map((a) => {
                  const on = picked.includes(a.id);
                  return (
                    <button
                      type="button"
                      key={a.id}
                      onClick={() =>
                        setPicked((prev) =>
                          on ? prev.filter((x) => x !== a.id) : [...prev, a.id],
                        )
                      }
                      className={`flex min-w-0 items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-[13px] transition-colors ${on ? "bg-accent" : "hover:bg-muted"}`}
                    >
                      <span
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                        style={{ backgroundColor: agentColor(a.id) }}
                      >
                        *
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{a.name}</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          {agentLabel(a)}
                        </span>
                      </span>
                      {on && <I.Check size={13} className="shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <Label><Trans>When nobody is mentioned</Trans></Label>
              <Select
                className="min-w-0"
                value={routing}
                onChange={(v) => setRouting(v as Routing)}
                // An empty room can only be mention-only: the other two modes
                // need someone to hand the message to. Offering them as dead
                // entries would be worse than not offering them.
                options={routingOptions
                  .filter((o) => o.value === "mention" || picked.length > 0)
                  .map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
              />
              {routing === "default" && picked.length > 0 && (
                <Select
                  className="min-w-0"
                  value={effectiveDefault}
                  onChange={(v) => setDefaultAgentId(v)}
                  options={pickedAgents.map((a) => ({
                    value: a.id,
                    label: a.name,
                    hint: agentLabel(a),
                  }))}
                />
              )}
              {routing === "auto" && (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>
                    Picked from each agent's description, so give them one. Costs an extra model
                    call per unaddressed message.
                  </Trans>
                </span>
              )}
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}><Trans>Cancel</Trans></Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() =>
              onCreate({
                title: title.trim(),
                agentIds: picked,
                routing,
                defaultAgentId: routing === "default" ? effectiveDefault : null,
              })
            }
          >
            <Trans>Create room</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RoomView({
  room,
  agents,
  meId,
  pushToast,
  onPatch,
  onDelete,
  onActivity,
}: {
  room: Room;
  agents: Agent[];
  meId: string | null;
  pushToast: PushToast;
  onPatch: (patch: Partial<Room>) => void;
  onDelete: () => void;
  onActivity: () => void;
}) {
  const { t } = useLingui();
  const routingOptions = useRoutingOptions();
  const [messages, setMessages] = useState<Message[]>([]);
  const [authors, setAuthors] = useState<Record<string, Author>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [liveRuns, setLiveRuns] = useState<LiveRun[]>([]);
  const [mention, setMention] = useState<MentionQuery | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  // Deleting a room throws away a shared transcript, so it asks first.
  const [confirmDelete, setConfirmDelete] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const memberIds = room.agentIds ?? [];
  const members = useMemo(
    () => memberIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a),
    [memberIds, agents],
  );
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const loadTranscript = useCallback(async (id: string) => {
    const r = await fetchSafely<{
      data: {
        messages: Message[];
        authors?: Author[];
        agentIds?: string[];
        activeRuns?: AgentRun[];
      };
    }>(`/api/agents/threads/${id}`);
    setMessages(r?.data?.messages ?? []);
    setAuthors(Object.fromEntries((r?.data?.authors ?? []).map((a) => [a.id, a])));
    // Turns already in flight when you opened the room — otherwise a teammate's
    // running agent looks idle until its next step lands.
    setLiveRuns(
      (r?.data?.activeRuns ?? []).map((run) => ({
        runId: run.id,
        agentId: run.agentId,
        steps: [],
        startedBy: run.startedBy,
      })),
    );
    return r?.data;
  }, []);

  useEffect(() => {
    void (async () => {
      const data = await loadTranscript(room.id);
      if (data?.agentIds) onPatch({ agentIds: data.agentIds });
    })();
    // Reload only when the room changes — `onPatch` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, loadTranscript]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages, liveRuns]);

  // ── live sync ────────────────────────────────────────────────────────────
  // Every frame lands for every viewer, and now carries `agentId` + `runId` —
  // a room streams several turns at once, so the indicators are per agent.
  const onLiveEvent = useCallback(
    (e: { event: string; data: any }) => {
      const d = e.data ?? {};
      switch (e.event) {
        case "agent.message": {
          if (d.userId && meId && d.userId === meId) return; // already optimistic
          if (!d.id || !d.content) return;
          setMessages((m) =>
            m.some((x) => x.id === d.id)
              ? m
              : [...m, { id: d.id, role: d.role ?? "user", content: d.content, userId: d.userId }],
          );
          return;
        }
        case "agent.queued":
        case "agent.start": {
          if (!d.runId) return;
          setLiveRuns((runs) =>
            runs.some((r) => r.runId === d.runId)
              ? runs
              : [...runs, { runId: d.runId, agentId: d.agentId, steps: [], startedBy: d.userId }],
          );
          return;
        }
        case "agent.step": {
          if (!d.runId) return;
          setLiveRuns((runs) =>
            runs.map((r) =>
              r.runId === d.runId ? { ...r, steps: [...r.steps, d as RunStep] } : r,
            ),
          );
          return;
        }
        case "agent.final":
        case "agent.error": {
          setLiveRuns((runs) => runs.filter((r) => r.runId !== d.runId));
          if (e.event === "agent.error" && d.message) {
            pushToast(
              t`${agentLabel(agentById.get(d.agentId))} couldn't finish: ${d.message}`,
              "error",
            );
          }
          // Pull the persisted transcript rather than trusting the frame — it
          // carries the tool rows and token counts too.
          void loadTranscript(room.id);
          onActivity();
          return;
        }
        default:
      }
    },
    [meId, room.id, loadTranscript, onActivity, pushToast, t, agentById],
  );
  const { peers, notifyTyping } = useAgentThreadLive(room.id, meId, onLiveEvent);

  const nameFor = useCallback(
    (userId: string): string =>
      authorLabel(authors[userId]) ??
      peers.find((p) => p.id === userId)?.name ??
      userId.slice(0, 6),
    [authors, peers],
  );

  // ── composer ─────────────────────────────────────────────────────────────
  const mentionMatches = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return members
      .filter((a) => a.active)
      .filter(
        (a) =>
          !q ||
          (a.handle ?? "").toLowerCase().includes(q) ||
          a.name.toLowerCase().includes(q),
      );
  }, [mention, members]);

  const applyMention = useCallback(
    (agent: Agent) => {
      if (!mention) return;
      const handle = agent.handle ?? agent.name.replace(/\s+/g, "-").toLowerCase();
      const caret = inputRef.current?.selectionStart ?? input.length;
      const next = `${input.slice(0, mention.at)}@${handle} ${input.slice(caret)}`;
      setInput(next);
      setMention(null);
      // Put the caret right after the inserted handle, so typing continues.
      const pos = mention.at + handle.length + 2;
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(pos, pos);
      });
    },
    [mention, input],
  );

  const onInputChange = useCallback(
    (value: string, caret: number) => {
      setInput(value);
      const m = mentionAtCaret(value, caret);
      setMention(m);
      setMentionIdx(0);
      notifyTyping();
    },
    [notifyTyping],
  );

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || sending) return;
    setInput("");
    setMention(null);
    setSending(true);
    // Optimistic bubble — the send is async, so this is what makes the room
    // feel immediate even before the first agent frame arrives.
    const tmpId = `tmp-${Date.now()}`;
    setMessages((m) => [...m, { id: tmpId, role: "user", content: message, userId: meId }]);
    if (!room.title) onPatch({ title: previewTitle(message) });
    onActivity();

    try {
      const res = await api<{
        data: { runs?: { runId: string; agentId: string }[]; busy?: { agentId: string }[] };
      }>(`/api/agents/threads/${room.id}/messages`, {
        method: "POST",
        body: JSON.stringify({ message, async: true }),
      });
      // Seed the working strips from the response instead of waiting for the
      // channel — the runs are already claimed by the time this resolves.
      const started = res.data.runs ?? [];
      setLiveRuns((runs) => [
        ...runs,
        ...started
          .filter((r) => !runs.some((x) => x.runId === r.runId))
          .map((r) => ({ runId: r.runId, agentId: r.agentId, steps: [], startedBy: meId })),
      ]);
      for (const b of res.data.busy ?? []) {
        pushToast(
          t`${agentLabel(agentById.get(b.agentId))} is still working on the previous message.`,
          "error",
        );
      }
      void loadTranscript(room.id);
    } catch (e) {
      setMessages((m) => m.filter((x) => x.id !== tmpId));
      setInput((cur) => cur || message);
      pushToast((e as Error).message, "error");
    } finally {
      setSending(false);
    }
  }, [input, sending, room.id, room.title, meId, pushToast, t, agentById, loadTranscript, onPatch, onActivity]);

  // ── room settings ────────────────────────────────────────────────────────
  const setRouting = useCallback(
    async (routing: Routing) => {
      const prev = room.routing ?? "mention";
      onPatch({ routing });
      try {
        await api(`/api/agents/threads/${room.id}`, {
          method: "PATCH",
          body: JSON.stringify({ routing }),
        });
      } catch (e) {
        onPatch({ routing: prev });
        pushToast((e as Error).message, "error");
      }
    },
    [room.id, room.routing, onPatch, pushToast],
  );

  const setDefaultAgent = useCallback(
    async (agentId: string) => {
      const prev = room.defaultAgentId ?? null;
      onPatch({ defaultAgentId: agentId });
      try {
        await api(`/api/agents/threads/${room.id}`, {
          method: "PATCH",
          body: JSON.stringify({ defaultAgentId: agentId }),
        });
      } catch (e) {
        onPatch({ defaultAgentId: prev });
        pushToast((e as Error).message, "error");
      }
    },
    [room.id, room.defaultAgentId, onPatch, pushToast],
  );

  const toggleMember = useCallback(
    async (agentId: string) => {
      const inRoom = memberIds.includes(agentId);
      const next = inRoom ? memberIds.filter((x) => x !== agentId) : [...memberIds, agentId];
      onPatch({ agentIds: next });
      try {
        if (inRoom) {
          await api(`/api/agents/threads/${room.id}/agents/${agentId}`, { method: "DELETE" });
        } else {
          await api(`/api/agents/threads/${room.id}/agents`, {
            method: "POST",
            body: JSON.stringify({ agentId }),
          });
        }
      } catch (e) {
        onPatch({ agentIds: memberIds });
        pushToast((e as Error).message, "error");
      }
    },
    [memberIds, room.id, onPatch, pushToast],
  );

  const speakerFor = useCallback(
    (m: Message): Speaker | null => {
      if (m.role === "user") {
        if (!m.userId || m.userId === meId) return null;
        return { name: nameFor(m.userId), color: collabColor(m.userId), isAgent: false };
      }
      const agent = m.agentId ? agentById.get(m.agentId) : undefined;
      if (!agent) return null;
      return { name: agentLabel(agent), color: agentColor(agent.id), isAgent: true };
    },
    [meId, nameFor, agentById],
  );

  const totalTokens = messages.reduce(
    (sum, m) => sum + (m.tokensIn ?? 0) + (m.tokensOut ?? 0),
    0,
  );
  const typingPeers = peers.filter((p) => p.typing);
  const routing = room.routing ?? "mention";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="truncate text-base font-semibold">{room.title || t`Empty room`}</span>
        {totalTokens > 0 && (
          <span className="text-xs text-muted-foreground">
            {fmtTokens(totalTokens)} {t`tokens`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <PresenceChips peers={peers} nameFor={nameFor} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" icon={I.Users}>
                <span className="max-[420px]:hidden"><Trans>Agents</Trans></span>
                <span className="font-mono text-[11px]">{members.length}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[min(20rem,calc(100vw-2rem))]">
              <DropdownMenuLabel><Trans>In this room</Trans></DropdownMenuLabel>
              <ScrollArea viewportClassName="max-h-[280px]">
                {agents.map((a) => (
                  <DropdownMenuCheckboxItem
                    key={a.id}
                    checked={memberIds.includes(a.id)}
                    onCheckedChange={() => void toggleMember(a.id)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-[13px]">{a.name}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground">
                        {agentLabel(a)}
                      </span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </ScrollArea>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setConfirmDelete(true)}>
                <I.Trash size={12} /> <Trans>Delete room</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {members.map((a) => (
          <Badge key={a.id} variant="secondary" className="gap-1.5 font-normal">
            <span
              className="inline-flex size-3.5 items-center justify-center rounded-full text-[8px] font-semibold text-white"
              style={{ backgroundColor: agentColor(a.id) }}
            >
              *
            </span>
            <span className="font-mono text-[11px]">{agentLabel(a)}</span>
          </Badge>
        ))}
        {members.length === 0 && (
          <span className="text-[12px] text-muted-foreground">
            <Trans>No agents in this room yet — add one from the Agents menu.</Trans>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-1.5">
          <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
            <Trans>When nobody is mentioned</Trans>
          </Label>
          <Select
            className="min-w-0"
            value={routing}
            onChange={(v) => void setRouting(v as Routing)}
            options={routingOptions
              .filter((o) => o.value === "mention" || members.length > 0)
              .map((o) => ({ value: o.value, label: o.label, hint: o.hint }))}
          />
        </div>
        {routing === "default" && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">
              <Trans>Default agent</Trans>
            </Label>
            <Select
              className="min-w-0"
              value={room.defaultAgentId ?? ""}
              onChange={(v) => void setDefaultAgent(v)}
              options={members.map((a) => ({ value: a.id, label: a.name, hint: agentLabel(a) }))}
            />
          </div>
        )}
      </div>

      <div className="flex h-[460px] flex-col overflow-hidden rounded-control border border-border max-[640px]:h-[420px]">
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex min-w-0 flex-col gap-3 p-4">
            {messages.length === 0 && liveRuns.length === 0 && (
              <div className="py-10 text-center text-[13px] text-muted-foreground">
                <Trans>Send a message to start the conversation. Type @ to address an agent.</Trans>
              </div>
            )}
            {messages.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                speaker={speakerFor(m)}
                isMine={m.role === "user" && (!m.userId || m.userId === meId)}
              />
            ))}
            {/* One strip per agent mid-turn — a room can have several at once. */}
            {liveRuns.map((run) => {
              const agent = agentById.get(run.agentId);
              return (
                <div key={run.runId} className="flex min-w-0 flex-col gap-2">
                  {run.steps.map((s, i) => (
                    <StepNote
                      key={`${run.runId}-${i}`}
                      icon="tool"
                      title={`${agentLabel(agent)} · ${s.tool}`}
                      thought={s.thought}
                      observation={s.observation}
                      isError={s.isError}
                    />
                  ))}
                  <div className="flex flex-col gap-2 px-1 py-1.5">
                    <div className="agent-sweep-track" aria-hidden />
                    <span className="text-[12px] text-muted-foreground">
                      {run.steps.length > 0
                        ? t`${agentLabel(agent)} is working…`
                        : t`${agentLabel(agent)} is thinking…`}
                    </span>
                  </div>
                </div>
              );
            })}
            <div ref={endRef} />
          </div>
        </ScrollArea>

        <div className="relative flex flex-col gap-1.5 border-t border-border p-2.5">
          {mention && mentionMatches.length > 0 && (
            <div className="absolute bottom-full left-2.5 right-2.5 z-20 mb-1 overflow-hidden rounded-control border border-border bg-popover shadow-md">
              <ScrollArea viewportClassName="max-h-[200px]" className="w-full">
                <div className="flex flex-col p-1">
                  {mentionMatches.map((a, i) => (
                    <button
                      type="button"
                      key={a.id}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        applyMention(a);
                      }}
                      onMouseEnter={() => setMentionIdx(i)}
                      className={`flex min-w-0 items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-[13px] ${i === mentionIdx ? "bg-accent" : ""}`}
                    >
                      <span
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                        style={{ backgroundColor: agentColor(a.id) }}
                      >
                        *
                      </span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                        {agentLabel(a)}
                      </span>
                      <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                        {a.name}
                      </span>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
          {typingPeers.length > 0 && (
            <span className="px-1 text-[11px] text-muted-foreground">
              {typingPeers.length === 1
                ? t`${nameFor(typingPeers[0]!.id)} is typing…`
                : t`${typingPeers.length} teammates are typing…`}
            </span>
          )}
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              className="min-h-[40px] min-w-0 flex-1 resize-none text-[13px]"
              value={input}
              onChange={(e) => onInputChange(e.target.value, e.target.selectionStart ?? 0)}
              onKeyDown={(e) => {
                if (mention && mentionMatches.length > 0) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setMentionIdx((i) => (i + 1) % mentionMatches.length);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setMentionIdx((i) => (i - 1 + mentionMatches.length) % mentionMatches.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    const picked = mentionMatches[mentionIdx];
                    if (picked) applyMention(picked);
                    return;
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setMention(null);
                    return;
                  }
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={
                members.length === 0
                  ? t`Add an agent to this room, or just talk to your team…`
                  : t`Message the room — type @ to address an agent…`
              }
            />
            <Button
              variant="primary"
              size="sm"
              icon={I.ArrowRight}
              disabled={sending || !input.trim()}
              onClick={send}
            >
              <span className="max-[420px]:hidden">
                {sending ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
              </span>
            </Button>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        destructive
        title={t`Delete "${room.title || t`this room`}"?`}
        description={
          <Trans>
            This deletes the room and its whole transcript for everyone on the team. The agents
            themselves are <strong>not</strong> deleted. This can't be undone.
          </Trans>
        }
        actionLabel={t`Delete room`}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          setConfirmDelete(false);
          onDelete();
        }}
      />
    </>
  );
}
