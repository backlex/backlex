// Payments page — connect Stripe / Polar / Lemon Squeezy, hand the provider a
// signed webhook URL, and watch what it delivers. The synced business data
// itself lives in ordinary collections (payment_customers, …), so this page is
// only about the connection: credentials, the receive URL, the delivery log,
// and a manual reconcile.
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  relativeTime,
  type BadgeVariant,
} from "../ui";
import { I } from "../icons";
import { api } from "@/lib/api";
import { Input } from "@backlex/ui/components/input";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { fetchSafely } from "./_shared";

type Field = {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  optional?: boolean;
  choices?: string[];
  hint?: string;
};
type CheckoutMode = "adhoc" | "catalog" | null;
type CatalogEntry = {
  provider: string;
  label: string;
  /** `adhoc` takes an amount; `catalog` needs a pre-made price and can't yet. */
  checkoutMode: CheckoutMode;
  fields: Field[];
};
type Catalog = { providers: CatalogEntry[]; recordKinds: string[] };
type Connection = {
  id: string;
  provider: string;
  status: string;
  config: Record<string, unknown>;
  webhookPath: string;
  lastEventAt?: number | string | null;
  lastSyncAt?: number | string | null;
  lastSyncError: string | null;
};
type DeliveryRow = {
  id: string;
  providerId: string;
  externalId: string;
  type: string;
  status: string;
  recordCount: number;
  error: string | null;
  createdAt?: number | string | null;
};

/** Stripe's mark is the simple-icons single-path glyph. Polar and Lemon
 *  Squeezy don't publish one we can vendor, so they get a lettermark and the
 *  fruit respectively — better an honest stand-in than an invented "logo". */
const STRIPE_MARK =
  "M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z";

type Brand = { mark: ReactNode; markBg: string };
const BRANDS: Record<string, Brand> = {
  stripe: {
    mark: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d={STRIPE_MARK} />
      </svg>
    ),
    markBg: "#635BFF",
  },
  polar: { mark: "P", markBg: "#0062FF" },
  lemonsqueezy: { mark: "\u{1F34B}", markBg: "#FFC233" },
  paddle: { mark: "Pd", markBg: "#FDDD35" },
  paytr: { mark: "PT", markBg: "#00A0E9" },
  iyzico: { mark: "iy", markBg: "#1E64FF" },
  dummy: { mark: "TE", markBg: "oklch(0.55 0.13 75)" },
};
const brandFor = (provider: string): Brand =>
  BRANDS[provider] ?? { mark: provider.slice(0, 2).toUpperCase(), markBg: "oklch(0.45 0.02 286)" };

const absoluteWebhookUrl = (path: string): string =>
  typeof window === "undefined" ? path : `${window.location.origin}${path}`;

const STATUS_VARIANT: Record<string, BadgeVariant> = {
  processed: "default",
  received: "secondary",
  skipped: "outline",
  failed: "destructive",
};

export function PaymentsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [catalog, setCatalog] = useState<Catalog>({ providers: [], recordKinds: [] });
  const [connected, setConnected] = useState<Connection[]>([]);
  const [events, setEvents] = useState<DeliveryRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [connectProvider, setConnectProvider] = useState<string | null>(null);
  const [checkoutFor, setCheckoutFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = async () => {
    const [cat, list, log] = await Promise.all([
      fetchSafely<Catalog>("/api/admin/payments/catalog"),
      fetchSafely<{ data: Connection[] }>("/api/admin/payments/providers"),
      fetchSafely<{ data: DeliveryRow[] }>("/api/admin/payments/events?limit=25"),
    ]);
    if (cat) setCatalog(cat);
    if (list) setConnected(list.data);
    if (log) setEvents(log.data);
    setLoaded(true);
  };
  useEffect(() => {
    void reload();
  }, []);

  const byProvider = new Map(connected.map((c) => [c.provider, c]));
  const labelFor = (provider: string) =>
    catalog.providers.find((p) => p.provider === provider)?.label ?? provider;

  const copy = (text: string, message: string) => {
    void navigator.clipboard.writeText(text).then(
      () => pushToast(message),
      () => pushToast(t`Couldn't copy — select the URL and copy it manually.`),
    );
  };

  const connect = async (provider: string, config: Record<string, string>) => {
    setBusy(provider);
    try {
      const res = await api<{
        data: Connection;
        collections: { created: string[]; existing: string[]; conflicts: string[] };
      }>("/api/admin/payments/providers", {
        method: "POST",
        body: JSON.stringify({ provider, config }),
      });
      // Reconcile straight from the response — the row carries the webhook path
      // the admin needs next, so there's nothing to wait a refetch for.
      setConnected((prev) => [
        res.data,
        ...prev.filter((c) => c.provider !== provider),
      ]);
      setConnectProvider(null);
      // A slug collision means nothing will ever be written to that kind —
      // loud toast rather than a silently-empty collection later.
      if (res.collections.conflicts.length > 0) {
        pushToast(
          t`${labelFor(provider)} connected, but ${res.collections.conflicts.join(", ")} already exist and aren't sync targets — rename them or that data won't sync.`,
        );
      } else {
        pushToast(t`${labelFor(provider)} connected.`);
      }
      void reload();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (row: Connection) => {
    const snapshot = connected;
    const eventsSnapshot = events;
    // Optimistic: the card flips back to "Connect" immediately, and the
    // deliveries that belonged to this connection disappear with it.
    setConnected((prev) => prev.filter((c) => c.id !== row.id));
    setEvents((prev) => prev.filter((e) => e.providerId !== row.id));
    // Deliberately NOT setting `busy`: the card has already flipped back to
    // its unconnected state, so a "Connecting…" label on the in-flight DELETE
    // would describe the opposite of what is happening.
    try {
      await api(`/api/admin/payments/providers/${row.id}`, { method: "DELETE" });
      pushToast(t`${labelFor(row.provider)} disconnected. Synced rows were kept.`);
    } catch (e) {
      setConnected(snapshot);
      setEvents(eventsSnapshot);
      pushToast((e as Error).message);
    }
  };

  const rotate = async (row: Connection) => {
    const snapshot = connected;
    setBusy(row.provider);
    try {
      const res = await api<{ data: Connection }>(
        `/api/admin/payments/providers/${row.id}/rotate-token`,
        { method: "POST" },
      );
      setConnected((prev) => prev.map((c) => (c.id === row.id ? res.data : c)));
      copy(
        absoluteWebhookUrl(res.data.webhookPath),
        t`New URL copied. Paste it into ${labelFor(row.provider)} — the old one is dead.`,
      );
    } catch (e) {
      setConnected(snapshot);
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sync = async (row: Connection) => {
    setBusy(row.provider);
    try {
      const res = await api<{ written?: number; failed?: number; error?: string }>(
        `/api/admin/payments/providers/${row.id}/sync`,
        { method: "POST", body: JSON.stringify({ resume: false }) },
      );
      if (res.error) pushToast(t`Sync stopped: ${res.error}`);
      else pushToast(t`Synced ${res.written ?? 0} records from ${labelFor(row.provider)}.`);
      void reload();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const skeletonProviders = catalog.providers.length
    ? catalog.providers.map((p) => p.provider)
    : ["stripe", "polar", "lemonsqueezy"];

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Payments`}
        description={t`Mirror customers, subscriptions, invoices and payments into your collections — and open hosted checkouts to ask for payment. Deliveries are signature-verified; credentials are encrypted at rest.`}
      />

      <div className="grid grid-cols-3 gap-3 max-[920px]:grid-cols-2 max-[560px]:grid-cols-1">
        {!loaded
          ? skeletonProviders.map((p) => (
              <div key={p} className="flex flex-col gap-3 rounded-control border border-border bg-card p-5">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-10 w-10 rounded-control" />
                  <Skeleton className="mt-1 h-3.5 w-24" />
                </div>
                <Skeleton className="h-3 w-full" />
                <Skeleton className="mt-auto h-8 w-24" />
              </div>
            ))
          : catalog.providers.map((entry) => {
              const brand = brandFor(entry.provider);
              const row = byProvider.get(entry.provider);
              const isBusy = busy === entry.provider;
              return (
                <div
                  key={entry.provider}
                  className="flex flex-col gap-3 rounded-control border border-border bg-card p-5"
                >
                  <div className="flex items-start gap-3">
                    <span
                      className="grid h-10 w-10 shrink-0 place-items-center rounded-control text-[14px] font-bold text-white"
                      style={{ background: brand.markBg }}
                    >
                      {brand.mark}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[14px] font-semibold">{entry.label}</h3>
                        {row && (
                          <Badge variant="default" className="text-[10px]">
                            <Trans>Connected</Trans>
                          </Badge>
                        )}
                      </div>
                      {row?.lastEventAt ? (
                        <div className="truncate text-[11.5px] text-muted-foreground">
                          <Trans>last event {relativeTime(row.lastEventAt)}</Trans>
                        </div>
                      ) : row ? (
                        <div className="truncate text-[11.5px] text-muted-foreground">
                          <Trans>no deliveries yet</Trans>
                        </div>
                      ) : null}
                    </div>
                  </div>

                  {row ? (
                    <>
                      <div className="flex min-w-0 items-center gap-1.5 rounded-control border border-border bg-muted/40 px-2 py-1.5">
                        <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                          {absoluteWebhookUrl(row.webhookPath)}
                        </code>
                        <IconButton
                          icon={I.Copy}
                          title={t`Copy webhook URL`}
                          onClick={() =>
                            copy(absoluteWebhookUrl(row.webhookPath), t`Webhook URL copied.`)
                          }
                        />
                      </div>
                      {row.lastSyncError ? (
                        <p className="text-[11.5px] leading-snug text-destructive">
                          <Trans>Last sync failed: {row.lastSyncError}</Trans>
                        </p>
                      ) : null}
                      <div className="mt-auto flex flex-wrap gap-1.5">
                        {entry.checkoutMode === "adhoc" ? (
                          <Button variant="outline" onClick={() => setCheckoutFor(entry.provider)}>
                            <Trans>Payment link</Trans>
                          </Button>
                        ) : null}
                        <Button disabled={isBusy} onClick={() => void sync(row)}>
                          {isBusy ? <Trans>Working…</Trans> : <Trans>Sync now</Trans>}
                        </Button>
                        <Button variant="outline" disabled={isBusy} onClick={() => void rotate(row)}>
                          <Trans>New URL</Trans>
                        </Button>
                        <Button variant="ghost" disabled={isBusy} onClick={() => void disconnect(row)}>
                          <Trans>Disconnect</Trans>
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p className="flex-1 text-[12px] leading-snug text-muted-foreground">
                        {entry.provider === "dummy" ? (
                          <Trans>
                            A local stand-in that settles payments without charging anything.
                            Demo and development instances only.
                          </Trans>
                        ) : entry.checkoutMode === "adhoc" ? (
                          <Trans>
                            Mirror {entry.label}'s billing objects, and open checkouts to ask for
                            payment.
                          </Trans>
                        ) : (
                          <Trans>
                            Mirror customers, subscriptions, invoices and payments from{" "}
                            {entry.label}.
                          </Trans>
                        )}
                      </p>
                      <div className="mt-auto">
                        <Button disabled={isBusy} onClick={() => setConnectProvider(entry.provider)}>
                          {isBusy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              );
            })}
      </div>

      <section className="rounded-control border border-border bg-card">
        <header className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-[13px] font-semibold">
            <Trans>Recent deliveries</Trans>
          </h2>
          <IconButton icon={I.Refresh} title={t`Refresh`} onClick={() => void reload()} />
        </header>
        {!loaded ? (
          <div className="flex flex-col gap-2 p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            icon={I.Receipt}
            title={t`No deliveries yet`}
            description={t`Once a provider posts to the webhook URL above, every delivery shows up here with what it wrote.`}
          />
        ) : (
          <ScrollArea className="w-full" viewportClassName="max-h-[380px]">
            <table className="w-full text-[12px]">
              <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">
                    <Trans>Event</Trans>
                  </th>
                  <th className="px-4 py-2 font-medium">
                    <Trans>Status</Trans>
                  </th>
                  <th className="px-4 py-2 font-medium max-[640px]:hidden">
                    <Trans>Rows</Trans>
                  </th>
                  <th className="px-4 py-2 font-medium max-[640px]:hidden">
                    <Trans>Received</Trans>
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-border/60 last:border-0">
                    <td className="max-w-0 px-4 py-2">
                      <div className="truncate font-mono text-[11.5px]">{e.type || "—"}</div>
                      <div className="truncate font-mono text-[10.5px] text-muted-foreground">
                        {e.externalId}
                      </div>
                      {e.error ? (
                        <div className="truncate text-[10.5px] text-destructive">{e.error}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant={STATUS_VARIANT[e.status] ?? "secondary"} className="text-[10px]">
                        {e.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 tabular-nums max-[640px]:hidden">{e.recordCount}</td>
                    <td className="px-4 py-2 text-muted-foreground max-[640px]:hidden">
                      {relativeTime(e.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </section>

      {connectProvider && (
        <ConnectDialog
          label={labelFor(connectProvider)}
          fields={catalog.providers.find((p) => p.provider === connectProvider)?.fields ?? []}
          busy={busy === connectProvider}
          onClose={() => setConnectProvider(null)}
          onConnect={(config) => void connect(connectProvider, config)}
        />
      )}
      {checkoutFor && (
        <CheckoutDialog
          provider={checkoutFor}
          label={labelFor(checkoutFor)}
          onClose={() => setCheckoutFor(null)}
          onCopy={copy}
        />
      )}
    </div>
  );
}

/**
 * Open a one-off checkout from the admin.
 *
 * Deliberately not a full invoicing screen: the useful automation is the
 * `payment.checkout` flow step, which bills a row the moment it lands. This is
 * the manual escape hatch — and the fastest way to check a freshly connected
 * provider actually works before wiring a flow around it.
 */
function CheckoutDialog({
  provider,
  label,
  onClose,
  onCopy,
}: {
  provider: string;
  label: string;
  onClose: () => void;
  onCopy: (text: string, message: string) => void;
}) {
  const { t } = useLingui();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [description, setDescription] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url: string; reference: string } | null>(null);

  // Typed in major units because that is what an admin has in front of them;
  // the API takes minor units, so the conversion happens here rather than
  // asking somebody to multiply their invoice total by 100.
  const minorUnits = Math.round(Number(amount.replace(",", ".")) * 100);
  const ready = Number.isInteger(minorUnits) && minorUnits > 0 && currency.length === 3;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ data: { url: string; reference: string } }>(
        "/api/admin/payments/checkout",
        {
          method: "POST",
          body: JSON.stringify({
            provider,
            amount: minorUnits,
            currency: currency.toUpperCase(),
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(email.trim() ? { customer: { email: email.trim() } } : {}),
          }),
        },
      );
      setResult(res.data);
    } catch (e) {
      // The service distinguishes a bad amount from an unreachable provider,
      // and the message says which — surface it rather than "failed".
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(86vh,720px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            {t`${label} payment link`}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              Opens a hosted checkout and gives you a link to send. To bill a row automatically,
              use the payment-link step in a flow.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[calc(min(86vh,720px)-10rem)] max-[640px]:max-h-[calc(min(86vh,720px)-15rem)]">
          <div className="flex flex-col gap-3.5 px-5 py-4">
            {result ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">
                    <Trans>Payment link</Trans>
                  </span>
                  <Input readOnly value={result.url} onFocus={(e) => e.currentTarget.select()} />
                </label>
                <p className="text-[11.5px] leading-snug text-muted-foreground">
                  <Trans>
                    Reference <span className="font-mono">{result.reference}</span> comes back on
                    the settlement, so the payment can be matched to whatever you opened this for.
                  </Trans>
                </p>
              </>
            ) : (
              <>
                <div className="grid grid-cols-[1fr_7rem] gap-3 [&>*]:min-w-0">
                  <label className="block">
                    <span className="mb-1 block text-[11.5px] font-medium">
                      <Trans>Amount</Trans>
                    </span>
                    <Input
                      inputMode="decimal"
                      placeholder="108.90"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11.5px] font-medium">
                      <Trans>Currency</Trans>
                    </span>
                    <Input
                      value={currency}
                      maxLength={3}
                      onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">
                    <Trans>Description</Trans>
                  </span>
                  <Input
                    placeholder={t`Invoice INV-42`}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">
                    <Trans>Customer email</Trans>
                  </span>
                  <Input
                    type="email"
                    placeholder="buyer@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                  <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                    <Trans>PayTR and iyzico both require one.</Trans>
                  </span>
                </label>
                {error ? (
                  <p className="text-[11.5px] leading-snug text-destructive">{error}</p>
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0 flex-col-reverse gap-2 border-t border-border px-5 py-3.5 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            {result ? <Trans>Done</Trans> : <Trans>Cancel</Trans>}
          </Button>
          {result ? (
            <Button onClick={() => onCopy(result.url, t`Payment link copied.`)}>
              <Trans>Copy link</Trans>
            </Button>
          ) : (
            <Button disabled={!ready || busy} onClick={() => void submit()}>
              {busy ? <Trans>Opening…</Trans> : <Trans>Create link</Trans>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Connect a provider: API key + webhook signing secret ── */
function ConnectDialog({
  label,
  fields,
  busy,
  onClose,
  onConnect,
}: {
  label: string;
  fields: Field[];
  busy: boolean;
  onClose: () => void;
  onConnect: (config: Record<string, string>) => void;
}) {
  const { t } = useLingui();
  const [values, setValues] = useState<Record<string, string>>({});

  const ready = fields.every((f) => f.optional || (values[f.key]?.trim().length ?? 0) > 0);

  const submit = () => {
    const config: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) if (v.trim()) config[k] = v.trim();
    onConnect(config);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(86vh,720px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            {t`Connect ${label}`}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              Credentials are encrypted at rest and shown masked afterwards. You'll get a webhook
              URL to paste into the provider once this is saved.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[calc(min(86vh,720px)-10rem)] max-[640px]:max-h-[calc(min(86vh,720px)-15rem)]">
          <div className="flex flex-col gap-3.5 px-5 py-4">
            {fields.map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1 block text-[11.5px] font-medium">
                  {f.label}
                  {f.optional ? (
                    <span className="ml-1 font-normal text-muted-foreground">
                      · <Trans>optional</Trans>
                    </span>
                  ) : null}
                </span>
                {f.choices ? (
                  // A finite value set is picked, never typed — the first
                  // choice is the documented default.
                  <Select
                    value={values[f.key] ?? f.choices[0] ?? ""}
                    onValueChange={(val) => setValues((v) => ({ ...v, [f.key]: val }))}
                  >
                    <SelectTrigger className="w-full min-w-0">
                      <SelectValue placeholder={f.placeholder} />
                    </SelectTrigger>
                    <SelectContent>
                      {f.choices.map((choice) => (
                        <SelectItem key={choice} value={choice}>
                          {choice}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    type={f.secret ? "password" : "text"}
                    placeholder={f.placeholder}
                    value={values[f.key] ?? ""}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                )}
                {f.hint ? (
                  <span className="mt-1 block text-[11px] leading-snug text-muted-foreground">
                    {f.hint}
                  </span>
                ) : null}
              </label>
            ))}
            <p className="rounded-control border border-border bg-muted/40 px-3 py-2 text-[11.5px] leading-snug text-muted-foreground">
              <Trans>
                Connecting also creates the payment_customers, payment_subscriptions,
                payment_invoices and payment_transactions collections if they don't exist
                yet.
              </Trans>
            </p>
          </div>
        </ScrollArea>

        <DialogFooter className="border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={submit} disabled={busy || !ready}>
            {busy ? <Trans>Connecting…</Trans> : <Trans>Connect</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
