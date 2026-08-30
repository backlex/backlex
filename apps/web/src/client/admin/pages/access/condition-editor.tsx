// No-code permission editor.
//
// One rule governs this screen: everything it shows is either read from the
// permission row being edited or written back to it. That used to be false in
// three separate ways, and each one was worse than a missing feature because an
// operator acted on it.
//
//  - The editor opened on a hard-coded template regardless of what was stored,
//    so "Edit rule" on a live rule showed a fabricated one — and Save then
//    replaced the real rule with the fabrication.
//  - Two of its four tabs (Validation, Presets) collected input that no request
//    ever carried, while their copy described concrete server behaviour
//    ("Failures return 422 invalid_payload", "stamped server-side after
//    validation") that does not exist anywhere in the product.
//  - The field table offered a Write column that was counted, badged, and then
//    dropped on the floor: only the READ set is sent, as the `fields`
//    allow-list, which is the only per-field control the server has.
//
// What is left is the two things that do persist — the condition DSL and the
// readable-field allow-list — plus a preview that says, in its own copy, that
// it runs in the browser and is not what the server enforces.
import type { PushToast } from "../../types";
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@backlex/ui/components/collapsible";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { Textarea } from "@backlex/ui/components/textarea";
import { useIsMobile } from "@backlex/ui/hooks/use-mobile";
import { I } from "../../icons";
import { Badge, Button, Checkbox } from "../../ui";
import { api } from "@/lib/api";
import type { RoleData } from "./role-editor";
import {
  CE_DYNAMIC_VARS,
  type CondNode,
  type GroupNode,
  objToPretty,
  objToTree,
  RB_TOGGLE,
  RuleBuilder,
  ruleTreeToObj,
  treeHasRule,
  type TreeNode,
} from "../../rule-builder";

/** A `permissions` row as `GET /api/roles/:id/permissions` returns it. Both
 *  JSON columns come back parsed — `fields` is the readable allow-list
 *  (`null` = every field), `condition` the DSL (`null` = no condition). */
interface StoredPermission {
  id: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
}

const persistRule = async (
  roleId: string,
  collection: string,
  action: string,
  condition: unknown,
  fields: string[] | null,
): Promise<void> => {
  const perms = await api<{ data: StoredPermission[] }>(`/api/roles/${roleId}/permissions`);
  const existing = perms.data.find(
    (p) => p.collection === collection && p.action === action,
  );
  if (existing) await api(`/api/permissions/${existing.id}`, { method: "DELETE" });
  await api(`/api/roles/${roleId}/permissions`, {
    method: "POST",
    body: JSON.stringify({ collection, action, fields, condition }),
  });
};

// Rule-builder primitives (types, DSL codec, the visual builder, shared class
// tokens + variable list) live in ./rule-builder so the field editor reuses them.

/** The starting point offered when this (role, collection, action) has no rule
 *  stored yet. Only ever used for a permission the operator is writing from
 *  scratch — never over the top of something the server already holds. */
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

/** A rule row that exists with no condition: every row in the collection
 *  matches. Rendered as an empty group, which is exactly what the builder says
 *  ("No conditions — this rule matches everything") and what compiles back to
 *  `null` on save. */
const unrestrictedTree = (): GroupNode => ({ kind: "group", op: "and", children: [] });

/** Where the rule on screen came from. Shown to the operator verbatim, because
 *  "this is a suggestion" and "this is your live rule" must never look alike. */
type RuleOrigin = "stored" | "unrestricted" | "preset";

const allVisible = (fields: string[]): Record<string, boolean> =>
  Object.fromEntries(fields.map((f) => [f, true]));

/** The stored `fields` allow-list projected onto the collection's current
 *  fields. `null` means "no restriction", so everything is readable. */
const visibleFromStored = (fields: string[], stored: string[] | null): Record<string, boolean> => {
  if (!Array.isArray(stored)) return allVisible(fields);
  return Object.fromEntries(fields.map((f) => [f, stored.includes(f)]));
};

/** Dynamic variables the browser preview can stand in for. The server resolves
 *  these from the real caller; here they are a fixed stub, spelled out on
 *  screen so a passing preview is never mistaken for a passing request. */
const PREVIEW_VARS: Record<string, unknown> = {
  "$user.id": "usr_preview",
  "$user.email": "preview@example.test",
  "$user.roles": ["preview"],
  "$tenant.id": "tnt_preview",
  "$org.id": "org_preview",
  "$org.role": "member",
  "$user.orgs": ["org_preview"],
};

export interface ConditionEditorProps {
  role: string;
  action: string;
  collection: string;
  roles: RoleData[];
  pushToast: PushToast;
  availableFields: string[];
}

export function ConditionEditor({ role, action, collection, roles, pushToast, availableFields }: ConditionEditorProps) {
  const { t } = useLingui();
  // Below the shared mobile breakpoint the tab strip and the rule rows compete
  // for the same ~350 usable pixels inside the dialog, so the two sections
  // become an accordion instead: one column, both reachable, nothing clipped.
  const isMobile = useIsMobile();
  const [section, setSection] = useState<"item" | "fields">("item");
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ item: true, fields: false });
  const [mode, setMode] = useState<"builder" | "json">("builder");

  const [tree, setTree] = useState<GroupNode>(() => presetTree(action));
  const [visible, setVisible] = useState<Record<string, boolean>>(() => allVisible(availableFields));
  // The state as loaded. Discard restores THIS, not the template — discarding
  // an edit must never be a way to lose the rule that was on the server.
  const [baseline, setBaseline] = useState<{ tree: GroupNode; visible: Record<string, boolean> }>(
    () => ({ tree: presetTree(action), visible: allVisible(availableFields) }),
  );
  const [origin, setOrigin] = useState<RuleOrigin>("preset");
  const [roleId, setRoleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);

  const [jsonDraft, setJsonDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [previewRow, setPreviewRow] = useState('{\n  "id": "01HZ7K8M9NPQ",\n  "owner_id": "usr_preview",\n  "status": "published",\n  "title": "Drizzle 1.0 in production"\n}');
  const [previewResult, setPreviewResult] = useState<{ passed?: boolean; error?: string } | null>(null);
  const [showSql, setShowSql] = useState(false);

  const fields = availableFields;
  // A stable dependency for the load effect: the prop array is rebuilt by the
  // parent on every render, so depending on it directly would refetch forever.
  const fieldsKey = fields.join(" ");
  const knownRoleId = useMemo(() => roles.find((r) => r.name === role)?.id ?? null, [roles, role]);

  // Read the rule that is actually stored for this (role, collection, action).
  // Everything below renders what this puts in state; nothing invents a rule
  // except the `preset` branch, which only fires when there is no row at all.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setDirty(false);
    setPreviewResult(null);
    setMode("builder");
    (async () => {
      try {
        let id = knownRoleId;
        if (!id) {
          const res = await api<{ data: { id: string; name: string }[] }>("/api/roles");
          id = res.data.find((r) => r.name === role)?.id ?? null;
        }
        if (!id) throw new Error(`Role "${role}" not found`);
        const perms = await api<{ data: StoredPermission[] }>(`/api/roles/${id}/permissions`);
        if (cancelled) return;
        const row = (perms.data ?? []).find(
          (p) => p.collection === collection && p.action === action,
        );
        const cond = row?.condition;
        const hasCondition =
          cond != null && typeof cond === "object" && Object.keys(cond as object).length > 0;
        const nextTree = hasCondition
          ? objToTree(cond)
          : row
            ? unrestrictedTree()
            : presetTree(action);
        const nextVisible = row
          ? visibleFromStored(fields, row.fields)
          : allVisible(fields);
        setRoleId(id);
        setTree(nextTree);
        setVisible(nextVisible);
        setBaseline({ tree: nextTree, visible: nextVisible });
        setOrigin(hasCondition ? "stored" : row ? "unrestricted" : "preset");
      } catch (e) {
        if (!cancelled) setLoadError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [role, action, collection, knownRoleId, fieldsKey, reloadKey]);

  useEffect(() => {
    if (mode === "json") setJsonDraft(objToPretty(ruleTreeToObj(tree)));
  }, [mode]);

  const compiledObj = useMemo(() => ruleTreeToObj(tree), [tree]);
  const compiledJson = useMemo(() => objToPretty(compiledObj), [compiledObj]);
  // A rule with no leaf compiles to no condition at all — the row stays, and
  // every item in the collection matches it.
  const conditionToSave = useMemo(() => (treeHasRule(tree) ? compiledObj : null), [tree, compiledObj]);

  const visibleCount = fields.filter((f) => visible[f]).length;

  /** The WHERE fragment this rule compiles to. Deliberately NOT dressed up as a
   *  full statement: the physical table is `c_<tenantPrefix12>_<slug>`, which
   *  this screen does not know, and printing `SELECT * FROM c_<slug>` invented a
   *  table name that exists nowhere. */
  const compileWhere = () => {
    const walk = (node: any): string => {
      if (node.$and) return "(" + node.$and.map(walk).join(" AND ") + ")";
      if (node.$or) return "(" + node.$or.map(walk).join(" OR ") + ")";
      const out: string[] = [];
      for (const [k, v] of Object.entries(node)) {
        if (k.startsWith("$")) continue;
        if (v && typeof v === "object") {
          for (const [op, val] of Object.entries(v as Record<string, unknown>)) {
            // `_null` carries its polarity in the VALUE (`{_null:false}` is
            // "is not null"), so reading only the operator printed the
            // inverse of the rule the operator had just built.
            if (op === "_null") { out.push(`${k} ${val === false ? "IS NOT NULL" : "IS NULL"}`); continue; }
            const sqlOp = ({ _eq: "=", _neq: "!=", _gt: ">", _gte: ">=", _lt: "<", _lte: "<=", _in: "IN", _nin: "NOT IN", _contains: "LIKE", _starts_with: "LIKE" } as Record<string, string>)[op] || op;
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
    if (conditionToSave == null) return "-- no condition: every row matches";
    return walk(conditionToSave);
  };

  const runPreview = () => {
    try {
      const item = JSON.parse(previewRow);
      const resolve = (val: unknown): unknown =>
        typeof val === "string" && val.startsWith("$") && val in PREVIEW_VARS
          ? PREVIEW_VARS[val]
          : val;
      const evalNode = (node: any): boolean => {
        if (node.$and) return node.$and.every(evalNode);
        if (node.$or) return node.$or.some(evalNode);
        for (const [k, v] of Object.entries(node)) {
          if (k.startsWith("$")) continue;
          for (const [op, raw] of Object.entries(v as Record<string, unknown>)) {
            const left = item[k];
            const val = resolve(raw);
            if (op === "_eq" && left !== val) return false;
            if (op === "_neq" && left === val) return false;
            if (op === "_gt" && !((left as any) > (val as any))) return false;
            if (op === "_gte" && !((left as any) >= (val as any))) return false;
            if (op === "_lt" && !((left as any) < (val as any))) return false;
            if (op === "_lte" && !((left as any) <= (val as any))) return false;
            if (op === "_in" && !(Array.isArray(val) ? val : [val]).includes(left)) return false;
            if (op === "_nin" && (Array.isArray(val) ? val : [val]).includes(left)) return false;
            if (op === "_null" && (val === false ? left == null : left != null)) return false;
            if (op === "_contains" && !String(left ?? "").includes(String(val))) return false;
            if (op === "_starts_with" && !String(left ?? "").startsWith(String(val))) return false;
          }
        }
        return true;
      };
      setPreviewResult({ passed: conditionToSave == null ? true : evalNode(conditionToSave) });
    } catch (e: any) {
      setPreviewResult({ error: e.message });
    }
  };

  const setTreeDirty = (next: GroupNode) => { setTree(next); setDirty(true); setPreviewResult(null); };

  const discard = () => {
    setTree(baseline.tree);
    setVisible(baseline.visible);
    setDirty(false);
    setPreviewResult(null);
    pushToast(t`Changes discarded.`);
  };

  const save = async () => {
    if (!roleId) return;
    setSaving(true);
    try {
      const allowed = fields.filter((f) => visible[f]);
      await persistRule(
        roleId,
        collection,
        action,
        conditionToSave,
        allowed.length === fields.length ? null : allowed,
      );
      setBaseline({ tree, visible });
      setOrigin(conditionToSave == null ? "unrestricted" : "stored");
      setDirty(false);
      pushToast(t`Permission saved: ${role} · ${action} · ${collection}.`);
    } catch (e) {
      // Nothing to roll back — the form still holds what the operator typed,
      // which is the state they need in order to try again.
      pushToast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const originNote =
    origin === "stored"
      ? <Trans>Showing the rule stored for this role, action and collection.</Trans>
      : origin === "unrestricted"
        ? <Trans>This permission is saved with no condition — every row matches. Add conditions to narrow it.</Trans>
        : <Trans>Nothing is stored for this combination yet. The rule below is a starting suggestion; it is not in effect until you save.</Trans>;

  const sections = [
    { id: "item" as const, label: t`Item permissions`, count: String(tree.children.length), hint: t`rules` },
    { id: "fields" as const, label: t`Field permissions`, count: `${visibleCount}/${fields.length}`, hint: t`readable` },
  ];

  const itemPanel = (
    <div className="flex min-w-0 flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 text-[12.5px] text-muted-foreground">{(() => {
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
      <div className="rounded-surface border border-dashed border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-3 py-2.5 text-xs text-muted-foreground">
        {originNote}
      </div>
      {availableFields.length === 0 && (
        <div className="rounded-surface border border-dashed border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-3 py-2.5 text-xs text-muted-foreground">
          <Trans>No fields defined for <span className="font-mono text-foreground">{collection}</span> yet — add fields in the schema editor before writing rules.</Trans>
        </div>
      )}
      {mode === "builder" ? (
        // Below `sm` a rule row has no room for field + operator + value side by
        // side, so each control is widened to the full row and the builder's own
        // `flex-wrap` does the stacking. It is done from here rather than inside
        // RuleBuilder because the same builder is embedded in wider surfaces
        // (the field editor's Conditions panel) that do not need it.
        <div className="min-w-0 max-[639px]:[&_[data-slot=select-trigger]]:w-full">
          <RuleBuilder tree={tree} onChange={setTreeDirty} fields={fields} />
        </div>
      ) : (
        <div className="flex min-w-0 flex-col gap-1.5">
          {/* The raw DSL is the one block that can be arbitrarily wide. A
              textarea scrolls its own content, so the dialog never grows a
              horizontal scrollbar of its own on a narrow screen. */}
          <Textarea
            className="font-mono min-h-[180px] w-full resize-y overflow-auto p-3 text-[12.5px] leading-[1.5]"
            aria-label={t`Condition DSL`}
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
                const parsedTree = back(parsed);
                setTreeDirty(parsedTree.kind === "group" ? parsedTree : { kind: "group", op: "and", children: [parsedTree] });
              } catch { /* silent */ }
            }}
          />
          <span className="text-[11.5px] text-muted-foreground"><Trans>Edit raw DSL. Click Builder to round-trip back to visual.</Trans></span>
        </div>
      )}
      <div className="flex flex-wrap gap-1 rounded-control border border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] p-1.5">
        {CE_DYNAMIC_VARS.map((v) => (
          <span key={v.v} className="inline-flex max-w-full items-center gap-[5px] rounded-full border border-border bg-card px-[7px] py-0.5 text-[11px]" title={v.desc}><span className="font-mono">{v.v}</span><span className="min-w-0 truncate text-muted-foreground">{v.desc}</span></span>
        ))}
      </div>

      <details className="rounded-control border border-border bg-card">
        <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-medium text-foreground [list-style:none]">
          <Trans>Preview against a row</Trans>
        </summary>
        <div className="px-3 pb-3">
          <div className="mb-2 text-[11.5px] text-muted-foreground">
            <Trans>
              Evaluated in your browser against the rule as it stands here — not
              a request, and not proof of what the server will do. Dynamic
              variables are stubbed: <span className="font-mono text-foreground">$user.id</span> is{" "}
              <span className="font-mono text-foreground">usr_preview</span>. Use the Permission tester
              for a real decision from the server.
            </Trans>
          </div>
          <Textarea
            className="font-mono min-h-[90px] w-full resize-y overflow-auto p-3 text-xs leading-[1.5]"
            aria-label={t`Sample row`}
            value={previewRow}
            onChange={(e) => { setPreviewRow(e.target.value); setPreviewResult(null); }}
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" icon={I.Zap} onClick={runPreview}><Trans>Run preview</Trans></Button>
            {previewResult?.error && <Badge variant="destructive"><Trans>error: {previewResult.error}</Trans></Badge>}
            {previewResult && previewResult.passed === true && <Badge variant="default"><Trans>row matches the rule</Trans></Badge>}
            {previewResult && previewResult.passed === false && <Badge variant="destructive"><Trans>row does not match</Trans></Badge>}
          </div>
        </div>
      </details>
    </div>
  );

  const fieldsPanel = (
    <div className="flex min-w-0 flex-col gap-3.5">
      <div className="text-[12.5px] text-muted-foreground">
        {/* One list, and what it does depends on the action this rule is for —
            the server stores a single `fields` allow-list per (role, collection,
            action) row. Saying so is the point: the Write column that used to
            sit here could never have been saved, because there is nowhere to
            put it. */}
        {action === "read" ? (
          <Trans>Unchecked fields are stripped from this role's API responses.</Trans>
        ) : action === "create" || action === "update" ? (
          <Trans>This role may only send the checked fields — a payload touching any other is refused with "No permission to write field".</Trans>
        ) : (
          <Trans>Stored on this rule, but only read, create and update consult the list; it does not change what {action} does.</Trans>
        )}
      </div>
      <div className="overflow-hidden rounded-control border border-border bg-card">
        <div className="grid grid-cols-[minmax(0,1fr)_88px] items-center border-b border-border bg-[color-mix(in_oklch,var(--muted)_40%,var(--card))] px-3.5 py-2 text-[11.5px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
          <span><Trans>Field</Trans></span>
          <span className="text-center"><Trans>Readable</Trans></span>
        </div>
        {fields.map((f) => (
          <div key={f} className="grid grid-cols-[minmax(0,1fr)_88px] items-center px-3.5 py-2 text-[12.5px] [&+&]:border-t [&+&]:border-border">
            <span className="truncate font-mono text-[12.5px]">{f}</span>
            <label className="grid cursor-pointer place-items-center">
              <Checkbox
                checked={visible[f] ?? false}
                onChange={(next) => { setVisible((p) => ({ ...p, [f]: next })); setDirty(true); }}
              />
            </label>
          </div>
        ))}
        {fields.length === 0 && (
          <div className="px-3.5 py-4 text-center text-xs text-muted-foreground">
            <Trans>This collection has no fields yet.</Trans>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))] px-3.5 py-2 text-[12.5px]">
          <span className="text-muted-foreground"><Trans>{visibleCount} of {fields.length} readable</Trans></span>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => { setVisible(allVisible(fields)); setDirty(true); }}><Trans>Allow all</Trans></Button>
          <Button size="sm" variant="ghost" onClick={() => { setVisible(Object.fromEntries(fields.map((f) => [f, false]))); setDirty(true); }}><Trans>Deny all</Trans></Button>
        </div>
      </div>
    </div>
  );

  const panelFor = (id: "item" | "fields") => (id === "item" ? itemPanel : fieldsPanel);

  if (loading) {
    return (
      <Card className="gap-0 py-0">
        <div className="flex flex-col gap-3 p-4" aria-busy="true">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </Card>
    );
  }

  if (loadError) {
    // Refusing to render the editor here is the point: with the stored rule
    // unread, every control below would be a template, and Save would overwrite
    // a live rule with one nobody chose.
    return (
      <Card className="gap-0 py-0">
        <div className="flex flex-col items-start gap-2.5 p-4">
          <Badge variant="destructive"><Trans>Could not read the stored rule</Trans></Badge>
          <span className="text-[12.5px] text-muted-foreground">
            <Trans>
              {loadError} — nothing is shown rather than a made-up rule, because
              saving one would replace whatever the server currently holds.
            </Trans>
          </span>
          <Button variant="outline" size="sm" onClick={() => setReloadKey((k) => k + 1)}><Trans>Try again</Trans></Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="min-w-0 gap-0 py-0">
      {isMobile ? (
        <div className="flex min-w-0 flex-col">
          {sections.map((s) => (
            <Collapsible
              key={s.id}
              open={openSections[s.id] ?? false}
              onOpenChange={(next) => setOpenSections((o) => ({ ...o, [s.id]: next }))}
              className="min-w-0 border-b border-border"
            >
              <CollapsibleTrigger className="flex w-full cursor-pointer items-center gap-2 bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))] px-3.5 py-2.5 text-left text-[12.5px] font-medium text-foreground">
                <I.ChevronDown size={13} className={openSections[s.id] ? "" : "-rotate-90"} />
                <span className="min-w-0 truncate">{s.label}</span>
                <div className="flex-1" />
                <span className="rounded-full bg-muted px-1.5 py-px font-mono text-[11px] text-muted-foreground">{s.count}</span>
                <span className="text-[11px] text-muted-foreground">{s.hint}</span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="min-w-0 p-3.5">{panelFor(s.id)}</div>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </div>
      ) : (
        <>
          <ScrollArea className="border-b border-border bg-[color-mix(in_oklch,var(--muted)_25%,var(--card))]">
            {/* `data-slot` rather than a role: these are toggle buttons with
                `aria-pressed`, not ARIA tabs, and the rule builder's own AND/OR
                toggle already carries `role="tablist"` — a test that looked for
                one found that instead. */}
            <div className="flex gap-1 px-3.5" data-slot="section-tabs">
              {sections.map((s) => {
                const on = section === s.id;
                return (
                  <Button
                    key={s.id}
                    type="button"
                    variant="ghost"
                    size="xs"
                    className={`-mb-px inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-none border-0 border-b-2 bg-transparent px-3.5 py-2.5 text-[12.5px] font-medium hover:text-foreground ${on ? "border-b-primary text-foreground" : "border-b-transparent text-muted-foreground"}`}
                    aria-pressed={on}
                    onClick={() => setSection(s.id)}
                  >
                    <span>{s.label}</span>
                    <span className={`rounded-full px-1.5 py-px font-mono text-[11px] ${on ? "bg-[color-mix(in_oklch,var(--primary)_18%,transparent)] text-primary" : "bg-muted text-muted-foreground"}`}>{s.count}</span>
                  </Button>
                );
              })}
            </div>
          </ScrollArea>
          <div className="min-w-0 p-4">{panelFor(section)}</div>
        </>
      )}

      <div className="flex min-w-0 flex-col gap-3.5 p-4">
        {showSql && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Compiled WHERE clause</Trans></label>
            {/* Its own scroll container: a long clause must scroll here rather
                than widen the dialog and take the page sideways with it. */}
            <ScrollArea className="rounded-control">
              <pre className="m-0 whitespace-pre rounded-control bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-[11.5px] leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)]">{compileWhere()}</pre>
            </ScrollArea>
          </div>
        )}

        <div className="flex flex-wrap gap-2 border-t border-border pt-2.5">
          <Button variant="outline" size="sm" icon={I.Code} onClick={() => setShowSql((v) => !v)}>{showSql ? <Trans>Hide compiled WHERE</Trans> : <Trans>View compiled WHERE</Trans>}</Button>
          <div className="flex-1" />
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={discard}><Trans>Discard</Trans></Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={save}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </div>
      </div>
    </Card>
  );
}
