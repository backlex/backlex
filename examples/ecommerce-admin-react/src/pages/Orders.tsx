/**
 * The order list, filtered along the three axes the template separates.
 *
 * `state` (the order's own life), `status` (payment) and `fulfillment_status`
 * (delivery) are three different questions, and this screen keeps them three
 * different controls — the old single-column model is exactly what let
 * "cancelled" hide inside a payment value.
 */
import { useState } from "react";
import type { ComparisonObj } from "backlex";
import { channels, orders } from "../lib/backlex";
import { errText, useAsync } from "../lib/hooks";
import { fmtDate, fmtMoney, fmtNumber } from "../lib/money";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  PageHeader,
  Table,
  TableScroll,
  TableSkeleton,
  Td,
  Th,
  cx,
  inputCls,
} from "../lib/ui";
import { stateTone } from "./Dashboard";

const PAGE = 20;

export const payTone = (s: string | null | undefined) =>
  ({
    pending: "amber",
    authorized: "blue",
    partially_paid: "amber",
    paid: "green",
    partially_refunded: "purple",
    refunded: "gray",
    voided: "red",
  })[s ?? ""] ?? "gray";

export const shipTone = (s: string | null | undefined) =>
  ({ unfulfilled: "gray", partial: "amber", fulfilled: "green", restocked: "slate" })[s ?? ""] ?? "gray";

export function Orders({ go }: { go: (to: string) => void }) {
  const [state, setState] = useState("");
  const [status, setStatus] = useState("");
  const [ship, setShip] = useState("");
  const [channel, setChannel] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);

  const chs = useAsync(() => channels.list({ limit: 100 }).then((r) => r.data), []);

  const list = useAsync(() => {
    const filter: Record<string, ComparisonObj> = {};
    if (state) filter.state = { _eq: state };
    if (status) filter.status = { _eq: status };
    if (ship) filter.fulfillment_status = { _eq: ship };
    if (channel) filter.channel = { _eq: channel };
    return orders.list({
      filter: Object.keys(filter).length ? filter : undefined,
      q: q || undefined,
      sort: ["-placed_at"],
      limit: PAGE,
      offset,
      meta: "filter_count",
      expand: ["customer", "channel"],
    });
  }, [state, status, ship, channel, q, offset]);

  const total = list.data?.meta?.filter_count ?? 0;
  const reset = () => setOffset(0);

  return (
    <>
      <PageHeader title="Orders" subtitle={list.data ? `${fmtNumber(total)} matching` : undefined} />

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Search">
            <input className={inputCls} value={q} placeholder="Number, email…" onChange={(e) => { reset(); setQ(e.target.value); }} />
          </Field>
          <Field label="Order state">
            <select className={inputCls} value={state} onChange={(e) => { reset(); setState(e.target.value); }}>
              <option value="">Any</option>
              {["draft", "open", "completed", "cancelled"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Payment">
            <select className={inputCls} value={status} onChange={(e) => { reset(); setStatus(e.target.value); }}>
              <option value="">Any</option>
              {["pending", "authorized", "partially_paid", "paid", "partially_refunded", "refunded", "voided"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Fulfillment">
            <select className={inputCls} value={ship} onChange={(e) => { reset(); setShip(e.target.value); }}>
              <option value="">Any</option>
              {["unfulfilled", "partial", "fulfilled", "restocked"].map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </Field>
          <Field label="Channel">
            <select className={cx(inputCls)} value={channel} onChange={(e) => { reset(); setChannel(e.target.value); }}>
              <option value="">Any</option>
              {(chs.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <ErrorNote error={list.error ? errText(list.error) : null} />
        {list.data == null ? (
          <TableSkeleton rows={8} cols={7} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="No orders match" hint="Every filter above narrows a different axis — clear one to widen the search." />
        ) : (
          <>
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Placed</Th>
                    <Th>Customer</Th>
                    <Th>State</Th>
                    <Th>Payment</Th>
                    <Th>Fulfillment</Th>
                    <Th className="text-right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((o) => {
                    const c = o.customer as { first_name?: string; last_name?: string; email?: string } | string | null;
                    const who = c && typeof c === "object" ? [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email : o.email;
                    return (
                      <tr key={o.id} className="cursor-pointer border-t border-white/5 hover:bg-white/5" onClick={() => go(`/orders/${o.id}`)}>
                        <Td className="whitespace-nowrap font-medium">{o.number ?? o.id.slice(0, 8)}</Td>
                        <Td className="whitespace-nowrap text-white/60">{fmtDate(o.placed_at)}</Td>
                        <Td className="max-w-[20ch] truncate text-white/70">{who || "—"}</Td>
                        <Td><Badge tone={stateTone(o.state)}>{o.state ?? "—"}</Badge></Td>
                        <Td><Badge tone={payTone(o.status)}>{o.status ?? "—"}</Badge></Td>
                        <Td><Badge tone={shipTone(o.fulfillment_status)}>{o.fulfillment_status ?? "—"}</Badge></Td>
                        <Td className="text-right tabular-nums">{fmtMoney(o.total, o.currency)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            </TableScroll>
            <div className="mt-3 flex items-center justify-between text-sm text-white/50">
              <span>
                {offset + 1}–{Math.min(offset + PAGE, total || offset + list.data.data.length)} of {fmtNumber(total)}
              </span>
              <div className="flex gap-2">
                <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</Button>
                <Button disabled={!list.data.has_more} onClick={() => setOffset(offset + PAGE)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
