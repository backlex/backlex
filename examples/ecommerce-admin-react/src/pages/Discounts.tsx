/**
 * Coded and automatic promotions, plus the rules that say what a discount is
 * FOR.
 *
 * `target_selection: "entitled"` is only meaningful when something names the
 * entitled items, so the editor refuses to leave that combination half-made —
 * the model used to let a merchant pick "entitled" with nothing to point at.
 */
import { useState } from "react";
import type { Discount } from "../lib/backlex";
import { backlex, categories, discounts, products } from "../lib/backlex";
import { errText, useAsync, useToast } from "../lib/hooks";
import { fmtDate, fmtMoney, fmtNumber, fromLocalInput, toLocalInput } from "../lib/money";
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
} from "@backlex-examples/shared";

type Rule = {
  id: string;
  discount?: string;
  scope?: "target" | "condition";
  attribute?: string;
  operator?: string;
  product?: string | null;
  category?: string | null;
  collection?: string | null;
  value?: string | null;
};
const rules = backlex.from<Rule>("discount_rules");

const statusTone = (s: string | null | undefined) =>
  ({ draft: "gray", scheduled: "blue", active: "green", expired: "slate" })[s ?? ""] ?? "gray";

export function Discounts() {
  const [editing, setEditing] = useState<Discount | "new" | null>(null);
  const toast = useToast();

  const list = useAsync(() => discounts.list({ sort: ["-starts_at"], limit: 100 }).then((r) => r.data), []);

  return (
    <>
      <PageHeader
        title="Discounts"
        subtitle={list.data ? `${fmtNumber(list.data.length)} defined` : undefined}
        actions={
          <Button variant="primary" onClick={() => setEditing("new")}>
            New discount
          </Button>
        }
      />

      <Card>
        <ErrorNote error={list.error ? errText(list.error) : null} />
        {list.data == null ? (
          <TableSkeleton rows={6} cols={6} />
        ) : list.data.length === 0 ? (
          <EmptyState
            title="No discounts"
            hint="A coded discount needs a code; an automatic one applies with none."
            action={
              <Button variant="primary" onClick={() => setEditing("new")}>
                New discount
              </Button>
            }
          />
        ) : (
          <TableScroll>
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Code</Th>
                  <Th>Value</Th>
                  <Th>Applies to</Th>
                  <Th>Status</Th>
                  <Th>Window</Th>
                  <Th className="text-right">Used</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {list.data.map((d) => (
                  <tr key={d.id} className="border-t border-line">
                    <Td className="font-medium">{d.name}</Td>
                    <Td>
                      {d.code ? (
                        <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs">{d.code}</code>
                      ) : (
                        <Badge tone="purple">automatic</Badge>
                      )}
                    </Td>
                    <Td className="tabular-nums">
                      {d.value_type === "percentage"
                        ? `${d.value ?? 0}%`
                        : d.value_type === "free_shipping"
                          ? "free shipping"
                          : fmtMoney(d.value ?? 0)}
                    </Td>
                    <Td className="text-ink-muted">
                      {d.target_type} · {d.target_selection}
                    </Td>
                    <Td>
                      <Badge tone={statusTone(d.status)}>{d.status}</Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-ink-muted">
                      {fmtDate(d.starts_at)} → {d.ends_at ? fmtDate(d.ends_at) : "open"}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {d.usage_count ?? 0}
                      {d.usage_limit ? ` / ${d.usage_limit}` : ""}
                    </Td>
                    <Td className="text-right">
                      <Button onClick={() => setEditing(d)}>Edit</Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableScroll>
        )}
      </Card>

      {editing ? (
        <DiscountEditor
          discount={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onDone={(msg) => {
            setEditing(null);
            toast(msg);
            list.reload();
          }}
        />
      ) : null}
    </>
  );
}

function DiscountEditor({
  discount,
  onClose,
  onDone,
}: {
  discount: Discount | null;
  onClose: () => void;
  onDone: (msg: string) => void;
}) {
  const [f, setF] = useState(() => ({
    name: discount?.name ?? "",
    code: discount?.code ?? "",
    automatic: discount?.automatic ?? false,
    status: discount?.status ?? "active",
    value_type: discount?.value_type ?? "percentage",
    value: String(discount?.value ?? 10),
    target_type: discount?.target_type ?? "items",
    target_selection: discount?.target_selection ?? "all",
    allocation: discount?.allocation ?? "across",
    usage_limit: discount?.usage_limit == null ? "" : String(discount.usage_limit),
    starts_at: toLocalInput(discount?.starts_at ?? Date.now()),
    ends_at: toLocalInput(discount?.ends_at ?? null),
  }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));

  const existingRules = useAsync(
    () => (discount ? rules.list({ filter: { discount: { _eq: discount.id } }, limit: 50 }).then((r) => r.data) : Promise.resolve([])),
    [discount?.id],
  );

  const entitledWithoutTarget =
    f.target_selection === "entitled" && (existingRules.data ?? []).every((r) => r.scope !== "target");

  async function submit() {
    setBusy(true);
    setErr("");
    try {
      const patch = {
        name: f.name,
        code: f.automatic ? null : f.code || null,
        automatic: f.automatic,
        status: f.status as Discount["status"],
        value_type: f.value_type as Discount["value_type"],
        value: Number(f.value),
        target_type: f.target_type as Discount["target_type"],
        target_selection: f.target_selection as Discount["target_selection"],
        allocation: f.allocation as Discount["allocation"],
        usage_limit: f.usage_limit === "" ? null : Number(f.usage_limit),
        starts_at: fromLocalInput(f.starts_at),
        ends_at: fromLocalInput(f.ends_at),
      };
      if (discount) {
        await discounts.update(discount.id, patch);
        onDone("Discount updated.");
      } else {
        await discounts.create(patch);
        onDone("Discount created.");
      }
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
      title={discount ? `Edit “${discount.name}”` : "New discount"}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !f.name.trim()} onClick={submit}>
            {busy ? "Saving…" : discount ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      {err ? <p className="mb-3 rounded-control border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{err}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <Field label="Name" className="sm:col-span-2">
          <input className={inputCls} value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Welcome 10%" />
        </Field>
        <label className="flex items-center gap-2 pb-1 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.automatic} onChange={(e) => set("automatic", e.target.checked)} />
          Applies automatically — no code to type
        </label>
        {!f.automatic ? (
          <Field label="Code" className="sm:col-span-2" hint="Unique across the store.">
            <input className={inputCls} value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} placeholder="WELCOME10" />
          </Field>
        ) : null}
        <Field label="Value type">
          <select className={inputCls} value={f.value_type} onChange={(e) => set("value_type", e.target.value as Discount["value_type"] & string)}>
            <option value="percentage">Percentage</option>
            <option value="fixed_amount">Fixed amount</option>
            <option value="free_shipping">Free shipping</option>
          </select>
        </Field>
        <Field label={f.value_type === "percentage" ? "Percent off" : "Amount off"}>
          <input
            className={inputCls}
            type="number"
            min="0"
            step={f.value_type === "percentage" ? "1" : "0.01"}
            value={f.value}
            disabled={f.value_type === "free_shipping"}
            onChange={(e) => set("value", e.target.value)}
          />
        </Field>
        <Field label="Applies to">
          <select className={inputCls} value={f.target_type} onChange={(e) => set("target_type", e.target.value as Discount["target_type"] & string)}>
            <option value="items">Items</option>
            <option value="shipping">Shipping</option>
            <option value="order">The whole order</option>
          </select>
        </Field>
        <Field label="Scope" hint="Entitled means only what the rules below name.">
          <select
            className={inputCls}
            value={f.target_selection}
            onChange={(e) => set("target_selection", e.target.value as Discount["target_selection"] & string)}
          >
            <option value="all">Everything</option>
            <option value="entitled">Only entitled items</option>
          </select>
        </Field>
        <Field label="Status">
          <select className={inputCls} value={f.status} onChange={(e) => set("status", e.target.value as Discount["status"] & string)}>
            {["draft", "scheduled", "active", "expired"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Usage limit" hint="Leave empty for unlimited.">
          <input className={inputCls} type="number" min="0" value={f.usage_limit} onChange={(e) => set("usage_limit", e.target.value)} />
        </Field>
        <Field label="Starts">
          <input className={inputCls} type="datetime-local" value={f.starts_at} onChange={(e) => set("starts_at", e.target.value)} />
        </Field>
        <Field label="Ends" hint="Empty means it runs until stopped.">
          <input className={inputCls} type="datetime-local" value={f.ends_at} onChange={(e) => set("ends_at", e.target.value)} />
        </Field>
      </div>

      {discount ? (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="mb-2 text-sm font-medium">Rules</h3>
          {entitledWithoutTarget ? (
            <p className="mb-2 rounded-control border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn">
              Scope is “entitled” but no <em>target</em> rule names what is entitled — as written, this discount can match nothing.
            </p>
          ) : null}
          <RulesEditor discountId={discount.id} rules={existingRules.data ?? []} onChanged={existingRules.reload} />
        </div>
      ) : (
        <p className="mt-4 text-xs text-ink-dim">Rules can be added once the discount exists.</p>
      )}
    </Modal>
  );
}

function RulesEditor({ discountId, rules: rows, onChanged }: { discountId: string; rules: Rule[]; onChanged: () => void }) {
  const [scope, setScope] = useState<"target" | "condition">("target");
  const [attribute, setAttribute] = useState("product");
  const [operator, setOperator] = useState("in");
  const [refId, setRefId] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const prods = useAsync(() => products.list({ limit: 200, status: "all", sort: ["name"] }).then((r) => r.data), []);
  const cats = useAsync(() => categories.list({ limit: 200 }).then((r) => r.data), []);

  const needsRelation = attribute === "product" || attribute === "category";

  async function add() {
    setBusy(true);
    try {
      await rules.create({
        discount: discountId,
        scope,
        attribute,
        operator,
        product: attribute === "product" ? refId || null : null,
        category: attribute === "category" ? refId || null : null,
        value: needsRelation ? null : value || null,
      });
      setRefId("");
      setValue("");
      onChanged();
    } catch (e) {
      toast(errText(e), "err");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {rows.length === 0 ? (
        <p className="text-xs text-ink-dim">No rules — the discount applies to everything in its scope.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2 rounded-control border border-line px-3 py-1.5 text-xs">
              <span>
                <Badge tone={r.scope === "target" ? "green" : "blue"}>{r.scope}</Badge>{" "}
                <span className="text-ink">
                  {r.attribute} {r.operator} {r.product ?? r.category ?? r.value ?? "—"}
                </span>
              </span>
              <button
                type="button"
                className="text-ink-dim hover:text-bad"
                onClick={async () => {
                  await rules.delete(r.id).catch(() => {});
                  onChanged();
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-4 [&>*]:min-w-0">
        <select className={inputCls} value={scope} onChange={(e) => setScope(e.target.value as "target")}>
          <option value="target">target</option>
          <option value="condition">condition</option>
        </select>
        <select className={inputCls} value={attribute} onChange={(e) => setAttribute(e.target.value)}>
          {["product", "collection", "category", "brand", "tag", "customer_group", "country", "subtotal"].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select className={inputCls} value={operator} onChange={(e) => setOperator(e.target.value)}>
          {["in", "nin", "eq", "gt", "gte", "lt", "lte"].map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        {needsRelation ? (
          <select className={inputCls} value={refId} onChange={(e) => setRefId(e.target.value)}>
            <option value="">Pick…</option>
            {(attribute === "product" ? (prods.data ?? []) : (cats.data ?? [])).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        ) : (
          <input className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} placeholder="US,CA" />
        )}
      </div>
      <Button disabled={busy || (needsRelation ? !refId : !value)} onClick={add}>
        Add rule
      </Button>
    </div>
  );
}
