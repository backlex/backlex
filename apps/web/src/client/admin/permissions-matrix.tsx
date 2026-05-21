// @ts-nocheck
// Directus-parity permission matrix
import { Fragment, useEffect, useMemo, useState } from "react";
import { I } from "./icons";
import { Badge, IconButton } from "./ui";
import { Tabs, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@workeros/ui/components/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";
import { api } from "@/lib/api";
import type { RoleData } from "./role-editor";
import { ConditionEditor } from "./condition-editor";
import { useCollections } from "./queries";

const persistMatrixCell = async (
  roleName: string,
  collection: string,
  action: string,
  state: "all" | "none" | "custom",
): Promise<void> => {
  // Look up role id + the permission row for this (role, collection, action),
  // then POST a new one or DELETE the existing one based on the picked state.
  const rolesRes = await api<{ data: { id: string; name: string }[] }>("/api/roles");
  const role = rolesRes.data.find((r) => r.name === roleName);
  if (!role) throw new Error(`Role "${roleName}" not found`);

  const perms = await api<{ data: { id: string; collection: string; action: string }[] }>(
    `/api/roles/${role.id}/permissions`,
  );
  const existing = perms.data.find(
    (p) => p.collection === collection && p.action === action,
  );

  if (state === "all") {
    // Unrestricted: ensure a row with no condition exists.
    if (existing) {
      await api(`/api/permissions/${existing.id}`, { method: "DELETE" });
    }
    await api(`/api/roles/${role.id}/permissions`, {
      method: "POST",
      body: JSON.stringify({
        collection,
        action,
        fields: null,
        condition: null,
      }),
    });
    return;
  }

  if (state === "none") {
    // Just drop the row; absence = denied.
    if (existing) {
      await api(`/api/permissions/${existing.id}`, { method: "DELETE" });
    }
    return;
  }

  // 'custom' — leave a row with a placeholder condition; the ConditionEditor
  // overwrites the actual rule on save.
  if (existing) {
    await api(`/api/permissions/${existing.id}`, { method: "DELETE" });
  }
  await api(`/api/roles/${role.id}/permissions`, {
    method: "POST",
    body: JSON.stringify({
      collection,
      action,
      fields: null,
      condition: { owner_id: { _eq: "$user.id" } },
    }),
  });
};

const PM_ACTIONS = [
  { v: "create", label: "C", title: "Create" },
  { v: "read", label: "R", title: "Read" },
  { v: "update", label: "U", title: "Update" },
  { v: "delete", label: "D", title: "Delete" },
];

type CellState = "all" | "none" | "custom";

type Matrix = Record<string, Record<string, Record<string, CellState>>>;

function defaultRow(roleName: string): Record<string, CellState> {
  if (roleName === "admin") return { create: "all", read: "all", update: "all", delete: "all" };
  if (roleName === "public") return { create: "none", read: "none", update: "none", delete: "none" };
  if (roleName === "authenticated") return { create: "none", read: "none", update: "none", delete: "none" };
  return { create: "none", read: "none", update: "none", delete: "none" };
}

function emptyMatrix(roles: RoleData[], collections: string[]): Matrix {
  const out: Matrix = {};
  for (const r of roles) {
    out[r.name] = {};
    for (const c of collections) out[r.name][c] = defaultRow(r.name);
  }
  return out;
}

function cellSummary(state: CellState, action: string, collection: string) {
  if (state === "all") return "Full access — no condition.";
  if (state === "none") return "No access — denied for this role.";
  if (action === "read") return collection === "posts" ? 'Where status = "published" OR owner_id = $user.id' : "Where owner_id = $user.id";
  if (action === "create") return "Stamps owner_id = $user.id on insert";
  if (action === "update") return 'Where owner_id = $user.id AND status ≠ "archived"';
  return "Where owner_id = $user.id";
}

function CellGlyph({ state }: { state: CellState }) {
  const variant =
    state === "all"
      ? "bg-[color-mix(in_oklch,oklch(from_var(--primary)_0.72_0.18_h)_22%,transparent)] text-[oklch(from_var(--primary)_0.42_0.16_h)]"
      : state === "none"
        ? "bg-[color-mix(in_oklch,var(--muted)_80%,transparent)] text-muted-foreground"
        : "bg-[color-mix(in_oklch,oklch(0.78_0.16_75)_22%,transparent)] text-[oklch(0.48_0.14_70)]";
  const cls = `inline-grid size-[22px] place-items-center rounded-full ${variant}`;
  if (state === "all") {
    return (
      <span className={cls} aria-label="full access">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2L4.8 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  }
  if (state === "none") {
    return (
      <span className={cls} aria-label="no access">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 6h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </span>
    );
  }
  return (
    <span className={cls} aria-label="conditional access">
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="2.2" fill="currentColor" /><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.5" /></svg>
    </span>
  );
}

export interface PermissionsMatrixProps {
  roles: RoleData[];
  pushToast: (msg: string) => void;
}

export function PermissionsMatrix({ roles, pushToast }: PermissionsMatrixProps) {
  const [activeRole, setActiveRole] = useState(roles[1]?.name || "authenticated");
  const [matrix, setMatrix] = useState<Matrix>(() => emptyMatrix(roles, []));
  const [sheetTarget, setSheetTarget] = useState<{ role: string; action: string; collection: string } | null>(null);

  // Live collections (c_<slug> tables) via React Query — cached + deduped
  // with the rest of the admin instead of a one-shot useEffect fetch.
  const collectionsQuery = useCollections();
  const collections = useMemo<string[]>(
    () => (collectionsQuery.data?.data ?? []).map((c) => c.slug).sort(),
    [collectionsQuery.data],
  );
  const fieldsBySlug = useMemo<Record<string, string[]>>(() => {
    const map: Record<string, string[]> = {};
    for (const c of collectionsQuery.data?.data ?? []) {
      map[c.slug] = Array.isArray(c.fields) ? c.fields.map((f: any) => f.name) : [];
    }
    return map;
  }, [collectionsQuery.data]);

  // Load per-role permissions and derive matrix cell states from real rows.
  // No more "seedMatrix" — empty cells = "none" until we discover a row.
  useEffect(() => {
    let cancelled = false;
    if (roles.length === 0 || collections.length === 0) {
      setMatrix(emptyMatrix(roles, collections));
      return;
    }
    Promise.all(
      roles.map(async (r) => {
        if (r.name === "admin") return [r.name, null] as const;
        try {
          const res = await api<{ data: { collection: string; action: string; condition: unknown }[] }>(
            `/api/roles/${r.id}/permissions`,
          );
          return [r.name, res.data ?? []] as const;
        } catch {
          return [r.name, []] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Matrix = {};
      for (const [roleName, rows] of entries) {
        next[roleName] = {};
        for (const c of collections) {
          if (roleName === "admin") {
            next[roleName][c] = { create: "all", read: "all", update: "all", delete: "all" };
            continue;
          }
          const row: Record<string, CellState> = { create: "none", read: "none", update: "none", delete: "none" };
          for (const p of rows ?? []) {
            if (p.collection !== c) continue;
            if (!(p.action in row)) continue;
            row[p.action] = p.condition == null ? "all" : "custom";
          }
          next[roleName][c] = row;
        }
      }
      setMatrix(next);
    });
    return () => { cancelled = true; };
  }, [roles, collections]);

  const isAdmin = activeRole === "admin";

  const setCell = (collection: string, action: string, val: CellState) => {
    setMatrix((m) => ({
      ...m,
      [activeRole]: {
        ...m[activeRole],
        [collection]: { ...m[activeRole][collection], [action]: val },
      },
    }));
  };

  const pickState = async (collection: string, action: string, val: CellState) => {
    setCell(collection, action, val);
    try {
      await persistMatrixCell(activeRole, collection, action, val);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
    if (val === "custom") {
      setSheetTarget({ role: activeRole, action, collection });
    } else {
      pushToast?.(`${activeRole} · ${action} · ${collection} → ${val === "all" ? "full access" : "no access"}`);
    }
  };

  const stats = useMemo(() => {
    const m = matrix[activeRole] || {};
    let all = 0, none = 0, custom = 0;
    for (const c of collections) for (const a of PM_ACTIONS) {
      const v = m[c]?.[a.v] || "none";
      if (v === "all") all++; else if (v === "none") none++; else custom++;
    }
    return { all, none, custom };
  }, [matrix, activeRole, collections]);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3.5">
        <I.Shield size={14} />
        <span className="text-[13px] font-medium">permission matrix</span>
        <span className="font-mono text-xs text-muted-foreground">
          {stats.all} all · {stats.custom} custom · {stats.none} none
        </span>
        <div className="flex-1" />
        {isAdmin && <Badge variant="secondary">bypass — read-only</Badge>}
      </div>

      <div className="border-b border-border bg-[color-mix(in_oklch,var(--muted)_22%,var(--card))] px-3.5 py-2.5">
        <Tabs value={activeRole} onValueChange={(v) => setActiveRole(v)}>
          <TabsList>
            {roles.map((r) => (
              <TabsTrigger key={r.name} value={r.name}>
                <I.Users size={12} />
                <span className="font-mono">{r.name}</span>
                {r.system && <span className="rounded-[3px] bg-[color-mix(in_oklch,var(--muted)_70%,transparent)] px-[5px] py-px text-[9.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">system</span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="relative bg-card p-4">
        <div className="grid grid-cols-[minmax(160px,1.4fr)_repeat(4,minmax(80px,1fr))] overflow-x-auto rounded-xl border border-border bg-card" role="grid" aria-label={`Permissions for ${activeRole}`}>
          <div className="border-b border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))]" />
          {PM_ACTIONS.map((a) => (
            <div key={a.v} className="flex flex-col items-center justify-center gap-0.5 border-b border-l border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-2 py-2.5" title={a.title}>
              <span className="font-mono text-[13px] font-semibold tracking-[0.04em] text-foreground">{a.label}</span>
              <span className="text-[10.5px] tracking-[0.02em] text-muted-foreground">{a.title}</span>
            </div>
          ))}

          {collections.length === 0 && (
            <div className="col-span-full p-6 text-center text-xs text-muted-foreground">
              No collections yet — create one in the Schema tab to manage permissions here.
            </div>
          )}
          {collections.map((c) => (
            <Fragment key={c}>
              <div className="flex items-center gap-2 border-t border-border px-3.5 py-3 text-[12.5px] text-foreground first-of-type:border-t-0">
                <I.Database size={12} className="text-muted-foreground" />
                <span className="font-mono">{c}</span>
              </div>
              {PM_ACTIONS.map((a) => {
                const state = (matrix[activeRole]?.[c]?.[a.v] || "none") as CellState;
                const cellCls = `relative grid h-11 w-full place-items-center border-0 border-l border-t border-border outline-none transition-[background,box-shadow] focus-visible:z-[2] focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--ring)_70%,transparent)] data-[state=open]:z-[2] data-[state=open]:bg-[color-mix(in_oklch,var(--primary)_10%,var(--card))] data-[state=open]:shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--primary)_70%,transparent)] ${
                  isAdmin
                    ? "cursor-not-allowed bg-card opacity-85"
                    : "cursor-pointer bg-card hover:bg-[color-mix(in_oklch,var(--accent)_50%,var(--card))]"
                }`;
                const trigger = (
                  <button
                    type="button"
                    className={cellCls}
                    title={cellSummary(state, a.v, c)}
                    aria-label={`${activeRole} · ${a.title} · ${c}: ${state}`}
                  >
                    <CellGlyph state={isAdmin ? "all" : state} />
                  </button>
                );
                if (isAdmin) return <div key={a.v} className="relative grid">{trigger}</div>;
                return (
                  <div key={a.v} className="group relative grid">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
                      <DropdownMenuContent align="start" className="min-w-[240px]">
                        <DropdownMenuItem
                          className="gap-2.5"
                          onSelect={() => pickState(c, a.v, "all")}
                        >
                          <CellGlyph state="all" />
                          <span><strong className="block font-medium">Full access</strong><span className="mt-px block text-[11px] text-muted-foreground">no condition; everyone in role</span></span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="gap-2.5"
                          onSelect={() => pickState(c, a.v, "custom")}
                        >
                          <CellGlyph state="custom" />
                          <span><strong className="block font-medium">Use custom rule</strong><span className="mt-px block text-[11px] text-muted-foreground">edit conditions below ↓</span></span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="gap-2.5"
                          onSelect={() => pickState(c, a.v, "none")}
                        >
                          <CellGlyph state="none" />
                          <span><strong className="block font-medium">No access</strong><span className="mt-px block text-[11px] text-muted-foreground">denied for this role</span></span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {state === "custom" && (
                      <IconButton
                        icon={I.Pencil}
                        title="Edit rule"
                        className="absolute right-[3px] top-[3px] z-[3] size-5 min-w-0 bg-[color-mix(in_oklch,var(--card)_80%,transparent)] p-0 opacity-0 backdrop-blur-[2px] transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => {
                          setSheetTarget({ role: activeRole, action: a.v, collection: c });
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3.5 border-t border-border px-4 py-2.5 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><CellGlyph state="all" /> full</span>
        <span className="inline-flex items-center gap-1.5"><CellGlyph state="custom" /> custom rule</span>
        <span className="inline-flex items-center gap-1.5"><CellGlyph state="none" /> denied</span>
        <div className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground">Click any cell to set state. Custom opens the rule builder in a dialog.</span>
      </div>

      <Dialog open={sheetTarget !== null} onOpenChange={(o) => { if (!o) setSheetTarget(null); }}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto overflow-x-hidden [grid-template-columns:minmax(0,1fr)]">
          <DialogHeader>
            <DialogTitle>Edit rule</DialogTitle>
            <DialogDescription className="font-mono">
              {sheetTarget ? `${sheetTarget.role} · ${sheetTarget.action} · ${sheetTarget.collection}` : ""}
            </DialogDescription>
          </DialogHeader>
          {sheetTarget && (
            <div className="min-w-0">
              <ConditionEditor
                role={sheetTarget.role}
                action={sheetTarget.action}
                collection={sheetTarget.collection}
                roles={roles}
                pushToast={pushToast}
                availableFields={fieldsBySlug[sheetTarget.collection] ?? []}
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
