// @ts-nocheck
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@workeros/ui/components/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workeros/ui/components/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@workeros/ui/components/table";
import { I } from "../icons";
import { Badge, Button, Checkbox, PageHeader } from "../ui";
import { ConfirmDialog } from "../sheet";
import {
  appUsersApi,
  rolesApi,
  type ApiAppUser,
  type ApiRole,
} from "../api";
import { AppUsersSkeleton } from "../page-skeletons";

/* ──────────────────────────────────────────────────────────────────────
 * App users — the workspace end-user pool (the `app_users` table). Distinct
 * from `UsersPage`, which manages the control-plane (admin-app) accounts.
 * ────────────────────────────────────────────────────────────────────── */

const APP_USER_SYSTEM_ROLES = new Set(["admin", "authenticated", "public"]);

const initials = (s: string): string =>
  s
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

export function AppUsersPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiAppUser[]>([]);
  const [roles, setRoles] = useState<ApiRole[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [activeUser, setActiveUser] = useState<ApiAppUser | null>(null);
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
      setActiveUser((cur) => (cur && cur.id === u.id ? { ...cur, status } : cur));
      pushToast?.(`${u.email} ${status === "suspended" ? t`suspended` : t`reactivated`}.`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
  };
  const doDelete = async (u: ApiAppUser) => {
    try {
      await appUsersApi.remove(u.id);
      setRows((arr) => arr.filter((x) => x.id !== u.id));
      setActiveUser((cur) => (cur && cur.id === u.id ? null : cur));
      pushToast?.(`${u.email} ${t`deleted.`}`);
    } catch (e) {
      pushToast?.((e as Error).message);
    }
    setConfirmDelete(null);
  };

  const fmtDate = (v: string | number): string => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
  };

  // First whole-page fetch — end-users + roles haven't landed yet.
  if (!loaded) return <AppUsersSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`App users`}
        description={
          <>
            <Trans>End-users of the application built on this workspace — a pool separate from the
            admin/control-plane <span className="font-mono">users</span>. They sign up via this
            workspace's own auth endpoint (see <strong>Authentication → Workspace auth API</strong>).</Trans>
          </>
        }
      />
      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Users size={13} />
          <span className="text-[13px] font-medium"><Trans>End-users</Trans></span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{rows.length}</span>
          <div className="flex-1" />
          <Input
            placeholder={t`Filter by email / name…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-0 flex-1 max-w-[240px]"
          />
        </div>
        <Table className="[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground">
          <TableHeader>
            <TableRow><TableHead><Trans>Email</Trans></TableHead><TableHead><Trans>Name</Trans></TableHead><TableHead><Trans>Status</Trans></TableHead><TableHead><Trans>Roles</Trans></TableHead><TableHead><Trans>Created</Trans></TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={5} className="text-muted-foreground">
                {rows.length === 0
                  ? <Trans>No end-users yet — they appear here after signing up via the workspace auth endpoint.</Trans>
                  : <Trans>No matches.</Trans>}
              </TableCell></TableRow>
            )}
            {filtered.map((u) => (
              <TableRow key={u.id} onClick={() => setActiveUser(u)} className="cursor-pointer">
                <TableCell>{u.email}{!u.emailVerified && <Badge variant="outline" className="ml-1.5"><Trans>unverified</Trans></Badge>}</TableCell>
                <TableCell className="text-muted-foreground">{u.name ?? "—"}</TableCell>
                <TableCell>{u.status === "suspended" ? <Badge variant="destructive"><Trans>suspended</Trans></Badge> : <Badge variant="default"><Trans>active</Trans></Badge>}</TableCell>
                <TableCell>
                  {u.roles.length === 0
                    ? <span className="text-xs text-muted-foreground">authenticated</span>
                    : u.roles.map((r) => <Badge key={r.id} variant="secondary" className="mr-1">{r.name}</Badge>)}
                </TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{fmtDate(u.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {activeUser && (
        <AppUserDrawer
          user={activeUser}
          roles={roles}
          onClose={() => setActiveUser(null)}
          onPatched={(patch) =>
            setRows((arr) => arr.map((x) => (x.id === activeUser.id ? { ...x, ...patch } : x)))
          }
          onSetStatus={(status) => void setStatus(activeUser, status)}
          onDelete={() => setConfirmDelete(activeUser)}
          pushToast={pushToast}
        />
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title={t`Delete end-user`}
        description={
          confirmDelete
            ? t`Permanently delete ${confirmDelete.email}? Their sessions, OAuth accounts and role assignments are removed too. This can't be undone.`
            : ""
        }
        actionLabel={t`Delete`}
        destructive
        onConfirm={() => confirmDelete && void doDelete(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}

function AppUserDrawer({
  user,
  roles,
  onClose,
  onPatched,
  onSetStatus,
  onDelete,
  pushToast,
}: {
  user: ApiAppUser;
  roles: ApiRole[];
  onClose: () => void;
  onPatched: (patch: Partial<ApiAppUser>) => void;
  onSetStatus: (status: "active" | "suspended") => void;
  onDelete: () => void;
  pushToast: (m: string) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState(user.name ?? "");
  const [roleIds, setRoleIds] = useState<Set<string>>(
    new Set(user.roles.map((r) => r.id)),
  );
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState<any[]>([]);

  const initialRoleIds = new Set(user.roles.map((r) => r.id));
  const nameDirty = name.trim() !== (user.name ?? "").trim() && name.trim().length > 0;
  const rolesDirty =
    roleIds.size !== initialRoleIds.size ||
    [...roleIds].some((id) => !initialRoleIds.has(id));
  const dirty = nameDirty || rolesDirty;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const j = await appUsersApi.sessions(user.id);
        if (cancelled) return;
        const fmtAgo = (ms: number | null): string => {
          if (!ms) return "—";
          const d = Date.now() - ms;
          if (d < 60_000) return t`just now`;
          if (d < 3_600_000) return t`${Math.floor(d / 60_000)}m ago`;
          if (d < 86_400_000) return t`${Math.floor(d / 3_600_000)}h ago`;
          return t`${Math.floor(d / 86_400_000)}d ago`;
        };
        setSessions(
          (j.data ?? []).map((s, i) => ({
            id: s.id ?? `s${i}`,
            device: s.userAgent ?? t`Unknown device`,
            ip: s.ipAddress ?? "—",
            last: fmtAgo(s.updatedAt ?? s.createdAt ?? null),
          })),
        );
      } catch {
        // leave empty
      }
    })();
    return () => { cancelled = true; };
  }, [user.id]);

  const toggleRole = (id: string, on: boolean) =>
    setRoleIds((s) => {
      const n = new Set(s);
      if (on) n.add(id); else n.delete(id);
      return n;
    });

  const save = async () => {
    setSaving(true);
    try {
      if (nameDirty) await appUsersApi.patch(user.id, { name: name.trim() });
      let nextRoles = user.roles;
      if (rolesDirty) {
        await appUsersApi.setRoles(user.id, [...roleIds]);
        const byId = new Map(roles.map((r) => [r.id, r] as const));
        nextRoles = [...roleIds].map((id) => ({ id, name: byId.get(id)?.name ?? id }));
      }
      onPatched({
        ...(nameDirty ? { name: name.trim() } : {}),
        ...(rolesDirty ? { roles: nextRoles } : {}),
      });
      pushToast(t`Profile saved for ${user.email}.`);
      onClose();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const fmtDate = (v: string | number): string => {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
  };

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-[min(560px,100vw)] gap-0 p-0 sm:max-w-none">
        <SheetHeader className="flex-row items-start gap-3 space-y-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <div className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold text-primary-foreground">
            {initials(name || user.email)}
          </div>
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em]">
              {name || user.email}
              {user.status === "suspended"
                ? <Badge variant="destructive"><Trans>suspended</Trans></Badge>
                : <Badge variant="default"><Trans>active</Trans></Badge>}
            </SheetTitle>
            <SheetDescription className="mt-0.5 text-[12.5px]">{user.email} · id <span className="font-mono">{user.id}</span></SheetDescription>
          </div>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-8 overflow-auto px-5 py-[18px]">
          <div>
            <div className="mb-2 text-[12.5px] font-medium"><Trans>Profile</Trans></div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Name</Trans></label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t`Display name`} />
            </div>
            <div className="mt-4">
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Roles</Trans></div>
              {roles.length === 0 ? (
                <div className="text-[12.5px] text-muted-foreground">
                  <Trans>This workspace has no custom roles yet — create one under <strong>Roles &amp; permissions</strong>.</Trans>
                </div>
              ) : (
                <div className="flex flex-col overflow-hidden rounded-xl border border-border">
                  {roles.map((r) => (
                    <label key={r.id} className="flex cursor-pointer items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                      <div className="min-w-0">
                        <div className="text-[12.5px] font-medium text-foreground">{r.name}</div>
                        {r.description && <div className="text-[11.5px] text-muted-foreground">{r.description}</div>}
                      </div>
                      <Checkbox checked={roleIds.has(r.id)} onChange={(on) => toggleRole(r.id, on)} />
                    </label>
                  ))}
                </div>
              )}
              <div className="mt-1.5 text-[11.5px] text-muted-foreground">
                <Trans>End-users always implicitly have <span className="font-mono">authenticated</span>; the <span className="font-mono">admin</span> role can't be assigned.</Trans>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-3.5 gap-y-2.5 rounded-xl bg-muted px-3.5 py-3 max-[900px]:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Email verified</Trans></span><span className="font-mono text-xs">{user.emailVerified ? t`yes` : t`no`}</span></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Status</Trans></span><span className="font-mono text-xs">{user.status}</span></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Created</Trans></span><span className="font-mono text-xs">{fmtDate(user.createdAt)}</span></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Sessions</Trans></span><span className="font-mono text-xs">{sessions.length} <Trans>active</Trans></span></div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium">
              <span><Trans>Active sessions</Trans></span>
              <span className="text-[11.5px] font-normal text-muted-foreground">{sessions.length}</span>
            </div>
            {sessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-3.5 text-center text-[12.5px] text-muted-foreground"><Trans>No active sessions.</Trans></div>
            ) : (
              <div className="flex flex-col overflow-hidden rounded-xl border border-border">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[12.5px] font-medium">{s.device}</span>
                      <span className="font-mono text-[11.5px] text-muted-foreground">{s.ip} · <Trans>last seen</Trans> {s.last}</span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={async () => {
                      try {
                        await appUsersApi.revokeSession(user.id, s.id);
                        setSessions((arr) => arr.filter((x) => x.id !== s.id));
                        pushToast(t`Session revoked: ${s.device}`);
                      } catch (e) {
                        pushToast((e as Error).message);
                      }
                    }}><Trans>Revoke</Trans></Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_5%,var(--card))] px-3.5 py-3">
            <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium"><span><Trans>Danger zone</Trans></span></div>
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color-mix(in_oklch,var(--destructive)_18%,var(--border))] py-2 last:border-b-0">
              <div>
                <div className="text-[12.5px] font-medium">{user.status === "suspended" ? <Trans>Reactivate end-user</Trans> : <Trans>Suspend end-user</Trans>}</div>
                <div className="text-[11.5px] text-muted-foreground">
                  {user.status === "suspended"
                    ? <Trans>Re-enables sign-in for this end-user.</Trans>
                    : <Trans>Blocks sign-in and drops all active sessions immediately.</Trans>}
                </div>
              </div>
              {user.status === "suspended" ? (
                <Button size="sm" variant="outline" onClick={() => onSetStatus("active")}><Trans>Activate</Trans></Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onSetStatus("suspended")}><Trans>Suspend</Trans></Button>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color-mix(in_oklch,var(--destructive)_18%,var(--border))] py-2 last:border-b-0">
              <div>
                <div className="text-[12.5px] font-medium text-destructive"><Trans>Delete end-user</Trans></div>
                <div className="text-[11.5px] text-muted-foreground"><Trans>Permanent. Removes sessions, OAuth accounts and role assignments.</Trans></div>
              </div>
              <Button size="sm" variant="outline" className="text-destructive" onClick={onDelete}><Trans>Delete</Trans></Button>
            </div>
          </div>
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose}><Trans>Close</Trans></Button>
          <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
