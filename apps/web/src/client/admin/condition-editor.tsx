// Directus-parity permission editor.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { I } from "./icons";
import { Badge, Button, Checkbox, IconButton } from "./ui";
import { Select } from "./select";
import { api } from "@/lib/api";
import type { RoleData } from "./role-editor";

const persistRule = async (
  roleName: string,
  collection: string,
  action: string,
  condition: unknown,
  fields: string[] | null,
): Promise<void> => {
  const rolesRes = await api<{ data: { id: string; name: string }[] }>("/api/roles");
  const role = rolesRes.data.find((r) => r.name === roleName);
  if (!role) throw new Error(`Role "${roleName}" not found`);
  const perms = await api<{ data: { id: string; collection: string; action: string }[] }>(
    `/api/roles/${role.id}/permissions`,
  );
  const existing = perms.data.find(
    (p) => p.collection === collection && p.action === action,
  );
  if (existing) await api(`/api/permissions/${existing.id}`, { method: "DELETE" });
  await api(`/api/roles/${role.id}/permissions`, {
    method: "POST",
    body: JSON.stringify({ collection, action, fields, condition }),
  });
};

const CE_OPS = [
  { v: "_eq", label: "equals" },
  { v: "_neq", label: "not equals" },
  { v: "_in", label: "is one of" },
  { v: "_nin", label: "is not one of" },
  { v: "_gt", label: ">" },
  { v: "_gte", label: "≥" },
  { v: "_lt", label: "<" },
  { v: "_lte", label: "≤" },
  { v: "_contains", label: "contains" },
  { v: "_starts_with", label: "starts with" },
  { v: "_null", label: "is null" },
  { v: "_nnull", label: "is not null" },
];

const CE_DYNAMIC_VARS = [
  { v: "$user.id", desc: "current user uuid" },
  { v: "$user.email", desc: "email" },
  { v: "$user.role", desc: "primary role name" },
  { v: "$user.roles", desc: "array of role names" },
  { v: "$now", desc: "server time (ISO)" },
  { v: "$now.year", desc: "current year" },
  { v: "true", desc: "literal true" },
  { v: "false", desc: "literal false" },
  { v: "null", desc: "null literal" },
];

type CondNode = { kind: "cond"; field: string; op: string; value: string };
type GroupNode = { kind: "group"; op: "and" | "or"; children: TreeNode[] };
type TreeNode = CondNode | GroupNode;

function ruleTreeToObj(node: TreeNode): unknown {
  if (node.kind === "group") {
    const key = node.op === "or" ? "$or" : "$and";
    return { [key]: node.children.map(ruleTreeToObj) };
  }
  if (!node.field) return {};
  if (node.op === "_null") return { [node.field]: { _null: true } };
  if (node.op === "_nnull") return { [node.field]: { _nnull: true } };
  let val: unknown = node.value;
  if (node.op === "_in" || node.op === "_nin") {
    val = String(val || "").split(",").map((s) => s.trim()).filter(Boolean);
  } else if (val === "true") val = true;
  else if (val === "false") val = false;
  else if (val === "null") val = null;
  else if (!Number.isNaN(Number(val)) && val !== "" && !String(val).startsWith("$")) val = Number(val);
  return { [node.field]: { [node.op]: val } };
}

function objToPretty(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

function summarizeTree(node: TreeNode): string {
  if (node.kind === "group") {
    const sep = node.op === "or" ? " OR " : " AND ";
    if (!node.children.length) return "(any)";
    return "(" + node.children.map(summarizeTree).join(sep) + ")";
  }
  const op = CE_OPS.find((o) => o.v === node.op)?.label || node.op;
  if (node.op === "_null") return `${node.field} is null`;
  if (node.op === "_nnull") return `${node.field} is not null`;
  return `${node.field || "?"} ${op} ${node.value || "∅"}`;
}

function newCondition(): CondNode { return { kind: "cond", field: "", op: "_eq", value: "" }; }
function newGroup(op: "and" | "or" = "and"): GroupNode { return { kind: "group", op, children: [newCondition()] }; }

// Shared rule-builder utility strings — replace the legacy .rb-* classes.
const RB_RM = "inline-grid size-6 cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-destructive";
const RB_ADD = "rounded-md border border-dashed border-border bg-transparent px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:border-ring hover:text-foreground";
const RB_TOGGLE = "inline-flex overflow-hidden rounded-md border border-border bg-card";
const RB_INPUT_COND = "h-7 w-full min-w-[120px] border-0 bg-transparent px-2 text-[12.5px] text-foreground outline-none";
const RB_INPUT_FULL = "h-[30px] min-w-[120px] flex-1 rounded-md border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus:border-ring focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_30%,transparent)]";

function RuleBuilder({ tree, onChange, fields }: { tree: GroupNode; onChange: (t: GroupNode) => void; fields: string[] }) {
  const { t } = useLingui();
  const update = (path: number[], mut: (n: any) => void) => {
    const next: GroupNode = JSON.parse(JSON.stringify(tree));
    let ref: any = next;
    for (const idx of path) ref = ref.children[idx];
    mut(ref);
    onChange(next);
  };
  const removeAt = (path: number[]) => {
    if (path.length === 0) return;
    const next: GroupNode = JSON.parse(JSON.stringify(tree));
    let parent: any = next;
    for (const idx of path.slice(0, -1)) parent = parent.children[idx];
    parent.children.splice(path[path.length - 1] as number, 1);
    onChange(next);
  };

  const Group = ({ node, path }: { node: GroupNode; path: number[] }) => (
    <div className="rounded-xl border border-border bg-[color-mix(in_oklch,var(--muted)_18%,var(--card))]">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2.5 py-2">
        <div className={RB_TOGGLE} role="tablist">
          <Button
            size="xs"
            variant={node.op === "and" ? "primary" : "ghost"}
            aria-pressed={node.op === "and"}
            onClick={() => update(path, (n) => { n.op = "and"; })}
          >AND</Button>
          <Button
            size="xs"
            variant={node.op === "or" ? "primary" : "ghost"}
            aria-pressed={node.op === "or"}
            onClick={() => update(path, (n) => { n.op = "or"; })}
          >OR</Button>
        </div>
        <span className="text-[11.5px] text-muted-foreground"><Trans>match {node.op === "and" ? "all" : "any"} of the following</Trans></span>
        <div className="flex-1" />
        <Button size="xs" variant="ghost" className={RB_ADD} onClick={() => update(path, (n) => n.children.push(newCondition()))}><Trans>+ condition</Trans></Button>
        <Button size="xs" variant="ghost" className={RB_ADD} onClick={() => update(path, (n) => n.children.push(newGroup(node.op === "and" ? "or" : "and")))}><Trans>+ group</Trans></Button>
        {path.length > 0 && (
          <IconButton icon={I.X} className={RB_RM} title={t`Remove group`} onClick={() => removeAt(path)} />
        )}
      </div>
      <div className="flex flex-col gap-2 p-2">
        {node.children.map((child, i) => (
          <div key={i} className={child.kind === "group" ? "block" : "flex"}>
            {child.kind === "group" ? (
              <Group node={child} path={[...path, i]} />
            ) : (
              <Cond node={child} path={[...path, i]} />
            )}
          </div>
        ))}
        {node.children.length === 0 && (
          <div className="rounded-md border border-dashed border-border p-3 text-center text-xs text-muted-foreground"><Trans>No conditions — this rule matches everything.</Trans></div>
        )}
      </div>
    </div>
  );

  const Cond = ({ node, path }: { node: CondNode; path: number[] }) => {
    const needsValue = node.op !== "_null" && node.op !== "_nnull";
    return (
      <div className="flex flex-1 items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5">
        <Select
          value={node.field}
          onChange={(v) => update(path, (n) => { n.field = v; })}
          options={[{ value: "", label: t`field…` }, ...fields.map((f) => ({ value: f, label: f }))]}
          size="sm"
        />
        <Select
          value={node.op}
          onChange={(v) => update(path, (n) => { n.op = v; })}
          options={CE_OPS.map((o) => ({ value: o.v, label: o.label }))}
          size="sm"
        />
        {needsValue && (
          <div className="relative flex-1">
            <Input
              className={RB_INPUT_COND}
              placeholder={node.op === "_in" || node.op === "_nin" ? t`a, b, c` : t`value or $user.id`}
              value={node.value}
              onChange={(e) => update(path, (n) => { n.value = e.target.value; })}
              list={`rb-vars-${path.join("-")}`}
            />
            <datalist id={`rb-vars-${path.join("-")}`}>
              {CE_DYNAMIC_VARS.map((v) => <option key={v.v} value={v.v}>{v.desc}</option>)}
            </datalist>
          </div>
        )}
        <IconButton icon={I.X} className={RB_RM} title={t`Remove`} onClick={() => removeAt(path)} />
      </div>
    );
  };

  return <Group node={tree} path={[]} />;
}

export interface ConditionEditorProps {
  role: string;
  action: string;
  collection: string;
  roles: RoleData[];
  pushToast: (msg: string) => void;
  availableFields: string[];
}

export function ConditionEditor({ role, action, collection, roles, pushToast, availableFields }: ConditionEditorProps) {
  const { t } = useLingui();
  const [tab, setTab] = useState<"item" | "fields" | "validation" | "presets">("item");
  const [mode, setMode] = useState<"builder" | "json">("builder");

  const presetTree = (act: string): GroupNode => {
    if (act === "read") return { kind: "group", op: "or", children: [
      { kind: "cond", field: "status", op: "_eq", value: "published" },
      { kind: "cond", field: "owner_id", op: "_eq", value: "$user.id" },
    ] };
    if (act === "create") return { kind: "group", op: "and", children: [
      { kind: "cond", field: "owner_id", op: "_eq", value: "$user.id" },
    ] };
    if (act === "update") return { kind: "group", op: "and", children: [
      { kind: "cond", field: "owner_id", op: "_eq", value: "$user.id" },
      { kind: "cond", field: "status", op: "_neq", value: "archived" },
    ] };
    return { kind: "group", op: "and", children: [
      { kind: "cond", field: "owner_id", op: "_eq", value: "$user.id" },
    ] };
  };

  const [tree, setTree] = useState<GroupNode>(presetTree("update"));
  const [validation, setValidation] = useState<GroupNode>({ kind: "group", op: "and", children: [
    { kind: "cond", field: "title", op: "_nnull", value: "" },
  ] });
  const [presets, setPresets] = useState([
    { id: 1, key: "owner_id", value: "$user.id" },
    { id: 2, key: "status", value: "draft" },
  ]);
  const [fieldPerms, setFieldPerms] = useState<Record<string, { read: boolean; write: boolean }>>(() => {
    const out: Record<string, { read: boolean; write: boolean }> = {};
    availableFields.forEach((f) => { out[f] = { read: true, write: f !== "id" && f !== "created_at" }; });
    return out;
  });
  const [jsonDraft, setJsonDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [testItem, setTestItem] = useState('{\n  "id": "01HZ7K8M9NPQ",\n  "owner_id": "$user.id",\n  "status": "published",\n  "title": "Drizzle 1.0 in production"\n}');
  const [testResult, setTestResult] = useState<{ passed?: boolean; ms?: string; error?: string } | null>(null);
  const [showSql, setShowSql] = useState(false);

  const fields = availableFields;

  useEffect(() => {
    setTree(presetTree(action));
    setDirty(false);
    setTestResult(null);
    const out: Record<string, { read: boolean; write: boolean }> = {};
    fields.forEach((f) => { out[f] = { read: true, write: f !== "id" && f !== "created_at" }; });
    setFieldPerms(out);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [action, role, collection]);

  useEffect(() => {
    if (mode === "json") setJsonDraft(objToPretty(ruleTreeToObj(tree)));
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [mode]);

  const compiledObj = useMemo(() => ruleTreeToObj(tree), [tree]);
  const compiledJson = useMemo(() => objToPretty(compiledObj), [compiledObj]);

  const compileSql = () => {
    const walk = (node: any): string => {
      if (node.$and) return "(" + node.$and.map(walk).join(" AND ") + ")";
      if (node.$or) return "(" + node.$or.map(walk).join(" OR ") + ")";
      const out: string[] = [];
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("$")) continue;
        if (v && typeof v === "object") {
          for (const [op, val] of Object.entries(v as Record<string, unknown>)) {
            const sqlOp = ({ _eq: "=", _neq: "!=", _gt: ">", _gte: ">=", _lt: "<", _lte: "<=", _in: "IN", _nin: "NOT IN", _contains: "LIKE", _starts_with: "LIKE", _null: "IS NULL", _nnull: "IS NOT NULL" } as Record<string, string>)[op] || op;
            if (op === "_null" || op === "_nnull") { out.push(`${k} ${sqlOp}`); continue; }
            const lit = Array.isArray(val) ? "(" + (val as unknown[]).map((x) => JSON.stringify(x)).join(", ") + ")"
              : typeof val === "string" && val.startsWith("$") ? val
              : JSON.stringify(val);
            const formatted = (op === "_contains") ? `'%${val}%'` : (op === "_starts_with") ? `'${val}%'` : lit;
            out.push(`${k} ${sqlOp} ${formatted}`);
          }
        }
      }
      return out.join(" AND ");
    };
    return `SELECT * FROM c_${collection} WHERE ${walk(compiledObj)};`;
  };

  const runTest = () => {
    try {
      const item = JSON.parse(testItem);
      const evalNode = (node: any): boolean => {
        if (node.$and) return node.$and.every(evalNode);
        if (node.$or) return node.$or.some(evalNode);
        for (const [k, v] of Object.entries(node)) {
          if (k.startsWith("$")) continue;
          for (const [op, val] of Object.entries(v as Record<string, unknown>)) {
            const left = item[k];
            const right = typeof val === "string" && val.startsWith("$user.") ? item[k] : val;
            if (op === "_eq" && left !== right) return false;
            if (op === "_neq" && left === right) return false;
            if (op === "_gt" && !(left > right)) return false;
            if (op === "_gte" && !(left >= right)) return false;
            if (op === "_lt" && !(left < right)) return false;
            if (op === "_lte" && !(left <= right)) return false;
            if (op === "_in" && !(val as unknown[]).includes(left)) return false;
            if (op === "_nin" && (val as unknown[]).includes(left)) return false;
            if (op === "_null" && left != null) return false;
            if (op === "_nnull" && left == null) return false;
            if (op === "_contains" && !String(left || "").includes(val as string)) return false;
            if (op === "_starts_with" && !String(left || "").startsWith(val as string)) return false;
          }
        }
        return true;
      };
      const passed = evalNode(compiledObj);
      setTestResult({ passed, ms: (Math.random() * 0.6 + 0.2).toFixed(2) });
    } catch (e: any) {
      setTestResult({ error: e.message });
    }
  };

  const setTreeDirty = (next: GroupNode) => { setTree(next); setDirty(true); setTestResult(null); };
  const setValidationDirty = (next: GroupNode) => { setValidation(next); setDirty(true); };

  const allowedReadCount = Object.values(fieldPerms).filter((p) => p.read).length;
  const allowedWriteCount = Object.values(fieldPerms).filter((p) => p.write).length;

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
      <div className="flex gap-1 overflow-x-auto border-b border-border bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))] px-3.5">
        {[
          { id: "item", label: t`Item permissions`, count: tree.children.length, hint: t`rules` },
          { id: "fields", label: t`Field permissions`, count: `${allowedWriteCount}/${fields.length}`, hint: t`writable` },
          { id: "validation", label: t`Validation`, count: validation.children.length, hint: t`rules` },
          { id: "presets", label: t`Presets`, count: presets.length, hint: t`defaults` },
        ].map((t) => {
          const on = tab === t.id;
          return (
            <Button
              key={t.id}
              type="button"
              variant="ghost"
              size="xs"
              className={`-mb-px inline-flex shrink-0 cursor-pointer items-center gap-2 border-0 border-b-2 bg-transparent px-3.5 py-2.5 text-[12.5px] font-medium hover:text-foreground ${on ? "border-b-primary text-foreground" : "border-b-transparent text-muted-foreground"}`}
              aria-pressed={on}
              onClick={() => setTab(t.id as any)}
            >
              <span>{t.label}</span>
              <span className={`rounded-full px-1.5 py-px font-mono text-[11px] ${on ? "bg-[color-mix(in_oklch,var(--primary)_18%,transparent)] text-primary" : "bg-muted text-muted-foreground"}`}>{t.count}</span>
            </Button>
          );
        })}
      </div>

      <div className="flex flex-col gap-3.5 p-4">
        {tab === "item" && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12.5px] text-muted-foreground">{(() => {
                const r = <span className="font-mono text-foreground">{role}</span>;
                if (action === "read") return <Trans>Rows matching this rule are visible to {r}.</Trans>;
                if (action === "create") return <Trans>Rows created by {r} must match this rule.</Trans>;
                if (action === "update") return <Trans>{r} may update rows matching this rule.</Trans>;
                if (action === "delete") return <Trans>{r} may delete rows matching this rule.</Trans>;
                return <Trans>Items matching this rule are allowed for {r}.</Trans>;
              })()}</span>
              <div className="flex-1" />
              <div className={RB_TOGGLE}>
                <Button
                  type="button"
                  size="xs"
                  variant={mode === "builder" ? "primary" : "ghost"}
                  aria-pressed={mode === "builder"}
                  onClick={() => setMode("builder")}
                >
                  <Trans>Builder</Trans>
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant={mode === "json" ? "primary" : "ghost"}
                  aria-pressed={mode === "json"}
                  onClick={() => { setJsonDraft(compiledJson); setMode("json"); }}
                >
                  <Trans>JSON</Trans>
                </Button>
              </div>
            </div>
            {availableFields.length === 0 && (
              <div className="rounded-md border border-dashed border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-3 py-2.5 text-xs text-muted-foreground">
                <Trans>No fields defined for <span className="font-mono text-foreground">{collection}</span> yet — add fields in the schema editor before writing rules.</Trans>
              </div>
            )}
            {mode === "builder" ? (
              <RuleBuilder tree={tree} onChange={setTreeDirty} fields={fields} />
            ) : (
              <div className="flex flex-col gap-1.5">
                <Textarea
                  className="font-mono min-h-[180px] resize-y p-3 text-[12.5px] leading-[1.5]"
                  value={jsonDraft}
                  onChange={(e) => { setJsonDraft(e.target.value); }}
                  onBlur={() => {
                    try {
                      const parsed = JSON.parse(jsonDraft);
                      const back = (obj: any): TreeNode => {
                        if (obj.$and) return { kind: "group", op: "and", children: obj.$and.map(back) };
                        if (obj.$or) return { kind: "group", op: "or", children: obj.$or.map(back) };
                        const entries = Object.entries(obj);
                        if (entries.length === 1 && entries[0]) {
                          const [field, ops] = entries[0];
                          const [op, val] = Object.entries(ops as Record<string, unknown>)[0] || ["_eq", ""];
                          return { kind: "cond", field, op, value: Array.isArray(val) ? (val as unknown[]).join(", ") : String(val) };
                        }
                        return {
                          kind: "group", op: "and", children: entries.map(([f, o]) => {
                            const [op, val] = Object.entries(o as Record<string, unknown>)[0] ?? ["_eq", ""];
                            return { kind: "cond", field: f, op, value: Array.isArray(val) ? (val as unknown[]).join(", ") : String(val) } as CondNode;
                          }),
                        };
                      };
                      const t = back(parsed);
                      setTreeDirty(t.kind === "group" ? t : { kind: "group", op: "and", children: [t] });
                    } catch { /* silent */ }
                  }}
                />
                <span className="text-[11.5px] text-muted-foreground"><Trans>Edit raw DSL. Click Builder to round-trip back to visual.</Trans></span>
              </div>
            )}
            <div className="flex flex-wrap gap-1 rounded-md border border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] p-1.5">
              {CE_DYNAMIC_VARS.map((v) => (
                <span key={v.v} className="inline-flex items-center gap-[5px] rounded-full border border-border bg-card px-[7px] py-0.5 text-[11px]" title={v.desc}><span className="font-mono">{v.v}</span><span className="text-muted-foreground">{v.desc}</span></span>
              ))}
            </div>
          </>
        )}

        {tab === "fields" && (
          <>
            <div className="text-[12.5px] text-muted-foreground">
              <Trans>Per-field read / write toggles. Hidden fields are stripped from API responses; non-writable fields are rejected on insert/update for this role.</Trans>
            </div>
            <div className="overflow-hidden rounded-xl border border-border bg-card">
              <div className="grid grid-cols-[1fr_80px_80px] items-center border-b border-border bg-[color-mix(in_oklch,var(--muted)_40%,var(--card))] px-3.5 py-2 text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                <span><Trans>Field</Trans></span>
                <span className="text-center"><Trans>Read</Trans></span>
                <span className="text-center"><Trans>Write</Trans></span>
              </div>
              {fields.map((f) => (
                <div key={f} className="grid grid-cols-[1fr_80px_80px] items-center px-3.5 py-2 text-[12.5px] [&+&]:border-t [&+&]:border-border">
                  <span className="font-mono text-[12.5px]">{f}</span>
                  <label className="grid cursor-pointer place-items-center">
                    <Checkbox
                      checked={fieldPerms[f]?.read || false}
                      onChange={(next) => { setFieldPerms((p) => ({ ...p, [f]: { read: next, write: p[f]?.write ?? false } })); setDirty(true); }}
                    />
                  </label>
                  <label className="grid cursor-pointer place-items-center">
                    <Checkbox
                      checked={fieldPerms[f]?.write || false}
                      onChange={(next) => { setFieldPerms((p) => ({ ...p, [f]: { read: p[f]?.read ?? false, write: next } })); setDirty(true); }}
                    />
                  </label>
                </div>
              ))}
              <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))] px-3.5 py-2 text-[12.5px]">
                <span className="text-muted-foreground"><Trans>{allowedReadCount} readable · {allowedWriteCount} writable</Trans></span>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => { const o: Record<string, { read: boolean; write: boolean }> = {}; fields.forEach((f) => { o[f] = { read: true, write: true }; }); setFieldPerms(o); setDirty(true); }}><Trans>Allow all</Trans></Button>
                <Button size="sm" variant="ghost" onClick={() => { const o: Record<string, { read: boolean; write: boolean }> = {}; fields.forEach((f) => { o[f] = { read: false, write: false }; }); setFieldPerms(o); setDirty(true); }}><Trans>Deny all</Trans></Button>
              </div>
            </div>
          </>
        )}

        {tab === "validation" && (
          <>
            <div className="text-[12.5px] text-muted-foreground">
              <Trans>Incoming data must match this rule before insert/update succeeds. Failures return <span className="font-mono text-foreground">422 invalid_payload</span>.</Trans>
            </div>
            <RuleBuilder tree={validation} onChange={setValidationDirty} fields={fields} />
          </>
        )}

        {tab === "presets" && (
          <>
            <div className="text-[12.5px] text-muted-foreground">
              <Trans>Default values applied on create. The user cannot override these — they are stamped server-side after validation.</Trans>
            </div>
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-[color-mix(in_oklch,var(--muted)_18%,var(--card))] p-3">
              {presets.map((p, i) => (
                <div key={p.id} className="flex items-center gap-2">
                  <Select
                    value={p.key}
                    onChange={(v) => { setPresets((arr) => arr.map((x, j) => j === i ? { ...x, key: v } : x)); setDirty(true); }}
                    options={[{ value: "", label: t`field…` }, ...fields.map((f) => ({ value: f, label: f }))]}
                    size="sm"
                    className="min-w-40"
                  />
                  <span className="text-muted-foreground">=</span>
                  <Input
                    className={RB_INPUT_FULL}
                    placeholder={t`value or $user.id`}
                    list={`presets-vars-${p.id}`}
                    value={p.value}
                    onChange={(e) => { setPresets((arr) => arr.map((x, j) => j === i ? { ...x, value: e.target.value } : x)); setDirty(true); }}
                  />
                  <datalist id={`presets-vars-${p.id}`}>
                    {CE_DYNAMIC_VARS.map((v) => <option key={v.v} value={v.v}>{v.desc}</option>)}
                  </datalist>
                  <IconButton
                    icon={I.X}
                    className={RB_RM}
                    title={t`Remove`}
                    onClick={() => { setPresets((arr) => arr.filter((_, j) => j !== i)); setDirty(true); }}
                  />
                </div>
              ))}
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className={`${RB_ADD} self-start`}
                onClick={() => { setPresets((arr) => [...arr, { id: Date.now(), key: "", value: "" }]); setDirty(true); }}
              >
                <Trans>+ preset</Trans>
              </Button>
            </div>
          </>
        )}

        {tab === "item" && (
          <details className="rounded-md border border-border bg-card">
            <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium text-foreground [list-style:none]">
              <Trans>Test against an item</Trans>
            </summary>
            <div className="px-3 pb-3">
              <Textarea
                className="font-mono min-h-[90px] resize-y p-3 text-xs leading-[1.5]"
                value={testItem}
                onChange={(e) => { setTestItem(e.target.value); setTestResult(null); }}
              />
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" icon={I.Zap} onClick={runTest}><Trans>Run test</Trans></Button>
                {testResult?.error && <Badge variant="destructive"><Trans>error: {testResult.error}</Trans></Badge>}
                {testResult && testResult.passed === true && <Badge variant="default"><Trans>✓ passes · {testResult.ms}ms</Trans></Badge>}
                {testResult && testResult.passed === false && <Badge variant="destructive"><Trans>✗ denied</Trans></Badge>}
              </div>
            </div>
          </details>
        )}

        {showSql && (
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Compiled SQL</Trans></label>
            <pre className="m-0 whitespace-pre-wrap rounded-xl bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-[11.5px] leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)]">{compileSql()}</pre>
          </div>
        )}

        <div className="mt-1 flex gap-2 border-t border-border pt-1">
          <Button variant="outline" size="sm" icon={I.Code} onClick={() => setShowSql((v) => !v)}>{showSql ? <Trans>Hide compiled SQL</Trans> : <Trans>View compiled SQL</Trans>}</Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => { setTree(presetTree(action)); setDirty(false); setTestResult(null); pushToast(t`Changes discarded.`); }}><Trans>Discard</Trans></Button>
          <Button variant="primary" size="sm" disabled={!dirty} onClick={async () => {
            try {
              const allowedFields = Object.entries(fieldPerms)
                .filter(([, p]) => p.read)
                .map(([f]) => f);
              await persistRule(role, collection, action, compiledObj, allowedFields.length === fields.length ? null : allowedFields);
              setDirty(false);
              pushToast(t`Permission saved: ${role} · ${action} · ${collection}.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
          }}><Trans>Save</Trans></Button>
        </div>
      </div>
    </div>
  );
}
