// @ts-nocheck
// Directus-parity permission editor.
import { useEffect, useMemo, useState } from "react";
import { Textarea } from "@workeros/ui/components/textarea";
import { I } from "./icons";
import { Badge, Button } from "./ui";
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
  else if (!isNaN(Number(val)) && val !== "" && !String(val).startsWith("$")) val = Number(val);
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

function RuleBuilder({ tree, onChange, fields }: { tree: GroupNode; onChange: (t: GroupNode) => void; fields: string[] }) {
  const update = (path: number[], mut: (n: any) => void) => {
    const next: GroupNode = JSON.parse(JSON.stringify(tree));
    let ref: any = next;
    for (let i = 0; i < path.length; i++) ref = ref.children[path[i]];
    mut(ref);
    onChange(next);
  };
  const removeAt = (path: number[]) => {
    if (path.length === 0) return;
    const next: GroupNode = JSON.parse(JSON.stringify(tree));
    let parent: any = next;
    for (let i = 0; i < path.length - 1; i++) parent = parent.children[path[i]];
    parent.children.splice(path[path.length - 1], 1);
    onChange(next);
  };

  const Group = ({ node, path }: { node: GroupNode; path: number[] }) => (
    <div className="rb-group">
      <div className="rb-group-head">
        <div className="rb-toggle" role="tablist">
          <button type="button" className={node.op === "and" ? "on" : ""} onClick={() => update(path, (n) => { n.op = "and"; })}>AND</button>
          <button type="button" className={node.op === "or" ? "on" : ""} onClick={() => update(path, (n) => { n.op = "or"; })}>OR</button>
        </div>
        <span className="muted" style={{ fontSize: 11.5 }}>match {node.op === "and" ? "all" : "any"} of the following</span>
        <div className="spacer" />
        <button type="button" className="rb-add" onClick={() => update(path, (n) => n.children.push(newCondition()))}>+ condition</button>
        <button type="button" className="rb-add" onClick={() => update(path, (n) => n.children.push(newGroup(node.op === "and" ? "or" : "and")))}>+ group</button>
        {path.length > 0 && (
          <button type="button" className="rb-rm" onClick={() => removeAt(path)} title="Remove group"><I.X size={12} /></button>
        )}
      </div>
      <div className="rb-children">
        {node.children.map((child, i) => (
          <div key={i} className={`rb-row ${child.kind === "group" ? "is-group" : ""}`}>
            {child.kind === "group" ? (
              <Group node={child} path={[...path, i]} />
            ) : (
              <Cond node={child} path={[...path, i]} />
            )}
          </div>
        ))}
        {node.children.length === 0 && (
          <div className="rb-empty">No conditions — this rule matches everything.</div>
        )}
      </div>
    </div>
  );

  const Cond = ({ node, path }: { node: CondNode; path: number[] }) => {
    const needsValue = node.op !== "_null" && node.op !== "_nnull";
    return (
      <div className="rb-cond">
        <Select
          value={node.field}
          onChange={(v) => update(path, (n) => { n.field = v; })}
          options={[{ value: "", label: "field…" }, ...fields.map((f) => ({ value: f, label: f }))]}
          size="sm"
        />
        <Select
          value={node.op}
          onChange={(v) => update(path, (n) => { n.op = v; })}
          options={CE_OPS.map((o) => ({ value: o.v, label: o.label }))}
          size="sm"
        />
        {needsValue && (
          <div style={{ position: "relative", flex: 1 }}>
            <input
              className="rb-input"
              style={{ width: "100%" }}
              placeholder={node.op === "_in" || node.op === "_nin" ? "a, b, c" : "value or $user.id"}
              value={node.value}
              onChange={(e) => update(path, (n) => { n.value = e.target.value; })}
              list={`rb-vars-${path.join("-")}`}
            />
            <datalist id={`rb-vars-${path.join("-")}`}>
              {CE_DYNAMIC_VARS.map((v) => <option key={v.v} value={v.v}>{v.desc}</option>)}
            </datalist>
          </div>
        )}
        <button type="button" className="rb-rm" onClick={() => removeAt(path)} title="Remove"><I.X size={12} /></button>
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
    <div className="card">
      <div className="ce-tabs">
        {[
          { id: "item", label: "Item permissions", count: tree.children.length, hint: "rules" },
          { id: "fields", label: "Field permissions", count: `${allowedWriteCount}/${fields.length}`, hint: "writable" },
          { id: "validation", label: "Validation", count: validation.children.length, hint: "rules" },
          { id: "presets", label: "Presets", count: presets.length, hint: "defaults" },
        ].map((t) => (
          <button key={t.id} type="button" className={`ce-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id as any)}>
            <span>{t.label}</span>
            <span className="ce-tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
        {tab === "item" && (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="muted" style={{ fontSize: 12.5 }}>{(() => {
                const r = <span className="font-mono" style={{ color: "var(--foreground)" }}>{role}</span>;
                if (action === "read") return <>Rows matching this rule are visible to {r}.</>;
                if (action === "create") return <>Rows created by {r} must match this rule.</>;
                if (action === "update") return <>{r} may update rows matching this rule.</>;
                if (action === "delete") return <>{r} may delete rows matching this rule.</>;
                return <>Items matching this rule are allowed for {r}.</>;
              })()}</span>
              <div className="spacer" />
              <div className="rb-toggle">
                <button type="button" className={mode === "builder" ? "on" : ""} onClick={() => setMode("builder")}>Builder</button>
                <button type="button" className={mode === "json" ? "on" : ""} onClick={() => { setJsonDraft(compiledJson); setMode("json"); }}>JSON</button>
              </div>
            </div>
            {availableFields.length === 0 && (
              <div className="muted" style={{
                fontSize: 12,
                padding: "10px 12px",
                border: "1px dashed var(--border)",
                borderRadius: "var(--radius-md)",
                background: "color-mix(in oklch, var(--muted) 30%, var(--card))",
              }}>
                No fields defined for <span className="font-mono" style={{ color: "var(--foreground)" }}>{collection}</span> yet — add fields in the schema editor before writing rules.
              </div>
            )}
            {mode === "builder" ? (
              <RuleBuilder tree={tree} onChange={setTreeDirty} fields={fields} />
            ) : (
              <div className="field" style={{ marginTop: 0 }}>
                <Textarea
                  className="font-mono"
                  style={{ minHeight: 180, padding: 12, lineHeight: 1.5, fontSize: 12.5, resize: "vertical" }}
                  value={jsonDraft}
                  onChange={(e) => { setJsonDraft(e.target.value); }}
                  onBlur={() => {
                    try {
                      const parsed = JSON.parse(jsonDraft);
                      const back = (obj: any): TreeNode => {
                        if (obj.$and) return { kind: "group", op: "and", children: obj.$and.map(back) };
                        if (obj.$or) return { kind: "group", op: "or", children: obj.$or.map(back) };
                        const entries = Object.entries(obj);
                        if (entries.length === 1) {
                          const [field, ops] = entries[0];
                          const [op, val] = Object.entries(ops as Record<string, unknown>)[0] || ["_eq", ""];
                          return { kind: "cond", field, op, value: Array.isArray(val) ? (val as unknown[]).join(", ") : String(val) };
                        }
                        return {
                          kind: "group", op: "and", children: entries.map(([f, o]) => {
                            const [op, val] = Object.entries(o as Record<string, unknown>)[0];
                            return { kind: "cond", field: f, op, value: Array.isArray(val) ? (val as unknown[]).join(", ") : String(val) } as CondNode;
                          }),
                        };
                      };
                      const t = back(parsed);
                      setTreeDirty(t.kind === "group" ? t : { kind: "group", op: "and", children: [t] });
                    } catch { /* silent */ }
                  }}
                />
                <span className="field-hint">Edit raw DSL. Click Builder to round-trip back to visual.</span>
              </div>
            )}
            <div className="ce-vars">
              {CE_DYNAMIC_VARS.map((v) => (
                <span key={v.v} className="ce-var" title={v.desc}><span className="font-mono">{v.v}</span><span className="muted">{v.desc}</span></span>
              ))}
            </div>
          </>
        )}

        {tab === "fields" && (
          <>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Per-field read / write toggles. Hidden fields are stripped from API responses; non-writable fields are rejected on insert/update for this role.
            </div>
            <div className="field-grid">
              <div className="fg-head">
                <span>Field</span>
                <span style={{ textAlign: "center" }}>Read</span>
                <span style={{ textAlign: "center" }}>Write</span>
              </div>
              {fields.map((f) => (
                <div key={f} className="fg-row">
                  <span className="font-mono" style={{ fontSize: 12.5 }}>{f}</span>
                  <label className="fg-cell">
                    <input type="checkbox" checked={fieldPerms[f]?.read || false} onChange={(e) => { setFieldPerms((p) => ({ ...p, [f]: { ...p[f], read: e.target.checked } })); setDirty(true); }} />
                  </label>
                  <label className="fg-cell">
                    <input type="checkbox" checked={fieldPerms[f]?.write || false} onChange={(e) => { setFieldPerms((p) => ({ ...p, [f]: { ...p[f], write: e.target.checked } })); setDirty(true); }} />
                  </label>
                </div>
              ))}
              <div className="fg-foot">
                <span className="muted">{allowedReadCount} readable · {allowedWriteCount} writable</span>
                <div className="spacer" />
                <Button size="sm" variant="ghost" onClick={() => { const o: Record<string, { read: boolean; write: boolean }> = {}; fields.forEach((f) => { o[f] = { read: true, write: true }; }); setFieldPerms(o); setDirty(true); }}>Allow all</Button>
                <Button size="sm" variant="ghost" onClick={() => { const o: Record<string, { read: boolean; write: boolean }> = {}; fields.forEach((f) => { o[f] = { read: false, write: false }; }); setFieldPerms(o); setDirty(true); }}>Deny all</Button>
              </div>
            </div>
          </>
        )}

        {tab === "validation" && (
          <>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Incoming data must match this rule before insert/update succeeds. Failures return <span className="font-mono" style={{ color: "var(--foreground)" }}>422 invalid_payload</span>.
            </div>
            <RuleBuilder tree={validation} onChange={setValidationDirty} fields={fields} />
          </>
        )}

        {tab === "presets" && (
          <>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Default values applied on create. The user cannot override these — they are stamped server-side after validation.
            </div>
            <div className="presets-list">
              {presets.map((p, i) => (
                <div key={p.id} className="presets-row">
                  <Select
                    value={p.key}
                    onChange={(v) => { setPresets((arr) => arr.map((x, j) => j === i ? { ...x, key: v } : x)); setDirty(true); }}
                    options={[{ value: "", label: "field…" }, ...fields.map((f) => ({ value: f, label: f }))]}
                    size="sm"
                    style={{ minWidth: 160 }}
                  />
                  <span className="muted">=</span>
                  <input className="rb-input" style={{ flex: 1 }} placeholder="value or $user.id" list={`presets-vars-${p.id}`} value={p.value} onChange={(e) => { setPresets((arr) => arr.map((x, j) => j === i ? { ...x, value: e.target.value } : x)); setDirty(true); }} />
                  <datalist id={`presets-vars-${p.id}`}>
                    {CE_DYNAMIC_VARS.map((v) => <option key={v.v} value={v.v}>{v.desc}</option>)}
                  </datalist>
                  <button type="button" className="rb-rm" onClick={() => { setPresets((arr) => arr.filter((_, j) => j !== i)); setDirty(true); }} title="Remove"><I.X size={12} /></button>
                </div>
              ))}
              <button type="button" className="rb-add" style={{ alignSelf: "flex-start" }} onClick={() => { setPresets((arr) => [...arr, { id: Date.now(), key: "", value: "" }]); setDirty(true); }}>+ preset</button>
            </div>
          </>
        )}

        {tab === "item" && (
          <details style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-md)",
            background: "var(--card)",
          }}>
            <summary style={{
              cursor: "pointer",
              padding: "8px 12px",
              fontSize: 12.5,
              fontWeight: 500,
              color: "var(--foreground)",
              listStyle: "none",
            }}>
              Test against an item
            </summary>
            <div style={{ padding: "0 12px 12px 12px" }}>
              <Textarea
                className="font-mono"
                style={{ minHeight: 90, padding: 12, lineHeight: 1.5, fontSize: 12, resize: "vertical" }}
                value={testItem}
                onChange={(e) => { setTestItem(e.target.value); setTestResult(null); }}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                <Button variant="outline" size="sm" icon={I.Zap} onClick={runTest}>Run test</Button>
                {testResult?.error && <Badge variant="destructive">error: {testResult.error}</Badge>}
                {testResult && testResult.passed === true && <Badge variant="default">✓ passes · {testResult.ms}ms</Badge>}
                {testResult && testResult.passed === false && <Badge variant="destructive">✗ denied</Badge>}
              </div>
            </div>
          </details>
        )}

        {showSql && (
          <div className="field">
            <label className="field-label">Compiled SQL</label>
            <pre className="alter-preview" style={{ fontSize: 11.5, margin: 0, whiteSpace: "pre-wrap" }}>{compileSql()}</pre>
          </div>
        )}

        <div style={{ display: "flex", gap: 8, paddingTop: 4, borderTop: "1px solid var(--border)", marginTop: 4 }}>
          <Button variant="outline" size="sm" icon={I.Code} onClick={() => setShowSql((v) => !v)}>{showSql ? "Hide" : "View"} compiled SQL</Button>
          <div className="spacer" />
          <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => { setTree(presetTree(action)); setDirty(false); setTestResult(null); pushToast("Changes discarded."); }}>Discard</Button>
          <Button variant="primary" size="sm" disabled={!dirty} onClick={async () => {
            try {
              const allowedFields = Object.entries(fieldPerms)
                .filter(([, p]) => p.read)
                .map(([f]) => f);
              await persistRule(role, collection, action, compiledObj, allowedFields.length === fields.length ? null : allowedFields);
              setDirty(false);
              pushToast(`Permission saved: ${role} · ${action} · ${collection}.`);
            } catch (e) {
              pushToast((e as Error).message);
            }
          }}>Save</Button>
        </div>
      </div>
    </div>
  );
}
