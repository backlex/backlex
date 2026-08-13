// Source syncs — the inbound half of integrations, shown under the provider
// grid so the two directions sit together: a sink is sent events, a source
// brings rows in.
//
// The editor's job is to stop three mistakes that are cheap to make and
// expensive to notice. The mapping target is a dropdown of the collection's own
// fields, because a typo there would be refused by the server but only after the
// admin had filled the whole form. The interval is a dropdown too, since the
// useful values are a short list and "0" needs explaining. And "run now" is
// offered right after creating, because a schedule that silently never fires
// looks identical to one that has not come round yet.
import type { PushToast } from "../../types";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, relativeTime } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { api } from "@/lib/api";
// The descriptor subpath, not the package root: it imports nothing, so the
// column rules are shared with the server without every provider adapter
// landing in the admin bundle.
import { columnsForSettings, type DestinationColumn } from "@backlex/integrations/provider";
import { useCollections } from "../../queries";
import { fetchSafely } from "../_shared";
import { ListingDialog, type ListingInfo } from "./integration-listing-dialog";

/**
 * The group a listing sync's variant rows travel under.
 *
 * The same `childMappings` a pull uses, read in the other direction — which is
 * what keeps "this workspace models variants" a configuration rather than a
 * branch in every provider. Must match the server's `LISTING_VARIANT_GROUP`.
 */
const LISTING_VARIANT_GROUP = "variants";

/** Rows leaving the collection, for the arrow that is drawn in the direction of
 *  travel. Showing a listing as "Trendyol → products" would say the opposite of
 *  what happens: the products are ours and the listing is theirs. */
const outbound = (direction: string): boolean => direction === "push" || direction === "listing";

/** What a collection offers as a mapping target — or as the column an attribute
 *  reads its value from. Computed columns are excluded: they regenerate
 *  themselves and the server refuses them as a target anyway. */
const writableFieldsOf = (
  collections: { slug: string }[],
  slug: string,
): { value: string; label: string }[] => {
  const c = collections.find((x) => x.slug === slug) as
    | { fields?: { name: string; computed?: boolean }[] }
    | undefined;
  return (c?.fields ?? []).filter((f) => !f.computed).map((f) => ({ value: f.name, label: f.name }));
};

export type SettingField = {
  key: string;
  label: string;
  placeholder?: string;
  /** Present when the field is a choice; the UI renders a picker, not a box. */
  options?: { value: string; label: string }[];
};

/** A group of rows a source hands back beneath each record — an order's lines. */
export type ChildGroup = { key: string; label: string };

/**
 * What a provider that CALLS US needs this form to know.
 *
 * Straight from the catalog, so the dialog never special-cases a kind: `auth`
 * decides which sentence explains the secret, `landing` decides whether a match
 * field is asked for at all, and `selfRegistering` decides whether the operator
 * is handed a URL to paste or simply told it is live.
 */
export type WebhookInfo = {
  auth: "hmac" | "header" | "basic";
  header: string | null;
  events: { key: string; label: string }[];
  landing: "upsert" | "patch";
  matchLabel: string | null;
  selfRegistering: boolean;
};

/** A live endpoint, as the enable call describes it. */
type Endpoint = {
  url: string;
  /** Present ONLY on the response that minted it. */
  secret: string | null;
  events: string[];
  registered: boolean;
  registrationError?: string;
};

/** One delivery a provider made, and what became of it. */
type InboundDelivery = {
  id: string;
  event: string;
  status: string;
  rowsWritten: number;
  error: string | null;
  createdAt: number | string | null;
};

/** Where one group's rows land. Mirrors the server's `ChildMappingSpec`. */
export type ChildMapping = {
  collection: string;
  parentField: string;
  mapping: Record<string, string>;
};

export type ApiSync = {
  id: string;
  integrationId: string;
  collection: string;
  settings: Record<string, unknown>;
  mapping: Record<string, string>;
  childMappings?: Record<string, ChildMapping>;
  direction: string;
  intervalMinutes: number;
  enabled: boolean;
  resuming: boolean;
  lastRunAt: number | string | null;
  lastRowCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
  matchField?: string | null;
  /** Listing only. The product column naming the local category. */
  categoryField?: string | null;
  /** Listing only, and read the other way from `mapping`: provider output key →
   *  the column a marketplace's verdict is written to. */
  outputsMapping?: Record<string, string>;
  /** The endpoint, described — never the secret. Null when it receives nothing. */
  webhook?: { path: string; events: string[]; registered: boolean } | null;
};

/** A connected integration the picker can offer, with which way it travels. */
export type SourceOption = {
  id: string;
  kind: string;
  label: string;
  /** `inbound` is a sync with nothing to poll: the provider does the calling;
   *  `listing` puts products on sale and hears the verdict back. */
  direction: "pull" | "push" | "inbound" | "listing";
};

/** Identifies one ROW of the picker. A connection that can travel both ways
 *  appears twice under one id, so the direction has to be part of the key. */
const keyOf = (s: SourceOption): string => `${s.id}:${s.direction}`;

/** One group's editor state, before it becomes a {@link ChildMapping}. */
type ChildDraft = {
  collection: string;
  parentField: string;
  pairs: { id: string; external: string; field: string }[];
};

/** A group nobody has touched yet. Frozen and shared: the editor replaces the
 *  whole draft on every change rather than mutating one. */
const EMPTY_CHILD: ChildDraft = Object.freeze({ collection: "", parentField: "", pairs: [] });

/** Cadences worth offering. The labels live at the call site rather than here,
 *  because Lingui extracts `t` only where it is lexically in scope — passing it
 *  in as a parameter compiles and runs, but the string never reaches a catalog
 *  and silently stays English in every locale. */
const INTERVAL_MINUTES = [15, 30, 60, 180, 720, 1440] as const;

export function IntegrationSyncsCard({
  sources,
  settingFields,
  destinationColumns = {},
  childGroups = {},
  webhooks = {},
  listings = {},
  pushToast,
}: {
  /** Every direction; the dialog reads `direction` off the chosen entry. */
  sources: SourceOption[];
  /** Keyed `<kind>:<direction>` so one provider can declare both. */
  settingFields: Record<string, SettingField[]>;
  /** Destinations with a closed column set, keyed by kind. Absent = free text. */
  destinationColumns?: Record<string, DestinationColumn[]>;
  /** Child groups each source returns, keyed by kind. Absent = flat records. */
  childGroups?: Record<string, ChildGroup[]>;
  /** How each provider that calls us behaves, keyed by kind. Absent = it does not. */
  webhooks?: Record<string, WebhookInfo>;
  /** The fixed half of each listing provider, keyed by kind. Absent = it cannot
   *  put a product on sale, and the direction is never offered for it. */
  listings?: Record<string, ListingInfo>;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [syncs, setSyncs] = useState<ApiSync[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** The sync whose endpoint is open, and the secret if it was just minted. */
  const [endpointFor, setEndpointFor] = useState<ApiSync | null>(null);
  const [freshSecret, setFreshSecret] = useState<Endpoint | null>(null);
  /** The listing sync whose category mapping and batches are open. */
  const [listingFor, setListingFor] = useState<ApiSync | null>(null);
  // Read here as well as in the dialog: the listing panel needs the product
  // collection's own fields, and it opens from a row rather than from the form.
  const collections = useCollections().data?.data ?? [];

  useEffect(() => {
    let live = true;
    void (async () => {
      // The table may predate the migration on an older instance — an empty
      // list is the right rendering, not an error.
      const res = await fetchSafely<{ data: ApiSync[] }>("/api/admin/integrations/syncs");
      if (!live) return;
      setSyncs(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const labelFor = (integrationId: string) =>
    sources.find((s) => s.id === integrationId)?.label ?? t`Disconnected source`;

  const kindOf = (integrationId: string) => sources.find((s) => s.id === integrationId)?.kind ?? "";

  /**
   * The endpoint description for this row's provider, or undefined.
   *
   * Gated on the DIRECTION as well as the provider, because a delivery lands
   * through this sync's own collection and mapping. A marketplace is normally
   * connected as a source AND a listing off one credential, and offering the
   * endpoint on the listing row would upsert incoming order packages into the
   * product catalog. The server refuses it too; this is so the button is never
   * there to press.
   */
  const hookFor = (row: ApiSync): WebhookInfo | undefined =>
    row.direction === "pull" || row.direction === "inbound"
      ? webhooks[kindOf(row.integrationId)]
      : undefined;

  /**
   * Turn the endpoint on — or rotate its secret, which is the same call.
   *
   * Optimistic on the row's badge, and the secret is put on screen from the
   * response rather than re-read: nothing hands it back a second time.
   */
  const enableHook = async (row: ApiSync) => {
    const snapshot = syncs;
    setBusy(row.id);
    try {
      const res = await api<{ data: Endpoint }>(`/api/admin/integrations/syncs/${row.id}/webhook`, {
        method: "POST",
        body: JSON.stringify({ events: row.webhook?.events ?? [] }),
      });
      setSyncs((prev) =>
        prev.map((s) =>
          s.id === row.id
            ? {
                ...s,
                webhook: {
                  path: new URL(res.data.url).pathname,
                  events: res.data.events,
                  registered: res.data.registered,
                },
              }
            : s,
        ),
      );
      setFreshSecret(res.data);
      setEndpointFor({ ...row, webhook: { path: new URL(res.data.url).pathname, events: res.data.events, registered: res.data.registered } });
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const disableHook = async (row: ApiSync) => {
    const snapshot = syncs;
    setSyncs(snapshot.map((s) => (s.id === row.id ? { ...s, webhook: null } : s)));
    setEndpointFor(null);
    setFreshSecret(null);
    try {
      await api(`/api/admin/integrations/syncs/${row.id}/webhook`, { method: "DELETE" });
      pushToast(t`Endpoint removed. The sync and every row it wrote stay.`);
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    }
  };

  const setHookEvents = async (row: ApiSync, events: string[]) => {
    const snapshot = syncs;
    setSyncs(
      snapshot.map((s) => (s.id === row.id && s.webhook ? { ...s, webhook: { ...s.webhook, events } } : s)),
    );
    try {
      const res = await api<{ data: ApiSync }>(`/api/admin/integrations/syncs/${row.id}/webhook`, {
        method: "PATCH",
        body: JSON.stringify({ events }),
      });
      setSyncs((prev) => prev.map((s) => (s.id === row.id ? res.data : s)));
      setEndpointFor((prev) => (prev && prev.id === row.id ? res.data : prev));
      // Re-registering is how a server-side filter is changed, and that mints a
      // new secret. Saying so beats an operator discovering it when the provider
      // starts being refused.
      if (row.webhook?.registered) {
        pushToast(t`Events updated. The provider was re-registered with a new secret.`);
      }
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    }
  };

  const create = async (input: Record<string, unknown>) => {
    const snapshot = syncs;
    setEditing(false);
    try {
      const res = await api<{ data: ApiSync }>("/api/admin/integrations/syncs", {
        method: "POST",
        body: JSON.stringify(input),
      });
      setSyncs([...snapshot, res.data]);
      pushToast(t`Sync created. Run it now to check the mapping.`);
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    }
  };

  const toggle = async (row: ApiSync) => {
    const snapshot = syncs;
    const next = !row.enabled;
    setSyncs(
      snapshot.map((s) =>
        s.id === row.id
          ? { ...s, enabled: next, ...(next ? { consecutiveFailures: 0, disabledReason: null } : {}) }
          : s,
      ),
    );
    try {
      const res = await api<{ data: ApiSync }>(`/api/admin/integrations/syncs/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: next }),
      });
      setSyncs((prev) => prev.map((s) => (s.id === row.id ? res.data : s)));
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (row: ApiSync) => {
    const snapshot = syncs;
    setSyncs(snapshot.filter((s) => s.id !== row.id));
    try {
      await api(`/api/admin/integrations/syncs/${row.id}`, { method: "DELETE" });
      pushToast(t`Sync deleted. Rows already pulled stay in the collection.`);
    } catch (e) {
      setSyncs(snapshot);
      pushToast((e as Error).message);
    }
  };

  const runNow = async (row: ApiSync) => {
    setBusy(row.id);
    try {
      // Two shapes, because a listing run reports what it PUBLISHED rather than
      // what it wrote — and the difference matters to the operator: rows landing
      // is the whole result of a pull, while a published unit has not been ruled
      // on yet.
      const res = await api<{
        data:
          | { written: number; complete: boolean }
          | {
              sent: number;
              pending: number;
              accepted: number;
              rejected: number;
              unmapped: number;
              batchId: string | null;
            };
      }>(`/api/admin/integrations/syncs/${row.id}/run`, { method: "POST" });
      const d = res.data;
      pushToast(
        // Every count is written out per case rather than pluralised: this
        // codebase has no `<Plural>` anywhere, and "1 products" is the same slip
        // "Every 1 hours" was.
        "sent" in d
          ? d.sent === 0
            ? // The single most likely reason a run looks like it did nothing,
              // so it is named rather than reported as a clean empty run.
              d.unmapped === 1
              ? t`Published nothing — 1 product is in a category nobody has mapped.`
              : d.unmapped > 1
                ? t`Published nothing — ${d.unmapped} products are in categories nobody has mapped.`
                : t`Published nothing — no product had everything the marketplace needs.`
            : d.pending === 0
              ? // A marketplace that answers the publish itself — there is no
                // batch to watch, so saying so would send an operator looking
                // for a row that will never appear.
                d.rejected === 0
                ? d.sent === 1
                  ? t`Listed 1 unit.`
                  : t`Listed ${d.sent} units.`
                : d.rejected === 1
                  ? t`Listed ${d.accepted} of ${d.sent} units — 1 was refused. The reason is on the row.`
                  : t`Listed ${d.accepted} of ${d.sent} units — ${d.rejected} were refused. The reasons are on the rows.`
              : d.pending === 1
                ? t`Sent 1 unit. The marketplace rules on it in its own time; watch the batch.`
                : t`Sent ${d.pending} units. The marketplace rules on them in its own time; watch the batch.`
          : d.complete
            ? t`Pulled ${d.written} rows into ${row.collection}.`
            : t`Pulled ${d.written} rows; more pages resume on the schedule.`,
      );
      const list = await fetchSafely<{ data: ApiSync[] }>("/api/admin/integrations/syncs");
      if (list) setSyncs(list.data);
    } catch (e) {
      pushToast((e as Error).message);
      const list = await fetchSafely<{ data: ApiSync[] }>("/api/admin/integrations/syncs");
      if (list) setSyncs(list.data);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>Data syncs</Trans>
          </h2>
          <p className="text-[12.5px] text-muted-foreground">
            <Trans>
              Move rows between a connected provider and a collection — pulled on a schedule, pushed out on a
              watermark, or delivered by the provider itself. Rows update in place and never overwrite rows
              created here.
            </Trans>
          </p>
        </div>
        <Button
          className="ml-auto shrink-0"
          disabled={sources.length === 0}
          onClick={() => setEditing(true)}
        >
          <Trans>Add sync</Trans>
        </Button>
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : sources.length === 0 ? (
        <EmptyState
          icon={I.Download}
          title={t`No source connected`}
          description={t`Connect Google Sheets, Airtable or Notion above, authorize it, then schedule a pull.`}
          size="md"
        />
      ) : syncs.length === 0 ? (
        <EmptyState
          icon={I.Download}
          title={t`No syncs`}
          description={t`Point a connected source at a collection and pick how often it should run.`}
          size="md"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {syncs.map((row) => (
            <Card
              key={row.id}
              className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {/* Drawn in the direction of travel, so a glance says which
                      way the rows are moving. Showing a push as
                      "ClickHouse → leads" would say the opposite of what
                      happens. */}
                  <span className="text-[13px] font-medium">
                    {outbound(row.direction) ? row.collection : labelFor(row.integrationId)}
                  </span>
                  <I.ArrowRight size={13} className="text-muted-foreground" />
                  <code className="text-[12px] text-muted-foreground">
                    {outbound(row.direction) ? labelFor(row.integrationId) : row.collection}
                  </code>
                  {!row.enabled && (
                    <Badge variant="destructive" className="text-[10px]">
                      <Trans>Paused</Trans>
                    </Badge>
                  )}
                  {row.enabled && row.resuming && (
                    <Badge variant="secondary" className="text-[10px]">
                      <Trans>More pages pending</Trans>
                    </Badge>
                  )}
                  {Object.keys(row.childMappings ?? {}).length > 0 && (
                    // Worth saying on the row: a sync that also writes lines
                    // touches a second collection, and nothing else here would
                    // hint at that until somebody opened the other one.
                    <Badge variant="secondary" className="text-[10px]">
                      {/* A listing's second collection holds the sellable units,
                          not an order's lines — the same mechanism, a different
                          thing, and calling both "lines" would mislead. */}
                      {row.direction === "listing" ? <Trans>+ variants</Trans> : <Trans>+ lines</Trans>}
                    </Badge>
                  )}
                  {row.enabled && row.intervalMinutes === 0 && row.direction !== "inbound" && (
                    <Badge variant="secondary" className="text-[10px]">
                      <Trans>Manual only</Trans>
                    </Badge>
                  )}
                  {row.webhook && (
                    // The one badge worth having: a live endpoint is the
                    // difference between a row that updates within seconds and
                    // one that waits for the next interval, and nothing else on
                    // the row would say which.
                    <Badge variant="secondary" className="text-[10px]">
                      <I.Zap size={9} className="mr-0.5" />
                      <Trans>Live</Trans>
                    </Badge>
                  )}
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {row.direction === "inbound" ? (
                    <Trans>arrives when the provider sends it</Trans>
                  ) : row.intervalMinutes > 0 ? (
                    <Trans>every {row.intervalMinutes} min</Trans>
                  ) : (
                    <Trans>runs only when you ask</Trans>
                  )}
                  {row.lastRunAt ? (
                    <>
                      {" · "}
                      <Trans>
                        {row.lastRowCount} rows {relativeTime(row.lastRunAt)}
                      </Trans>
                    </>
                  ) : row.direction === "inbound" ? null : (
                    <>
                      {" · "}
                      <Trans>never run</Trans>
                    </>
                  )}
                </div>
                {row.disabledReason ?? row.lastError ? (
                  <p className="mt-1 text-[11.5px] leading-snug text-destructive">
                    {row.disabledReason ?? row.lastError}
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                {/* An inbound row has nothing to run: the server refuses it, and
                    offering the button would be a promise it cannot keep. */}
                {row.direction !== "inbound" && (
                  <Button variant="ghost" disabled={busy === row.id} onClick={() => void runNow(row)}>
                    {busy === row.id ? (
                      row.direction === "listing" ? (
                        <Trans>Publishing…</Trans>
                      ) : (
                        <Trans>Pulling…</Trans>
                      )
                    ) : row.direction === "listing" ? (
                      <Trans>Publish now</Trans>
                    ) : (
                      <Trans>Run now</Trans>
                    )}
                  </Button>
                )}
                {/* A listing sync is the only one whose setup CANNOT be finished
                    in the create dialog — the categories are the marketplace's
                    and have to be asked for with the seller's credentials. */}
                {row.direction === "listing" && listings[kindOf(row.integrationId)] && (
                  <Button variant="ghost" onClick={() => setListingFor(row)}>
                    <Trans>Categories</Trans>
                  </Button>
                )}
                {hookFor(row) &&
                  (row.webhook ? (
                    <Button variant="ghost" onClick={() => setEndpointFor(row)}>
                      <Trans>Endpoint</Trans>
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      disabled={busy === row.id}
                      onClick={() => void enableHook(row)}
                    >
                      {busy === row.id ? <Trans>Turning on…</Trans> : <Trans>Turn on endpoint</Trans>}
                    </Button>
                  ))}
                <Button variant="ghost" onClick={() => void toggle(row)}>
                  {row.enabled ? <Trans>Pause</Trans> : <Trans>Resume</Trans>}
                </Button>
                <Button variant="ghost" onClick={() => void remove(row)}>
                  <Trans>Delete</Trans>
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {editing && (
        <SyncDialog
          sources={sources}
          settingFields={settingFields}
          destinationColumns={destinationColumns}
          childGroups={childGroups}
          webhooks={webhooks}
          listings={listings}
          onClose={() => setEditing(false)}
          onCreate={(input) => void create(input)}
        />
      )}

      {listingFor && listings[kindOf(listingFor.integrationId)] && (
        <ListingDialog
          syncId={listingFor.id}
          integrationId={listingFor.integrationId}
          providerName={labelFor(listingFor.integrationId)}
          info={listings[kindOf(listingFor.integrationId)]!}
          // BOTH collections, because the engine resolves an attribute against
          // the VARIANT row first and falls back to the product. Offering only
          // the product's fields would make the most important case
          // unconfigurable: a varianter attribute — a size, a colour — is by
          // definition the column that differs per unit, so it lives on the
          // variant. De-duplicated because the two often share a name.
          productFields={[
            ...writableFieldsOf(collections, listingFor.collection),
            ...(listingFor.childMappings?.[LISTING_VARIANT_GROUP]?.collection
              ? writableFieldsOf(
                  collections,
                  listingFor.childMappings[LISTING_VARIANT_GROUP]!.collection,
                )
              : []),
          ].filter((f, i, all) => all.findIndex((x) => x.value === f.value) === i)}
          onClose={() => setListingFor(null)}
          pushToast={pushToast}
        />
      )}

      {endpointFor && hookFor(endpointFor) && (
        <EndpointDialog
          sync={endpointFor}
          info={hookFor(endpointFor)!}
          providerName={labelFor(endpointFor.integrationId)}
          fresh={freshSecret}
          onClose={() => {
            setEndpointFor(null);
            setFreshSecret(null);
          }}
          onRotate={() => void enableHook(endpointFor)}
          onDisable={() => void disableHook(endpointFor)}
          onEvents={(events) => void setHookEvents(endpointFor, events)}
        />
      )}
    </section>
  );
}

/* ── The endpoint a provider delivers to ────────────────────────────────── */
/**
 * What an operator needs in front of them once an endpoint is live.
 *
 * Three things, in the order they matter. The SECRET, if it was just minted —
 * on screen once, never again, and said so plainly rather than left for the
 * operator to discover. Which EVENTS reach it, as checkboxes over the provider's
 * own declared list. And what has actually ARRIVED, because "the marketplace says
 * it sent it" is the question this panel exists to answer, and the verdict column
 * is the answer: `applied` and `unmatched` look identical from the provider's
 * side and mean completely different things here.
 */
function EndpointDialog({
  sync,
  info,
  providerName,
  fresh,
  onClose,
  onRotate,
  onDisable,
  onEvents,
}: {
  sync: ApiSync;
  info: WebhookInfo;
  providerName: string;
  /** The just-minted endpoint, when this was opened by turning it on. */
  fresh: Endpoint | null;
  onClose: () => void;
  onRotate: () => void;
  onDisable: () => void;
  onEvents: (events: string[]) => void;
}) {
  const { t } = useLingui();
  const [deliveries, setDeliveries] = useState<InboundDelivery[] | null>(null);
  const [copied, setCopied] = useState<"url" | "secret" | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: InboundDelivery[] }>(
        `/api/admin/integrations/syncs/${sync.id}/deliveries`,
      );
      if (live) setDeliveries(res?.data ?? []);
    })();
    return () => {
      live = false;
    };
  }, [sync.id]);

  const url = fresh?.url ?? `${window.location.origin}${sync.webhook?.path ?? ""}`;
  const selected = sync.webhook?.events ?? [];

  const copy = async (what: "url" | "secret", value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(what);
    window.setTimeout(() => setCopied(null), 1500);
  };

  /** How this provider uses the secret. Three providers, three sentences. */
  const secretUse =
    info.auth === "hmac"
      ? t`${providerName} signs every delivery with it — nothing is accepted without a matching signature.`
      : info.auth === "basic"
        ? t`${providerName} sends it as the password on every delivery.`
        : t`${providerName} sends it back in the ${info.header ?? "x-api-key"} header on every delivery.`;

  const toggleEvent = (key: string) => {
    const next = selected.includes(key) ? selected.filter((e) => e !== key) : [...selected, key];
    onEvents(next);
  };

  /** `applied` is the good one; the rest are shades of "nothing happened". */
  const tone = (status: string): "secondary" | "destructive" | "default" =>
    status === "applied" ? "default" : status === "rejected" || status === "failed" ? "destructive" : "secondary";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* `[&>*]:min-w-0` earns its keep here and nowhere else in this file: a URL
          and a 64-character secret have no break opportunity, so their
          min-content sets the dialog's implicit grid track and every sibling —
          the header included — is stretched to it and hangs off a phone screen.
          The tokens themselves wrap with `break-all` below; this stops the track
          being sized by them in the first place. */}
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[560px] [&>*]:min-w-0">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>Inbound endpoint</Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            {sync.webhook?.registered ? (
              <Trans>
                {providerName} has been told to post here. Rows land the moment it sends them; the schedule
                above stays as the backstop for anything a delivery misses.
              </Trans>
            ) : (
              <Trans>
                Give this URL and secret to {providerName}. Rows land the moment it posts; the schedule above
                stays as the backstop for anything a delivery misses.
              </Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-4 px-5 py-4">
            <div>
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Delivery URL</Trans>
              </span>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 text-[11.5px]">
                  {url}
                </code>
                <Button variant="ghost" className="shrink-0" onClick={() => void copy("url", url)}>
                  {copied === "url" ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                </Button>
              </div>
            </div>

            {fresh?.secret ? (
              <div className="rounded-md border border-border p-3">
                <span className="mb-1 block text-[11.5px] font-medium">
                  <Trans>Secret — shown once</Trans>
                </span>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 break-all rounded-md bg-muted px-2 py-1.5 text-[11.5px]">
                    {fresh.secret}
                  </code>
                  <Button
                    variant="ghost"
                    className="shrink-0"
                    onClick={() => void copy("secret", fresh.secret!)}
                  >
                    {copied === "secret" ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
                  </Button>
                </div>
                <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">
                  {secretUse}{" "}
                  <Trans>
                    Save it now — closing this panel is the last time you will see it. Lost means rotating,
                    which keeps the same URL.
                  </Trans>
                </p>
              </div>
            ) : (
              <p className="text-[11.5px] leading-snug text-muted-foreground">
                <Trans>The secret was shown when this endpoint was turned on and is not stored in a readable
                form. Rotate to get a new one; the URL stays the same.</Trans>
              </p>
            )}

            {fresh?.registrationError && (
              <p className="text-[11.5px] leading-snug text-destructive">
                <Trans>
                  The endpoint is live, but {providerName} was not told about it: {fresh.registrationError}
                </Trans>
              </p>
            )}

            <div>
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Events</Trans>{" "}
                <span className="font-normal text-muted-foreground">
                  · {selected.length === 0 ? <Trans>all of them</Trans> : <Trans>the ones ticked</Trans>}
                </span>
              </span>
              <div className="flex flex-col gap-1">
                {info.events.map((e) => (
                  <label key={e.key} className="flex items-center gap-2 text-[12px]">
                    <input
                      type="checkbox"
                      className="size-3.5 shrink-0 accent-primary"
                      checked={selected.length === 0 || selected.includes(e.key)}
                      onChange={() => toggleEvent(e.key)}
                    />
                    <span className="min-w-0 truncate">{e.label}</span>
                    <code className="ml-auto shrink-0 text-[10.5px] text-muted-foreground">{e.key}</code>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Recent deliveries</Trans>
              </span>
              {deliveries === null ? (
                <div className="flex flex-col gap-1.5">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-7 w-full" />
                  ))}
                </div>
              ) : deliveries.length === 0 ? (
                <p className="text-[11.5px] text-muted-foreground">
                  <Trans>Nothing has arrived yet.</Trans>
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {deliveries.slice(0, 12).map((d) => (
                    <div key={d.id} className="flex items-center gap-2 text-[11.5px]">
                      <Badge variant={tone(d.status)} className="shrink-0 text-[10px]">
                        {d.status}
                      </Badge>
                      <code className="min-w-0 truncate text-muted-foreground">{d.event}</code>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {/* Written out per case rather than pluralised: this
                            codebase has no `<Plural>` anywhere, and "1 rows"
                            is the same slip "Every 1 hours" was. */}
                        {d.rowsWritten === 1 ? (
                          <Trans>1 row</Trans>
                        ) : d.rowsWritten > 1 ? (
                          <Trans>{d.rowsWritten} rows written</Trans>
                        ) : null}
                        {d.createdAt ? ` · ${relativeTime(d.createdAt)}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onDisable}>
            <Trans>Turn off</Trans>
          </Button>
          <Button variant="ghost" onClick={onRotate}>
            <Trans>Rotate secret</Trans>
          </Button>
          <Button onClick={onClose}>
            <Trans>Done</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── One group of lines beneath each record ─────────────────────────────── */
/**
 * Where an order's lines land, for the sources that return any.
 *
 * Optional by construction: leaving the collection unset imports headers on
 * their own, which is a perfectly ordinary thing to want and must not look like
 * an unfinished form. That is why this is a plain section rather than a
 * required field — and why the link field only appears once a collection is
 * chosen, since its options are that collection's own.
 */
function ChildGroupEditor({
  group,
  draft,
  collections,
  fieldsOf,
  externalOptions,
  hint,
  onChange,
}: {
  group: ChildGroup;
  draft: ChildDraft;
  collections: string[];
  fieldsOf: (slug: string) => { value: string; label: string }[];
  /** A closed set for the far side, when the provider declares one. Absent
   *  leaves it free text, which is right for a source's arbitrary line columns. */
  externalOptions?: { value: string; label: string }[];
  /** Why leaving it empty is a real choice. Different sentence per direction:
   *  a pull imports headers without lines, a listing sells a product that has
   *  no variants — and "import headers only" is nonsense for the second. */
  hint?: ReactNode;
  onChange: (next: ChildDraft) => void;
}) {
  const { t } = useLingui();
  const childFields = draft.collection ? fieldsOf(draft.collection) : [];
  const pairs = draft.pairs.length > 0 ? draft.pairs : [{ id: "seed", external: "", field: "" }];

  /** The far side of one pair — a picker when the provider declared its
   *  columns, a box when the columns are the operator's own. */
  const externalCell = (p: { id: string; external: string }) =>
    externalOptions ? (
      <div className="min-w-0 flex-1">
        <Select
          value={p.external || undefined}
          onChange={(v: string) =>
            onChange({
              ...draft,
              pairs: pairs.map((x) => (x.id === p.id ? { ...x, external: v } : x)),
            })
          }
          placeholder={t`Marketplace field`}
          options={externalOptions}
          className="min-w-0"
        />
      </div>
    ) : (
      <Input
        className="min-w-0 flex-1"
        placeholder={t`Line column`}
        value={p.external}
        onChange={(e) =>
          onChange({
            ...draft,
            pairs: pairs.map((x) => (x.id === p.id ? { ...x, external: e.target.value } : x)),
          })
        }
      />
    );

  /** The collection's own field. */
  const fieldCell = (p: { id: string; field: string }) => (
    <div className="min-w-0 flex-1">
      <Select
        value={p.field || undefined}
        onChange={(v: string) =>
          onChange({
            ...draft,
            pairs: pairs.map((x) => (x.id === p.id ? { ...x, field: v } : x)),
          })
        }
        placeholder={t`Field`}
        options={childFields}
        className="min-w-0"
      />
    </div>
  );

  return (
    <div className="rounded-md border border-border p-3">
      <span className="mb-1 block text-[11.5px] font-medium">
        {group.label}{" "}
        <span className="font-normal text-muted-foreground">
          · {hint ?? <Trans>optional — leave empty to import headers only</Trans>}
        </span>
      </span>

      <div className="flex flex-col gap-2">
        <Select
          value={draft.collection || undefined}
          onChange={(v: string) =>
            // The link field and every mapping target belong to the collection
            // that was just replaced, so they go with it rather than staying
            // behind naming columns the new one may not have.
            onChange({ collection: v, parentField: "", pairs: [] })
          }
          placeholder={t`Into collection`}
          options={collections.map((slug) => ({ value: slug, label: slug }))}
          className="min-w-0"
        />

        {draft.collection && (
          <>
            <Select
              value={draft.parentField || undefined}
              onChange={(v: string) => onChange({ ...draft, parentField: v })}
              placeholder={t`Field linking back to the header`}
              options={childFields}
              className="min-w-0"
            />

            {pairs.map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                {/* Laid out exactly as the header mapping above, so one grammar
                    serves both: the far side on the left, this collection's own
                    field on the right. */}
                {externalCell(p)}
                <I.ArrowRight size={13} className="shrink-0 text-muted-foreground" />
                {fieldCell(p)}
                <Button
                  variant="ghost"
                  className="shrink-0 px-2"
                  aria-label={t`Remove line column`}
                  disabled={pairs.length === 1}
                  onClick={() => onChange({ ...draft, pairs: pairs.filter((x) => x.id !== p.id) })}
                >
                  <I.X size={13} />
                </Button>
              </div>
            ))}

            <Button
              variant="ghost"
              className="self-start"
              onClick={() =>
                onChange({
                  ...draft,
                  pairs: [...pairs, { id: crypto.randomUUID(), external: "", field: "" }],
                })
              }
            >
              <Trans>Add line column</Trans>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Point a source at a collection ─────────────────────────────────────── */
function SyncDialog({
  sources,
  settingFields,
  destinationColumns,
  childGroups,
  webhooks,
  listings,
  onClose,
  onCreate,
}: {
  sources: SourceOption[];
  settingFields: Record<string, SettingField[]>;
  destinationColumns: Record<string, DestinationColumn[]>;
  childGroups: Record<string, ChildGroup[]>;
  webhooks: Record<string, WebhookInfo>;
  listings: Record<string, ListingInfo>;
  onClose: () => void;
  onCreate: (input: Record<string, unknown>) => void;
}) {
  const { t } = useLingui();
  const collectionsQuery = useCollections();
  const collections = collectionsQuery.data?.data ?? [];

  // Keyed by connection AND direction, never by id alone. A provider that can
  // do both — Google Calendar mirrors a calendar in and writes bookings out —
  // appears twice with the SAME connection id, so an id-keyed picker collapses
  // the two into one option and the second direction becomes unreachable.
  const [selectionKey, setSelectionKey] = useState(sources[0] ? keyOf(sources[0]) : "");
  const [collection, setCollection] = useState("");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [interval, setInterval] = useState(60);
  /** The column a patching delivery is matched on. Only asked for when the
   *  provider's deliveries are ABOUT rows rather than being them. */
  const [matchField, setMatchField] = useState("");
  /** Listing only. The product column whose value the category mapping is keyed
   *  by — a typo here makes every product unmapped and the run publish nothing. */
  const [categoryField, setCategoryField] = useState("");
  /** Listing only. Provider output key → the column its verdict is written to.
   *  Without one a batch is published and every answer discarded. */
  const [outputs, setOutputs] = useState<Record<string, string>>({});
  // Stable ids rather than the array index: rows can be removed, and an index
  // key would make React reuse the wrong input's state when one disappears.
  const [pairs, setPairs] = useState<{ id: string; external: string; field: string }[]>([
    { id: crypto.randomUUID(), external: "", field: "" },
  ]);
  /**
   * One draft per child group the source declares, keyed by group.
   *
   * Kept for every group rather than only the ones in use, so a half-filled
   * group is still on screen when the operator comes back to it. A group with
   * no collection chosen is simply not submitted — importing headers without
   * their lines is a perfectly ordinary thing to want.
   */
  const [children, setChildren] = useState<Record<string, ChildDraft>>({});

  /** Connections offered in both directions, so the picker can say which. */
  const bothWays = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const s of sources) {
      if (seen.has(s.id)) dupes.add(s.id);
      seen.add(s.id);
    }
    return dupes;
  }, [sources]);

  const chosen = sources.find((s) => keyOf(s) === selectionKey);
  const integrationId = chosen?.id ?? "";
  const direction = chosen?.direction ?? "pull";
  // An inbound sync has nothing to configure: the provider decides what it
  // sends, and the server refuses settings on one.
  const fields = direction === "inbound" ? [] : settingFields[`${chosen?.kind ?? ""}:${direction}`] ?? [];
  const hook = webhooks[chosen?.kind ?? ""];
  /** A patching provider's deliveries name a row; this is the column that holds
   *  the name. Only meaningful — and only accepted — on an inbound sync. */
  const needsMatch = direction === "inbound" && hook?.landing === "patch";
  // A destination that writes into a structured object (a calendar event) has a
  // fixed set of targets; a warehouse's are whatever its DDL declared and stay
  // free text. The server refuses an unknown one either way — this is so the
  // operator doesn't have to guess the spelling.
  //
  // Narrowed by the settings, because some providers' targets depend on them:
  // QuickBooks writes customers OR invoices, and offering `dueDate` on a
  // customer sync is a trap that only shows up as a column nobody wrote.
  //
  // A listing's product columns come from the same declaration and are read the
  // same way — that is the whole reason `columnsForSettings` narrows both, and
  // why a listing needed no second mapping editor.
  const listing = direction === "listing" ? listings[chosen?.kind ?? ""] : undefined;
  /** Whether the variants live in a collection of their own. */
  const hasVariantCollection = Boolean(children[LISTING_VARIANT_GROUP]?.collection);
  const allColumns =
    direction === "push"
      ? destinationColumns[chosen?.kind ?? ""]
      : listing
        ? // With no variant collection the product row IS the unit, so it maps
          // through both lists — offering only the product columns would leave
          // the barcode and the price unmappable and every product refused for
          // having no reference.
          hasVariantCollection
          ? listing.columns
          : [...listing.columns, ...(listing.variantColumns ?? [])]
        : undefined;
  const externalOptions = useMemo(
    () => (allColumns ? columnsForSettings(allColumns, settings) : undefined),
    [allColumns, settings],
  );
  /** Per-unit columns, for the collection that holds the variants. */
  const variantOptions = useMemo(
    () => (listing?.variantColumns ? columnsForSettings(listing.variantColumns, settings) : undefined),
    [listing, settings],
  );

  /** Change one setting, and drop any mapping target it just invalidated —
   *  switching a QuickBooks sync from customers to invoices otherwise leaves
   *  `email` selected in a picker that no longer offers it. */
  const setSetting = (key: string, value: string) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    if (!allColumns) return;
    const still = new Set(columnsForSettings(allColumns, next).map((c) => c.value));
    setPairs((prev) =>
      prev.map((p) =>
        still.has(p.external)
          ? p
          : // A NEW id, not just a cleared value: Radix's Select keeps showing
            // the last item it rendered when its value goes back to undefined,
            // so a cleared row would sit there displaying a column that is no
            // longer on offer. Changing the key remounts it onto the placeholder.
            { ...p, id: crypto.randomUUID(), external: "" },
      ),
    );
  };

  // Only writable fields can be a mapping target; a computed column regenerates
  // itself and the server would refuse it anyway.
  const fieldsOf = (slug: string) => writableFieldsOf(collections, slug);
  const targetOptions = fieldsOf(collection);

  // Lines are an inbound idea in either sense: a push walks one collection's
  // watermark and has no second collection to write into, so the server refuses
  // them outright. A `patch` landing has none either — it writes onto a row that
  // already exists rather than building one.
  const groups =
    direction === "pull" || (direction === "inbound" && hook?.landing === "upsert")
      ? (childGroups[chosen?.kind ?? ""] ?? [])
      : direction === "listing" && listing?.variantColumns
        ? // Not the provider's source groups: a listing's one group is where the
          // sellable units live, and it exists for every listing provider that
          // declares per-unit columns rather than being declared per provider.
          [{ key: LISTING_VARIANT_GROUP, label: t`Variants` }]
        : [];

  // Written out rather than derived: `Every ${m / 60} hours` renders
  // "Every 1 hours" for the default cadence.
  const intervalLabel = (m: number) =>
    m === 15
      ? t`Every 15 minutes`
      : m === 30
        ? t`Every 30 minutes`
        : m === 60
          ? t`Hourly`
          : m === 180
            ? t`Every 3 hours`
            : m === 720
              ? t`Every 12 hours`
              : t`Daily`;

  /**
   * A group is either untouched or finished — never half.
   *
   * Submitting only the complete ones would be the worst answer available: the
   * operator chose a collection for the lines, the sync is created without
   * them, and the first run reports a clean import of orders with nothing in
   * them. Blocking here is what makes that impossible to do by accident.
   */
  const childrenReady = groups.every((g) => {
    const draft = children[g.key];
    if (!draft?.collection) return true;
    return Boolean(draft.parentField) && draft.pairs.some((p) => p.external.trim() && p.field);
  });

  const ready =
    Boolean(integrationId) &&
    Boolean(collection) &&
    fields.every((f) => f.label.toLowerCase().includes("optional") || (settings[f.key] ?? "").trim()) &&
    pairs.some((p) => p.external.trim() && p.field) &&
    // The server refuses this one too, but only after the whole form was filled:
    // without it a delivery would be understood and applied to nothing.
    (!needsMatch || Boolean(matchField)) &&
    // Both are refused by the server for the same reason they are required here:
    // without a category column every product is unmapped, and without a
    // writeback column every verdict the marketplace sends is discarded.
    (direction !== "listing" || (Boolean(categoryField) && Object.values(outputs).some(Boolean))) &&
    childrenReady;

  const submit = () => {
    const mapping: Record<string, string> = {};
    // Written in the direction of travel: the collection field is the value on
    // a pull and the key on a push.
    for (const p of pairs) {
      if (!p.external.trim() || !p.field) continue;
      // A listing travels the same way a push does — out of the collection —
      // so its mapping is keyed by the collection's field.
      if (direction === "push" || direction === "listing") mapping[p.field] = p.external.trim();
      else mapping[p.external.trim()] = p.field;
    }
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(settings)) if (v.trim()) cleaned[k] = v.trim();

    // Only the groups actually filled in. A group with a collection but no
    // link field would be refused by the server, and one with neither is an
    // operator who decided not to import lines after all.
    const childMappings: Record<string, ChildMapping> = {};
    for (const g of groups) {
      const draft = children[g.key];
      if (!draft?.collection || !draft.parentField) continue;
      const childMapping: Record<string, string> = {};
      for (const p of draft.pairs) {
        if (!p.external.trim() || !p.field) continue;
        // Same rule as the header mapping above, for the same reason: a
        // listing's units travel out, so the variant row's own field is the key.
        if (direction === "listing") childMapping[p.field] = p.external.trim();
        else childMapping[p.external.trim()] = p.field;
      }
      if (Object.keys(childMapping).length === 0) continue;
      childMappings[g.key] = {
        collection: draft.collection,
        parentField: draft.parentField,
        mapping: childMapping,
      };
    }

    onCreate({
      integrationId,
      collection,
      direction,
      settings: cleaned,
      mapping,
      // An inbound sync is never due, and the server refuses an interval on one.
      ...(direction === "inbound" ? {} : { intervalMinutes: interval }),
      ...(Object.keys(childMappings).length > 0 ? { childMappings } : {}),
      ...(needsMatch && matchField ? { matchField } : {}),
      ...(direction === "listing"
        ? {
            categoryField,
            outputsMapping: Object.fromEntries(
              Object.entries(outputs).filter(([, column]) => Boolean(column)),
            ),
          }
        : {}),
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* `[&>*]:min-w-0` is load-bearing, and only became so when a listing
          arrived. DialogContent is a grid, so its column is sized from the
          body's max-content — and the connection picker's longest option
          ("Trendyol · put products on sale") stretched it to 464px inside a
          358px dialog that then clipped 106px off every field AND the header.
          `min-w-0` on the trigger cannot reach the column; this can. Desktop
          never showed it: 464 fits inside `sm:max-w-[560px]`. */}
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[560px] [&>*]:min-w-0">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>New data sync</Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              Rows land in an ordinary collection, so permissions, querying and exports apply to them like any
              other data.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Connection</Trans>
              </span>
              <Select
                value={selectionKey}
                onChange={(v: string) => {
                  setSelectionKey(v);
                  setMatchField("");
                  setCategoryField("");
                  setOutputs({});
                  // Manual is the default for a listing and only for a listing:
                  // publishing costs a listing at the far end, so it happens
                  // when somebody asks rather than on the hour.
                  setInterval(sources.find((s) => keyOf(s) === v)?.direction === "listing" ? 0 : 60);
                  // Settings belong to a provider AND a direction; carrying them
                  // across would send a spreadsheet id to Airtable, or a
                  // calendar id to a pull.
                  setSettings({});
                  setPairs([{ id: crypto.randomUUID(), external: "", field: "" }]);
                  // The groups themselves are a provider's, so a draft for one
                  // provider's "lines" means nothing to the next.
                  setChildren({});
                }}
                options={sources.map((s) => ({
                  value: keyOf(s),
                  // Two rows carrying the same provider name are otherwise
                  // indistinguishable in the list.
                  label:
                    // Named before the both-ways check: a marketplace is
                    // routinely connected as a source AND a listing, and "rows
                    // out" would describe the wrong one of the two.
                    s.direction === "listing"
                      ? `${s.label} · ${t`put products on sale`}`
                      : bothWays.has(s.id)
                        ? `${s.label} · ${s.direction === "push" ? t`rows out` : t`rows in`}`
                        : s.direction === "inbound"
                          ? `${s.label} · ${t`it calls us`}`
                          : s.label,
                }))}
                className="min-w-0"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                {direction === "listing" ? (
                  <Trans>Products in</Trans>
                ) : direction === "push" ? (
                  <Trans>From collection</Trans>
                ) : needsMatch ? (
                  <Trans>Updates rows in</Trans>
                ) : (
                  <Trans>Into collection</Trans>
                )}
              </span>
              <Select
                // `undefined`, not `""`: the shared Select maps "" to a
                // sentinel meaning "an option with an empty value is selected",
                // which suppresses the placeholder and leaves a blank trigger.
                value={collection || undefined}
                onChange={(v: string) => {
                  setCollection(v);
                  // Targets are that collection's fields, so a change invalidates
                  // whatever was picked — the match column included.
                  setPairs([{ id: crypto.randomUUID(), external: "", field: "" }]);
                  setMatchField("");
                  setCategoryField("");
                  setOutputs({});
                }}
                placeholder={t`Pick a collection`}
                options={collections.map((c) => ({ value: c.slug, label: c.slug }))}
                className="min-w-0"
              />
            </label>

            {needsMatch && (
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-medium">
                  <Trans>Matched on</Trans>
                </span>
                <Select
                  value={matchField || undefined}
                  onChange={(v: string) => setMatchField(v)}
                  placeholder={collection ? t`Pick a field` : t`Pick a collection first`}
                  options={targetOptions}
                  className="min-w-0"
                />
                <span className="mt-1 block text-[11.5px] leading-snug text-muted-foreground">
                  {/* The one field an operator gets wrong by picking the
                      plausible neighbour — a shipment id and a tracking number
                      sit next to each other and look alike. */}
                  <Trans>
                    The column holding the {hook?.matchLabel ?? t`provider's id`}. A delivery updates the row
                    that matches, and only the fields it carries.
                  </Trans>
                </span>
              </label>
            )}

            {direction === "listing" && (
              <label className="block">
                <span className="mb-1 block text-[11.5px] font-medium">
                  <Trans>Category column</Trans>
                </span>
                <Select
                  value={categoryField || undefined}
                  onChange={(v: string) => setCategoryField(v)}
                  placeholder={collection ? t`Pick a field` : t`Pick a collection first`}
                  options={targetOptions}
                  className="min-w-0"
                />
                <span className="mt-1 block text-[11.5px] leading-snug text-muted-foreground">
                  <Trans>
                    Your own category, whatever you call it. Each distinct value is mapped to a marketplace
                    category from the sync's row once it exists — a product whose value is unmapped is skipped.
                  </Trans>
                </span>
              </label>
            )}

            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[11.5px] font-medium">{f.label}</span>
                {f.options ? (
                  // A closed set the server enforces anyway — typing it would
                  // fail on submit with a list the operator had to guess at.
                  <Select
                    value={settings[f.key] || undefined}
                    onChange={(v: string) => setSetting(f.key, v)}
                    placeholder={f.placeholder ?? t`Choose one`}
                    options={f.options}
                    className="min-w-0"
                  />
                ) : (
                  <Input
                    placeholder={f.placeholder}
                    value={settings[f.key] ?? ""}
                    onChange={(e) => setSetting(f.key, e.target.value)}
                  />
                )}
              </label>
            ))}

            <div>
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Field mapping</Trans>{" "}
                <span className="font-normal text-muted-foreground">
                  · <Trans>unmapped columns are dropped</Trans>
                </span>
              </span>
              <div className="flex flex-col gap-2">
                {pairs.map((p) => (
                  <div key={p.id} className="flex items-center gap-2">
                    {externalOptions ? (
                      <div className="min-w-0 flex-1">
                        <Select
                          value={p.external || undefined}
                          onChange={(v: string) =>
                            setPairs((prev) =>
                              prev.map((x) => (x.id === p.id ? { ...x, external: v } : x)),
                            )
                          }
                          placeholder={direction === "listing" ? t`Marketplace field` : t`Destination column`}
                          options={externalOptions}
                          className="min-w-0"
                        />
                      </div>
                    ) : (
                      <Input
                        className="min-w-0 flex-1"
                        placeholder={direction === "push" ? t`Destination column` : t`External column`}
                        value={p.external}
                        onChange={(e) =>
                          setPairs((prev) =>
                            prev.map((x) => (x.id === p.id ? { ...x, external: e.target.value } : x)),
                          )
                        }
                      />
                    )}
                    <I.ArrowRight size={13} className="shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <Select
                        value={p.field || undefined}
                        onChange={(v: string) =>
                          setPairs((prev) => prev.map((x) => (x.id === p.id ? { ...x, field: v } : x)))
                        }
                        placeholder={collection ? t`Field` : t`Pick a collection first`}
                        options={targetOptions}
                        className="min-w-0"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      className="shrink-0 px-2"
                      aria-label={t`Remove column`}
                      disabled={pairs.length === 1}
                      onClick={() => setPairs((prev) => prev.filter((x) => x.id !== p.id))}
                    >
                      <I.X size={13} />
                    </Button>
                  </div>
                ))}
              </div>
              <Button
                variant="ghost"
                className="mt-1.5"
                onClick={() =>
                  setPairs((prev) => [...prev, { id: crypto.randomUUID(), external: "", field: "" }])
                }
              >
                <Trans>Add column</Trans>
              </Button>
            </div>

            {groups.map((g) => (
              <ChildGroupEditor
                key={g.key}
                group={g}
                draft={children[g.key] ?? EMPTY_CHILD}
                collections={collections.map((c) => c.slug)}
                fieldsOf={fieldsOf}
                externalOptions={g.key === LISTING_VARIANT_GROUP ? variantOptions : undefined}
                hint={
                  g.key === LISTING_VARIANT_GROUP ? (
                    <Trans>optional — leave empty when a product is one sellable unit</Trans>
                  ) : undefined
                }
                onChange={(next) => {
                  setChildren((prev) => ({ ...prev, [g.key]: next }));
                  // Choosing (or clearing) a variant collection moves where the
                  // verdict lands, so the writeback targets belong to a
                  // different collection now and cannot be carried across.
                  if (g.key === LISTING_VARIANT_GROUP) setOutputs({});
                }}
              />
            ))}

            {direction === "listing" && listing && (
              <div>
                <span className="mb-1 block text-[11.5px] font-medium">
                  <Trans>Write the verdict back to</Trans>{" "}
                  <span className="font-normal text-muted-foreground">
                    ·{" "}
                    {hasVariantCollection ? (
                      <Trans>columns on the variant</Trans>
                    ) : (
                      <Trans>columns on the product</Trans>
                    )}
                  </span>
                </span>
                <div className="flex flex-col gap-2">
                  {listing.outputs.map((o) => (
                    <div key={o.key} className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[11.5px]">{o.label}</span>
                      <I.ArrowRight size={13} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <Select
                          value={outputs[o.key] || undefined}
                          onChange={(v: string) => setOutputs((prev) => ({ ...prev, [o.key]: v }))}
                          placeholder={t`Field`}
                          // The verdict lands on the row the UNIT came from, so
                          // these are the variant collection's columns when there
                          // is one. Offering the product's would make the correct
                          // configuration impossible: a unit's listing status is
                          // not a product column.
                          options={
                            hasVariantCollection
                              ? fieldsOf(children[LISTING_VARIANT_GROUP]?.collection ?? "")
                              : targetOptions
                          }
                          className="min-w-0"
                        />
                      </div>
                    </div>
                  ))}
                </div>
                <span className="mt-1 block text-[11.5px] leading-snug text-muted-foreground">
                  <Trans>
                    A marketplace rules on each unit separately and hours later. Without somewhere to put the
                    answer the batch is published and every verdict discarded.
                  </Trans>
                </span>
              </div>
            )}

            {direction === "inbound" ? (
              <p className="text-[11.5px] leading-snug text-muted-foreground">
                <Trans>
                  There is no schedule: rows arrive when the provider sends them. Turn the endpoint on from
                  the sync's row once it exists.
                </Trans>
              </p>
            ) : (
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">
                <Trans>Run</Trans>
              </span>
              <Select
                value={String(interval)}
                onChange={(v: string) => setInterval(Number(v))}
                options={[
                  // 0 needs saying out loud — "manual" is not a duration.
                  { value: "0", label: t`Only when I ask` },
                  ...INTERVAL_MINUTES.map((m) => ({ value: String(m), label: intervalLabel(m) })),
                ]}
                className="min-w-0"
              />
            </label>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button disabled={!ready} onClick={submit}>
            <Trans>Create sync</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
