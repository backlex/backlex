// @ts-nocheck
// Members panel — workspace member management for multi-tenant.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Input } from "@workeros/ui/components/input";
import { I } from "./icons";
import { Badge, Button, IconButton } from "./ui";
import { Select } from "./select";
import { tenantsApi, type ApiTenantMember } from "./api";
import { queryKeys, useTenantMembers, useTenants } from "./queries";
import type { RoleData } from "./role-editor";
import { useUrlState } from "@/lib/use-url-state";
import { SkeletonList } from "./loading";

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  last: string;
  status: "active" | "invited" | "suspended";
  avatar: string;
  color: string;
}

const PALETTE = [
  "oklch(0.72 0.18 145)",
  "oklch(0.78 0.16 95)",
  "oklch(0.7 0.16 28)",
  "oklch(0.72 0.16 240)",
  "oklch(0.7 0.16 320)",
  "oklch(0.74 0.14 200)",
];

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
  PALETTE[Math.abs([...key].reduce((a, c) => a + c.charCodeAt(0), 0)) % PALETTE.length];

const fromApiMember = (m: ApiTenantMember): Member => {
  // Prefer last_seen_at (touched on every authenticated request) — falls
  // back to joinedAt/invitedAt/createdAt for never-seen members or when
  // the column is missing on older deployments.
  const last = (m as any).lastSeenAt || m.joinedAt || m.invitedAt || m.createdAt || null;
  return {
    id: m.id,
    name: m.email.split("@")[0],
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
  const m = /workeros-tenant=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
};

export interface MembersPanelProps {
  roles: RoleData[];
  pushToast: (msg: string) => void;
}

export function MembersPanel({ roles, pushToast }: MembersPanelProps) {
  /**
   * Workspace-level roles — these live on `tenant_members.role`, not on the
   * global `roles` table. The system roles (admin/authenticated/public) the
   * permissions matrix uses are different and intentionally not surfaced
   * here.
   */
  const WORKSPACE_ROLES = ["owner", "admin", "editor", "member"] as const;

  // Server-state via React Query — caches across navigation so the panel
  // doesn't re-fetch when the user bounces off and back. The tenants list
  // is shared with the workspace switcher and the topbar.
  const qc = useQueryClient();
  const tenantsQuery = useTenants();
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

  const [q, setQ] = useUrlState("q", "");
  const [invite, setInvite] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? members.filter((m) => (m.name + m.email + m.role).toLowerCase().includes(s)) : members;
  }, [q, members]);

  const stats = useMemo(() => ({
    total: members.length,
    active: members.filter((m) => m.status === "active").length,
    invited: members.filter((m) => m.status === "invited").length,
  }), [members]);

  const sendInvite = async () => {
    const email = invite.trim().toLowerCase();
    if (!email || !/.+@.+\..+/.test(email)) { pushToast("Enter a valid email."); return; }
    if (!tenantId) { pushToast("No active workspace."); return; }
    if (members.find((m) => m.email === email)) { pushToast(`${email} is already a member.`); return; }
    try {
      await tenantsApi.invite(tenantId, { email, role: inviteRole });
      pushToast(`Invite sent to ${email}.`);
      setInvite("");
      // Refetch members list (and any other view that observes the same
      // subtree). Tenants list itself didn't change — leave it cached.
      await qc.invalidateQueries({ queryKey: queryKeys.tenantMembers(tenantId) });
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const remove = async (id: string) => {
    if (!tenantId) return;
    try {
      await tenantsApi.removeMember(tenantId, id);
      await qc.invalidateQueries({ queryKey: queryKeys.tenantMembers(tenantId) });
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3.5">
        <I.Users size={14} />
        <span className="text-[13px] font-medium">members</span>
        <span className="font-mono text-xs text-muted-foreground">{stats.active} active · {stats.invited} invited</span>
        <div className="flex-1" />
        <div className="flex h-[30px] items-center gap-1.5 rounded-md border border-border bg-card px-2.5">
          <I.Search size={12} />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search members…"
            className="h-auto w-40 border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0 focus-visible:border-0"
          />
        </div>
      </div>

      <div className="flex items-center gap-2 border-b border-border bg-[color-mix(in_oklch,var(--muted)_22%,var(--card))] px-3.5 py-2.5">
        <I.Mail size={13} className="text-muted-foreground" />
        <Input
          className="h-[30px] min-w-[200px] flex-1 text-[12.5px]"
          placeholder="invite by email…"
          value={invite}
          onChange={(e) => setInvite(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") sendInvite(); }}
        />
        <Select
          value={inviteRole}
          onChange={setInviteRole}
          options={WORKSPACE_ROLES.map((r) => ({ value: r, label: r }))}
          size="sm"
          className="w-[150px] shrink-0"
        />
        <Button variant="primary" size="sm" icon={I.Plus} onClick={sendInvite}>Invite</Button>
      </div>

      <div className="py-1">
        <div className="grid grid-cols-[1.6fr_1fr_1fr_0.8fr_36px] items-center gap-3 border-b border-border bg-[color-mix(in_oklch,var(--muted)_18%,var(--card))] px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          <span>Member</span>
          <span>Role</span>
          <span>Last active</span>
          <span>Status</span>
          <span />
        </div>
        {loading && filtered.length === 0 && <SkeletonList rows={4} cols={5} />}
        {filtered.map((m) => (
          <div
            key={m.id}
            className="grid grid-cols-[1.6fr_1fr_1fr_0.8fr_36px] items-center gap-3 px-4 py-2.5 hover:bg-[color-mix(in_oklch,var(--accent)_50%,var(--card))] [&+&]:border-t [&+&]:border-border"
          >
            <div className="flex items-center gap-2.5">
              <span
                className="grid size-[30px] place-items-center rounded-full font-mono text-[11.5px] font-semibold text-[oklch(0.18_0_0)]"
                style={{ background: m.color }}
              >
                {m.avatar}
              </span>
              <div className="flex min-w-0 flex-col gap-px">
                <span className="text-[13px]">{m.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{m.email}</span>
              </div>
            </div>
            <Select
              value={m.role}
              onChange={() => {
                // Role mutation isn't wired yet — there's no /api/tenants/:id/
                // members/:id PATCH route. Surface the current role read-only
                // so the column shape stays consistent with the rest of the
                // grid until that endpoint lands.
              }}
              options={WORKSPACE_ROLES.map((r) => ({ value: r, label: r }))}
              size="sm"
              disabled
            />
            <span className="font-mono text-[11.5px] text-muted-foreground">{m.last}</span>
            <span>
              {m.status === "active" && <Badge variant="secondary">active</Badge>}
              {m.status === "invited" && <Badge variant="outline">pending</Badge>}
            </span>
            <IconButton icon={I.Trash} title="Remove" onClick={() => remove(m.id)} />
          </div>
        ))}
        {!loading && !filtered.length && (
          <div className="p-6 text-center text-[12.5px] text-muted-foreground">
            {q ? `No members match "${q}".` : "No members yet."}
          </div>
        )}
      </div>
    </div>
  );
}
