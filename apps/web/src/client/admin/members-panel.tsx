// @ts-nocheck
// Members panel — workspace member management for multi-tenant.
import { useEffect, useMemo, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { I } from "./icons";
import { Badge, Button, IconButton } from "./ui";
import { Select } from "./select";
import { tenantsApi, type ApiTenantMember } from "./api";
import type { RoleData } from "./role-editor";

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

  const [members, setMembers] = useState<Member[]>([]);
  const [q, setQ] = useState("");
  const [invite, setInvite] = useState("");
  const [inviteRole, setInviteRole] = useState("member");
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ts = await tenantsApi.list();
        const active = ts.active || sniffActiveTenantId() || ts.data[0]?.id;
        if (!active) {
          if (!cancelled) setLoading(false);
          return;
        }
        if (cancelled) return;
        setTenantId(active);
        const ms = await tenantsApi.members(active);
        if (cancelled) return;
        setMembers(ms.data.map(fromApiMember));
      } catch (e) {
        pushToast?.((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);

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
      const ms = await tenantsApi.members(tenantId);
      setMembers(ms.data.map(fromApiMember));
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const setRole = (id: string, r: string) =>
    setMembers((arr) => arr.map((m) => (m.id === id ? { ...m, role: r } : m)));

  const remove = async (id: string) => {
    if (!tenantId) return;
    try {
      await tenantsApi.removeMember(tenantId, id);
      setMembers((arr) => arr.filter((m) => m.id !== id));
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  return (
    <div className="card">
      <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <I.Users size={14} />
        <span style={{ fontSize: 13, fontWeight: 500 }}>members</span>
        <span className="font-mono" style={{ fontSize: 12, color: "var(--muted-foreground)" }}>{stats.active} active · {stats.invited} invited</span>
        <div className="spacer" />
        <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--border)", borderRadius: "var(--radius-md)", padding: "4px 10px", height: 30, background: "var(--card)" }}>
          <I.Search size={12} />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search members…"
            className="h-auto border-0 bg-transparent p-0 text-xs shadow-none focus-visible:ring-0 focus-visible:border-0"
            style={{ width: 160 }}
          />
        </div>
      </div>

      <div className="mp-invite">
        <I.Mail size={13} />
        <Input
          className="mp-invite-input"
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
        />
        <Button variant="primary" size="sm" icon={I.Plus} onClick={sendInvite}>Invite</Button>
      </div>

      <div className="mp-table">
        <div className="mp-head">
          <span>Member</span>
          <span>Role</span>
          <span>Last active</span>
          <span>Status</span>
          <span />
        </div>
        {filtered.map((m) => (
          <div key={m.id} className="mp-row">
            <div className="mp-member">
              <span className="mp-avatar" style={{ background: m.color }}>{m.avatar}</span>
              <div className="mp-meta">
                <span className="mp-name">{m.name}</span>
                <span className="mp-email font-mono">{m.email}</span>
              </div>
            </div>
            <Select
              value={m.role}
              onChange={(v) => setRole(m.id, v)}
              options={WORKSPACE_ROLES.map((r) => ({ value: r, label: r }))}
              size="sm"
            />
            <span className="muted font-mono" style={{ fontSize: 11.5 }}>{m.last}</span>
            <span>
              {m.status === "active" && <Badge variant="secondary">active</Badge>}
              {m.status === "invited" && <Badge variant="outline">pending</Badge>}
            </span>
            <IconButton icon={I.Trash} title="Remove" onClick={() => remove(m.id)} />
          </div>
        ))}
        {!filtered.length && (
          <div style={{ padding: 24, textAlign: "center", color: "var(--muted-foreground)", fontSize: 12.5 }}>
            {loading ? "Loading members…" : q ? `No members match "${q}".` : "No members yet."}
          </div>
        )}
      </div>
    </div>
  );
}
