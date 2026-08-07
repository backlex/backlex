import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
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
import { Badge, Button, PageHeader } from "../../ui";
import { ConfirmDialog } from "../../sheet";
import { Select } from "../../select";
import {
  appOrgsApi,
  appUsersApi,
  rolesApi,
  type ApiAppUser,
  type ApiOrg,
  type ApiOrgInvite,
  type ApiOrgMember,
  type ApiRole,
  type OrgRole,
} from "../../api";
import { AppOrgsSkeleton } from "../../page-skeletons";

/* ──────────────────────────────────────────────────────────────────────
 * Organizations — the B2B grouping level INSIDE this workspace. Members are
 * end-users (`app_users`), not the dashboard team. Two role layers show up
 * here and the UI keeps them visually separate on purpose:
 *
 *   - the membership role (owner/admin/member) governs org administration;
 *   - the org-scoped workspace roles drive DATA access through `$org.id` /
 *     `$user.orgs` permission rules.
 *
 * Every mutation is optimistic: state is snapshotted, patched immediately,
 * and rolled back on failure.
 * ────────────────────────────────────────────────────────────────────── */

const ORG_SYSTEM_ROLES = new Set(["admin", "authenticated", "public"]);

/** Membership roles. No `hint` on purpose — the Select renders hints inside
 *  the trigger, which at the ~130px these sit at pushed the label out of view
 *  on a phone. The helper line under each control carries the explanation. */
const ORG_ROLE_OPTIONS: { value: OrgRole; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
];

/** Rows of controls inside the drawer: one control per line on a phone (where
 *  the sheet is only ~290px), back to a single row once there's space. `sm:`
 *  tracks the viewport, which is what drives the sheet's own width. */
const ROW_ITEM = "basis-full sm:basis-0 sm:flex-1";

const fmtDate = (v: number | null): string =>
  v == null ? "—" : new Date(v).toISOString().slice(0, 10);

export function AppOrgsPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiOrg[]>([]);
  const [roles, setRoles] = useState<ApiRole[]>([]);
  const [appUsers, setAppUsers] = useState<ApiAppUser[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [q, setQ] = useState("");
  const [activeOrg, setActiveOrg] = useState<ApiOrg | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ApiOrg | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [o, r, u] = await Promise.all([
          appOrgsApi.list(),
          rolesApi.list().catch(() => ({ data: [] as ApiRole[] })),
          appUsersApi.list().catch(() => ({ data: [] as ApiAppUser[] })),
        ]);
        if (cancelled) return;
        setRows(o.data ?? []);
        setRoles((r.data ?? []).filter((x) => !x.admin && !ORG_SYSTEM_ROLES.has(x.name)));
        setAppUsers(u.data ?? []);
      } catch (e) {
        if (!cancelled) pushToast?.((e as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);

  const filtered = rows.filter((o) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return o.name.toLowerCase().includes(s) || o.slug.toLowerCase().includes(s);
  });

  const doDelete = async (org: ApiOrg) => {
    const snapshot = rows;
    setRows((arr) => arr.filter((x) => x.id !== org.id));
    setActiveOrg((cur) => (cur && cur.id === org.id ? null : cur));
    setConfirmDelete(null);
    try {
      await appOrgsApi.remove(org.id);
      pushToast?.(t`${org.name} deleted.`);
    } catch (e) {
      setRows(snapshot);
      pushToast?.((e as Error).message);
    }
  };

  if (!loaded) return <AppOrgsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Organizations`}
        description={
          <Trans>
            Teams inside this workspace — the customer accounts your end-users belong to. Members come
            from <strong>Users</strong> (the end-user pool), and the roles you bind here apply only
            within that organization, which is what <span className="font-mono">$org.id</span> matches
            in permission rules.
          </Trans>
        }
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <I.Plus size={13} />
            <Trans>New organization</Trans>
          </Button>
        }
      />
      <Card className="py-0 gap-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <I.Building size={13} />
          <span className="text-[13px] font-medium"><Trans>Organizations</Trans></span>
          <span className="font-mono text-[11.5px] text-muted-foreground">{rows.length}</span>
          {/* Spacer only on desktop so the filter uses the full row on mobile. */}
          <div className="hidden flex-1 sm:block" />
          <Input
            placeholder={t`Filter by name / slug…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="min-w-0 flex-1 sm:max-w-[240px]"
          />
        </div>
        <Table className="[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground">
          <TableHeader>
            <TableRow>
              <TableHead><Trans>Name</Trans></TableHead>
              <TableHead><Trans>Slug</Trans></TableHead>
              <TableHead><Trans>Members</Trans></TableHead>
              <TableHead><Trans>Created</Trans></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.length === 0 && (
              <TableRow><TableCell colSpan={4} className="text-muted-foreground">
                {rows.length === 0
                  ? <Trans>No organizations yet — create one here, or let end-users start their own from your app.</Trans>
                  : <Trans>No matches.</Trans>}
              </TableCell></TableRow>
            )}
            {filtered.map((o) => (
              <TableRow key={o.id} onClick={() => setActiveOrg(o)} className="cursor-pointer">
                <TableCell className="font-medium">{o.name}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{o.slug}</TableCell>
                <TableCell>{o.memberCount}</TableCell>
                <TableCell className="font-mono text-[11.5px] text-muted-foreground">{fmtDate(o.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {creating && (
        <CreateOrgDialog
          appUsers={appUsers}
          onClose={() => setCreating(false)}
          onCreated={(org) => {
            setRows((arr) => [...arr, org].sort((a, b) => a.name.localeCompare(b.name)));
            setCreating(false);
          }}
          pushToast={pushToast}
        />
      )}
      {activeOrg && (
        <OrgDrawer
          org={activeOrg}
          roles={roles}
          appUsers={appUsers}
          onClose={() => setActiveOrg(null)}
          onPatched={(patch) => {
            setRows((arr) => arr.map((x) => (x.id === activeOrg.id ? { ...x, ...patch } : x)));
            setActiveOrg((cur) => (cur ? { ...cur, ...patch } : cur));
          }}
          onDelete={() => setConfirmDelete(activeOrg)}
          pushToast={pushToast}
        />
      )}
      <ConfirmDialog
        open={!!confirmDelete}
        title={t`Delete organization`}
        description={
          confirmDelete
            ? t`Permanently delete ${confirmDelete.name}? Its memberships, org-scoped role bindings and invitations go with it, and any session pinned to it falls back to no active organization. This can't be undone.`
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

function CreateOrgDialog({
  appUsers,
  onClose,
  onCreated,
  pushToast,
}: {
  appUsers: ApiAppUser[];
  onClose: () => void;
  onCreated: (org: ApiOrg) => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [owner, setOwner] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const { data } = await appOrgsApi.create({
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        ...(owner ? { ownerAppUserId: owner } : {}),
      });
      // The create response is a bare org row — the list column needs a count,
      // and a freshly created org has exactly the owner we just seeded (or
      // nobody). Without this the new row's Members cell renders blank.
      onCreated({ ...data, memberCount: owner ? 1 : 0 });
      pushToast(t`${data.name} created.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="flex w-[min(460px,100vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <SheetHeader className="shrink-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <SheetTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>New organization</Trans></SheetTitle>
          <SheetDescription className="text-[12.5px]">
            <Trans>Seed an owner now, or leave it empty and add members once it exists.</Trans>
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="w-full" viewportClassName="max-h-[calc(100vh-14rem)]">
          <div className="flex flex-col gap-4 px-5 py-[18px]">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Name</Trans></label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t`Acme Inc.`} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Slug</Trans></label>
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder={t`derived from the name`} />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>URL handle, unique per workspace. Leave blank to derive it from the name.</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>First owner</Trans></label>
              <Select
                value={owner}
                onChange={setOwner}
                className="min-w-0"
                options={[
                  { value: "", label: t`No owner yet` },
                  ...appUsers.map((u) => ({ value: u.id, label: u.email })),
                ]}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>An end-user who can administer the org from your app. You can add one later.</Trans>
              </span>
            </div>
          </div>
        </ScrollArea>
        <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" disabled={!name.trim() || saving} onClick={() => void submit()}>
            {saving ? <Trans>Creating…</Trans> : <Trans>Create</Trans>}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function OrgDrawer({
  org,
  roles,
  appUsers,
  onClose,
  onPatched,
  onDelete,
  pushToast,
}: {
  org: ApiOrg;
  roles: ApiRole[];
  appUsers: ApiAppUser[];
  onClose: () => void;
  onPatched: (patch: Partial<ApiOrg>) => void;
  onDelete: () => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [saving, setSaving] = useState(false);
  const [members, setMembers] = useState<ApiOrgMember[]>([]);
  const [invites, setInvites] = useState<ApiOrgInvite[]>([]);
  const [addUser, setAddUser] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<OrgRole>("member");

  const dirty = name.trim() !== org.name || slug.trim() !== org.slug;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [m, i] = await Promise.all([
          appOrgsApi.members(org.id),
          appOrgsApi.invites(org.id).catch(() => ({ data: [] as ApiOrgInvite[] })),
        ]);
        if (cancelled) return;
        setMembers(m.data ?? []);
        setInvites(i.data ?? []);
      } catch (e) {
        if (!cancelled) pushToast((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [org.id]);

  const save = async () => {
    setSaving(true);
    const patch = {
      ...(name.trim() !== org.name ? { name: name.trim() } : {}),
      ...(slug.trim() !== org.slug ? { slug: slug.trim() } : {}),
    };
    try {
      const { data } = await appOrgsApi.patch(org.id, patch);
      // Reconcile with the server's answer — the slug is normalized server-side
      // (lowercased, non-alphanumerics collapsed), so echoing the typed value
      // back would drift from what's actually stored.
      onPatched({ name: data.name, slug: data.slug });
      pushToast(t`${data.name} updated.`);
      onClose();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  /** Members not yet in this org — the "add member" picker's options. */
  const candidates = appUsers.filter((u) => !members.some((m) => m.appUserId === u.id));

  const addMember = async (appUserId: string) => {
    const user = appUsers.find((u) => u.id === appUserId);
    if (!user) return;
    const snapshot = members;
    const optimistic: ApiOrgMember = {
      appUserId,
      email: user.email,
      name: user.name ?? null,
      status: user.status,
      role: "member",
      roles: [],
      createdAt: Date.now(),
    };
    setMembers((arr) => [...arr, optimistic]);
    setAddUser("");
    onPatched({ memberCount: snapshot.length + 1 });
    try {
      const { data } = await appOrgsApi.addMember(org.id, { appUserId });
      setMembers((arr) => arr.map((m) => (m.appUserId === appUserId ? data : m)));
      pushToast(t`${user.email} added.`);
    } catch (e) {
      setMembers(snapshot);
      onPatched({ memberCount: snapshot.length });
      pushToast((e as Error).message);
    }
  };

  const setMemberRole = async (m: ApiOrgMember, role: OrgRole) => {
    const snapshot = members;
    setMembers((arr) => arr.map((x) => (x.appUserId === m.appUserId ? { ...x, role } : x)));
    try {
      await appOrgsApi.patchMember(org.id, m.appUserId, { role });
    } catch (e) {
      setMembers(snapshot);
      pushToast((e as Error).message);
    }
  };

  const setMemberRoles = async (m: ApiOrgMember, roleIds: string[]) => {
    const snapshot = members;
    const byId = new Map(roles.map((r) => [r.id, r] as const));
    setMembers((arr) =>
      arr.map((x) =>
        x.appUserId === m.appUserId
          ? { ...x, roles: roleIds.map((id) => ({ id, name: byId.get(id)?.name ?? id })) }
          : x,
      ),
    );
    try {
      await appOrgsApi.patchMember(org.id, m.appUserId, { roleIds });
    } catch (e) {
      setMembers(snapshot);
      pushToast((e as Error).message);
    }
  };

  const removeMember = async (m: ApiOrgMember) => {
    const snapshot = members;
    setMembers((arr) => arr.filter((x) => x.appUserId !== m.appUserId));
    onPatched({ memberCount: Math.max(0, snapshot.length - 1) });
    try {
      await appOrgsApi.removeMember(org.id, m.appUserId);
      pushToast(t`${m.email} removed.`);
    } catch (e) {
      setMembers(snapshot);
      onPatched({ memberCount: snapshot.length });
      pushToast((e as Error).message);
    }
  };

  const sendInvite = async () => {
    const email = inviteEmail.trim();
    if (!email) return;
    setInviteEmail("");
    try {
      const { data } = await appOrgsApi.invite(org.id, { email, role: inviteRole });
      const { data: fresh } = await appOrgsApi.invites(org.id);
      setInvites(fresh ?? []);
      pushToast(t`Invitation sent to ${data.email}.`);
    } catch (e) {
      setInviteEmail(email);
      pushToast((e as Error).message);
    }
  };

  const revokeInvite = async (inv: ApiOrgInvite) => {
    const snapshot = invites;
    setInvites((arr) => arr.filter((x) => x.id !== inv.id));
    try {
      await appOrgsApi.revokeInvite(org.id, inv.id);
    } catch (e) {
      setInvites(snapshot);
      pushToast((e as Error).message);
    }
  };

  const pendingInvites = invites.filter((i) => i.pending);

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="flex w-[min(620px,100vw)] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <SheetHeader className="shrink-0 flex-row items-start gap-3 space-y-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <div className="grid size-10 shrink-0 place-items-center rounded-control bg-primary text-primary-foreground">
            <I.Building size={16} />
          </div>
          <div className="min-w-0">
            <SheetTitle className="text-base font-semibold tracking-[-0.01em]">{org.name}</SheetTitle>
            <SheetDescription className="mt-0.5 text-[12.5px]">
              <span className="font-mono">{org.slug}</span> · {members.length} <Trans>members</Trans>
            </SheetDescription>
          </div>
        </SheetHeader>

        <ScrollArea className="w-full" viewportClassName="max-h-[calc(100vh-11rem)]">
          <div className="flex flex-col gap-8 px-5 py-[18px]">
            <div>
              <div className="mb-2 text-[12.5px] font-medium"><Trans>Details</Trans></div>
              <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Name</Trans></label>
                  <Input value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Slug</Trans></label>
                  <Input value={slug} onChange={(e) => setSlug(e.target.value)} />
                </div>
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium">
                <span><Trans>Members</Trans></span>
                <span className="text-[11.5px] font-normal text-muted-foreground">{members.length}</span>
              </div>
              {members.length === 0 ? (
                <div className="rounded-control border border-dashed border-border p-3.5 text-center text-[12.5px] text-muted-foreground">
                  <Trans>No members yet.</Trans>
                </div>
              ) : (
                <div className="flex flex-col overflow-hidden rounded-control border border-border">
                  {members.map((m) => (
                    <div key={m.appUserId} className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <div className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                          <div className="truncate text-[12.5px] font-medium">{m.email}</div>
                          {m.name && <div className="truncate text-[11.5px] text-muted-foreground">{m.name}</div>}
                        </div>
                        <Select
                          value={m.role}
                          onChange={(v) => void setMemberRole(m, v as OrgRole)}
                          className="min-w-0 flex-1 sm:w-[120px] sm:flex-none"
                          options={ORG_ROLE_OPTIONS}
                        />
                        <Button size="sm" variant="ghost" className="shrink-0 text-destructive" onClick={() => void removeMember(m)}>
                          <Trans>Remove</Trans>
                        </Button>
                      </div>
                      {roles.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground">
                            <Trans>In-org roles</Trans>
                          </span>
                          {roles.map((r) => {
                            const on = m.roles.some((x) => x.id === r.id);
                            return (
                              <button
                                key={r.id}
                                type="button"
                                onClick={() =>
                                  void setMemberRoles(
                                    m,
                                    on
                                      ? m.roles.filter((x) => x.id !== r.id).map((x) => x.id)
                                      : [...m.roles.map((x) => x.id), r.id],
                                  )
                                }
                                className="cursor-pointer"
                              >
                                <Badge variant={on ? "default" : "outline"}>{r.name}</Badge>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {candidates.length > 0 && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Select
                    value={addUser}
                    onChange={setAddUser}
                    className={`min-w-0 ${ROW_ITEM}`}
                    options={[
                      { value: "", label: t`Add an end-user…` },
                      ...candidates.map((u) => ({ value: u.id, label: u.email })),
                    ]}
                  />
                  <Button size="sm" variant="outline" className="shrink-0" disabled={!addUser} onClick={() => void addMember(addUser)}>
                    <Trans>Add</Trans>
                  </Button>
                </div>
              )}
              <div className="mt-1.5 text-[11.5px] text-muted-foreground">
                <Trans>
                  The role dropdown governs org administration. In-org roles are workspace roles that
                  apply only inside this organization — the <span className="font-mono">admin</span> role
                  can never be granted here.
                </Trans>
              </div>
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium">
                <span><Trans>Pending invitations</Trans></span>
                <span className="text-[11.5px] font-normal text-muted-foreground">{pendingInvites.length}</span>
              </div>
              {pendingInvites.length === 0 ? (
                <div className="rounded-control border border-dashed border-border p-3.5 text-center text-[12.5px] text-muted-foreground">
                  <Trans>Nothing outstanding.</Trans>
                </div>
              ) : (
                <div className="flex flex-col overflow-hidden rounded-control border border-border">
                  {pendingInvites.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-[12.5px] font-medium">{inv.email}</span>
                        <span className="font-mono text-[11.5px] text-muted-foreground">
                          {inv.role} · <Trans>expires</Trans> {fmtDate(inv.expiresAt)}
                        </span>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => void revokeInvite(inv)}>
                        <Trans>Revoke</Trans>
                      </Button>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <Input
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder={t`colleague@example.com`}
                  className={`min-w-0 ${ROW_ITEM}`}
                />
                <Select
                  value={inviteRole}
                  onChange={(v) => setInviteRole(v as OrgRole)}
                  className="min-w-0 flex-1 sm:w-[120px] sm:flex-none"
                  options={ORG_ROLE_OPTIONS}
                />
                <Button size="sm" variant="outline" className="shrink-0" disabled={!inviteEmail.trim()} onClick={() => void sendInvite()}>
                  <Trans>Invite</Trans>
                </Button>
              </div>
              <div className="mt-1.5 text-[11.5px] text-muted-foreground">
                <Trans>The invitee must already have an end-user account with this email, and accepts from your app.</Trans>
              </div>
            </div>

            <div className="rounded-control border border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_5%,var(--card))] px-3.5 py-3">
              <div className="mb-2 text-[12.5px] font-medium"><Trans>Danger zone</Trans></div>
              <div className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="text-[12.5px] font-medium text-destructive"><Trans>Delete organization</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground">
                    <Trans>Permanent. Removes memberships, in-org role bindings and invitations.</Trans>
                  </div>
                </div>
                <Button size="sm" variant="outline" className="shrink-0 text-destructive" onClick={onDelete}>
                  <Trans>Delete</Trans>
                </Button>
              </div>
            </div>
          </div>
        </ScrollArea>

        <SheetFooter className="shrink-0 flex-row justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose}><Trans>Close</Trans></Button>
          <Button variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save changes</Trans>}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
