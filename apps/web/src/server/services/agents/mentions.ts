/**
 * Who answers a message in a room.
 *
 * A room hosts several agents, so "send a message" no longer implies "run the
 * thread's agent". Three ways an agent gets picked, in precedence order:
 *
 *  1. **Explicit `@handle`** — deterministic, free, and the default the UI
 *     drives through a picker so nobody has to type a handle correctly.
 *  2. **The room's default agent** (`routing: "default"`) — what a pre-rooms
 *     thread does on every message, preserved for migrated threads.
 *  3. **A cheap router call** (`routing: "auto"`) — one small model call that
 *     reads the participants' descriptions and names one. Costs a round-trip
 *     and can pick wrong, which is why it's opt-in per room.
 *
 * Only `role: "user"` messages are ever routed. An `@mention` inside an
 * agent's own answer never starts a turn, so agents can't trigger each other
 * into an endless chain — the guarantee is structural, not a depth counter.
 */
import { callClaude } from "../../mcp/ai-client";
import type { Env } from "../../env";
import type { AgentRow, ThreadRow } from "./store";

/** Trailing characters stripped off a mention token so `@sales, what…` and
 *  `(@sales)` still resolve. Only these — trimming arbitrary characters could
 *  turn `@data-buddy` into a match for an unrelated `@data`. */
const TRAILING_PUNCT = new Set([",", ".", "!", "?", ":", ";", ")", "]", "}", "'", '"', "…"]);

/** Handles can hold unicode letters and dashes but never whitespace or a
 *  second `@`, so a token runs to the next space. */
const MENTION_RE = /@([^\s@]+)/gu;

/** What may NOT precede a mention's `@`. Deliberately the characters an email
 *  local-part ends with, so `me@sales` is prose, while `(@sales` is a mention. */
const WORD_CHAR = /[\p{L}\p{N}._+@-]/u;

/**
 * Agent ids explicitly mentioned in `text`, in the order they appear, deduped.
 * Unknown handles are ignored (an `@` in prose isn't an error), and so are
 * inactive agents — a paused agent shouldn't answer just because it was named.
 */
export const parseMentions = (text: string, agents: AgentRow[]): string[] => {
  const byHandle = new Map<string, AgentRow>();
  for (const a of agents) if (a.handle) byHandle.set(a.handle.toLowerCase(), a);
  if (byHandle.size === 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) {
    // Only an `@` that starts a word is a mention — otherwise every email
    // address in a message would summon an agent. Opening brackets and quotes
    // still count as a start, so "(@sales)" works.
    const at = m.index ?? 0;
    if (at > 0 && WORD_CHAR.test(text[at - 1] as string)) continue;
    let token = (m[1] ?? "").toLowerCase();
    while (token.length > 0 && !byHandle.has(token)) {
      const last = token[token.length - 1] as string;
      if (!TRAILING_PUNCT.has(last)) break;
      token = token.slice(0, -1);
    }
    const agent = byHandle.get(token);
    if (!agent || !agent.active || seen.has(agent.id)) continue;
    seen.add(agent.id);
    out.push(agent.id);
  }
  return out;
};

/** Does this text mention anyone at all? Used to decide whether routing even
 *  applies, separately from whether the mentioned agents were resolvable. */
export const hasMention = (text: string, agents: AgentRow[]): boolean =>
  parseMentions(text, agents).length > 0;

const ROUTER_SYSTEM =
  "You route a message in a team chat room to the single agent best suited to " +
  "answer it. Reply with ONLY that agent's handle, exactly as given, and " +
  "nothing else. If no agent is a good fit, reply with exactly: none";

/** One small model call that names a participant. Best-effort by design: any
 *  failure (no AI provider, a garbled reply, an unknown handle) resolves to
 *  "nobody answers" rather than breaking the message send. */
const routeAutomatically = async (
  env: Env,
  message: string,
  candidates: AgentRow[],
): Promise<string | null> => {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]?.id ?? null;

  const roster = candidates
    .map((a) => `- ${a.handle}: ${a.name}${a.description ? ` — ${a.description}` : " — (no description)"}`)
    .join("\n");
  let text: string;
  try {
    const reply = await callClaude(env, {
      system: ROUTER_SYSTEM,
      user: `Agents:\n${roster}\n\nMessage:\n${message}`,
      maxTokens: 16,
    });
    text = reply.text;
  } catch {
    return null; // no provider / provider error — the room just stays quiet
  }
  const answer = text.trim().toLowerCase().replace(/^@/, "").replace(/[.!?,]+$/, "");
  if (!answer || answer === "none") return null;
  return candidates.find((a) => a.handle?.toLowerCase() === answer)?.id ?? null;
};

export interface ResolveRespondersInput {
  env: Env;
  thread: ThreadRow;
  /** The room's participants, already loaded. */
  participants: AgentRow[];
  message: string;
}

/**
 * The agents that should answer this message — possibly none, possibly
 * several. Each returned id gets its own run, and runs for different agents
 * proceed in parallel (see `claimRun`).
 */
export const resolveResponders = async (
  input: ResolveRespondersInput,
): Promise<string[]> => {
  const { thread, participants, message, env } = input;
  const active = participants.filter((a) => a.active);

  const mentioned = parseMentions(message, active);
  if (mentioned.length > 0) return mentioned;

  if (thread.routing === "default") {
    const id = thread.defaultAgentId ?? thread.agentId;
    const agent = active.find((a) => a.id === id);
    return agent ? [agent.id] : [];
  }
  if (thread.routing === "auto") {
    const picked = await routeAutomatically(env, message, active);
    return picked ? [picked] : [];
  }
  // "mention": nobody was named, so nobody answers. A room stays usable as a
  // plain human-to-human thread.
  return [];
};
