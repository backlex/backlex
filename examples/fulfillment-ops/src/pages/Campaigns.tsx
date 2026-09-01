/**
 * Campaigns: what is running, what it has cost, and how much budget is left.
 *
 * The status buttons come from the server's `transitions`, so a campaign that
 * cannot legally be resumed simply does not offer the button.
 */
import { useState } from "react";
import type { TransitionMove } from "backlex";
import { campaigns, type Campaign } from "../lib/backlex";
import { CAMPAIGN_STATUS, fmtDate, fmtMoney, fmtNumber } from "../lib/format";
import { errText, useAsync, useToast } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, PageHeader, Skeleton, TableSkeleton, cx } from "@backlex-examples/shared";

export function Campaigns() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, error, reload, setData } = useAsync(async () => {
    const rows = await campaigns.list({ limit: 100, sort: "-starts_at" });
    const moves = await Promise.all(
      rows.data.map((c) =>
        campaigns
          .transitions(c.id)
          .then((r) => [c.id, r.data.find((f) => f.field === "status")?.moves ?? []] as [string, TransitionMove[]])
          .catch(() => [c.id, []] as [string, TransitionMove[]]),
      ),
    );
    return { rows: rows.data, moves: new Map(moves) };
  }, []);

  async function move(c: Campaign, to: string) {
    const prev = c.status;
    setBusy(c.id);
    setData((d) => (d ? { ...d, rows: d.rows.map((x) => (x.id === c.id ? { ...x, status: to as Campaign["status"] } : x)) } : d));
    try {
      await campaigns.update(c.id, { status: to as Campaign["status"] });
      toast(`${c.name}: ${CAMPAIGN_STATUS[to]?.label ?? to}`);
      reload();
    } catch (e) {
      setData((d) => (d ? { ...d, rows: d.rows.map((x) => (x.id === c.id ? { ...x, status: prev } : x)) } : d));
      toast(errText(e), "err");
    } finally {
      setBusy(null);
    }
  }

  const offer = (c: Campaign) => {
    const label = { scheduled: "Planla", active: "Yayına al", paused: "Duraklat", ended: "Bitir", draft: "Taslağa al" };
    return (data?.moves.get(c.id) ?? [])
      .filter((m) => m.allowed)
      .map((m) => ({ to: m.to, label: m.label ?? label[m.to as keyof typeof label] ?? m.to }));
  };

  const value = (c: Campaign) =>
    c.kind === "percent"
      ? `%${fmtNumber(c.percent_off ?? 0)}`
      : c.kind === "amount"
        ? fmtMoney(c.amount_off)
        : "Ücretsiz kargo";

  return (
    <>
      <PageHeader title="Kampanyalar" subtitle={loading ? undefined : `${fmtNumber(data?.rows.length ?? 0)} kampanya`} />

      {error ? <EmptyState title="Kampanyalar yüklenemedi" hint={String(error)} /> : null}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Card key={i}>
              <Skeleton className="h-5 w-40" />
              <Skeleton className="mt-3 h-2 w-full" />
              <TableSkeleton rows={2} cols={2} />
            </Card>
          ))}
        </div>
      ) : (data?.rows.length ?? 0) === 0 ? (
        <EmptyState title="Henüz kampanya yok" hint="İlk kampanyayı oluşturduğunuzda burada listelenir." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {data?.rows.map((c) => {
            const budget = c.budget?.amount ?? 0;
            const spent = c.spent?.amount ?? 0;
            const pct = budget > 0 ? Math.min(100, (spent / budget) * 100) : 0;
            const over = budget > 0 && spent > budget;
            const usageFull = typeof c.usage_limit === "number" && (c.redemption_count ?? 0) >= c.usage_limit;
            return (
              <Card key={c.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="truncate font-medium">{c.name}</h2>
                    <p className="mt-0.5 font-mono text-xs text-ink-dim">{c.code ?? "kodsuz"}</p>
                  </div>
                  <Badge tone={CAMPAIGN_STATUS[c.status]?.tone}>{CAMPAIGN_STATUS[c.status]?.label ?? c.status}</Badge>
                </div>

                <dl className="mt-3 grid grid-cols-2 gap-y-1 text-sm">
                  <dt className="text-ink-dim">İndirim</dt>
                  <dd className="text-right">{value(c)}</dd>
                  <dt className="text-ink-dim">Min. sepet</dt>
                  <dd className="text-right tabular-nums">{fmtMoney(c.min_basket)}</dd>
                  <dt className="text-ink-dim">Dönem</dt>
                  <dd className="text-right text-ink-muted">
                    {fmtDate(c.starts_at)} – {fmtDate(c.ends_at)}
                  </dd>
                  <dt className="text-ink-dim">Kullanım</dt>
                  <dd className={cx("text-right tabular-nums", usageFull && "text-warn")}>
                    {fmtNumber(c.redemption_count ?? 0)}
                    {typeof c.usage_limit === "number" ? ` / ${fmtNumber(c.usage_limit)}` : ""}
                  </dd>
                </dl>

                {budget > 0 ? (
                  <div className="mt-3">
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="text-ink-dim">Bütçe</span>
                      <span className={cx("tabular-nums", over ? "text-bad" : "text-ink-muted")}>
                        {fmtMoney(c.spent)} / {fmtMoney(c.budget)}
                      </span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-raised">
                      <div
                        className={cx("h-full rounded-full", over ? "bg-bad/80" : pct > 80 ? "bg-warn/80" : "bg-ok/70")}
                        style={{ width: `${Math.max(pct, over ? 100 : 0)}%` }}
                      />
                    </div>
                    {over ? <p className="mt-1 text-xs text-bad">Bütçe aşıldı — kampanyayı duraklatmayı düşünün.</p> : null}
                  </div>
                ) : null}

                {offer(c).length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {offer(c).map((m) => (
                      <Button key={m.to} disabled={busy === c.id} onClick={() => move(c, m.to)}>
                        {busy === c.id ? "…" : m.label}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
