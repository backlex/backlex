// Pieces shared by the two agent surfaces: **Agents** (definitions — what an
// agent is and what it may do) and **Chat** (rooms — where you actually talk to
// them). They were one page until rooms arrived; splitting them kept the daily
// surface out of a management screen, and this module is what both still need.
import { useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { collabColor } from "../../lib/collab";
import type { AgentPeer } from "../../lib/agent-thread-live";

export interface Agent {
  id: string;
  name: string;
  /** Stable `@`-mention token — what you type in a room to address it. */
  handle?: string | null;
  description?: string | null;
  systemPrompt?: string | null;
  model?: string | null;
  /** Reasoning effort; "" / null = the provider default. */
  effort?: string | null;
  tools: string[];
  maxSteps: number;
  memory: boolean;
  /** How far distilled facts reach: `thread` (default) | `agent`. */
  memoryScope?: string;
  active: boolean;
  /** Reachable by the workspace's own END USERS through the app-plane chat
   *  route, not just by operators. Off unless an operator asks for it. */
  appAccess?: boolean;
}

/** How a room routes a message that addresses nobody. */
export type Routing = "mention" | "default" | "auto";

export interface Room {
  id: string;
  /** Server-derived label: the first line of the opening prompt (a raw id is
   *  meaningless in a list). Null only for a room with no messages yet. */
  title?: string | null;
  status: string;
  routing?: Routing;
  defaultAgentId?: string | null;
  agentId?: string | null;
  agentIds?: string[];
  updatedAt?: string | number | null;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  /** Team member who asked — rooms are workspace-wide, so a transcript can mix
   *  several people. Null on assistant/tool rows. */
  userId?: string | null;
  /** Which agent wrote it — a room's transcript mixes several. */
  agentId?: string | null;
  toolName?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

/** A teammate who appears in a transcript, shipped alongside the messages. */
export interface Author {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface RunStep {
  thought?: string;
  tool: string;
  observation: string;
  isError: boolean;
}

/** One agent's turn. Several can be in flight in the same room at once. */
export interface AgentRun {
  id: string;
  agentId: string;
  status: "queued" | "running" | "done" | "error";
  startedBy?: string | null;
}

/** Display handle for an author: their name, else the email's local part. */
export const authorLabel = (a: Author | undefined): string | null => {
  if (!a) return null;
  if (a.name?.trim()) return a.name.trim();
  if (!a.email) return null;
  const at = a.email.indexOf("@");
  return at > 0 ? a.email.slice(0, at) : a.email;
};

/** Curated model dropdown. The runner accepts any `provider/model` string, so
 *  "Custom…" keeps a free-text escape hatch. Claude ids need the workspace to
 *  bring its own key (or a self-host key); the `@cf/*` Cloudflare Workers AI ids
 *  are what managed-cloud projects run within their metered plan allowance —
 *  a managed agent left on "Default" runs Llama 3.1 70B. */
export const MODEL_OPTIONS = [
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
  { value: "anthropic/claude-opus-5", label: "Claude Opus 5", hint: "your key · most capable" },
  { value: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", hint: "your key · balanced" },
  { value: "anthropic/claude-haiku-4-5", label: "Claude Haiku 4.5", hint: "your key · fast/cheap" },
  { value: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "your key · AI Gateway" },
  { value: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "your key · AI Gateway · fast/cheap" },
] as const;

/** Managed default (mirrors the runner's CLOUD_DEFAULT_AGENT_MODEL). */
export const MANAGED_DEFAULT_MODEL = "@cf/zai-org/glm-5.2";

/** A model that isn't a Cloudflare `@cf/*` id needs the workspace to bring an
 *  AI key (Anthropic / AI Gateway) — otherwise it can't run as picked. */
export const modelNeedsKey = (v?: string | null): boolean => !!v && !v.startsWith("@cf/");

/** Human label for a model id. */
export const modelLabel = (m?: string | null): string => {
  if (!m) return "Default";
  const known = MODEL_OPTIONS.find((o) => o.value === m);
  if (known) return known.label.replace(/^Claude /, "");
  return m.includes("/") ? m.split("/").pop()! : m;
};

/** Workspace AI config (subset of GET /api/admin/ai-config). `secretsSet` is
 *  keyed by the registry's per-provider secret key, so it grows with the
 *  registry rather than naming providers here. */
export interface AiCfg {
  provider: string;
  secretsSet: Record<string, boolean>;
  env: { cloud: boolean; hasGatewayKey: boolean; hasAnthropicKey: boolean };
  /** Provider registry from the server. Optional so an older cached payload
   *  (or a narrower caller) still type-checks. */
  providers?: readonly { id: string; secretKey: string }[];
}

/** Does the workspace/deployment effectively have a direct AI key, so BYO
 *  (Claude / GPT / Gemini) models actually run instead of falling back?
 *  Registry-driven: whichever provider is selected, we ask whether ITS secret
 *  is stored — hard-coding gateway/anthropic here is what would silently make a
 *  workspace on an OpenAI key look keyless. */
export const hasEffectiveKey = (c: AiCfg | null): boolean => {
  if (!c) return false;
  if (c.env.hasGatewayKey || c.env.hasAnthropicKey) return true;
  if (c.provider === "inherit") return false;
  const secretKey =
    c.providers?.find((p) => p.id === c.provider)?.secretKey ?? `${c.provider}Key`;
  return c.secretsSet[secretKey] === true;
};

/** BYO models silently fall back to Workers AI on managed cloud when no key. */
export const keylessManaged = (c: AiCfg | null): boolean =>
  !!c && !hasEffectiveKey(c) && c.env.cloud;

/** The model that ACTUALLY runs for an agent given the key situation — so the
 *  UI can show the effective model, not a misleading configured-but-ignored one. */
export const effectiveModelValue = (
  agentModel: string | null | undefined,
  c: AiCfg | null,
): string => {
  const m = agentModel || "anthropic/claude-sonnet-5"; // runner's DEFAULT_MODEL
  if (!c || hasEffectiveKey(c)) return m; // configured model runs as picked
  if (c.env.cloud) return m.startsWith("@cf/") ? m : MANAGED_DEFAULT_MODEL;
  return m; // self-host, no key — configured (may error until a key is set)
};

/** Compact a token count for a header chip (1234 → "1.2k"). */
export const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Mirror of the server's thread label (`threadTitleFrom`) so the optimistic
 *  room row reads the same as the one that comes back from the API. */
export const previewTitle = (message: string, max = 64): string => {
  const flat = message.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
};

/** Short "when" stamp for a list row — recency is what picks a room apart, so
 *  minutes/hours/days beat a full timestamp at this width. */
export const fmtWhen = (v: string | number | null | undefined): string => {
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

/** Reasoning-effort picker. Empty = don't send the parameter at all, which is
 *  the provider default (`high` on the models that support it). */
export const EFFORT_OPTIONS = [
  { value: "", label: "Default", hint: "provider default (high)" },
  { value: "low", label: "Low", hint: "cheapest · short, scoped tasks" },
  { value: "medium", label: "Medium", hint: "balanced" },
  { value: "high", label: "High", hint: "most thorough · most tokens" },
];

/** How far an agent's distilled facts reach. `agent` is deliberately described
 *  in terms of its consequence, not its mechanism — the sharing is the whole
 *  point and also the whole risk, so the picker says so out loud. */
export const MEMORY_SCOPE_OPTIONS = [
  {
    value: "thread",
    label: "This conversation",
    hint: "default · nothing carries between rooms",
  },
  {
    value: "agent",
    label: "Every conversation",
    hint: "shared pool · facts from one person reach the next",
  },
];

/** Mirror of the server's `slugifyHandle`, so the editor's placeholder shows
 *  the handle the agent will actually get. */
export const slugPreview = (name: string): string =>
  name.trim().toLowerCase().replace(/\s+/g, "-").replace(/^-+|-+$/g, "");

export const MODEL_CUSTOM = "__custom__";
export const isKnownModel = (m: string) => MODEL_OPTIONS.some((o) => o.value === m);

/** Who else has this room open, as overlapping initials. Rooms are
 *  workspace-wide, so knowing a teammate is here (and typing) is the difference
 *  between a shared conversation and two people talking over each other. */
export function PresenceChips({
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

/** A speaker's byline: whoever wrote the row, human or agent. */
export interface Speaker {
  name: string;
  /** Stable per-identity colour, so the same voice reads the same all thread. */
  color: string;
  isAgent: boolean;
}

/** One live tool step, shared by the transcript's persisted rows and the
 *  in-flight stream so a step doesn't change shape when it lands. */
export function StepNote({
  icon,
  title,
  thought,
  observation,
  isError,
}: {
  icon: "tool" | "agent";
  title: string;
  thought?: string | null;
  observation?: string | null;
  isError?: boolean;
}) {
  const Icon = icon === "tool" ? I.Zap : I.Sparkles;
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-control border border-border bg-muted/40 px-3 py-2 text-[12px]">
      <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
        <Icon size={12} /> {title}
      </span>
      {thought && (
        <span className="whitespace-pre-wrap break-words text-muted-foreground">{thought}</span>
      )}
      {observation && (
        <span
          className={`whitespace-pre-wrap break-all font-mono text-[11px] ${isError ? "text-destructive" : "text-muted-foreground"}`}
        >
          {observation.slice(0, 400)}
        </span>
      )}
    </div>
  );
}

export function MessageRow({
  message,
  speaker,
  isMine,
}: {
  message: Message;
  /** Who wrote it. Null for your own messages — a byline over your own bubble
   *  is noise. */
  speaker: Speaker | null;
  isMine: boolean;
}) {
  if (message.role === "tool") {
    return (
      <StepNote icon="tool" title={message.toolName ?? "tool"} observation={message.content} />
    );
  }
  // A tool-call assistant step carries a toolName — render it like a step note.
  if (message.role === "assistant" && message.toolName) {
    return (
      <StepNote
        icon="agent"
        title={
          speaker ? `${speaker.name} · ${message.toolName}` : (message.toolName ?? "step")
        }
        thought={message.content}
      />
    );
  }
  const isUser = message.role === "user";
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}>
      {speaker && (
        <span className="flex items-center gap-1.5 px-1 text-[11px] text-muted-foreground">
          <span
            className="inline-flex size-4 items-center justify-center rounded-full text-[9px] font-semibold uppercase text-white"
            style={{ backgroundColor: speaker.color }}
          >
            {speaker.isAgent ? "*" : speaker.name.charAt(0)}
          </span>
          {speaker.name}
        </span>
      )}
      <div
        className={`max-w-[80%] overflow-hidden whitespace-pre-wrap break-words rounded-surface px-3.5 py-2 text-[13px] ${
          isUser
            ? isMine
              ? "bg-primary text-primary-foreground"
              : "border border-border bg-background"
            : "bg-muted"
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

/** Stable colour for an agent's byline, distinct from the teammate palette by
 *  seeding on the id the same way collab does. */
export const agentColor = (id: string): string => collabColor(id);

/** The label a room shows for an agent: its mention handle when it has one, so
 *  what you read in the transcript is what you type to address it. */
export const agentLabel = (a: Agent | undefined): string =>
  a ? (a.handle ? `@${a.handle}` : a.name) : "agent";

/**
 * Room routing options — a finite set, so it's a dropdown, not free text.
 *
 * Each label reads as an answer to the field's question ("When nobody is
 * mentioned"), NOT as a statement about the room. An earlier wording,
 * "One agent always answers", read like a limit on how many agents a room may
 * hold, which is a different thing entirely — a room with five agents can still
 * have one of them field the unaddressed messages.
 */
export const useRoutingOptions = (): { value: Routing; label: string; hint: string }[] => {
  const { t } = useLingui();
  return [
    { value: "mention", label: t`Nobody answers`, hint: t`type @ to address an agent` },
    { value: "default", label: t`A chosen agent answers`, hint: t`pick which one below` },
    { value: "auto", label: t`Whichever agent fits best`, hint: t`one extra model call per message` },
  ];
};
