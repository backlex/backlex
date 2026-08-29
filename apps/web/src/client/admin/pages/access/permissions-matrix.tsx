// No-code permission matrix
import type { PushToast } from "../../types";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, IconButton } from "../../ui";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import { api } from "@/lib/api";
import type { RoleData } from "./role-editor";
import { ConditionEditor } from "./condition-editor";
import { useCollections } from "../../queries";

/** A stored permission row, as far as this matrix needs to read one. `fields`
 *  and `condition` are what separate "full access" from a narrowed grant, so
 *  both are fetched — deciding on `condition` alone would call a row with a
 *  field allow-list unrestricted. */
interface StoredPermission {
  id: string;
  collection: string;
  action: string;
  fields: string[] | null;
  condition: unknown;
}

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

  const perms = await api<{ data: StoredPermission[] }>(
    `/api/roles/${role.id}/permissions`,
  );
  const existing = perms.data.find(
    (p) => p.collection === collection && p.action === action,
  );

  if (state === "all") {
    // Already unrestricted — a row with neither a condition nor a field
    // allow-list IS full access, so rewriting it would only churn its id.
    if (existing && existing.condition == null && existing.fields == null) return;
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

  // 'custom' — a row already carrying a condition is left exactly as it is.
  // The operator asked to EDIT the rule, and re-POSTing the starter condition
  // here would silently throw away whatever was stored before the editor ever
  // opened. Only a cell that has no rule yet gets the starter one, so the
  // ConditionEditor opens on something rather than on nothing.
  if (existing && existing.condition != null) return;
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

/**
 * Every action this matrix renders a column for. It is also the complete set
 * the permission DSL knows — `Action` in `@backlex/core` is
 * `read | create | update | delete | publish` — so a row seeded from this list
 * can hold anything the server might have stored against a collection.
 */
const PM_ACTIONS = [
  { v: "create", label: "C", title: "Create" },
  { v: "read", label: "R", title: "Read" },
  { v: "update", label: "U", title: "Update" },
  { v: "delete", label: "D", title: "Delete" },
  { v: "publish", label: "P", title: "Publish" },
];

type CellState = "all" | "none" | "custom";

type Matrix = Record<string, Record<string, Record<string, CellState>>>;

/**
 * A row with every action set to one state.
 *
 * Seeded from {@link PM_ACTIONS} rather than a hand-written CRUD literal,
 * because the read-back below only keeps actions the row already carries. With
 * a CRUD-only seed a stored `publish` grant was dropped on the way in: the
 * Publish column was rendered, the grant behind it was invisible, and setting
 * that cell to "no access" changed nothing an operator could see. Anything the
 * UI offers a column for has to survive the round trip.
 */
function uniformRow(state: CellState): Record<string, CellState> {
  const row: Record<string, CellState> = {};
  for (const a of PM_ACTIONS) row[a.v] = state;
  return row;
}

function defaultRow(roleName: string): Record<string, CellState> {
  // `admin` bypasses the permission tables entirely, so its row reads full
  // before any row is fetched; every other role starts denied and only opens
  // up where a stored permission says so.
  return uniformRow(roleName === "admin" ? "all" : "none");
}

function emptyMatrix(roles: RoleData[], collections: string[]): Matrix {
  const out: Matrix = {};
  for (const r of roles) {
    // Build the row first, then attach it. Writing through `out[r.name][c]`
    // re-reads an index the compiler must treat as possibly-absent.
    const row: Record<string, Record<string, CellState>> = {};
    for (const c of collections) row[c] = defaultRow(r.name);
    out[r.name] = row;
  }
  return out;
}

/**
 * The cell's tooltip. It used to invent a rule per action — "Where owner_id =
 * $user.id", and a `status = "published"` clause for any collection named
 * `posts` — none of which was read from the stored condition. A tooltip that
 * states a rule the server may not hold is worse than one that states none, so
 * the conditional case now says only what is certainly true and points at the
 * editor that does show the real thing.
 */
function cellSummary(state: CellState) {
  if (state === "all") return "Full access — no condition.";
  if (state === "none") return "No access — denied for this role.";
  return "Conditional — open the rule builder to see the stored rule.";
}

function CellGlyph({ state }: { state: CellState }) {
  const { t } = useLingui();
  const variant =
    state === "all"
      ? "bg-[color-mix(in_oklch,oklch(from_var(--primary)_0.72_0.18_h)_22%,transparent)] text-[oklch(from_var(--primary)_0.42_0.16_h)]"
      : state === "none"
        ? "bg-[color-mix(in_oklch,var(--muted)_80%,transparent)] text-muted-foreground"
        : "bg-[color-mix(in_oklch,oklch(0.78_0.16_75)_22%,transparent)] text-[oklch(0.48_0.14_70)]";
  const cls = `inline-grid size-[22px] place-items-center rounded-full ${variant}`;
  if (state === "all") {
    return (
      <span className={cls} aria-label={t`full access`}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2L4.8 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  }
  if (state === "none") {
    return (
      <span className={cls} aria-label={t`no access`}>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 6h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </span>
    );
  }
  return (
    <span className={cls} aria-label={t`conditional access`}>
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="2.2" fill="currentColor" /><circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 1.5" /></svg>
    </span>
  );
}

export interface PermissionsMatrixProps {
  roles: RoleData[];
  pushToast: PushToast;
}

export function PermissionsMatrix({ roles, pushToast }: PermissionsMatrixProps) {
  const { t } = useLingui();
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
          const res = await api<{ data: StoredPermission[] }>(
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
            next[roleName][c] = uniformRow("all");
            continue;
          }
          const row = uniformRow("none");
          for (const p of rows ?? []) {
            if (p.collection !== c) continue;
            // The seed holds every action the matrix has a column for, so this
            // only skips an action a newer server stored that this build has
            // nowhere to show — never one the operator can see and click.
            if (!(p.action in row)) continue;
            // A field allow-list narrows the grant just as a condition does,
            // so a row carrying one reads as conditional rather than full.
            row[p.action] = p.condition == null && p.fields == null ? "all" : "custom";
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
    setMatrix((m) => {
      const roleRows = m[activeRole] ?? {};
      return {
        ...m,
        [activeRole]: {
          ...roleRows,
          [collection]: { ...(roleRows[collection] ?? {}), [action]: val },
        },
      };
    });
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
      pushToast?.(`${activeRole} · ${action} · ${collection} → ${val === "all" ? t`full access` : t`no access`}`);
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
    <Card className="py-0 gap-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3.5">
        <I.Shield size={14} />
        <span className="text-[13px] font-medium"><Trans>permission matrix</Trans></span>
        <span className="font-mono text-xs text-muted-foreground">
          <Trans>{stats.all} all · {stats.custom} custom · {stats.none} none</Trans>
        </span>
        <div className="flex-1" />
        {isAdmin && <Badge variant="secondary"><Trans>bypass — read-only</Trans></Badge>}
      </div>

      <div className="border-b border-border bg-[color-mix(in_oklch,var(--muted)_22%,var(--card))] px-3.5 py-2.5">
        <Tabs value={activeRole} onValueChange={(v) => setActiveRole(v)}>
          <TabsList>
            {roles.map((r) => (
              <TabsTrigger key={r.name} value={r.name}>
                <I.Users size={12} />
                <span className="font-mono">{r.name}</span>
                {r.system && <span className="rounded-sm bg-[color-mix(in_oklch,var(--muted)_70%,transparent)] px-[5px] py-px text-[9.5px] font-semibold uppercase tracking-[0.05em] text-muted-foreground"><Trans>system</Trans></span>}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="relative bg-card p-4">
        <ScrollArea className="rounded-control border border-border bg-card">
        <div className="grid grid-cols-[minmax(160px,1.4fr)_repeat(5,minmax(80px,1fr))]" role="grid" aria-label={t`Permissions for ${activeRole}`}>
          <div className="border-b border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))]" />
          {PM_ACTIONS.map((a) => (
            <div key={a.v} className="flex flex-col items-center justify-center gap-0.5 border-b border-l border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-2 py-2.5" title={a.title}>
              <span className="font-mono text-[13px] font-semibold tracking-[0.04em] text-foreground">{a.label}</span>
              <span className="text-[10.5px] tracking-[0.02em] text-muted-foreground">{a.title}</span>
            </div>
          ))}

          {collections.length === 0 && (
            <div className="col-span-full p-6 text-center text-xs text-muted-foreground">
              <Trans>No collections yet — create one in the Schema tab to manage permissions here.</Trans>
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
                const cellCls = `relative grid h-11 w-full place-items-center border-0 border-l border-t border-border outline-none transition-[background,box-shadow] focus-visible:z-[2] focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--ring)_70%,transparent)] data-[state=open]:z-[2] data-[state=open]:bg-selected-surface data-[state=open]:shadow-[inset_0_0_0_1.5px_color-mix(in_oklch,var(--primary)_70%,transparent)] ${
                  isAdmin
                    ? "cursor-not-allowed bg-card opacity-85"
                    : "cursor-pointer bg-card hover:bg-[color-mix(in_oklch,var(--accent)_50%,var(--card))]"
                }`;
                const trigger = (
                  <button
                    type="button"
                    className={cellCls}
                    title={cellSummary(state)}
                    aria-label={t`${activeRole} · ${a.title} · ${c}: ${state}`}
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
                          <span><strong className="block font-medium"><Trans>Full access</Trans></strong><span className="mt-px block text-[11px] text-muted-foreground"><Trans>no condition; everyone in role</Trans></span></span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="gap-2.5"
                          onSelect={() => pickState(c, a.v, "custom")}
                        >
                          <CellGlyph state="custom" />
                          <span><strong className="block font-medium"><Trans>Use custom rule</Trans></strong><span className="mt-px block text-[11px] text-muted-foreground"><Trans>edit conditions below ↓</Trans></span></span>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          className="gap-2.5"
                          onSelect={() => pickState(c, a.v, "none")}
                        >
                          <CellGlyph state="none" />
                          <span><strong className="block font-medium"><Trans>No access</Trans></strong><span className="mt-px block text-[11px] text-muted-foreground"><Trans>denied for this role</Trans></span></span>
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {state === "custom" && (
                      <IconButton
                        icon={I.Pencil}
                        title={t`Edit rule`}
                        className="absolute right-[3px] top-[3px] z-[3] size-5 min-w-0 bg-[color-mix(in_oklch,var(--card)_92%,transparent)] p-0 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
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
        </ScrollArea>
      </div>

      <div className="flex flex-wrap items-center gap-3.5 border-t border-border px-4 py-2.5 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><CellGlyph state="all" /> <Trans>full</Trans></span>
        <span className="inline-flex items-center gap-1.5"><CellGlyph state="custom" /> <Trans>custom rule</Trans></span>
        <span className="inline-flex items-center gap-1.5"><CellGlyph state="none" /> <Trans>denied</Trans></span>
        <div className="flex-1" />
        <span className="text-[11.5px] text-muted-foreground"><Trans>Click any cell to set state. Custom opens the rule builder in a dialog.</Trans></span>
      </div>

      <Dialog open={sheetTarget !== null} onOpenChange={(o) => { if (!o) setSheetTarget(null); }}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle><Trans>Edit rule</Trans></DialogTitle>
            <DialogDescription className="font-mono">
              {sheetTarget ? `${sheetTarget.role} · ${sheetTarget.action} · ${sheetTarget.collection}` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
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
          </DialogBody>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
