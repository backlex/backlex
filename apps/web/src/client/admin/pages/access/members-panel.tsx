// Members panel — workspace member management for multi-tenant.
//
// Every mutation here is optimistic: the row changes on the click and the
// request reconciles behind it. That is the house rule everywhere except
// erasure, and it matters most on this panel because the server rules are
// genuinely restrictive — an `admin` may not mint an `owner`, nobody may demote
// or remove the last one — so a rejection is an ordinary outcome rather than an
// exception. Each handler therefore snapshots the query cache before it paints,
// and puts the snapshot back with the server's own sentence in a toast when the
// request is refused.
import type { PushToast } from "../../types";
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../../icons";
import { Badge, Button, IconButton } from "../../ui";
import { Select } from "../../select";
import { tenantsApi, type ApiTenantMember, type Envelope } from "../../api";
import { queryKeys, useMe, useTenantMembers, useTenants } from "../../queries";
import type { RoleData } from "./role-editor";
import { useUrlState } from "@/lib/use-url-state";
import { SkeletonList } from "../../loading";

interface Member {
  id: string;
  /** The platform user behind the row — null while the invite is pending. */
  userId: string | null;
  name: string;
  email: string;
  role: string;
  last: string;
  status: "active" | "invited" | "suspended";
  avatar: string;
  color: string;
}

// Typed as a non-empty tuple so `PALETTE[0]` is a usable fallback for the
// modulo lookup below — under `noUncheckedIndexedAccess` a plain `string[]`
// makes every index read `string | undefined`, including the one the modulo
// already proves is in range.
const PALETTE: [string, ...string[]] = [
  "oklch(0.72 0.18 145)",
  "oklch(0.78 0.16 95)",
  "oklch(0.7 0.16 28)",
  "oklch(0.72 0.16 240)",
  "oklch(0.7 0.16 320)",
  "oklch(0.74 0.14 200)",
];

/**
 * The workspace membership ladder, mirrored from
 * `server/services/membership-guards.ts::WORKSPACE_RANK`.
 *
 * Restated rather than imported because that module lives on the server and
 * throws `AppError`; pulling it into the SPA bundle would drag the server's
 * error layer across the boundary for four integers. The server remains the
 * authority — this copy only decides which options are worth OFFERING, so the
 * worst a drift can do is show a choice the server then refuses, which the
 * rollback path already handles.
 */
const WORKSPACE_RANK: Readonly<Record<string, number>> = {
  owner: 4,
  admin: 3,
  editor: 2,
  member: 1,
};

/**
 * The roles this panel will hand out.
 *
 * `editor` is deliberately absent: it is deprecated and folded into `member` at
 * the HTTP boundary, so offering it would promise a distinction the server no
 * longer keeps. Rows written before that still read as `editor`, and the row's
 * own value is appended to its dropdown below so it still displays.
 */
const GRANTABLE_ROLES = ["owner", "admin", "member"] as const;

const rankOf = (role: string | undefined): number =>
  (role ? WORKSPACE_RANK[role] : undefined) ?? 0;

const fmtRelative = (iso?: string | null): string => {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
};

const initialsFor = (s: string): string =>
  s.split(/[._@-]/).slice(0, 2).map((p) => p[0]?.toUpperCase() || "").join("") || "??";

const colorFor = (key: string): string =>
  PALETTE[Math.abs([...key].reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length] ??
  PALETTE[0];

const fromApiMember = (m: ApiTenantMember): Member => {
  // Prefer last_seen_at (touched on every authenticated request) — falls
  // back to joinedAt/invitedAt/createdAt for never-seen members or when
  // the column is missing on older deployments.
  const last = (m as any).lastSeenAt || m.joinedAt || m.invitedAt || m.createdAt || null;
  return {
    id: m.id,
    userId: m.userId ?? null,
    name: m.email.split("@")[0] ?? m.email,
    email: m.email,
    role: m.role,
    last: m.status === "invited" ? "—" : fmtRelative(last),
    status: m.status,
    avatar: initialsFor(m.email),
    color: colorFor(m.email),
  };
};

const sniffActiveTenantId = (): string | null => {
  if (typeof document === "undefined") return null;
  const m = /backlex-tenant=([^;]+)/.exec(document.cookie);
  return m?.[1] ? decodeURIComponent(m[1]) : null;
};

/** What the confirmation dialog is currently asking about. Both of its cases
 *  cost the caller something they cannot undo with the same click, which is why
 *  neither fires straight off the row. */
type Confirming =
  | { kind: "transfer"; member: Member }
  | { kind: "remove"; member: Member };

export interface MembersPanelProps {
  roles: RoleData[];
  pushToast: PushToast;
}

export function MembersPanel({ pushToast }: MembersPanelProps) {
  const { t } = useLingui();

  // Server-state via React Query — caches across navigation so the panel
  // doesn't re-fetch when the user bounces off and back. The tenants list
  // is shared with the workspace switcher and the topbar.
  const qc = useQueryClient();
  const tenantsQuery = useTenants();
  const meQuery = useMe();
  const tenantId =
    tenantsQuery.data?.active ||
    sniffActiveTenantId() ||
    tenantsQuery.data?.data[0]?.id ||
    null;
  const membersQuery = useTenantMembers(tenantId);
  const members: Member[] = useMemo(
    () => (membersQuery.data?.data ?? []).map(fromApiMember),
    [membersQuery.data],
  );
  const loading = tenantsQuery.isLoading || membersQuery.isLoading;

  /**
   * The caller's own standing in this workspace, straight off the tenants list
   * (`ApiTenant.role` is the caller's membership row, not the workspace's).
   * `undefined` until that query lands, and an unknown role is treated as
   * unrestricted — offering everything and letting the server refuse is the
   * honest failure mode; guessing "member" would grey out controls an owner
   * actually has.
   */
  const myRole = tenantsQuery.data?.data.find((tn) => tn.id === tenantId)?.role;
  const myRank = myRole === undefined ? Number.POSITIVE_INFINITY : rankOf(myRole);
  const isSelf = (m: Member): boolean =>
    !!meQuery.data?.data.id && m.userId === meQuery.data.data.id;
  /** Mirrors `assertMayActOn`: yourself always, otherwise you must outrank. */
  const mayActOn = (m: Member): boolean => isSelf(m) || rankOf(m.role) < myRank;
  /** Mirrors `assertMayGrant`: you cannot hand out a standing above your own. */
  const mayGrant = (role: string): boolean => rankOf(role) <= myRank;
  const ownerCount = members.filter((m) => m.role === "owner").length;

  const [q, setQ] = useUrlState("q", "");
  const [invite, setInvite] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [lastInvite, setLastInvite] = useState<null | { email: string; url: string; sent: boolean }>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? members.filter((m) => (m.name + m.email + m.role).toLowerCase().includes(s)) : members;
  }, [q, members]);

  const stats = useMemo(() => ({
    total: members.length,
    active: members.filter((m) => m.status === "active").length,
    invited: members.filter((m) => m.status === "invited").length,
  }), [members]);

  const membersKey = queryKeys.tenantMembers(tenantId);

  /**
   * Paint a member-list change immediately and hand back the snapshot to
   * restore if the server refuses.
   *
   * `cancelQueries` is fired but deliberately NOT awaited: awaiting it would
   * put the optimistic paint behind a promise, which is the await-then-render
   * shape this panel exists to avoid. It still runs before any in-flight
   * refetch can resolve, which is all it is here for.
   */
  const applyOptimistically = (
    next: (rows: ApiTenantMember[]) => ApiTenantMember[],
  ): Envelope<ApiTenantMember[]> | undefined => {
    const snapshot = qc.getQueryData<Envelope<ApiTenantMember[]>>(membersKey);
    void qc.cancelQueries({ queryKey: membersKey });
    if (snapshot) qc.setQueryData(membersKey, { ...snapshot, data: next(snapshot.data) });
    return snapshot;
  };

  const rollback = (snapshot: Envelope<ApiTenantMember[]> | undefined, e: unknown) => {
    if (snapshot) qc.setQueryData(membersKey, snapshot);
    pushToast((e as Error).message);
  };

  const sendInvite = async () => {
    const email = invite.trim().toLowerCase();
    if (!email || !/.+@.+\..+/.test(email)) { pushToast(t`Enter a valid email.`); return; }
    if (!tenantId) { pushToast(t`No active workspace.`); return; }
    if (members.find((m) => m.email === email)) { pushToast(t`${email} is already a member.`); return; }
    try {
      const r = await tenantsApi.invite(tenantId, { email, role: inviteRole });
      // Deployments without SMTP never deliver the email — keep the accept
      // link on screen so the admin can share it by hand.
      setLastInvite({ email, url: r.data.url, sent: r.data.sent });
      pushToast(r.data.sent ? t`Invite sent to ${email}.` : t`Invite created — copy the link below.`);
      setInvite("");
      // Refetch members list (and any other view that observes the same
      // subtree). Tenants list itself didn't change — leave it cached.
      await qc.invalidateQueries({ queryKey: membersKey });
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  /** Change a member's workspace role. The row shows the new role on the click;
   *  a refusal (last owner, an admin reaching for `owner`) puts the old one
   *  back and says why. */
  const setRole = async (m: Member, role: string) => {
    if (!tenantId || role === m.role) return;
    const snapshot = applyOptimistically((rows) =>
      rows.map((row) => (row.id === m.id ? { ...row, role } : row)),
    );
    try {
      await tenantsApi.updateMember(tenantId, m.id, { role });
      // Reconcile in the background — the server may have folded a deprecated
      // value, and a transfer performed elsewhere may have moved other rows.
      void qc.invalidateQueries({ queryKey: membersKey });
    } catch (e) {
      rollback(snapshot, e);
    }
  };

  const remove = async (m: Member) => {
    if (!tenantId) return;
    const snapshot = applyOptimistically((rows) => rows.filter((row) => row.id !== m.id));
    try {
      await tenantsApi.removeMember(tenantId, m.id);
      pushToast(t`${m.email} no longer has access.`);
      void qc.invalidateQueries({ queryKey: membersKey });
    } catch (e) {
      rollback(snapshot, e);
    }
  };

  /** Hand the workspace over. Both rows move at once — the new owner up, the
   *  caller down to `admin` — because that is what the server does. */
  const transferOwnership = async (m: Member) => {
    if (!tenantId) return;
    const meId = meQuery.data?.data.id ?? null;
    const snapshot = applyOptimistically((rows) =>
      rows.map((row) => {
        if (row.id === m.id) return { ...row, role: "owner" };
        if (meId && row.userId === meId && row.role === "owner") return { ...row, role: "admin" };
        return row;
      }),
    );
    try {
      await tenantsApi.transferOwnership(tenantId, m.id);
      pushToast(t`${m.email} is now the owner.`);
      // The caller's own standing changed, so the tenants list (which carries
      // it, and drives this panel's permission gating) is stale too.
      void qc.invalidateQueries({ queryKey: membersKey });
      void qc.invalidateQueries({ queryKey: queryKeys.tenants() });
    } catch (e) {
      rollback(snapshot, e);
    }
  };

  const resendInvite = async (m: Member) => {
    if (!tenantId) return;
    try {
      const r = await tenantsApi.resendInvite(tenantId, m.id);
      // A link only ever comes from a create or a resend response. The members
      // list does not carry one, on purpose — a list endpoint that hands back
      // live invite tokens is a credential leak, not a convenience.
      if (r.data?.url) setLastInvite({ email: m.email, url: r.data.url, sent: !!r.data.sent });
      pushToast(r.data?.sent ? t`Invite re-sent to ${m.email}.` : t`New invite link created.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const revokeInvite = async (m: Member) => {
    if (!tenantId) return;
    const snapshot = applyOptimistically((rows) => rows.filter((row) => row.id !== m.id));
    if (lastInvite?.email === m.email) setLastInvite(null);
    try {
      await tenantsApi.revokeInvite(tenantId, m.id);
      pushToast(t`Invitation for ${m.email} withdrawn.`);
      void qc.invalidateQueries({ queryKey: membersKey });
    } catch (e) {
      rollback(snapshot, e);
    }
  };

  /**
   * Carry out whatever the dialog was asking about.
   *
   * The dialog closes FIRST and there is no "Working…" state, because the
   * handler it hands off to has already repainted the list — a spinner over a
   * result that is on screen behind it would be a spinner over nothing. The
   * only thing left to arrive is a refusal, and that comes back as a toast plus
   * the rows going back to how they were.
   */
  const runConfirmed = () => {
    if (!confirming) return;
    const { kind, member } = confirming;
    setConfirming(null);
    if (kind === "transfer") void transferOwnership(member);
    else void remove(member);
  };

  return (
    <Card className="py-0 gap-0">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3.5">
        <I.Users size={14} />
        <span className="text-[13px] font-medium"><Trans>members</Trans></span>
        <span className="font-mono text-xs text-muted-foreground"><Trans>{stats.active} active · {stats.invited} invited</Trans></span>
        <div className="hidden flex-1 sm:block" />
        <div className="ml-auto flex h-[30px] items-center gap-1.5 rounded-control border border-border bg-card px-2.5">
          <I.Search size={12} />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t`Search members…`}
            className="h-auto w-40 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0 focus-visible:border-0"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-[color-mix(in_oklch,var(--muted)_22%,var(--card))] px-3.5 py-2.5">
        <I.Mail size={13} className="text-muted-foreground" />
        <Input
          className="h-[30px] min-w-[200px] flex-1 text-[12.5px]"
          placeholder={t`invite by email…`}
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") sendInvite(); }}
        />
        <Select
          value={inviteRole}
          onChange={setInviteRole}
          options={GRANTABLE_ROLES.map((r) => ({
            value: r as string,
            label: r as string,
            // Offering a role the caller cannot grant would produce a refusal
            // at the end of a form rather than at the choice that caused it.
            disabled: !mayGrant(r),
            ...(mayGrant(r) ? {} : { hint: t`owners only` }),
          }))}
          size="sm"
          className="w-[150px] shrink-0"
        />
        <Button variant="primary" size="sm" icon={I.Plus} onClick={sendInvite}><Trans>Invite</Trans></Button>
      </div>

      {lastInvite && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-[color-mix(in_oklch,var(--primary)_6%,var(--card))] px-3.5 py-2.5">
          <I.Link size={13} className="shrink-0 text-muted-foreground" />
          <span className="text-[12px] text-muted-foreground">
            {lastInvite.sent
              ? <Trans>Invite emailed to {lastInvite.email} — link:</Trans>
              : <Trans>No email service configured — share this link with {lastInvite.email}:</Trans>}
          </span>
          <Input
            readOnly
            value={lastInvite.url}
            onFocus={(e) => e.currentTarget.select()}
            className="h-[26px] min-w-[160px] flex-1 font-mono text-[11px]"
          />
          <Button variant="outline" size="xs" className="shrink-0" onClick={() => {
            void navigator.clipboard.writeText(lastInvite.url).then(
              () => pushToast(t`Invite link copied.`),
              () => pushToast(lastInvite.url),
            );
          }}><Trans>Copy</Trans></Button>
          <IconButton icon={I.X} title={t`Dismiss`} onClick={() => setLastInvite(null)} />
        </div>
      )}

      <ScrollArea className="py-1">
        <div className="grid min-w-[560px] grid-cols-[1.6fr_1fr_1fr_0.8fr_76px] items-center gap-3 border-b border-border bg-[color-mix(in_oklch,var(--muted)_18%,var(--card))] px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          <span><Trans>Member</Trans></span>
          <span><Trans>Role</Trans></span>
          <span><Trans>Last active</Trans></span>
          <span><Trans>Status</Trans></span>
          <span />
        </div>
        {loading && filtered.length === 0 && <SkeletonList rows={4} cols={5} />}
        {filtered.map((m) => {
          const editable = mayActOn(m);
          // The server refuses this before it refuses anything else, so saying
          // so on the control is cheaper than a toast the operator has to read
          // twice to understand.
          const lastOwner = m.role === "owner" && ownerCount <= 1;
          return (
          <div
            key={m.id}
            className="grid min-w-[560px] grid-cols-[1.6fr_1fr_1fr_0.8fr_76px] items-center gap-3 px-4 py-2.5 hover:bg-[color-mix(in_oklch,var(--accent)_50%,var(--card))] [&+&]:border-t [&+&]:border-border"
          >
            <div className="flex items-center gap-2.5">
              <span
                className="grid size-[30px] place-items-center rounded-full font-mono text-[11.5px] font-semibold text-[oklch(0.18_0_0)]"
                style={{ background: m.color }}
              >
                {m.avatar}
              </span>
              <div className="flex min-w-0 flex-col gap-px">
                <span className="truncate text-[13px]">{m.name}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground" title={m.email}>{m.email}</span>
              </div>
            </div>
            <Select
              value={m.role}
              onChange={(next) => void setRole(m, next)}
              options={[
                ...GRANTABLE_ROLES.map((r) => ({
                  value: r as string,
                  label: r as string,
                  disabled: !mayGrant(r) || (lastOwner && r !== "owner"),
                  ...(mayGrant(r) ? {} : { hint: t`owners only` }),
                  ...(lastOwner && r !== "owner" ? { hint: t`last owner` } : {}),
                })),
                // Rows written before `editor` was deprecated still carry it,
                // and a Select with no matching option renders empty — which
                // reads as "this person has no role".
                ...(GRANTABLE_ROLES.includes(m.role as (typeof GRANTABLE_ROLES)[number])
                  ? []
                  : [{ value: m.role, label: m.role, hint: t`legacy` }]),
              ]}
              size="sm"
              disabled={!editable}
            />
            <span className="font-mono text-[11.5px] text-muted-foreground">{m.last}</span>
            <span>
              {m.status === "active" && <Badge variant="secondary"><Trans>active</Trans></Badge>}
              {m.status === "invited" && <Badge variant="outline"><Trans>pending</Trans></Badge>}
              {m.status === "suspended" && <Badge variant="destructive"><Trans>suspended</Trans></Badge>}
            </span>
            <div className="flex items-center justify-end gap-0.5">
              {m.status === "invited" ? (
                <>
                  <IconButton
                    icon={I.Send}
                    title={t`Resend invitation`}
                    disabled={!editable}
                    onClick={() => void resendInvite(m)}
                  />
                  <IconButton
                    icon={I.X}
                    title={t`Withdraw invitation`}
                    disabled={!editable}
                    onClick={() => void revokeInvite(m)}
                  />
                </>
              ) : (
                <>
                  <IconButton
                    icon={I.ShieldCheck}
                    title={t`Transfer ownership`}
                    // Only an owner has ownership to give, and giving it to
                    // yourself is not a move.
                    disabled={myRole !== "owner" || isSelf(m) || m.role === "owner"}
                    onClick={() => setConfirming({ kind: "transfer", member: m })}
                  />
                  <IconButton
                    icon={I.Trash}
                    title={lastOwner ? t`The last owner cannot be removed` : t`Remove`}
                    disabled={!editable || lastOwner}
                    onClick={() => setConfirming({ kind: "remove", member: m })}
                  />
                </>
              )}
            </div>
          </div>
          );
        })}
        {!loading && !filtered.length && (
          <div className="p-6 text-center text-[12.5px] text-muted-foreground">
            {q ? <Trans>No members match "{q}".</Trans> : <Trans>No members yet.</Trans>}
          </div>
        )}
      </ScrollArea>

      <Dialog open={!!confirming} onOpenChange={(o) => { if (!o) setConfirming(null); }}>
        {confirming && (
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {confirming.kind === "transfer"
                  ? <Trans>Transfer ownership</Trans>
                  : <Trans>Remove from workspace</Trans>}
              </DialogTitle>
              <DialogDescription>
                {confirming.kind === "transfer"
                  ? <Trans>Make {confirming.member.email} the owner of this workspace.</Trans>
                  : <Trans>{confirming.member.email} loses access to this workspace.</Trans>}
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              {confirming.kind === "transfer" ? (
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  {/* Said outright, because "make X the owner" and "stop being
                      one yourself" are the same click and only the first half
                      is obvious from the button. */}
                  <Trans>
                    You stop being the owner at the same moment: your own role
                    drops to admin. From then on only {confirming.member.email}
                    can transfer ownership back, delete this workspace, or grant
                    the owner role.
                  </Trans>
                </p>
              ) : (
                <p className="text-[12.5px] leading-relaxed text-muted-foreground">
                  <Trans>
                    Their membership, workspace roles and API keys are revoked
                    together — access ends immediately, on every surface. A new
                    invitation is the only way back.
                  </Trans>
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(null)}><Trans>Cancel</Trans></Button>
              <Button
                variant={confirming.kind === "transfer" ? "primary" : "destructive"}
                onClick={runConfirmed}
              >
                {confirming.kind === "transfer"
                  ? <Trans>Transfer ownership</Trans>
                  : <Trans>Remove member</Trans>}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </Card>
  );
}
