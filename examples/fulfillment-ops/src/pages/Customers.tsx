/**
 * Customers, and the addresses shipments actually go to.
 */
import { useState } from "react";
import { addresses, customers, orders, type Customer } from "../lib/backlex";
import { ORDER_STATUS, SEGMENT, fmtDateTime, fmtMoney, fmtNumber } from "../lib/format";
import { errText, useAsync, useToast } from "../lib/hooks";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Table,
  TableScroll,
  TableSkeleton,
  Td,
  Th,
  cx,
  inputCls,
} from "../lib/ui";

export function Customers({ go }: { go: (to: string) => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Customer | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", kind: "bireysel", email: "", phone: "", tax_office: "", tax_no: "" });
  const [saving, setSaving] = useState(false);

  const { data, loading, error, reload } = useAsync(
    async () => (await customers.list({ limit: 100, sort: "name", ...(q ? { q } : {}) })).data,
    [q],
  );

  const { data: detail, loading: detailLoading } = useAsync(async () => {
    if (!open) return null;
    const [addr, ords] = await Promise.all([
      addresses.list({ filter: { customer: { _eq: open.id } }, limit: 20 }),
      orders.list({ filter: { customer: { _eq: open.id } }, limit: 20, sort: "-placed_at" }),
    ]);
    return { addresses: addr.data, orders: ords.data };
  }, [open?.id]);

  async function create() {
    if (!form.name.trim()) {
      toast("Ünvan zorunlu", "err");
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        kind: form.kind,
        active: true,
        ...(form.email ? { email: form.email } : {}),
        ...(form.phone ? { phone: form.phone } : {}),
      };
      // The schema makes these required WHEN the customer is corporate; sending
      // them unconditionally would put empty strings on every private person.
      if (form.kind === "kurumsal") {
        body.tax_office = form.tax_office;
        body.tax_no = form.tax_no;
      }
      const r = await customers.create(body);
      toast(`${r.data.name} eklendi — ${r.data.code}`);
      setCreating(false);
      setForm({ name: "", kind: "bireysel", email: "", phone: "", tax_office: "", tax_no: "" });
      reload();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Müşteriler"
        subtitle={loading ? undefined : `${fmtNumber(data?.length ?? 0)} kayıt`}
        actions={
          <>
            <input
              className={cx(inputCls, "w-36 sm:w-56")}
              placeholder="Ünvan ara…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Müşteri ara"
            />
            <Button variant="primary" onClick={() => setCreating(true)}>
              Yeni
            </Button>
          </>
        }
      />

      {error ? <EmptyState title="Müşteriler yüklenemedi" hint={String(error)} /> : null}

      {loading ? (
        <TableSkeleton rows={8} cols={6} />
      ) : (data?.length ?? 0) === 0 ? (
        <EmptyState
          title={q ? "Eşleşen müşteri yok" : "Henüz müşteri yok"}
          hint={q ? `"${q}" için sonuç bulunamadı.` : "İlk müşteriyi ekleyerek başlayın."}
          action={q ? undefined : <Button variant="primary" onClick={() => setCreating(true)}>Yeni müşteri</Button>}
        />
      ) : (
        <Card>
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>No</Th>
                  <Th>Ünvan</Th>
                  <Th>Tip</Th>
                  <Th>Segment</Th>
                  <Th>İletişim</Th>
                  <Th className="text-right">Sipariş</Th>
                  <Th className="text-right">Kredi limiti</Th>
                </tr>
              </thead>
              <tbody>
                {data?.map((c) => (
                  <tr key={c.id} className="cursor-pointer border-t border-white/5 hover:bg-white/5" onClick={() => setOpen(c)}>
                    <Td className="font-mono text-xs text-white/50">{c.code ?? "—"}</Td>
                    <Td className="max-w-[16rem] truncate font-medium">{c.name}</Td>
                    <Td className="text-white/60">{c.kind === "kurumsal" ? "Kurumsal" : "Bireysel"}</Td>
                    <Td>
                      <Badge tone={SEGMENT[String(c.segment)]?.tone}>{SEGMENT[String(c.segment)]?.label ?? c.segment}</Badge>
                    </Td>
                    <Td className="text-white/55">
                      <span className="block truncate">{c.phone ?? "—"}</span>
                      <span className="block truncate text-xs text-white/35">{c.email ?? ""}</span>
                    </Td>
                    <Td className="text-right tabular-nums">{fmtNumber(c.orders_count ?? 0)}</Td>
                    <Td className="text-right tabular-nums text-white/60">{fmtMoney(c.credit_limit)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        </Card>
      )}

      <Modal open={open !== null} onClose={() => setOpen(null)} title={open?.name ?? ""}>
        {detailLoading ? (
          <TableSkeleton rows={5} cols={2} />
        ) : (
          <div className="space-y-5">
            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">Adresler</h3>
              {(detail?.addresses.length ?? 0) === 0 ? (
                <p className="text-sm text-white/40">Kayıtlı adres yok.</p>
              ) : (
                <ul className="space-y-3">
                  {detail?.addresses.map((a) => (
                    <li key={a.id} className="rounded-lg border border-white/10 p-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{a.label}</span>
                        {a.is_default ? <Badge tone="blue">Varsayılan</Badge> : null}
                      </div>
                      <p className="mt-1 text-white/60">{a.line1}</p>
                      <p className="text-white/50">
                        {a.district ? `${a.district} / ` : ""}
                        {a.city} {a.postcode ?? ""}
                      </p>
                      {a.phone ? <p className="mt-1 text-white/45">{a.phone}</p> : null}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-white/40">Siparişler</h3>
              {(detail?.orders.length ?? 0) === 0 ? (
                <p className="text-sm text-white/40">Henüz sipariş yok.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {detail?.orders.map((o) => (
                    <li key={o.id} className="flex items-center justify-between gap-2">
                      <button
                        type="button"
                        className="font-mono text-xs underline-offset-2 hover:underline"
                        onClick={() => {
                          setOpen(null);
                          go(`/orders/${o.id}`);
                        }}
                      >
                        {o.order_no}
                      </button>
                      <Badge tone={ORDER_STATUS[o.status]?.tone}>{ORDER_STATUS[o.status]?.label ?? o.status}</Badge>
                      <span className="tabular-nums text-white/60">{fmtMoney(o.grand_total)}</span>
                      <span className="hidden text-white/40 sm:inline">{fmtDateTime(o.placed_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </Modal>

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Yeni müşteri"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Vazgeç
            </Button>
            <Button variant="primary" onClick={create} disabled={saving}>
              {saving ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ünvan" className="sm:col-span-2">
            <input className={inputCls} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoComplete="organization" />
          </Field>
          <Field label="Tip">
            <select className={inputCls} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="bireysel">Bireysel</option>
              <option value="kurumsal">Kurumsal</option>
            </select>
          </Field>
          <Field label="Telefon" hint="0532 411 22 33 gibi yerel biçim de kabul edilir.">
            <input className={inputCls} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} autoComplete="tel" />
          </Field>
          <Field label="E-posta" className="sm:col-span-2">
            <input className={inputCls} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} autoComplete="email" />
          </Field>
          {form.kind === "kurumsal" ? (
            <>
              <Field label="Vergi dairesi">
                <input className={inputCls} value={form.tax_office} onChange={(e) => setForm({ ...form, tax_office: e.target.value })} />
              </Field>
              <Field label="Vergi no">
                <input className={inputCls} value={form.tax_no} onChange={(e) => setForm({ ...form, tax_no: e.target.value })} inputMode="numeric" />
              </Field>
            </>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
