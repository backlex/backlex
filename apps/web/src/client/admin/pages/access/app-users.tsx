import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@backlex/ui/components/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import { I } from "../../icons";
import { Badge, Button, Checkbox, PageHeader } from "../../ui";
import { ConfirmDialog } from "../../sheet";
import {
  appUserInviteConflict,
  appUsersApi,
  rolesApi,
  type ApiAppUser,
  type ApiRole,
  type AppUserInviteConflict,
  type InviteAppUserBody,
} from "../../api";
import { AppUsersSkeleton } from "../../page-skeletons";
import { ErasureCard } from "./erasure-card";

/* ──────────────────────────────────────────────────────────────────────
 * App users — the workspace end-user pool (the `app_users` table). Distinct
 * from `UsersPage`, which manages the control-plane (admin-app) accounts.
 * ────────────────────────────────────────────────────────────────────── */

/**
 * The three built-ins an end-user is never *given*.
 *
 * `admin` is refused outright by the server —
 * `services/app-user-invites.ts::resolveAssignableRoles` is the authority, and
 * it rejects the admin role on every surface that binds one, so offering it
 * here would only produce a 422. `authenticated` and `public` are implicit:
 * every signed-in end-user holds the first and every request holds the second,
 * so a checkbox for either would be a control with nothing behind it. What
 * remains after this filter is exactly the set the operator may grant.
 */
const APP_USER_SYSTEM_ROLES = new Set(["admin", "authenticated", "public"]);

/** A pending row has no credential and no session behind it: the invitation was
 *  sent and nobody has opened the link yet. */
const isPending = (u: ApiAppUser): boolean => u.status === "invited";

const initials = (s: string): string =>
  s
    .split(/[\s@.]+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";

export function AppUsersPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiAppUser[]>([]);
  const [roles, setRoles] = useState<ApiRole[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [activeUser, setActiveUser] = useState<ApiAppUser | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiAppUser | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

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
        title={t`Users`}
        description={
          <>
            <Trans>End-users of the application built on this workspace — a pool separate from the
            dashboard <strong>Team</strong> (the admin/control-plane operators). They arrive one of two
            ways: they sign themselves up through this workspace's own auth endpoint (see{" "}
            <strong>Authentication → Workspace auth API</strong>), or you invite them here and they
            choose a password from the emailed link.</Trans>
          </>
        }
        actions={
          <Button variant="primary" icon={I.Plus} onClick={() => setInviteOpen(true)}>
            <Trans>Invite end-user</Trans>
          </Button>
        }
      />
      <Card className="py-0 gap-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Users size={13} />
          <span className="text-[13px] font-medium"><Trans>End-users</Trans></span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{rows.length}</span>
          {/* Spacer only on desktop so the filter can use the full row width on mobile. */}
          <div className="hidden flex-1 sm:block" />
          <Input
            placeholder={t`Filter by email / name…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-0 flex-1 sm:max-w-[240px]"
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
                  ? <Trans>No end-users yet — invite one, or wait for the first sign-up through the workspace auth endpoint.</Trans>
                  : <Trans>No matches.</Trans>}
              </TableCell></TableRow>
            )}
            {filtered.map((u) => (
              <TableRow key={u.id} onClick={() => setActiveUser(u)} className="cursor-pointer">
                <TableCell>{u.email}{!u.emailVerified && !isPending(u) && <Badge variant="outline" className="ml-1.5"><Trans>unverified</Trans></Badge>}</TableCell>
                <TableCell className="text-muted-foreground">{u.name ?? "—"}</TableCell>
                {/* A pending row is neither active nor suspended, and calling it
                    active was a straight untruth: nobody can sign in as it. */}
                <TableCell>{u.status === "suspended"
                  ? <Badge variant="destructive"><Trans>suspended</Trans></Badge>
                  : isPending(u)
                    ? <Badge variant="outline"><Trans>invited</Trans></Badge>
                    : <Badge variant="default"><Trans>active</Trans></Badge>}</TableCell>
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
      </Card>
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
      {inviteOpen && (
        <InviteAppUserDialog
          roles={roles}
          onClose={() => setInviteOpen(false)}
          pushToast={pushToast}
          onInvited={(row, replacedId) =>
            // Straight into the table, no refetch. The row IS the evidence the
            // invitation happened, and making the operator wait for a list
            // round-trip to see it is the stale-row shape the house rule bans.
            // A re-send passes the withdrawn id so the list never shows both.
            setRows((arr) => [row, ...arr.filter((x) => x.id !== row.id && x.id !== replacedId)])
          }
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
      {/* Erasure lives here because this is where an operator is standing when
          a deletion request arrives. Deleting the end-user row above removes
          the account; erasure removes the person. */}
      <ErasureCard pushToast={pushToast} />
    </div>
  );
}

/**
 * Invite an end-user by address, from the dashboard.
 *
 * `POST /api/app-users/invite` has shipped on the SDK, GraphQL, MCP and the CLI
 * for a while; the one surface that could not reach it was the page whose whole
 * subject is the end-user pool, which instead told the operator that end-users
 * "sign up via this workspace's own auth endpoint" — true of one of the two
 * ways in, and dead-ending the other. B2B is where that bit hardest: an
 * organization invitation requires the account to exist already, so an operator
 * with no self-signup traffic could not seat the first member of anything.
 */
function InviteAppUserDialog({
  roles,
  onClose,
  onInvited,
  pushToast,
}: {
  /** Already narrowed to what the caller may grant — see APP_USER_SYSTEM_ROLES. */
  roles: ApiRole[];
  onClose: () => void;
  /** `replacedId` is set on a re-send: the pending row that was withdrawn. */
  onInvited: (row: ApiAppUser, replacedId?: string) => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // Set when the server refuses the address. Held in the dialog rather than
  // thrown at a toast because the useful next move — send it again — belongs
  // beside the form that was just filled in, and a toast takes it away after
  // five seconds.
  const [conflict, setConflict] = useState<AppUserInviteConflict | null>(null);

  const trimmed = email.trim().toLowerCase();
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);

  const body = (): InviteAppUserBody => ({
    email: trimmed,
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(roleIds.size ? { roleIds: [...roleIds] } : {}),
  });

  /** The table row the invitation just created, as the list models it. */
  const rowFor = (id: string, addr: string): ApiAppUser => ({
    id,
    email: addr,
    name: name.trim() || null,
    emailVerified: false,
    status: "invited",
    createdAt: Date.now(),
    roles: roles.filter((r) => roleIds.has(r.id)).map((r) => ({ id: r.id, name: r.name })),
  });

  const toggleRole = (id: string, on: boolean) =>
    setRoleIds((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const send = async () => {
    setBusy(true);
    setConflict(null);
    try {
      const r = await appUsersApi.invite(body());
      onInvited(rowFor(r.data.id, r.data.email));
      pushToast(t`Invitation sent to ${r.data.email}.`);
      onClose();
    } catch (e) {
      const c = appUserInviteConflict(e);
      if (c) setConflict(c);
      else pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resend = async (withdrawnId: string) => {
    setBusy(true);
    try {
      const r = await appUsersApi.resendInvite(withdrawnId, body());
      onInvited(rowFor(r.data.id, r.data.email), withdrawnId);
      pushToast(t`A new invitation is on its way to ${r.data.email}.`);
      onClose();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-[460px] max-w-[92vw] gap-0 p-0 sm:max-w-none">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Invite end-user</Trans></DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px]">
            <Trans>They get an email with a link, choose a password there, and land in this workspace's app — not in this dashboard.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-4 px-5 py-[18px]">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground"><Trans>Email</Trans></label>
              <Input
                autoFocus
                type="email"
                placeholder="customer@example.com"
                value={email}
                onChange={(e) => { setEmail(e.target.value); setConflict(null); }}
              />
              <span className="text-[11.5px] text-muted-foreground"><Trans>The invitation link is valid for 7 days.</Trans></span>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground"><Trans>Name</Trans> <span className="font-normal text-muted-foreground"><Trans>(optional)</Trans></span></label>
              <Input placeholder={t`Display name`} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground"><Trans>Roles</Trans></label>
              {roles.length === 0 ? (
                // Three built-ins and no explanation reads as a broken list. Say
                // why there is nothing to tick, and point at the page that fixes
                // it — the invitation itself still works without one.
                <div className="rounded-control border border-dashed border-border px-3.5 py-3 text-[12.5px] text-muted-foreground">
                  <Trans>This workspace has only the three built-in roles, and none of them is grantable
                  here: <span className="font-mono">admin</span> is refused for end-users, and{" "}
                  <span className="font-mono">authenticated</span> and <span className="font-mono">public</span>{" "}
                  are already implicit. You can invite without one — they will sign in as{" "}
                  <span className="font-mono">authenticated</span>.</Trans>
                  <div className="mt-2">
                    <Link to="/access/roles" className="font-medium text-foreground underline underline-offset-2">
                      <Trans>Create a role first →</Trans>
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col overflow-hidden rounded-control border border-border">
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
            </div>
            {conflict && (
              <div className="flex flex-col gap-2 rounded-control border border-border bg-muted px-3.5 py-3 text-[12.5px]">
                {conflict.reason === "already_invited" ? (
                  <>
                    <span>
                      <Trans><span className="font-medium">{conflict.email}</span> has already been invited and
                      hasn't accepted yet.</Trans>
                    </span>
                    <span className="text-muted-foreground">
                      <Trans>Sending again withdraws the old invitation — its link stops working — and mails a
                      fresh one with the roles selected above.</Trans>
                    </span>
                    <div>
                      <Button variant="primary" disabled={busy} onClick={() => void resend(conflict.appUserId)}>
                        {busy ? <Trans>Sending…</Trans> : <Trans>Send a new invitation</Trans>}
                      </Button>
                    </div>
                  </>
                ) : (
                  <span>
                    <Trans><span className="font-medium">{conflict.email}</span> already has an account in this
                    workspace ({conflict.status}). Close this and open their row to change roles or reinstate
                    them.</Trans>
                  </span>
                )}
              </div>
            )}
          </div>
        </DialogBody>
        <DialogFooter className="border-t border-border bg-card px-5 py-3 sm:justify-end">
          <Button variant="ghost" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" disabled={!valid || busy || !!conflict} onClick={() => void send()}>
            {busy ? <Trans>Sending…</Trans> : <Trans>Send invitation</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  pushToast: PushToast;
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
                : isPending(user)
                  ? <Badge variant="outline"><Trans>invited</Trans></Badge>
                  : <Badge variant="default"><Trans>active</Trans></Badge>}
            </SheetTitle>
            <SheetDescription className="mt-0.5 text-[12.5px]">{user.email} · id <span className="font-mono">{user.id}</span></SheetDescription>
          </div>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-8 px-5 py-[18px]">
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
                <div className="flex flex-col overflow-hidden rounded-control border border-border">
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

          <div className="grid grid-cols-2 gap-x-3.5 gap-y-2.5 rounded-control bg-muted px-3.5 py-3 max-[900px]:grid-cols-1">
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
              <div className="rounded-control border border-dashed border-border p-3.5 text-center text-[12.5px] text-muted-foreground"><Trans>No active sessions.</Trans></div>
            ) : (
              <div className="flex flex-col overflow-hidden rounded-control border border-border">
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

          <div className="rounded-control border border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_5%,var(--card))] px-3.5 py-3">
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
        </ScrollArea>

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
