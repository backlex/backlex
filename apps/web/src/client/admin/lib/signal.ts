/**
 * Data-plane signal transport for the admin — the realtime path on stateless
 * serverless deployments (Vercel / Netlify Functions), where there's no Durable
 * Object and no long-lived process to hold an `items:*` SSE stream open.
 *
 * The server publishes ID-ONLY signals (`{event, collection, id, at}`) to Ably
 * and the browser connects to Ably directly, so delivery costs the deployment
 * zero function invocations. The admin doesn't even need the id: React Query
 * owns the cache, so a signal is just a "something changed here" nudge that
 * debounce-invalidates the collection's queries and lets RQ refetch the exact,
 * permission-filtered window it was already showing. No row data crosses this
 * pipe — which is precisely why it can ride a hosted pub/sub at all.
 *
 * See `apps/web/src/server/services/realtime-signal.ts` for the server half and
 * the metadata trade-off that bounds who may subscribe.
 */

/** What `GET /api/realtime/items-config` reports. */
export type ItemsTransportKind = "sse" | "ably-signal" | "off";

const apiBase = (): string => import.meta.env.VITE_API_URL ?? "";

interface ItemsProbe {
  transport: ItemsTransportKind;
  /** Prefix this workspace's Ably rooms are named with (`t.<id>:`). Empty
   *  against a server that sends none — that deployment names rooms without a
   *  workspace, and the bare channel is what it publishes to. */
  ablyPrefix: string;
}

/** One capability probe per SPA session — the answer is deployment-static.
 *
 *  NOT static per WORKSPACE, though: `ablyPrefix` is. Switching workspace
 *  reloads the SPA (`tenants-switch`), so one probe per session still answers
 *  for one workspace — if that ever stops being true this cache has to be
 *  keyed on the active workspace, or a signal pipe attaches to the room of
 *  whichever workspace happened to load first. */
let transportPromise: Promise<ItemsProbe> | null = null;
export const itemsTransport = (): Promise<ItemsProbe> => {
  transportPromise ??= fetch(`${apiBase()}/api/realtime/items-config`, {
    credentials: "include",
  })
    .then((r) =>
      r.ok
        ? (r.json() as Promise<{ transport?: ItemsTransportKind; ablyPrefix?: string }>)
        : { transport: "sse" as const },
    )
    .then((j: { transport?: ItemsTransportKind; ablyPrefix?: string }) => ({
      transport: j.transport ?? ("sse" as const),
      ablyPrefix: j.ablyPrefix ?? "",
    }))
    // A failed probe must not take realtime down where SSE works — assume the
    // historical transport and let the EventSource decide.
    .catch(() => ({ transport: "sse" as const, ablyPrefix: "" }));
  return transportPromise;
};

/**
 * Open an Ably subscription on `signal:items:<slug>`, calling `onSignal` for
 * every row change the caller is allowed to hear about. Resolves to `null` when
 * the pipe can't be opened — a missing/failed token (which is what a role with
 * row-level read conditions gets, by design), or `ably` failing to load. The
 * caller then simply stays non-live, exactly as it does today.
 */
export const openSignalPipe = async (
  slug: string,
  onSignal: () => void,
): Promise<(() => void) | null> => {
  const channel = `signal:items:${slug}`;
  try {
    // The token is requested for the LOGICAL channel (the server namespaces it
    // and mints the capability for the room), but the attach has to name the
    // room itself — Ably matches the capability against the channel the client
    // opens, so the two must be the same string.
    const { ablyPrefix } = await itemsTransport();
    const Ably = await import("ably");
    const client = new Ably.Realtime({
      authCallback: (_params, cb) => {
        fetch(`${apiBase()}/api/realtime/ably-token`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channels: [channel] }),
        })
          .then(async (r) => {
            if (!r.ok) throw new Error(`ably-token ${r.status}`);
            const j = (await r.json()) as { tokenRequest: object };
            cb(null, j.tokenRequest as never);
          })
          .catch((e: unknown) => cb(e instanceof Error ? e.message : String(e), null));
      },
      closeOnUnload: true,
    });
    const ch = client.channels.get(`${ablyPrefix}${channel}`);
    await ch.subscribe("signal", () => onSignal());
    return () => client.close();
  } catch {
    return null; // no token (conditioned role) or ably unavailable — stay static
  }
};
