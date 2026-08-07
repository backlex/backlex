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

/** One capability probe per SPA session — the answer is deployment-static. */
let transportPromise: Promise<ItemsTransportKind> | null = null;
export const itemsTransport = (): Promise<ItemsTransportKind> => {
  transportPromise ??= fetch(`${apiBase()}/api/realtime/items-config`, {
    credentials: "include",
  })
    .then((r) => (r.ok ? r.json() : { transport: "sse" }))
    .then((j: { transport?: ItemsTransportKind }) => j.transport ?? "sse")
    // A failed probe must not take realtime down where SSE works — assume the
    // historical transport and let the EventSource decide.
    .catch(() => "sse" as const);
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
    const ch = client.channels.get(channel);
    await ch.subscribe("signal", () => onSignal());
    return () => client.close();
  } catch {
    return null; // no token (conditioned role) or ably unavailable — stay static
  }
};
