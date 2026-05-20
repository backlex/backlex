// @ts-nocheck
import { useEffect, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workeros/ui/components/table";
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
    <div className="flex flex-col gap-4.5">
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
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Users size={13} />
          <span className="text-[13px] font-medium">End-users</span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{rows.length}</span>
          <div className="flex-1" />
          <Input
            placeholder="Filter by email / name…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-[240px]"
          />
        </div>
        <Table className="[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground">
          <TableHeader>
            <TableRow><TableHead>Email</TableHead><TableHead>Name</TableHead><TableHead>Status</TableHead><TableHead>Roles</TableHead><TableHead>Created</TableHead><TableHead className="sticky right-0 bg-card" /></TableRow>
          </TableHeader>
          <TableBody>
            {!loaded && <TableRow><TableCell colSpan={6} className="text-muted-foreground">Loading…</TableCell></TableRow>}
            {loaded && filtered.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-muted-foreground">
                {rows.length === 0
                  ? "No end-users yet — they appear here after signing up via the workspace auth endpoint."
                  : "No matches."}
              </TableCell></TableRow>
            )}
            {filtered.map((u) => (
              <TableRow key={u.id}>
                <TableCell>{u.email}{!u.emailVerified && <Badge variant="outline" className="ml-1.5">unverified</Badge>}</TableCell>
                <TableCell className="text-muted-foreground">{u.name ?? "—"}</TableCell>
                <TableCell>{u.status === "suspended" ? <Badge variant="destructive">suspended</Badge> : <Badge variant="default">active</Badge>}</TableCell>
                <TableCell>
                  {u.roles.length === 0
                    ? <span className="text-xs text-muted-foreground">authenticated</span>
                    : u.roles.map((r) => <Badge key={r.id} variant="secondary" className="mr-1">{r.name}</Badge>)}
                </TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{fmtDate(u.createdAt)}</TableCell>
                <TableCell className="sticky right-0 bg-card text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditRoles(u)}>Roles</Button>
                  {u.status === "suspended"
                    ? <Button size="sm" variant="ghost" onClick={() => void setStatus(u, "active")}>Activate</Button>
                    : <Button size="sm" variant="ghost" onClick={() => void setStatus(u, "suspended")}>Suspend</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(u)}>Delete</Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
    <div className="fixed inset-0 z-[70] grid animate-in place-items-center bg-[oklch(0_0_0/0.45)] backdrop-blur-[2px] fade-in-0 duration-150" onClick={onClose}>
      <div className="relative flex max-h-[min(86vh,720px)] w-[92vw] max-w-[440px] animate-in flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-[0_24px_60px_oklch(0_0_0/0.22),0_2px_8px_oklch(0_0_0/0.08)] fade-in-0 zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-border px-5 pb-3.5 pt-[18px]">
          <div className="flex-1">
            <div className="text-base font-semibold tracking-[-0.01em]">Roles · {user.email}</div>
            <div className="mt-[3px] text-[12.5px] text-muted-foreground">
              End-users always have the workspace's <span className="font-mono">authenticated</span> role;
              pick any extra custom roles below. The <span className="font-mono">admin</span> role can't be
              assigned to end-users.
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
          {roles.length === 0 && (
            <div className="text-[12.5px] text-muted-foreground">
              This workspace has no custom roles yet — create one under <strong>Roles &amp; permissions</strong>.
            </div>
          )}
          {roles.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{r.name}</div>
                {r.description && <div className="text-[11.5px] text-muted-foreground">{r.description}</div>}
              </div>
              <Switch checked={selected.has(r.id)} onChange={(on) => setHas(r.id, on)} />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] px-4 py-3">
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" icon={I.Check} onClick={() => onSave([...selected])}>Save</Button>
        </div>
      </div>
    </div>
  );
}
