// @ts-nocheck
// Directus-parity permission matrix
import { Fragment, useEffect, useMemo, useState } from "react";
import { I } from "./icons";
import { Badge, IconButton } from "./ui";
import { Popover, PopoverContent, PopoverTrigger } from "@workeros/ui/components/popover";
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
  if (state === "all") {
    return (
      <span className="pm-glyph pm-glyph-all" aria-label="full access">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2L4.8 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  }
  if (state === "none") {
    return (
      <span className="pm-glyph pm-glyph-none" aria-label="no access">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 6h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </span>
    );
  }
  return (
    <span className="pm-glyph pm-glyph-custom" aria-label="conditional access">
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
  const [collections, setCollections] = useState<string[]>([]);
  const [fieldsBySlug, setFieldsBySlug] = useState<Record<string, string[]>>({});
  const [matrix, setMatrix] = useState<Matrix>(() => emptyMatrix(roles, []));
  const [pop, setPop] = useState<{ collection: string; action: string } | null>(null);
  const [sheetTarget, setSheetTarget] = useState<{ role: string; action: string; collection: string } | null>(null);

  // Load live collections (c_<slug> tables) once.
  useEffect(() => {
    let cancelled = false;
    api<{ data: { slug: string; fields: Array<{ name: string }> | null }[] }>("/api/collections")
      .then((res) => {
        if (cancelled) return;
        const rows = res.data ?? [];
        const slugs = rows.map((c) => c.slug).sort();
        const map: Record<string, string[]> = {};
        for (const c of rows) {
          map[c.slug] = Array.isArray(c.fields) ? c.fields.map((f: any) => f.name) : [];
        }
        setCollections(slugs);
        setFieldsBySlug(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

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
    setPop(null);
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
    <div className="card">
      <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <I.Shield size={14} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>permission matrix</span>
        <span className="font-mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>
          {stats.all} all · {stats.custom} custom · {stats.none} none
        </span>
        <div className="spacer" />
        {isAdmin && <Badge variant="secondary">bypass — read-only</Badge>}
      </div>

      <div className="pm-roles">
        {roles.map((r) => (
          <button
            key={r.name}
            type="button"
            className={`pm-role ${activeRole === r.name ? "on" : ""}`}
            onClick={() => { setActiveRole(r.name); setPop(null); }}
          >
            <I.Users size={12} />
            <span className="font-mono">{r.name}</span>
            {r.system && <span className="pm-role-tag">system</span>}
          </button>
        ))}
      </div>

      <div className="pm-grid-wrap">
        <div className="pm-grid" role="grid" aria-label={`Permissions for ${activeRole}`}>
          <div className="pm-corner" />
          {PM_ACTIONS.map((a) => (
            <div key={a.v} className="pm-col-head" title={a.title}>
              <span className="pm-col-letter">{a.label}</span>
              <span className="pm-col-name">{a.title}</span>
            </div>
          ))}

          {collections.length === 0 && (
            <div className="pm-empty" style={{ gridColumn: "1 / -1", padding: 24, textAlign: "center", color: "var(--muted-foreground)", fontSize: 12 }}>
              No collections yet — create one in the Schema tab to manage permissions here.
            </div>
          )}
          {collections.map((c) => (
            <Fragment key={c}>
              <div className="pm-row-head">
                <I.Database size={12} />
                <span className="font-mono">{c}</span>
              </div>
              {PM_ACTIONS.map((a) => {
                const state = (matrix[activeRole]?.[c]?.[a.v] || "none") as CellState;
                const isOpen = !!pop && pop.collection === c && pop.action === a.v;
                const trigger = (
                  <button
                    type="button"
                    className={`pm-cell pm-cell-${state} ${isOpen ? "is-open" : ""} ${isAdmin ? "is-locked" : ""}`}
                    title={cellSummary(state, a.v, c)}
                    aria-label={`${activeRole} · ${a.title} · ${c}: ${state}`}
                  >
                    <CellGlyph state={isAdmin ? "all" : state} />
                  </button>
                );
                if (isAdmin) return <div key={a.v} className="pm-cell-wrap">{trigger}</div>;
                return (
                  <div key={a.v} className="pm-cell-wrap" style={{ position: "relative" }}>
                    <Popover
                      open={isOpen}
                      onOpenChange={(o) => setPop(o ? { collection: c, action: a.v } : null)}
                    >
                      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
                      <PopoverContent
                        align="center"
                        sideOffset={6}
                        className="w-auto min-w-[240px] gap-0 rounded-lg p-1.5"
                      >
                        <div className="pm-pop-head">
                          <span className="font-mono" style={{ fontSize: 11.5 }}>{activeRole}</span>
                          <span className="muted">·</span>
                          <span className="font-mono" style={{ fontSize: 11.5 }}>{a.v}</span>
                          <span className="muted">·</span>
                          <span className="font-mono" style={{ fontSize: 11.5 }}>{c}</span>
                        </div>
                        <button type="button" className="pm-pop-opt" onClick={() => pickState(c, a.v, "all")}>
                          <CellGlyph state="all" />
                          <span><strong>Full access</strong><span className="muted">no condition; everyone in role</span></span>
                        </button>
                        <button type="button" className="pm-pop-opt" onClick={() => pickState(c, a.v, "custom")}>
                          <CellGlyph state="custom" />
                          <span><strong>Use custom rule</strong><span className="muted">edit conditions below ↓</span></span>
                        </button>
                        <button type="button" className="pm-pop-opt" onClick={() => pickState(c, a.v, "none")}>
                          <CellGlyph state="none" />
                          <span><strong>No access</strong><span className="muted">denied for this role</span></span>
                        </button>
                      </PopoverContent>
                    </Popover>
                    {state === "custom" && (
                      <IconButton
                        icon={I.Pencil}
                        title="Edit rule"
                        className="pm-cell-edit"
                        onClick={(e) => {
                          e.stopPropagation();
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

      <div className="pm-legend">
        <span><CellGlyph state="all" /> full</span>
        <span><CellGlyph state="custom" /> custom rule</span>
        <span><CellGlyph state="none" /> denied</span>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 11.5 }}>Click any cell to set state. Custom opens the rule builder in a dialog.</span>
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
