// @ts-nocheck
import { useEffect, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { I } from "../icons";
import { Badge, Button, IconButton, PageHeader, Switch } from "../ui";
import { ConfirmDialog } from "../sheet";
import {
  appUsersApi,
  rolesApi,
  type ApiAppUser,
  type ApiRole,
} from "../api";

/* ──────────────────────────────────────────────────────────────────────
 * App users — the workspace end-user pool (the `app_users` table). Distinct
 * from `UsersPage`, which manages the control-plane (admin-app) accounts.
 * ────────────────────────────────────────────────────────────────────── */

const APP_USER_SYSTEM_ROLES = new Set(["admin", "authenticated", "public"]);

export function AppUsersPage({ pushToast }: { pushToast: (m: string) => void }) {
  const [rows, setRows] = useState<ApiAppUser[]>([]);
  const [roles, setRoles] = useState<ApiRole[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [editRoles, setEditRoles] = useState<ApiAppUser | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiAppUser | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [u, r] = await Promise.all([
          appUsersApi.list(),
          rolesApi.list().catch(() => ({ data: [] as ApiRole[] })),
        ]);
        if (cancelled) return;
        setRows(u.data ?? []);
        setRoles((r.data ?? []).filter((x) => !x.admin && !APP_USER_SYSTEM_ROLES.has(x.name)));
      } catch (e) {
        if (!cancelled) pushToast?.((e as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);

  const filtered = rows.filter((u) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return u.email.toLowerCase().includes(s) || (u.name ?? "").toLowerCase().includes(s);
  });

  const setStatus = async (u: ApiAppUser, status: "active" | "suspended") => {
    try {
      await appUsersApi.patch(u.id, { status });
      setRows((arr) => arr.map((x) => (x.id === u.id ? { ...x, status } : x)));
      pushToast?.(`${u.email} ${status === "suspended" ? "suspended" : "reactivated"}.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };
  const doDelete = async (u: ApiAppUser) => {
    try {
      await appUsersApi.remove(u.id);
      setRows((arr) => arr.filter((x) => x.id !== u.id));
      pushToast?.(`${u.email} deleted.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
    setConfirmDelete(null);
  };
  const saveRoles = async (u: ApiAppUser, roleIds: string[]) => {
    try {
      await appUsersApi.setRoles(u.id, roleIds);
      const byId = new Map(roles.map((r) => [r.id, r] as const));
      setRows((arr) =>
        arr.map((x) =>
          x.id === u.id
            ? { ...x, roles: roleIds.map((id) => ({ id, name: byId.get(id)?.name ?? id })) }
            : x,
        ),
      );
      pushToast?.(`Roles updated for ${u.email}.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
    setEditRoles(null);
  };

  const fmtDate = (v: string | number): string => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader
        title="App users"
        description={
          <>
            End-users of the application built on this workspace — a pool separate from the
            admin/control-plane <span className="font-mono">users</span>. They sign up via this
            workspace's own auth endpoint (see <strong>Authentication → Workspace auth API</strong>).
          </>
        }
      />
      <div className="card">
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <I.Users size={13} />
          <span style={{ fontSize: 13, fontWeight: 500 }}>End-users</span>
          <span className="muted font-mono" style={{ fontSize: 11.5 }}>{rows.length}</span>
          <div className="spacer" />
          <Input
            placeholder="Filter by email / name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ maxWidth: 240 }}
          />
        </div>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr><th>Email</th><th>Name</th><th>Status</th><th>Roles</th><th>Created</th><th /></tr>
            </thead>
            <tbody>
              {!loaded && <tr><td colSpan={6} className="muted" style={{ padding: 14 }}>Loading…</td></tr>}
              {loaded && filtered.length === 0 && (
                <tr><td colSpan={6} className="muted" style={{ padding: 14 }}>
                  {rows.length === 0
                    ? "No end-users yet — they appear here after signing up via the workspace auth endpoint."
                    : "No matches."}
                </td></tr>
              )}
              {filtered.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}{!u.emailVerified && <Badge variant="outline" style={{ marginLeft: 6 }}>unverified</Badge>}</td>
                  <td className="muted">{u.name ?? "—"}</td>
                  <td>{u.status === "suspended" ? <Badge variant="destructive">suspended</Badge> : <Badge variant="default">active</Badge>}</td>
                  <td>
                    {u.roles.length === 0
                      ? <span className="muted" style={{ fontSize: 12 }}>authenticated</span>
                      : u.roles.map((r) => <Badge key={r.id} variant="secondary" style={{ marginRight: 4 }}>{r.name}</Badge>)}
                  </td>
                  <td className="muted font-mono" style={{ fontSize: 11.5 }}>{fmtDate(u.createdAt)}</td>
                  <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                    <Button size="sm" variant="ghost" onClick={() => setEditRoles(u)}>Roles</Button>
                    {u.status === "suspended"
                      ? <Button size="sm" variant="ghost" onClick={() => void setStatus(u, "active")}>Activate</Button>
                      : <Button size="sm" variant="ghost" onClick={() => void setStatus(u, "suspended")}>Suspend</Button>}
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(u)}>Delete</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {editRoles && (
        <AppUserRolesDialog
          user={editRoles}
          roles={roles}
          onClose={() => setEditRoles(null)}
          onSave={(ids) => void saveRoles(editRoles, ids)}
        />
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title="Delete end-user"
        description={
          confirmDelete
            ? `Permanently delete ${confirmDelete.email}? Their sessions, OAuth accounts and role assignments are removed too. This can't be undone.`
            : ""
        }
        actionLabel="Delete"
        destructive
        onConfirm={() => confirmDelete && void doDelete(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function AppUserRolesDialog({
  user,
  roles,
  onClose,
  onSave,
}: {
  user: ApiAppUser;
  roles: ApiRole[];
  onClose: () => void;
  onSave: (roleIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(user.roles.map((r) => r.id)));
  const setHas = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id); else n.delete(id);
      return n;
    });
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, width: "92vw" }}>
        <div className="dialog-head">
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Roles · {user.email}</div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
              End-users always have the workspace's <span className="font-mono">authenticated</span> role;
              pick any extra custom roles below. The <span className="font-mono">admin</span> role can't be
              assigned to end-users.
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div className="dialog-body">
          {roles.length === 0 && (
            <div className="muted" style={{ fontSize: 12.5 }}>
              This workspace has no custom roles yet — create one under <strong>Roles &amp; permissions</strong>.
            </div>
          )}
          {roles.map((r) => (
            <div key={r.id} className="field-row">
              <div>
                <div className="field-label">{r.name}</div>
                {r.description && <div className="field-hint">{r.description}</div>}
              </div>
              <Switch checked={selected.has(r.id)} onChange={(on) => setHas(r.id, on)} />
            </div>
          ))}
        </div>
        <div className="dialog-foot">
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={I.Check} onClick={() => onSave([...selected])}>Save</Button>
        </div>
      </div>
    </div>
  );
}
