// Shared visual filter/condition builder (AND/OR groups + leaf comparisons).
// Extracted from the permission editor so the collection field editor's
// Directus-style "Conditions" panel reuses the exact same builder + DSL codec.
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { I } from "./icons";
import { Button, IconButton } from "./ui";
import { Select } from "./select";

export const CE_OPS = [
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

export const CE_DYNAMIC_VARS = [
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

export type CondNode = { kind: "cond"; field: string; op: string; value: string };
export type GroupNode = { kind: "group"; op: "and" | "or"; children: TreeNode[] };
export type TreeNode = CondNode | GroupNode;

/** Compile a builder tree to the canonical Condition JSON the server speaks. */
export function ruleTreeToObj(node: TreeNode): unknown {
  if (node.kind === "group") {
    const key = node.op === "or" ? "$or" : "$and";
    return { [key]: node.children.map(ruleTreeToObj) };
  }
  if (!node.field) return {};
  if (node.op === "_null") return { [node.field]: { _null: true } };
  // The DSL has no `_nnull`; "is not null" is `_null: false` everywhere.
  if (node.op === "_nnull") return { [node.field]: { _null: false } };
  let val: unknown = node.value;
  if (node.op === "_in" || node.op === "_nin") {
    val = String(val || "").split(",").map((s) => s.trim()).filter(Boolean);
  } else if (val === "true") val = true;
  else if (val === "false") val = false;
  else if (val === "null") val = null;
  else if (!Number.isNaN(Number(val)) && val !== "" && !String(val).startsWith("$")) val = Number(val);
  return { [node.field]: { [node.op]: val } };
}

/** Parse a stored Condition object back into a builder tree (best-effort). */
export function objToTree(obj: unknown): GroupNode {
  const node = back(obj);
  return node.kind === "group" ? node : { kind: "group", op: "and", children: [node] };
}

function back(obj: any): TreeNode {
  if (obj && typeof obj === "object") {
    if (Array.isArray(obj.$and)) return { kind: "group", op: "and", children: obj.$and.map(back) };
    if (Array.isArray(obj.$or)) return { kind: "group", op: "or", children: obj.$or.map(back) };
    const entries = Object.entries(obj).filter(([k]) => !k.startsWith("$"));
    if (entries.length === 1 && entries[0]) {
      return leaf(entries[0][0], entries[0][1]);
    }
    if (entries.length > 1) {
      return { kind: "group", op: "and", children: entries.map(([f, o]) => leaf(f, o)) };
    }
  }
  return newCondition();
}

function leaf(field: string, ops: unknown): CondNode {
  const pair = Object.entries((ops as Record<string, unknown>) ?? {})[0] ?? ["_eq", ""];
  const [op, val] = pair as [string, unknown];
  // `_null: false` round-trips to the "is not null" operator.
  if (op === "_null" && val === false) return { kind: "cond", field, op: "_nnull", value: "" };
  const value = Array.isArray(val) ? (val as unknown[]).join(", ") : String(val ?? "");
  return { kind: "cond", field, op, value };
}

export function objToPretty(obj: unknown) {
  return JSON.stringify(obj, null, 2);
}

export function newCondition(): CondNode { return { kind: "cond", field: "", op: "_eq", value: "" }; }
export function newGroup(op: "and" | "or" = "and"): GroupNode { return { kind: "group", op, children: [newCondition()] }; }

/** True when a builder tree holds at least one real leaf (a picked field). */
export function treeHasRule(tree: GroupNode): boolean {
  return tree.children.some((c) => c.kind === "group" || (c.kind === "cond" && !!c.field));
}

// Shared rule-builder utility strings — replace the legacy .rb-* classes.
export const RB_RM = "inline-grid size-6 cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-destructive";
export const RB_ADD = "rounded-md border border-dashed border-border bg-transparent px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:border-ring hover:text-foreground";
export const RB_TOGGLE = "inline-flex overflow-hidden rounded-md border border-border bg-card";
export const RB_INPUT_COND = "h-7 w-full min-w-[120px] border-0 bg-transparent px-2 text-[12.5px] text-foreground outline-none";
export const RB_INPUT_FULL = "h-[30px] min-w-[120px] flex-1 rounded-md border border-border bg-card px-2.5 text-[12.5px] text-foreground outline-none focus:border-ring focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_30%,transparent)]";

export function RuleBuilder({ tree, onChange, fields }: { tree: GroupNode; onChange: (t: GroupNode) => void; fields: string[] }) {
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
      <div className="flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1.5">
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
