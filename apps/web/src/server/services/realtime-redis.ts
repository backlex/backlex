/**
 * Durable cross-instance realtime transport backed by an Upstash Redis Stream
 * per channel, over the Upstash REST API (plain `fetch`, so it works on every
 * runtime including stateless serverless).
 *
 * Why: on Vercel / Netlify Functions each invocation is a fresh isolate, so the
 * in-process pub/sub map (Bun) never sees a publish from another invocation and
 * there's no Durable Object (Workers). A Redis Stream gives both fan-out (any
 * instance XADDs, any subscriber XRANGEs) and replay (`Last-Event-ID` → resume
 * from a stream id) without holding server state.
 *
 * One stream key per channel: `rt:{channel}`, capped with `MAXLEN ~ N` so it
 * self-trims. Stream entry ids (`<ms>-<seq>`) double as the SSE `id:`, so the
 * browser's `Last-Event-ID` resume maps straight onto an exclusive XRANGE.
 *
 * Permission filtering is NOT done here — the subscribe loop renders each event
 * through `renderEventForMeta` (the same filter the in-process fan-out uses), so
 * the two transports can't drift on what a subscriber is allowed to see.
 */
import type { Env } from "../env";

/** Stream key per channel. */
const streamKey = (channel: string) => `rt:${channel}`;
/** Approximate cap on retained events per channel (self-trimming via MAXLEN ~). */
const STREAM_MAXLEN = 1000;

export interface RedisStreamEntry {
  /** Stream entry id, e.g. `1700000000000-0`. Used as the SSE `id:`. */
  id: string;
  /** The decoded published payload. */
  payload: unknown;
}

export const redisRealtimeEnabled = (env: Env): boolean =>
  Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);

/** Run one Redis command via the Upstash REST endpoint. */
const cmd = async (env: Env, args: (string | number)[]): Promise<unknown> => {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Upstash Redis is not configured");
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    throw new Error(`Upstash Redis ${args[0]} failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { result?: unknown; error?: string };
  if (body.error) throw new Error(`Upstash Redis ${args[0]} error: ${body.error}`);
  return body.result;
};

/** Append a payload to the channel's stream; returns the new entry id. */
export const redisPublish = async (
  env: Env,
  channel: string,
  payload: unknown,
): Promise<string> => {
  const id = await cmd(env, [
    "XADD",
    streamKey(channel),
    "MAXLEN",
    "~",
    STREAM_MAXLEN,
    "*",
    "d",
    JSON.stringify(payload),
  ]);
  return String(id);
};

/** The id of the most recent entry, or `"0"` if the stream is empty. Used to
 *  position a fresh subscriber at "now" (only future events). */
export const redisLatestId = async (env: Env, channel: string): Promise<string> => {
  const res = (await cmd(env, ["XREVRANGE", streamKey(channel), "+", "-", "COUNT", 1])) as
    | [string, string[]][]
    | null;
  return res && res[0] ? res[0][0] : "0";
};

/** Read entries newer than `afterId` (exclusive). Returns `[]` when none. */
export const redisReadSince = async (
  env: Env,
  channel: string,
  afterId: string,
  count = 200,
): Promise<RedisStreamEntry[]> => {
  const start = afterId === "0" ? "-" : `(${afterId}`;
  const res = (await cmd(env, [
    "XRANGE",
    streamKey(channel),
    start,
    "+",
    "COUNT",
    count,
  ])) as [string, string[]][] | null;
  if (!res) return [];
  const out: RedisStreamEntry[] = [];
  for (const [id, fields] of res) {
    // fields is a flat [k, v, k, v, ...]; we only store the `d` field.
    let raw: string | undefined;
    for (let i = 0; i < fields.length - 1; i += 2) {
      if (fields[i] === "d") raw = fields[i + 1];
    }
    if (raw === undefined) continue;
    try {
      out.push({ id, payload: JSON.parse(raw) });
    } catch {
      // skip a corrupt entry rather than break the whole replay
    }
  }
  return out;
};
