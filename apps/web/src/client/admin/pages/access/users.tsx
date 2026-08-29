// Users page — workspace user table + role/provider filters + invite + drawer
import type { PushToast } from "../../types";
import { useCallback, useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, Checkbox, EmptyState, IconButton, PageHeader } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@backlex/ui/components/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import { rolesApi, tenantsApi, usersApi, type ApiRole, type ApiUser } from "../../api";
import { useTenants } from "../../queries";
import { UsersSkeleton } from "../../page-skeletons";
import { auth } from "@/lib/auth";

const ProviderGlyph = ({ kind, size = 12 }: { kind: string; size?: number }) => {
  if (kind === "github") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" /></svg>
  );
  if (kind === "google") return (
    <svg width={size} height={size} viewBox="0 0 24 24"><path fill="#4285F4" d="M22 12.2c0-.8-.07-1.6-.2-2.4H12v4.5h5.6a4.8 4.8 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.5 3.1-7.8Z" /><path fill="#34A853" d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7A10 10 0 0 0 12 22Z" /><path fill="#FBBC05" d="M6.2 13.6a6 6 0 0 1 0-3.8V7.1H2.7a10 10 0 0 0 0 9l3.5-2.5Z" /><path fill="#EA4335" d="M12 5.4c1.5 0 2.9.5 4 1.5l3-3A10 10 0 0 0 2.7 7.1l3.5 2.7C7 7.2 9.3 5.4 12 5.4Z" /></svg>
  );
  if (kind === "magic") return <I.Bolt size={size} />;
  if (kind === "saml") return <I.Shield size={size} />;
  if (kind === "ldap") return <I.Network size={size} />;
  if (kind === "cloud") return <I.Globe size={size} />;
  return <I.Lock size={size} />;
};

const PROVIDER_LABEL: Record<string, string> = {
  password: "password",
  github: "github",
  google: "google",
  magic: "magic link",
  saml: "SAML SSO",
  ldap: "LDAP / AD",
  cloud: "cloud SSO",
};

type UserRow = { id: string; name: string; email: string; roles: string[]; status: string; provider: string; mfa: boolean; last: string; lastIso: string | null; created: string; memberId?: string };

/**
 * Whether a password reset is a thing that can happen to this account.
 *
 * A federated identity's credential lives in the IdP: backlex holds no password
 * to replace, and mailing a reset link to a SAML/LDAP/cloud-SSO user offers them
 * a door their organisation has already decided they do not walk through. A
 * pending invite has no account at all yet — the invite link IS its credential.
 * Both cases are knowable from the row, so the control is simply not rendered
 * rather than rendered and then failing (or, as it did before, "succeeding").
 */
const canResetPassword = (u: { status: string; provider: string }): boolean =>
  u.status !== "invited" && !["saml", "ldap", "cloud", "invite"].includes(u.provider);

/**
 * Ask the auth server to mail a one-time password-reset link.
 *
 * better-auth's client RESOLVES on a refused request rather than throwing, so
 * the `error` half of its envelope is the only place a failure appears. Reading
 * it is the difference between "the mail went out" and "we posted something and
 * looked away" — and looking away is what every reset control on this page used
 * to do, two of them without even posting.
 */
const sendResetLink = async (email: string): Promise<void> => {
  const client = auth as unknown as {
    forgetPassword?: (o: { email: string; redirectTo?: string }) => Promise<{ error?: { message?: string } | null }>;
  };
  if (typeof client.forgetPassword !== "function")
    throw new Error("This deployment's auth client cannot send password resets.");
  const r = await client.forgetPassword({ email, redirectTo: "/reset-password" });
  if (r?.error) throw new Error(r.error.message || "The reset request was refused.");
};

const fmtRelative = (ts: number | null): string => {
  if (!ts) return "—";
  const ms = Date.now() - ts;
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};

const toUserRow = (u: ApiUser & { lastSeenAt?: number | null }): UserRow => {
  const lastSeenAt = u.lastSeenAt ?? null;
  return {
    id: u.id,
    name: u.name ?? u.email.split("@")[0]!,
    email: u.email,
    roles: u.roles.map((x) => x.name),
    status: u.status ?? "active",
    provider: u.provider ?? "password",
    mfa: u.twoFactorEnabled === true,
    last: fmtRelative(lastSeenAt),
    lastIso: lastSeenAt ? new Date(lastSeenAt).toISOString().slice(0, 19).replace("T", " ") : null,
    created: u.createdAt ? String(u.createdAt).slice(0, 10) : "—",
    memberId: u.memberId,
  };
};

export function UsersPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [users, setUsers] = useState<UserRow[]>([]);
  // First-load gate — drives the page skeleton until the user list lands.
  const [loaded, setLoaded] = useState(false);
  // Reconcile the whole list against the server. Used by the initial load and
  // after an invite so the optimistic pending row is replaced by server truth
  // (with the rest of the roster intact — the source of a "list showed only
  // the new invite until refresh" glitch).
  const reloadUsers = useCallback(async () => {
    const r = await usersApi.list();
    if (!Array.isArray(r.data)) return;
    setUsers(r.data.map(toUserRow));
  }, []);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await usersApi.list();
        if (cancelled || !Array.isArray(r.data)) return;
        setUsers(r.data.map(toUserRow));
      } catch (e) {
        pushToast?.((e as Error).message);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);
  // Real workspace roles for the invite dialog + the role filter — keeps both
  // in sync with whatever exists under Roles & permissions (no hardcoded list).
  const [roleNames, setRoleNames] = useState<string[]>([]);
  const [allRoles, setAllRoles] = useState<ApiRole[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await rolesApi.list();
        if (!cancelled && Array.isArray(r.data)) {
          setRoleNames(r.data.map((x) => x.name).filter((n) => n !== "public"));
          setAllRoles(r.data);
        }
      } catch {
        /* leave empty — the dialog/filter fall back to `authenticated` */
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [q, setQ] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [activeUser, setActiveUser] = useState<any>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  // A link handed back by a create or a resend. It is shown once, in a dialog,
  // because that response is the only place it exists — the list deliberately
  // stopped carrying invite tokens.
  const [freshLink, setFreshLink] = useState<null | { email: string; url: string; sent: boolean }>(null);

  // The workspace whose invites this page resends. `active` is what the server
  // says the session is scoped to; the first tenant is the fallback for a
  // single-workspace deployment that never set the cookie.
  const tenantsQuery = useTenants();
  const tenantId = tenantsQuery.data?.active ?? tenantsQuery.data?.data[0]?.id ?? null;

  const filtered = users.filter((u) => {
    if (q && !(u.name.toLowerCase().includes(q.toLowerCase()) || u.email.toLowerCase().includes(q.toLowerCase()))) return false;
    if (roleFilter !== "all" && !u.roles.includes(roleFilter)) return false;
    if (statusFilter !== "all" && u.status !== statusFilter) return false;
    if (providerFilter !== "all" && u.provider !== providerFilter) return false;
    return true;
  });

  const stats = {
    total: users.length,
    active24h: users.filter((u) => /m ago|h ago|just now/.test(u.last)).length,
    pending: users.filter((u) => u.status === "invited").length,
    admins: users.filter((u) => u.roles.includes("admin")).length,
  };

  const toggleAll = () => {
    if (selected.size === filtered.length) setSelected(new Set());
    else setSelected(new Set(filtered.map((u) => u.id)));
  };
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const allChecked = selected.size > 0 && selected.size === filtered.length;
  const someChecked = selected.size > 0 && selected.size < filtered.length;

  const statusBadge = (s: string) => {
    if (s === "active") return <Badge variant="default"><Trans>active</Trans></Badge>;
    if (s === "invited") return <Badge variant="outline"><Trans>invited</Trans></Badge>;
    if (s === "suspended") return <Badge variant="destructive"><Trans>suspended</Trans></Badge>;
    return <Badge variant="secondary">{s}</Badge>;
  };

  /**
   * Apply one verb to the whole selection.
   *
   * `Promise.allSettled` never rejects, so the `catch` this used to sit in was
   * unreachable and the closing toast announced the full count whatever the
   * server had done — every request could have 403'd and the operator would
   * still read "Suspended 5 users." Failures are counted instead, and a mixed
   * outcome ends in a re-read: which rows actually moved is the server's
   * answer to give, not something worth reconstructing from a snapshot.
   */
  const bulk = async (verb: "delete" | "suspend" | "activate") => {
    const ids = [...selected];
    const chosen = new Set(ids);
    const snapshot = users;
    const call =
      verb === "delete" ? usersApi.remove : verb === "suspend" ? usersApi.suspend : usersApi.activate;
    if (verb === "delete") setUsers((arr) => arr.filter((u) => !chosen.has(u.id)));
    else
      setUsers((arr) =>
        arr.map((u) => (chosen.has(u.id) ? { ...u, status: verb === "suspend" ? "suspended" : "active" } : u)),
      );
    setSelected(new Set());

    const results = await Promise.allSettled(ids.map((id) => call(id)));
    const done = results.filter((r) => r.status === "fulfilled").length;
    const past = verb === "delete" ? "Deleted" : verb === "suspend" ? "Suspended" : "Activated";
    if (done === ids.length) {
      pushToast(t`${past} ${ids.length} user${ids.length === 1 ? "" : "s"}.`);
      return;
    }
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    pushToast(t`${past} ${done} of ${ids.length} — ${(failure.reason as Error).message}`);
    setUsers(snapshot);
    void reloadUsers().catch(() => {/* the snapshot stands until the next load */});
  };

  const applyUserPatch = (id: string, patch: { name?: string; roles?: string[] }) => {
    setUsers((arr) => arr.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  };

  /**
   * Mail reset links to everyone in the selection who can receive one, and say
   * how many actually went out.
   *
   * The count is not decoration. This used to be a `pushToast` with no request
   * behind it, which is the same sentence a working button prints — so the
   * replacement reports what the server answered, per address, rather than
   * asserting a number the click merely intended.
   */
  const bulkReset = async () => {
    const targets = users.filter((u) => selected.has(u.id) && canResetPassword(u));
    if (targets.length === 0) {
      pushToast(t`No selected account has a password for backlex to reset.`);
      return;
    }
    const results = await Promise.allSettled(targets.map((u) => sendResetLink(u.email)));
    const sent = results.filter((r) => r.status === "fulfilled").length;
    const failure = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    if (sent === 0) pushToast((failure?.reason as Error)?.message ?? t`No reset link could be sent.`);
    else if (failure) pushToast(t`Reset link sent to ${sent} of ${targets.length} — ${(failure.reason as Error).message}`);
    else pushToast(t`Reset link sent to ${sent} user${sent === 1 ? "" : "s"}.`);
    setSelected(new Set());
  };

  /**
   * Mint a fresh invite token for a pending member and surface the new link.
   *
   * This replaces a "Copy invite link" item that read a field the list stopped
   * returning, so it silently vanished from a row after a reload while still
   * appearing for one created in the same session. A resend is the honest form
   * of that action anyway: the old token is rotated, so the only link that can
   * now seat an account is the one this call just produced.
   */
  const resendInvite = async (u: UserRow) => {
    if (!tenantId) {
      pushToast(t`No active workspace — cannot resend this invite.`);
      return;
    }
    try {
      const r = await tenantsApi.resendInvite(tenantId, u.memberId ?? u.id);
      if (r.data?.url) setFreshLink({ email: u.email, url: r.data.url, sent: !!r.data.sent });
      else pushToast(t`Invite re-sent to ${u.email}.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  // First whole-page fetch — the user list hasn't landed yet.
  if (!loaded) return <UsersSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Team`}
        description={t`Operators with access to this dashboard. The first to sign up becomes admin; everyone else lands in authenticated. Sessions, providers, and 2FA are tracked per account.`}
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setInviteOpen(true)}><Trans>Invite</Trans></Button>}
      />

      <div className="grid grid-cols-4 gap-2.5 max-[900px]:grid-cols-2">
        {[
          { label: t`Total members`, value: stats.total, hint: t`${users.filter((u) => u.status === "active").length} active` },
          { label: t`Active in 24h`, value: stats.active24h, hint: t`${Math.round((stats.active24h / Math.max(1, stats.total)) * 100)}% of base` },
          { label: t`Pending invites`, value: stats.pending, hint: stats.pending ? t`awaiting accept` : t`none` },
          { label: t`Admins`, value: stats.admins, hint: t`full access` },
        ].map((s) => (
          <div key={s.label} className="flex flex-col gap-1 rounded-control border border-border bg-card px-4 py-3.5">
            <span className="text-[11.5px] uppercase tracking-[0.02em] text-muted-foreground">{s.label}</span>
            <span className="text-[26px] font-semibold tracking-[-0.02em]">{s.value}</span>
            <span className="text-[11.5px] text-muted-foreground">{s.hint}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <InputGroup className="min-w-[280px] flex-[0_1_320px]">
          <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
          <InputGroupInput value={q} onChange={(e) => setQ(e.target.value)} placeholder={t`Search by name or email…`} />
          {q && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" onClick={() => setQ("")}><I.X size={11} /></InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[11.5px] text-muted-foreground"><Trans>Role</Trans></span>
          <Select size="sm" value={roleFilter} onChange={setRoleFilter} className="w-[140px]"
            options={[{ value: "all", label: t`All roles` }, ...roleNames.map((n) => ({ value: n, label: n }))]} />
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[11.5px] text-muted-foreground"><Trans>Status</Trans></span>
          <Select size="sm" value={statusFilter} onChange={setStatusFilter} className="w-[140px]"
            options={[{ value: "all", label: t`All statuses` }, { value: "active", label: "active" }, { value: "invited", label: "invited" }, { value: "suspended", label: "suspended" }]} />
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[11.5px] text-muted-foreground"><Trans>Provider</Trans></span>
          <Select size="sm" value={providerFilter} onChange={setProviderFilter} className="w-[150px]"
            options={[{ value: "all", label: t`All providers` }, { value: "password", label: "password" }, { value: "github", label: "github" }, { value: "google", label: "google" }, { value: "magic", label: "magic link" }, { value: "saml", label: "SAML SSO" }, { value: "ldap", label: "LDAP / AD" }, { value: "cloud", label: "cloud SSO" }]} />
        </div>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground"><Trans>{filtered.length} of {users.length}</Trans></span>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-control border border-[color-mix(in_oklch,var(--primary)_40%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))] px-3 py-2">
          <Badge variant="default"><Trans>{selected.size} selected</Trans></Badge>
          <span className="text-[12.5px] text-muted-foreground"><Trans>Apply to selection:</Trans></span>
          <Button size="sm" variant="outline" onClick={() => bulk("activate")}><Trans>Activate</Trans></Button>
          <Button size="sm" variant="outline" onClick={() => bulk("suspend")}><Trans>Suspend</Trans></Button>
          {/* Offered only while the selection contains an account a reset can
              reach — a federated or still-invited selection has nothing for
              this button to do, so it is not drawn. */}
          {users.some((u) => selected.has(u.id) && canResetPassword(u)) && (
            <Button size="sm" variant="outline" onClick={() => void bulkReset()}><Trans>Reset password</Trans></Button>
          )}
          <Button size="sm" variant="outline" onClick={() => bulk("delete")} className="text-destructive"><Trans>Delete</Trans></Button>
          <div className="flex-1" />
          <Button variant="ghost" size="xs" icon={I.X} onClick={() => setSelected(new Set())} title={t`Clear selection`} />
        </div>
      )}

      {filtered.length === 0 ? (
        // Outside the table on purpose — an in-table empty state centers
        // inside the horizontal scroller and hangs off-screen on mobile.
        <EmptyState
          icon={I.Users}
          title={<Trans>No users match</Trans>}
          description={<Trans>Adjust your filters or invite a new teammate.</Trans>}
        />
      ) : (
      <Card className="py-0 gap-0">
        <Table className="[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground">
          <TableHeader>
            <TableRow>
              <TableHead className="w-9">
                <Checkbox checked={allChecked} indeterminate={someChecked} onChange={toggleAll} />
              </TableHead>
              <TableHead><Trans>User</Trans></TableHead>
              <TableHead className="w-[200px]"><Trans>Role</Trans></TableHead>
              <TableHead className="w-[130px]"><Trans>Status</Trans></TableHead>
              <TableHead className="w-[140px]"><Trans>Provider</Trans></TableHead>
              <TableHead className="w-[70px] text-center"><Trans>2FA</Trans></TableHead>
              <TableHead className="w-[120px]"><Trans>Last seen</Trans></TableHead>
              <TableHead className="sticky right-0 w-11 bg-card" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((u) => {
              return (
                <TableRow key={u.id} data-selected={selected.has(u.id)} onClick={() => { if (u.status !== "invited") setActiveUser(u); }} className="cursor-pointer data-[selected=true]:bg-selected-surface">
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground text-[12.5px] font-semibold tracking-[-0.01em]">{u.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}</div>
                      <div className="flex min-w-0 flex-col gap-px">
                        <span className="text-[13px] font-medium">{u.name}</span>
                        <span className="text-[11.5px] text-muted-foreground">{u.email}</span>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {u.roles.map((r) => <Badge key={r} variant={r === "admin" ? "default" : "secondary"}>{r}</Badge>)}
                    </div>
                  </TableCell>
                  <TableCell>{statusBadge(u.status)}</TableCell>
                  <TableCell>
                    {u.status === "invited" ? (
                      <span className="font-mono text-[11.5px] text-muted-foreground">—</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-foreground">
                        <ProviderGlyph kind={u.provider} />
                        <span className="text-[12.5px]">{PROVIDER_LABEL[u.provider] ?? u.provider}</span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    {u.mfa
                      ? <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklch,oklch(0.55_0.15_145)_35%,var(--border))] bg-[color-mix(in_oklch,oklch(0.78_0.14_145)_14%,transparent)] px-[7px] py-0.5 font-mono text-[11px] text-[oklch(0.55_0.15_145)]" title={t`2FA enabled`}><I.Shield size={11} /> <Trans>on</Trans></span>
                      : <span className="inline-flex items-center gap-1 rounded-full border border-border px-[7px] py-0.5 font-mono text-[11px] text-muted-foreground" title={t`2FA disabled`}><Trans>off</Trans></span>}
                  </TableCell>
                  <TableCell className="font-mono text-[11.5px] text-muted-foreground">{u.last}</TableCell>
                  <TableCell className="sticky right-0 bg-card text-right" onClick={(e) => e.stopPropagation()}>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <IconButton icon={I.More} />
                      </DropdownMenuTrigger>
                      {u.status === "invited" ? (
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onSelect={() => { void resendInvite(u); }}>
                            <I.Mail size={12} /><Trans>Resend invite</Trans>
                          </DropdownMenuItem>
                          <DropdownMenuItem variant="destructive" onSelect={() => {
                            const memberId = u.memberId ?? u.id;
                            const snapshot = users;
                            setUsers((arr) => arr.filter((x) => x.id !== u.id));
                            void usersApi.revokeInvite(memberId).then(
                              () => pushToast(t`Invite to ${u.email} revoked.`),
                              (e) => { setUsers(snapshot); pushToast((e as Error).message); },
                            );
                          }}><I.Trash size={12} /><Trans>Revoke invite</Trans></DropdownMenuItem>
                        </DropdownMenuContent>
                      ) : (
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => { setActiveUser(u); }}><I.Eye size={12} /><Trans>View profile</Trans></DropdownMenuItem>
                        {canResetPassword(u) && (
                          <DropdownMenuItem onSelect={() => {
                            void sendResetLink(u.email).then(
                              () => pushToast(t`Reset link sent to ${u.email}.`),
                              (e: Error) => pushToast(e.message),
                            );
                          }}><I.Mail size={12} /><Trans>Send reset link</Trans></DropdownMenuItem>
                        )}
                        {/* Each of the four below paints first and rolls back on
                            refusal. They used to await the request, report the
                            error, and then apply the change and toast success
                            anyway — so a rejected suspend left the row reading
                            "suspended" behind two contradictory toasts. */}
                        {u.status !== "suspended" ? (
                          <DropdownMenuItem onSelect={() => {
                            const snapshot = users;
                            setUsers((arr) => arr.map((x) => x.id === u.id ? { ...x, status: "suspended" } : x));
                            void usersApi.suspend(u.id).then(
                              () => pushToast(t`${u.email} suspended.`),
                              (e) => { setUsers(snapshot); pushToast((e as Error).message); },
                            );
                          }}><I.Lock size={12} /><Trans>Suspend</Trans></DropdownMenuItem>
                        ) : (
                          <DropdownMenuItem onSelect={() => {
                            const snapshot = users;
                            setUsers((arr) => arr.map((x) => x.id === u.id ? { ...x, status: "active" } : x));
                            void usersApi.activate(u.id).then(
                              () => pushToast(t`${u.email} activated.`),
                              (e) => { setUsers(snapshot); pushToast((e as Error).message); },
                            );
                          }}><I.Check size={12} /><Trans>Activate</Trans></DropdownMenuItem>
                        )}
                        {u.mfa && (
                          <DropdownMenuItem onSelect={() => {
                            const snapshot = users;
                            setUsers((arr) => arr.map((x) => x.id === u.id ? { ...x, mfa: false } : x));
                            void usersApi.resetTwoFactor(u.id).then(
                              () => pushToast(t`2FA reset for ${u.email}. They can re-enrol from Account → Security.`),
                              (e) => { setUsers(snapshot); pushToast((e as Error).message); },
                            );
                          }}><I.Shield size={12} /><Trans>Reset 2FA</Trans></DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={() => {
                          const snapshot = users;
                          setUsers((arr) => arr.filter((x) => x.id !== u.id));
                          void usersApi.remove(u.id).then(
                            () => pushToast(t`${u.email} deleted.`),
                            (e) => { setUsers(snapshot); pushToast((e as Error).message); },
                          );
                        }}><I.Trash size={12} /><Trans>Delete</Trans></DropdownMenuItem>
                      </DropdownMenuContent>
                      )}
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Card>
      )}

      {activeUser && <UserDrawer user={activeUser} allRoles={allRoles} onClose={() => setActiveUser(null)} onSaved={applyUserPatch} onDeleted={(id) => setUsers((arr) => arr.filter((x) => x.id !== id))} pushToast={pushToast} />}
      {inviteOpen && <InviteUserDialog roles={roleNames} onClose={() => setInviteOpen(false)} pushToast={pushToast} onCreated={(inv) => {
        // Optimistic: append the pending-invite row immediately (dedupe by
        // email so a re-invite doesn't double it), then reconcile against the
        // server so the row carries authoritative fields on the next paint.
        setUsers((arr) => [
          ...arr.filter((x) => x.email !== inv.email),
          {
            id: inv.id,
            name: inv.email.split("@")[0] ?? inv.email,
            email: inv.email,
            roles: [inv.role],
            status: "invited",
            provider: "invite",
            mfa: false,
            last: "—",
            lastIso: null,
            created: new Date().toISOString().slice(0, 10),
            memberId: inv.id,
          },
        ]);
        void reloadUsers().catch(() => {/* keep the optimistic row */});
      }} />}
      {freshLink && (
        <Dialog open onOpenChange={(o) => { if (!o) setFreshLink(null); }}>
          <DialogContent className="w-[460px] max-w-[92vw] gap-0 p-0 sm:max-w-none">
            <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
              <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Invite re-sent</Trans></DialogTitle>
              <DialogDescription className="mt-0.5 text-[12.5px]"><Trans>The previous link no longer works. This one is valid for 7 days.</Trans></DialogDescription>
            </DialogHeader>
            <div className="px-5 py-[18px]">
              <InviteLinkPanel invite={freshLink} pushToast={pushToast} />
            </div>
            <DialogFooter className="border-t border-border bg-card px-5 py-3 sm:justify-end">
              <Button variant="primary" onClick={() => setFreshLink(null)}><Trans>Done</Trans></Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/**
 * The freshly-minted invite link, with the one thing the reader has to know
 * about it: whether an email carrying it actually went out.
 *
 * Shared by the create dialog and the resend flow because those two responses
 * are the ONLY places the link exists — the users list stopped returning invite
 * tokens, so there is no third surface to read one from.
 */
function InviteLinkPanel({ invite, pushToast }: { invite: { email: string; url: string; sent: boolean }; pushToast: PushToast }) {
  const { t } = useLingui();
  const copy = () => {
    void navigator.clipboard.writeText(invite.url).then(
      () => pushToast(t`Invite link copied.`),
      () => pushToast(invite.url),
    );
  };
  return (
    <div className="flex flex-col gap-1.5">
      {invite.sent ? (
        <span className="text-[12.5px] text-muted-foreground"><Trans>An invite email was sent to <span className="font-mono text-foreground">{invite.email}</span>. You can also share the link directly:</Trans></span>
      ) : (
        <span className="text-[12.5px] text-muted-foreground"><Trans>No email service is configured, so nothing was sent to <span className="font-mono text-foreground">{invite.email}</span> — share this link with them directly:</Trans></span>
      )}
      <div className="flex items-center gap-2">
        <Input readOnly value={invite.url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-[12px]" />
        <Button variant="outline" size="sm" className="shrink-0" onClick={copy}><I.Link size={12} /><Trans>Copy link</Trans></Button>
      </div>
    </div>
  );
}

function UserDrawer({ user, allRoles, onClose, onSaved, onDeleted, pushToast }: { user: any; allRoles: ApiRole[]; onClose: () => void; onSaved: (id: string, patch: { name?: string; roles?: string[] }) => void; onDeleted: (id: string) => void; pushToast: PushToast }) {
  const { t } = useLingui();
  const [name, setName] = useState<string>(user.name ?? "");
  const [roles, setRoles] = useState<string[]>(user.roles as string[]);
  const [saving, setSaving] = useState(false);
  // Live sessions for this user — pulled from /api/users/:id/sessions which
  // surfaces sessions.user_agent + sessions.ip_address. Falls back to a
  // single placeholder row when the API returns nothing.
  const [sessions, setSessions] = useState<any[]>([]);
  // Real activity rows for this user (admin sees all; non-admin would only
  // see their own rows by virtue of the activity route's permission gate).
  const [activity, setActivity] = useState<{ t: string; ev: string; meta: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const j = await usersApi.sessions(user.id);
        if (cancelled) return;
        const fmtAgo = (ms: number | null): string => {
          if (!ms) return "—";
          const d = Date.now() - ms;
          if (d < 60_000) return "just now";
          if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
          if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
          return `${Math.floor(d / 86_400_000)}d ago`;
        };
        setSessions(
          (j.data ?? []).map((s, i) => ({
            id: s.id ?? `s${i}`,
            device: s.userAgent ?? "Unknown device",
            ip: s.ipAddress ?? "—",
            last: fmtAgo(s.updatedAt ?? s.createdAt ?? null),
          })),
        );
      } catch {
        // leave empty
      }
    })();
    void (async () => {
      try {
        const r = await fetch(`/api/activity?limit=20`, { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: any[] };
        const filtered = (j.data ?? []).filter((a) => a.userId === user.id || a.user_id === user.id);
        setActivity(
          filtered.slice(0, 6).map((a) => ({
            t: new Date(a.createdAt ?? a.created_at).toISOString().slice(0, 16).replace("T", " "),
            ev: `${a.collection ?? "?"}.${a.action}`,
            meta: a.itemId ? `id ${String(a.itemId).slice(0, 12)}` : "—",
          })),
        );
      } catch {
        // leave empty
      }
    })();
    return () => { cancelled = true; };
  }, [user.id]);

  const dirty =
    name.trim() !== (user.name ?? "").trim() ||
    [...roles].sort().join(" ") !== [...(user.roles as string[])].sort().join(" ");

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      if (name.trim() && name.trim() !== (user.name ?? "")) {
        await usersApi.update(user.id, { name: name.trim() });
      }
      const before = new Set(user.roles as string[]);
      const after = new Set(roles);
      const roleId = (n: string) => allRoles.find((x) => x.name === n)?.id;
      for (const n of roles) {
        if (!before.has(n)) { const id = roleId(n); if (id) await usersApi.addRole(user.id, id); }
      }
      for (const n of user.roles as string[]) {
        if (!after.has(n)) { const id = roleId(n); if (id) await usersApi.removeRole(user.id, id); }
      }
      onSaved(user.id, { name: name.trim() || (user.name ?? ""), roles });
      pushToast(t`Profile saved.`);
      onClose();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-[min(560px,100vw)] gap-0 p-0 sm:max-w-none">
        <SheetHeader className="flex-row items-start gap-3 space-y-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <div className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-sm font-semibold tracking-[-0.01em] text-primary-foreground">{(user.name || user.email).split(" ").map((p: string) => p[0]?.toUpperCase()).filter(Boolean).slice(0, 2).join("")}</div>
          <div className="min-w-0">
            <SheetTitle className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em]">
              {name || user.email}
              {user.status === "active" && <Badge variant="default"><Trans>active</Trans></Badge>}
              {user.status === "invited" && <Badge variant="outline"><Trans>invited</Trans></Badge>}
              {user.status === "suspended" && <Badge variant="destructive"><Trans>suspended</Trans></Badge>}
            </SheetTitle>
            <SheetDescription className="mt-0.5 text-[12.5px]">{user.email} · id <span className="font-mono">{user.id}</span></SheetDescription>
          </div>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-8 px-5 py-[18px]">
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground"><Trans>Name</Trans></label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t`Display name`} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium text-foreground"><Trans>Roles</Trans></label>
              <div className="flex flex-col overflow-hidden rounded-control border border-border">
                {allRoles.filter((r) => r.name !== "public").map((r) => (
                  <label key={r.id} className="flex cursor-pointer items-center gap-2.5 border-b border-border px-3 py-2.5 last:border-b-0">
                    <Checkbox
                      checked={roles.includes(r.name)}
                      onChange={() => setRoles((arr) => arr.includes(r.name) ? arr.filter((n) => n !== r.name) : [...arr, r.name])}
                    />
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[12.5px] font-medium">{r.name}</span>
                      {ROLE_HINTS[r.name] && <span className="text-[11.5px] text-muted-foreground">{ROLE_HINTS[r.name]}</span>}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-3.5 gap-y-2.5 rounded-control bg-muted px-3.5 py-3 max-[900px]:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Provider</Trans></span><span className="inline-flex items-center gap-1.5 text-foreground"><ProviderGlyph kind={user.provider} size={12} />{PROVIDER_LABEL[user.provider] ?? user.provider}</span></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>2FA</Trans></span>{user.mfa ? <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklch,oklch(0.55_0.15_145)_35%,var(--border))] bg-[color-mix(in_oklch,oklch(0.78_0.14_145)_14%,transparent)] px-[7px] py-0.5 font-mono text-[11px] text-[oklch(0.55_0.15_145)]"><I.Shield size={11} /> <Trans>enrolled</Trans></span> : <span className="inline-flex items-center gap-1 rounded-full border border-border px-[7px] py-0.5 font-mono text-[11px] text-muted-foreground"><Trans>disabled</Trans></span>}</div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Created</Trans></span><span className="font-mono text-xs">{user.created}</span></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Last seen</Trans></span><span className="font-mono text-xs">{user.lastIso || "—"}</span></div>
            {/* Counted from the sessions the drawer actually fetched. The row
                carried no such number — the field was hardcoded to 0, so this
                tile read "0 active" above a list of three live sessions. */}
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground"><Trans>Sessions</Trans></span><span className="font-mono text-xs"><Trans>{sessions.length} active</Trans></span></div>
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
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                        {s.device}
                      </span>
                      <span className="font-mono text-[11.5px] text-muted-foreground"><Trans>{s.ip} · last seen {s.last}</Trans></span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={async () => {
                      try {
                        await usersApi.revokeSession(user.id, s.id);
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

          <div>
            <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium">
              <span><Trans>Recent activity</Trans></span>
              {/* "last 30 days" was a claim the query does not make: it asks for
                  the newest 20 rows workspace-wide and keeps this user's. */}
              <span className="text-[11.5px] font-normal text-muted-foreground"><Trans>most recent</Trans></span>
            </div>
            {activity.length === 0 ? (
              <div className="rounded-control border border-dashed border-border p-3.5 text-center text-[12.5px] text-muted-foreground"><Trans>No recent activity.</Trans></div>
            ) : (
            <div className="flex flex-col overflow-hidden rounded-control border border-border">
              {activity.map((a, i) => (
                <div key={i} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-xs">{a.ev}</span>
                    <span className="text-[11.5px] text-muted-foreground">{a.meta}</span>
                  </div>
                  <span className="font-mono text-[11.5px] text-muted-foreground">{a.t}</span>
                </div>
              ))}
            </div>
            )}
          </div>

          <div className="rounded-control border border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_5%,var(--card))] px-3.5 py-3">
            <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium"><span><Trans>Danger zone</Trans></span></div>
            {/* Same rule as the row menu: an account whose credential lives in
                an IdP has no password here to reset, so the control is absent
                rather than present-and-lying. */}
            {canResetPassword(user) && (
              <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color-mix(in_oklch,var(--destructive)_18%,var(--border))] py-2 last:border-b-0">
                <div>
                  <div className="text-[12.5px] font-medium"><Trans>Send password reset</Trans></div>
                  <div className="text-[11.5px] text-muted-foreground"><Trans>Emails a one-time link valid for 30 minutes.</Trans></div>
                </div>
                <Button size="sm" variant="outline" onClick={async () => {
                  // `forgetPassword` was optional-chained here, so on a client
                  // without the method the call evaluated to `undefined`, the
                  // await resolved, and the success toast fired regardless.
                  try {
                    await sendResetLink(user.email);
                    pushToast(t`Reset link sent to ${user.email}.`);
                  } catch (e) {
                    pushToast((e as Error).message);
                  }
                }}><Trans>Send</Trans></Button>
              </div>
            )}
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color-mix(in_oklch,var(--destructive)_18%,var(--border))] py-2 last:border-b-0">
              <div>
                <div className="text-[12.5px] font-medium"><Trans>Revoke all sessions</Trans></div>
                <div className="text-[11.5px] text-muted-foreground"><Trans>Forces re-login on every device immediately.</Trans></div>
              </div>
              <Button size="sm" variant="outline" onClick={async () => {
                // The catch used to fall through to the success toast, so a
                // refused revoke told the operator every device was signed out.
                try { await usersApi.revokeAll(user.id); } catch (e) { pushToast((e as Error).message); return; }
                setSessions([]);
                pushToast(t`Sessions revoked for ${user.email}.`);
              }}><Trans>Revoke</Trans></Button>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color-mix(in_oklch,var(--destructive)_18%,var(--border))] py-2 last:border-b-0">
              <div>
                <div className="text-[12.5px] font-medium text-destructive"><Trans>Delete user</Trans></div>
                <div className="text-[11.5px] text-muted-foreground"><Trans>Permanent. Owned items remain; ownership is reassigned to admin.</Trans></div>
              </div>
              <Button size="sm" variant="outline" className="text-destructive" onClick={async () => {
                // A refused delete closed the drawer and reported the account
                // gone; the row was still there behind it.
                try { await usersApi.remove(user.id); } catch (e) { pushToast((e as Error).message); return; }
                onDeleted(user.id);
                pushToast(t`${user.email} deleted.`);
                onClose();
              }}><Trans>Delete</Trans></Button>
            </div>
          </div>
        </div>
        </ScrollArea>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose}><Trans>Close</Trans></Button>
          <Button variant="primary" onClick={handleSave} disabled={!dirty || saving}><Trans>Save changes</Trans></Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

const ROLE_HINTS: Record<string, string> = {
  admin: "full access — bypasses permission checks",
  authenticated: "standard signed-in user",
};
function InviteUserDialog({ roles, onClose, onCreated, pushToast }: { roles: string[]; onClose: () => void; onCreated: (inv: { id: string; email: string; role: string; url: string }) => void; pushToast: PushToast }) {
  const roleOptions = (roles.length ? roles : ["authenticated"]).map((name) => ({
    value: name,
    label: name,
    hint: ROLE_HINTS[name] ?? "custom role",
  }));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(
    roleOptions.some((o) => o.value === "authenticated") ? "authenticated" : roleOptions[0]!.value,
  );
  const [busy, setBusy] = useState(false);
  // After a successful create: the accept link + whether a real email went
  // out. Deployments without SMTP rely on the admin copying this link.
  const [created, setCreated] = useState<null | { email: string; url: string; sent: boolean }>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await usersApi.invite(email.trim().toLowerCase(), role);
      onCreated({ id: r.data.id, email: r.data.email, role, url: r.data.url });
      setCreated({ email: r.data.email, url: r.data.url, sent: r.data.sent });
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
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">{created ? <Trans>Invite created</Trans> : <Trans>Invite user</Trans>}</DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px]">{created ? <Trans>The invite is valid for 7 days.</Trans> : <Trans>Send an email invite. The user finishes signup themselves.</Trans>}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4 px-5 py-[18px]">
            <InviteLinkPanel invite={created} pushToast={pushToast} />
          </div>
        ) : (
        <DialogBody>
        <div className="flex flex-col gap-4 px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Email</Trans></label>
            <Input autoFocus placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <span className="text-[11.5px] text-muted-foreground"><Trans>An invite link will be emailed; valid for 7 days.</Trans></span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Default role</Trans></label>
            <Select value={role} onChange={setRole} options={roleOptions} />
            <span className="text-[11.5px] text-muted-foreground"><Trans>Roles come from <strong>Roles &amp; permissions</strong>. The user also implicitly gets <span className="font-mono">authenticated</span>.</Trans></span>
          </div>
        </div>
        </DialogBody>
        )}
        <DialogFooter className="border-t border-border bg-card px-5 py-3 sm:justify-end">
          {created ? (
            <Button variant="primary" onClick={onClose}><Trans>Done</Trans></Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose}><Trans>Cancel</Trans></Button>
              <Button variant="primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? <Trans>Creating…</Trans> : <Trans>Send invite</Trans>}</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
