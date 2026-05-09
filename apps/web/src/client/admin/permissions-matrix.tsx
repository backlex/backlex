// @ts-nocheck
// Directus-parity permission matrix
import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { I } from "./icons";
import { Badge } from "./ui";
import { api } from "@/lib/api";
import type { RoleData } from "./role-editor";

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

const PM_COLLECTIONS = ["posts", "comments", "authors", "tags"];
const PM_ACTIONS = [
  { v: "create", label: "C", title: "Create" },
  { v: "read", label: "R", title: "Read" },
  { v: "update", label: "U", title: "Update" },
  { v: "delete", label: "D", title: "Delete" },
];

type CellState = "all" | "none" | "custom";

type Matrix = Record<string, Record<string, Record<string, CellState>>>;

function seedMatrix(roles: RoleData[]): Matrix {
  const out: Matrix = {};
  for (const r of roles) {
    out[r.name] = {};
    for (const c of PM_COLLECTIONS) {
      if (r.name === "admin") {
        out[r.name][c] = { create: "all", read: "all", update: "all", delete: "all" };
      } else if (r.name === "public") {
        out[r.name][c] = { create: "none", read: c === "posts" ? "custom" : "all", update: "none", delete: "none" };
      } else if (r.name === "authenticated") {
        out[r.name][c] = { create: "all", read: "all", update: "custom", delete: "custom" };
      } else {
        out[r.name][c] = { create: "none", read: "all", update: "none", delete: "none" };
      }
    }
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
  const [matrix, setMatrix] = useState<Matrix>(() => seedMatrix(roles));
  const [pop, setPop] = useState<{ role: string; collection: string; action: string; x: number; y: number } | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setMatrix((m) => {
      const next = { ...m };
      for (const r of roles) if (!next[r.name]) {
        next[r.name] = {};
        for (const c of PM_COLLECTIONS) next[r.name][c] = { create: "none", read: "all", update: "none", delete: "none" };
      }
      return next;
    });
  }, [roles.length]);

  useEffect(() => {
    if (!pop) return;
    const onDoc = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setPop(null); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPop(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [pop]);

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

  const openCell = (e: ReactMouseEvent<HTMLButtonElement>, collection: string, action: string) => {
    if (isAdmin) return;
    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const host = (e.currentTarget.closest(".pm-grid-wrap") as HTMLElement).getBoundingClientRect();
    setPop({
      role: activeRole, collection, action,
      x: rect.left - host.left + rect.width / 2,
      y: rect.bottom - host.top + 6,
    });
  };

  const pickState = async (val: CellState) => {
    if (!pop) return;
    setCell(pop.collection, pop.action, val);
    try {
      await persistMatrixCell(pop.role, pop.collection, pop.action, val);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
    if (val === "custom") {
      window.dispatchEvent(new CustomEvent("ce:focus", { detail: { role: pop.role, collection: pop.collection, action: pop.action } }));
      pushToast?.(`Editing rule for ${pop.role} · ${pop.action} · ${pop.collection}`);
    } else {
      pushToast?.(`${pop.role} · ${pop.action} · ${pop.collection} → ${val === "all" ? "full access" : "no access"}`);
    }
    setPop(null);
  };

  const stats = useMemo(() => {
    const m = matrix[activeRole] || {};
    let all = 0, none = 0, custom = 0;
    for (const c of PM_COLLECTIONS) for (const a of PM_ACTIONS) {
      const v = m[c]?.[a.v] || "none";
      if (v === "all") all++; else if (v === "none") none++; else custom++;
    }
    return { all, none, custom };
  }, [matrix, activeRole]);

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

          {PM_COLLECTIONS.map((c) => (
            <Fragment key={c}>
              <div className="pm-row-head">
                <I.Database size={12} />
                <span className="font-mono">{c}</span>
              </div>
              {PM_ACTIONS.map((a) => {
                const state = (matrix[activeRole]?.[c]?.[a.v] || "none") as CellState;
                const isOpen = pop && pop.collection === c && pop.action === a.v;
                return (
                  <button
                    key={a.v}
                    type="button"
                    className={`pm-cell pm-cell-${state} ${isOpen ? "is-open" : ""} ${isAdmin ? "is-locked" : ""}`}
                    onClick={(e) => openCell(e, c, a.v)}
                    title={cellSummary(state, a.v, c)}
                    aria-label={`${activeRole} · ${a.title} · ${c}: ${state}`}
                  >
                    <CellGlyph state={isAdmin ? "all" : state} />
                  </button>
                );
              })}
            </Fragment>
          ))}
        </div>

        {pop && (
          <div ref={popRef} className="pm-pop" style={{ left: pop.x, top: pop.y }} role="dialog">
            <div className="pm-pop-head">
              <span className="font-mono" style={{ fontSize: 11.5 }}>{pop.role}</span>
              <span className="muted">·</span>
              <span className="font-mono" style={{ fontSize: 11.5 }}>{pop.action}</span>
              <span className="muted">·</span>
              <span className="font-mono" style={{ fontSize: 11.5 }}>{pop.collection}</span>
            </div>
            <button type="button" className="pm-pop-opt" onClick={() => pickState("all")}>
              <CellGlyph state="all" />
              <span><strong>Full access</strong><span className="muted">no condition; everyone in role</span></span>
            </button>
            <button type="button" className="pm-pop-opt" onClick={() => pickState("custom")}>
              <CellGlyph state="custom" />
              <span><strong>Use custom rule</strong><span className="muted">edit conditions below ↓</span></span>
            </button>
            <button type="button" className="pm-pop-opt" onClick={() => pickState("none")}>
              <CellGlyph state="none" />
              <span><strong>No access</strong><span className="muted">denied for this role</span></span>
            </button>
          </div>
        )}
      </div>

      <div className="pm-legend">
        <span><CellGlyph state="all" /> full</span>
        <span><CellGlyph state="custom" /> custom rule</span>
        <span><CellGlyph state="none" /> denied</span>
        <div className="spacer" />
        <span className="muted" style={{ fontSize: 11.5 }}>Click any cell to set state. Custom opens the rule builder below.</span>
      </div>
    </div>
  );
}
