/**
 * Who buys, what they have spent, and what they have ordered.
 *
 * `total_spent` and `orders_count` are plain columns on the customer in this
 * template rather than roll-ups, so this screen shows what is stored AND what
 * the orders actually say — a merchant should be able to see the two disagree.
 */
import { useState } from "react";
import type { Customer } from "../lib/backlex";
import { backlex, customers, orders } from "../lib/backlex";
import { errText, useAsync, useToast } from "../lib/hooks";
import { fmtDate, fmtMoney, fmtNumber, moneyAmount } from "../lib/money";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Field,
  Modal,
  PageHeader,
  Table,
  TableScroll,
  TableSkeleton,
  Td,
  Th,
  inputCls,
} from "../lib/ui";

const PAGE = 20;
const groups = backlex.from<{ id: string; name: string }>("customer_groups");

export function Customers({ go }: { go: (to: string) => void }) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);

  const grps = useAsync(() => groups.list({ limit: 100 }).then((r) => r.data), []);

  const list = useAsync(
    () =>
      customers.list({
        q: q || undefined,
        filter: group ? { customer_group: { _eq: group } } : undefined,
        sort: ["-created_at"],
        limit: PAGE,
        offset,
        meta: "filter_count",
        expand: ["customer_group"],
      }),
    [q, group, offset],
  );

  const total = list.data?.meta?.filter_count ?? 0;

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={list.data ? `${fmtNumber(total)} on file` : undefined}
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New customer
          </Button>
        }
      />

      <Card className="mb-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Search">
            <input
              className={inputCls}
              value={q}
              placeholder="Name or email"
              onChange={(e) => {
                setOffset(0);
                setQ(e.target.value);
              }}
            />
          </Field>
          <Field label="Group">
            <select
              className={inputCls}
              value={group}
              onChange={(e) => {
                setOffset(0);
                setGroup(e.target.value);
              }}
            >
              <option value="">Any</option>
              {(grps.data ?? []).map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Card>

      <Card>
        <ErrorNote error={list.error ? errText(list.error) : null} />
        {list.data == null ? (
          <TableSkeleton rows={8} cols={5} />
        ) : list.data.data.length === 0 ? (
          <EmptyState title="No customers match" hint="A customer row is created on their first order, or by hand here." />
        ) : (
          <>
            <TableScroll>
              <Table>
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Email</Th>
                    <Th>Group</Th>
                    <Th>Joined</Th>
                    <Th className="text-right">Orders</Th>
                    <Th className="text-right">Spent</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.data.map((c) => (
                    <tr key={c.id} className="cursor-pointer border-t border-white/5 hover:bg-white/5" onClick={() => setOpen(c)}>
                      <Td className="font-medium">{[c.first_name, c.last_name].filter(Boolean).join(" ") || "—"}</Td>
                      <Td className="max-w-[24ch] truncate text-white/60">{c.email ?? "—"}</Td>
                      <Td>
                        {c.customer_group && typeof c.customer_group === "object" ? (
                          <Badge tone="blue">{(c.customer_group as { name?: string }).name}</Badge>
                        ) : (
                          <span className="text-white/30">—</span>
                        )}
                      </Td>
                      <Td className="whitespace-nowrap text-white/50">{fmtDate(c.created_at)}</Td>
                      <Td className="text-right tabular-nums">{fmtNumber(c.orders_count ?? 0)}</Td>
                      <Td className="text-right tabular-nums">{fmtMoney(c.total_spent)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableScroll>
            <div className="mt-3 flex items-center justify-between text-sm text-white/50">
              <span>
                {offset + 1}–{Math.min(offset + PAGE, total || offset + list.data.data.length)} of {fmtNumber(total)}
              </span>
              <div className="flex gap-2">
                <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                  Previous
                </Button>
                <Button disabled={!list.data.has_more} onClick={() => setOffset(offset + PAGE)}>
                  Next
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>

      {open ? <CustomerSheet customer={open} onClose={() => setOpen(null)} go={go} /> : null}
      {creating ? (
        <NewCustomer
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function CustomerSheet({ customer, onClose, go }: { customer: Customer; onClose: () => void; go: (to: string) => void }) {
  const hist = useAsync(
    () => orders.list({ filter: { customer: { _eq: customer.id } }, sort: ["-placed_at"], limit: 50 }).then((r) => r.data),
    [customer.id],
  );
  const realSpend = (hist.data ?? [])
    .filter((o) => o.state !== "cancelled")
    .reduce((s, o) => s + moneyAmount(o.total), 0);
  const stored = moneyAmount(customer.total_spent);
  const drift = hist.data != null && Math.abs(realSpend - stored) > 0.005;

  return (
    <Modal
      open
      onClose={onClose}
      title={[customer.first_name, customer.last_name].filter(Boolean).join(" ") || (customer.email ?? "Customer")}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <dl className="mb-4 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-white/45">Email</dt>
          <dd className="truncate">{customer.email ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/45">Phone</dt>
          <dd>{customer.phone ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/45">Stored total spent</dt>
          <dd className="tabular-nums">{fmtMoney(customer.total_spent)}</dd>
        </div>
        <div>
          <dt className="text-xs text-white/45">From their orders</dt>
          <dd className="flex items-center gap-2 tabular-nums">
            {hist.data == null ? "…" : fmtMoney({ amount: realSpend, currency: hist.data[0]?.currency ?? "USD" })}
            {drift ? <Badge tone="amber">drift</Badge> : null}
          </dd>
        </div>
      </dl>
      {hist.data == null ? (
        <TableSkeleton rows={3} cols={4} />
      ) : hist.data.length === 0 ? (
        <p className="text-sm text-white/45">No orders yet.</p>
      ) : (
        <TableScroll>
          <Table>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Placed</Th>
                <Th>State</Th>
                <Th className="text-right">Total</Th>
              </tr>
            </thead>
            <tbody>
              {hist.data.map((o) => (
                <tr
                  key={o.id}
                  className="cursor-pointer border-t border-white/5 hover:bg-white/5"
                  onClick={() => {
                    onClose();
                    go(`/orders/${o.id}`);
                  }}
                >
                  <Td className="whitespace-nowrap font-medium">{o.number ?? o.id.slice(0, 8)}</Td>
                  <Td className="text-white/60">{fmtDate(o.placed_at)}</Td>
                  <Td>{o.state}</Td>
                  <Td className="text-right tabular-nums">{fmtMoney(o.total, o.currency)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableScroll>
      )}
    </Modal>
  );
}

function NewCustomer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [first, setFirst] = useState("");
  const [last, setLast] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const toast = useToast();

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      await customers.create({ first_name: first, last_name: last, email, phone: phone || undefined });
      toast("Customer created.");
      onDone();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="New customer"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !email.trim()} onClick={submit}>
            {busy ? "Creating…" : "Create"}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">{err}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="First name">
          <input className={inputCls} value={first} onChange={(e) => setFirst(e.target.value)} />
        </Field>
        <Field label="Last name">
          <input className={inputCls} value={last} onChange={(e) => setLast(e.target.value)} />
        </Field>
        <Field label="Email" className="sm:col-span-2" hint="Unique across the store.">
          <input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
        </Field>
        <Field label="Phone" className="sm:col-span-2" hint="Stored as canonical E.164.">
          <input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 555 555 0100" />
        </Field>
      </div>
    </Modal>
  );
}
