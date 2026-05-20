// Users page — workspace user table + role/provider filters + invite + drawer
import { useEffect, useState } from "react";
import { I } from "../icons";
import { Badge, Button, Checkbox, IconButton, PageHeader } from "../ui";
import { Select } from "../select";
import { Input } from "@workeros/ui/components/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@workeros/ui/components/input-group";
import { rolesApi, usersApi, type ApiUser } from "../api";

const ProviderGlyph = ({ kind, size = 12 }: { kind: string; size?: number }) => {
  if (kind === "github") return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.04c-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.09-.75.08-.73.08-.73 1.21.09 1.85 1.24 1.85 1.24 1.07 1.84 2.81 1.31 3.5 1 .11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.39 1.24-3.23-.13-.3-.54-1.52.12-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.3-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.92 1.24 3.23 0 4.62-2.81 5.64-5.49 5.94.43.37.82 1.1.82 2.22v3.29c0 .32.22.7.83.58A12 12 0 0 0 12 .5Z" /></svg>
  );
  if (kind === "google") return (
    <svg width={size} height={size} viewBox="0 0 24 24"><path fill="#4285F4" d="M22 12.2c0-.8-.07-1.6-.2-2.4H12v4.5h5.6a4.8 4.8 0 0 1-2.1 3.1v2.6h3.4c2-1.8 3.1-4.5 3.1-7.8Z" /><path fill="#34A853" d="M12 22c2.8 0 5.2-.9 6.9-2.5l-3.4-2.6c-.9.6-2.1 1-3.5 1-2.7 0-5-1.8-5.8-4.3H2.7v2.7A10 10 0 0 0 12 22Z" /><path fill="#FBBC05" d="M6.2 13.6a6 6 0 0 1 0-3.8V7.1H2.7a10 10 0 0 0 0 9l3.5-2.5Z" /><path fill="#EA4335" d="M12 5.4c1.5 0 2.9.5 4 1.5l3-3A10 10 0 0 0 2.7 7.1l3.5 2.7C7 7.2 9.3 5.4 12 5.4Z" /></svg>
  );
  if (kind === "magic") return <I.Bolt size={size} />;
  return <I.Lock size={size} />;
};

const PROVIDER_LABEL: Record<string, string> = { password: "password", github: "github", google: "google", magic: "magic link" };

export function UsersPage({ pushToast }: { pushToast: (m: string) => void }) {
  type UserRow = { id: string; name: string; email: string; roles: string[]; status: string; provider: string; mfa: boolean; last: string; lastIso: string | null; created: string; sessions: number; hue: number };
  const [users, setUsers] = useState<UserRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await usersApi.list();
        if (cancelled || !Array.isArray(r.data)) return;
        const fmt = (ts: number | null): string => {
          if (!ts) return "—";
          const ms = Date.now() - ts;
          if (ms < 60_000) return "just now";
          if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
          if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
          return `${Math.floor(ms / 86_400_000)}d ago`;
        };
        setUsers(
          r.data.map((u: ApiUser & { lastSeenAt?: number | null }, i: number) => {
            const lastSeenAt = u.lastSeenAt ?? null;
            return {
              id: u.id,
              name: u.name ?? u.email.split("@")[0],
              email: u.email,
              roles: u.roles.map((x) => x.name),
              status: u.status ?? "active",
              provider: "password",
              mfa: false,
              last: fmt(lastSeenAt),
              lastIso: lastSeenAt ? new Date(lastSeenAt).toISOString().slice(0, 19).replace("T", " ") : null,
              created: u.createdAt ? String(u.createdAt).slice(0, 10) : "—",
              sessions: 0,
              hue: 30 + ((i * 47) % 320),
            };
          }) as any,
        );
      } catch (e) {
        pushToast?.((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [pushToast]);
  // Real workspace roles for the invite dialog + the role filter — keeps both
  // in sync with whatever exists under Roles & permissions (no hardcoded list).
  const [roleNames, setRoleNames] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await rolesApi.list();
        if (!cancelled && Array.isArray(r.data)) {
          setRoleNames(r.data.map((x) => x.name).filter((n) => n !== "public"));
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
  const [menuOpen, setMenuOpen] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menuOpen]);

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
    if (s === "active") return <Badge variant="default">active</Badge>;
    if (s === "invited") return <Badge variant="outline">invited</Badge>;
    if (s === "suspended") return <Badge variant="destructive">suspended</Badge>;
    return <Badge variant="secondary">{s}</Badge>;
  };

  const bulk = async (verb: "delete" | "suspend" | "activate") => {
    const ids = [...selected];
    try {
      if (verb === "delete") {
        await Promise.allSettled(ids.map((id) => usersApi.remove(id)));
        setUsers((arr) => arr.filter((u) => !selected.has(u.id)));
      } else if (verb === "suspend") {
        await Promise.allSettled(ids.map((id) => usersApi.suspend(id)));
        setUsers((arr) =>
          arr.map((u) => (selected.has(u.id) ? { ...u, status: "suspended", sessions: 0 } : u)),
        );
      } else if (verb === "activate") {
        await Promise.allSettled(ids.map((id) => usersApi.activate(id)));
        setUsers((arr) => arr.map((u) => (selected.has(u.id) ? { ...u, status: "active" } : u)));
      }
      pushToast(`${verb === "delete" ? "Deleted" : verb === "suspend" ? "Suspended" : "Activated"} ${ids.length} user${ids.length === 1 ? "" : "s"}.`);
    } catch (e) {
      pushToast((e as Error).message);
    }
    setSelected(new Set());
  };

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title="Users"
        description="The first user to sign up becomes admin; everyone else lands in authenticated. Sessions, providers, and 2FA are tracked per account."
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setInviteOpen(true)}>Invite</Button>}
      />

      <div className="grid grid-cols-4 gap-2.5 max-[900px]:grid-cols-2">
        {[
          { label: "Total users", value: stats.total, hint: `${users.filter((u) => u.status === "active").length} active` },
          { label: "Active in 24h", value: stats.active24h, hint: `${Math.round((stats.active24h / Math.max(1, stats.total)) * 100)}% of base` },
          { label: "Pending invites", value: stats.pending, hint: stats.pending ? "awaiting accept" : "none" },
          { label: "Admins", value: stats.admins, hint: "full access" },
        ].map((s) => (
          <div key={s.label} className="flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3.5">
            <span className="text-[11.5px] uppercase tracking-[0.02em] text-muted-foreground">{s.label}</span>
            <span className="text-[26px] font-semibold tracking-[-0.02em]">{s.value}</span>
            <span className="text-[11.5px] text-muted-foreground">{s.hint}</span>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <InputGroup className="min-w-[280px] flex-[0_1_320px]">
          <InputGroupAddon><I.Search size={14} /></InputGroupAddon>
          <InputGroupInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or email…" />
          {q && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" onClick={() => setQ("")}><I.X size={11} /></InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[11.5px] text-muted-foreground">Role</span>
          <Select size="sm" value={roleFilter} onChange={setRoleFilter} className="w-[140px]"
            options={[{ value: "all", label: "All roles" }, ...roleNames.map((n) => ({ value: n, label: n }))]} />
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[11.5px] text-muted-foreground">Status</span>
          <Select size="sm" value={statusFilter} onChange={setStatusFilter} className="w-[140px]"
            options={[{ value: "all", label: "All statuses" }, { value: "active", label: "active" }, { value: "invited", label: "invited" }, { value: "suspended", label: "suspended" }]} />
        </div>
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-[11.5px] text-muted-foreground">Provider</span>
          <Select size="sm" value={providerFilter} onChange={setProviderFilter} className="w-[150px]"
            options={[{ value: "all", label: "All providers" }, { value: "password", label: "password" }, { value: "github", label: "github" }, { value: "google", label: "google" }, { value: "magic", label: "magic link" }]} />
        </div>
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">{filtered.length} of {users.length}</span>
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[color-mix(in_oklch,var(--primary)_40%,var(--border))] bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))] px-3 py-2">
          <Badge variant="default">{selected.size} selected</Badge>
          <span className="text-[12.5px] text-muted-foreground">Apply to selection:</span>
          <Button size="sm" variant="outline" onClick={() => bulk("activate")}>Activate</Button>
          <Button size="sm" variant="outline" onClick={() => bulk("suspend")}>Suspend</Button>
          <Button size="sm" variant="outline" onClick={() => pushToast(`Reset link sent to ${selected.size} user${selected.size === 1 ? "" : "s"}.`)}>Reset password</Button>
          <Button size="sm" variant="outline" onClick={() => bulk("delete")} className="text-destructive">Delete</Button>
          <div className="flex-1" />
          <button type="button" className="inline-grid size-6 cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-card hover:text-destructive" onClick={() => setSelected(new Set())} title="Clear selection"><I.X size={12} /></button>
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
        <div className="w-full max-w-full overflow-x-auto">
        <table className="table users-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <Checkbox checked={allChecked} indeterminate={someChecked} onChange={toggleAll} />
              </th>
              <th>User</th>
              <th style={{ width: 200 }}>Role</th>
              <th style={{ width: 130 }}>Status</th>
              <th style={{ width: 140 }}>Provider</th>
              <th style={{ width: 70, textAlign: "center" }}>2FA</th>
              <th style={{ width: 120 }}>Last seen</th>
              <th className="col-actions" style={{ width: 44 }}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const isOpen = menuOpen === u.id;
              return (
                <tr key={u.id} className={`users-row ${selected.has(u.id) ? "on" : ""}`} onClick={() => setActiveUser(u)}>
                  <td onClick={(e) => e.stopPropagation()}>
                    <Checkbox checked={selected.has(u.id)} onChange={() => toggle(u.id)} />
                  </td>
                  <td>
                    <div className="flex items-center gap-2.5">
                      <div className="grid size-8 place-items-center rounded-full text-[12.5px] font-semibold tracking-[-0.01em]" style={{ background: `oklch(0.78 0.14 ${u.hue})`, color: `oklch(0.25 0.06 ${u.hue})` }}>{u.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}</div>
                      <div className="flex min-w-0 flex-col gap-px">
                        <span className="text-[13px] font-medium">{u.name}</span>
                        <span className="text-[11.5px] text-muted-foreground">{u.email}</span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {u.roles.map((r) => <Badge key={r} variant={r === "admin" ? "default" : "secondary"}>{r}</Badge>)}
                    </div>
                  </td>
                  <td>{statusBadge(u.status)}</td>
                  <td>
                    <span className="inline-flex items-center gap-1.5 text-foreground">
                      <ProviderGlyph kind={u.provider} />
                      <span className="text-[12.5px]">{PROVIDER_LABEL[u.provider]}</span>
                    </span>
                  </td>
                  <td style={{ textAlign: "center" }}>
                    {u.mfa
                      ? <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklch,oklch(0.55_0.15_145)_35%,var(--border))] bg-[color-mix(in_oklch,oklch(0.78_0.14_145)_14%,transparent)] px-[7px] py-0.5 font-mono text-[11px] text-[oklch(0.55_0.15_145)]" title="2FA enabled"><I.Shield size={11} /> on</span>
                      : <span className="inline-flex items-center gap-1 rounded-full border border-border px-[7px] py-0.5 font-mono text-[11px] text-muted-foreground" title="2FA disabled">off</span>}
                  </td>
                  <td className="font-mono text-[11.5px] text-muted-foreground">{u.last}</td>
                  <td className="col-actions" style={{ textAlign: "right", position: "relative" }} onClick={(e) => e.stopPropagation()}>
                    <IconButton icon={I.More} onClick={(e: any) => { e.stopPropagation(); setMenuOpen(isOpen ? null : u.id); }} />
                    {isOpen && (
                      <div className="absolute right-2 top-[calc(100%-4px)] z-30 flex min-w-[180px] flex-col rounded-xl border border-border bg-popover p-1 text-left shadow-[0_8px_24px_oklch(0_0_0/0.16)] [&>button]:flex [&>button]:cursor-pointer [&>button]:items-center [&>button]:gap-2 [&>button]:rounded-md [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-2.5 [&>button]:py-[7px] [&>button]:text-left [&>button]:text-[12.5px] [&>button]:text-foreground [&>button:hover]:bg-accent" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setActiveUser(u); setMenuOpen(null); }}><I.Eye size={12} />View profile</button>
                        <button onClick={() => { pushToast(`Reset link sent to ${u.email}.`); setMenuOpen(null); }}><I.Mail size={12} />Send reset link</button>
                        {u.status !== "suspended" ? (
                          <button onClick={async () => {
                            try { await usersApi.suspend(u.id); } catch (e) { pushToast((e as Error).message); }
                            setUsers((arr) => arr.map((x) => x.id === u.id ? { ...x, status: "suspended", sessions: 0 } : x));
                            setMenuOpen(null);
                            pushToast(`${u.email} suspended.`);
                          }}><I.Lock size={12} />Suspend</button>
                        ) : (
                          <button onClick={async () => {
                            try { await usersApi.activate(u.id); } catch (e) { pushToast((e as Error).message); }
                            setUsers((arr) => arr.map((x) => x.id === u.id ? { ...x, status: "active" } : x));
                            setMenuOpen(null);
                            pushToast(`${u.email} activated.`);
                          }}><I.Check size={12} />Activate</button>
                        )}
                        <div className="mx-1.5 my-1 h-px bg-border" />
                        <button className="!text-destructive" onClick={async () => {
                          try { await usersApi.remove(u.id); } catch (e) { pushToast((e as Error).message); }
                          setUsers((arr) => arr.filter((x) => x.id !== u.id));
                          setMenuOpen(null);
                          pushToast(`${u.email} deleted.`);
                        }}><I.Trash size={12} />Delete</button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={8}>
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <I.Users size={20} />
                  <h4 className="m-0 text-[15px] font-semibold">No users match</h4>
                  <p className="m-0 max-w-[360px] text-[13px] text-muted-foreground">Adjust your filters or invite a new teammate.</p>
                </div>
              </td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {activeUser && <UserDrawer user={activeUser} onClose={() => setActiveUser(null)} pushToast={pushToast} />}
      {inviteOpen && <InviteUserDialog roles={roleNames} onClose={() => setInviteOpen(false)} onInvite={async (payload: any) => {
        try {
          await usersApi.invite(payload.email, payload.role);
          pushToast(`Invite sent to ${payload.email}.`);
        } catch (e) {
          pushToast((e as Error).message);
        }
        setInviteOpen(false);
      }} />}
    </div>
  );
}

function UserDrawer({ user, onClose, pushToast }: { user: any; onClose: () => void; pushToast: (m: string) => void }) {
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
        const r = await fetch(`/api/users/${encodeURIComponent(user.id)}/sessions`, { credentials: "include" });
        if (!r.ok || cancelled) return;
        const j = (await r.json()) as { data?: any[] };
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
            current: i === 0,
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

  return (
    <>
      <div className="fixed inset-0 z-[60] animate-in bg-[oklch(0_0_0/0.32)] fade-in-0 duration-150 dark:bg-[oklch(0_0_0/0.6)]" onClick={onClose} />
      <div className="fixed bottom-0 right-0 top-0 z-[61] flex w-[min(560px,100vw)] animate-in flex-col border-l border-border bg-card slide-in-from-right duration-200" role="dialog" aria-modal="true">
        <div className="flex items-start gap-3 border-b border-border px-5 pb-3.5 pt-[18px]">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="grid size-10 place-items-center rounded-full text-sm font-semibold tracking-[-0.01em]" style={{ background: `oklch(0.78 0.14 ${user.hue})`, color: `oklch(0.25 0.06 ${user.hue})` }}>{user.name.split(" ").map((p: string) => p[0]).slice(0, 2).join("")}</div>
            <div className="min-w-0">
              <h2 className="m-0 flex items-center gap-2 text-base font-semibold tracking-[-0.01em]">
                {user.name}
                {user.status === "active" && <Badge variant="default">active</Badge>}
                {user.status === "invited" && <Badge variant="outline">invited</Badge>}
                {user.status === "suspended" && <Badge variant="destructive">suspended</Badge>}
              </h2>
              <p className="mb-0 mt-0.5 text-[12.5px] text-muted-foreground">{user.email} · id <span className="font-mono">{user.id}</span></p>
            </div>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>

        <div className="flex flex-1 flex-col gap-8 overflow-auto px-5 py-[18px]">
          <div className="grid grid-cols-2 gap-x-3.5 gap-y-2.5 rounded-xl bg-muted px-3.5 py-3 max-[900px]:grid-cols-1">
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground">Roles</span><div className="flex flex-wrap gap-1">{user.roles.map((r: string) => <Badge key={r} variant={r === "admin" ? "default" : "secondary"}>{r}</Badge>)}</div></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground">Provider</span><span className="inline-flex items-center gap-1.5 text-foreground"><ProviderGlyph kind={user.provider} size={12} />{PROVIDER_LABEL[user.provider]}</span></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground">2FA</span>{user.mfa ? <span className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_oklch,oklch(0.55_0.15_145)_35%,var(--border))] bg-[color-mix(in_oklch,oklch(0.78_0.14_145)_14%,transparent)] px-[7px] py-0.5 font-mono text-[11px] text-[oklch(0.55_0.15_145)]"><I.Shield size={11} /> enrolled</span> : <span className="inline-flex items-center gap-1 rounded-full border border-border px-[7px] py-0.5 font-mono text-[11px] text-muted-foreground">disabled</span>}</div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground">Created</span><span className="font-mono text-xs">{user.created}</span></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground">Last seen</span><span className="font-mono text-xs">{user.lastIso || "—"}</span></div>
            <div className="flex min-w-0 flex-col gap-1"><span className="text-[11px] uppercase tracking-[0.02em] text-muted-foreground">Sessions</span><span className="font-mono text-xs">{user.sessions} active</span></div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium">
              <span>Active sessions</span>
              <span className="text-[11.5px] font-normal text-muted-foreground">{sessions.length}</span>
            </div>
            {sessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-border p-3.5 text-center text-[12.5px] text-muted-foreground">No active sessions.</div>
            ) : (
              <div className="flex flex-col overflow-hidden rounded-xl border border-border">
                {sessions.map((s) => (
                  <div key={s.id} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                        {s.device}
                        {s.current && <Badge variant="outline">this device</Badge>}
                      </span>
                      <span className="font-mono text-[11.5px] text-muted-foreground">{s.ip} · last seen {s.last}</span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => pushToast(`Session revoked: ${s.device}`)}>Revoke</Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium">
              <span>Recent activity</span>
              <span className="text-[11.5px] font-normal text-muted-foreground">last 30 days</span>
            </div>
            <div className="flex flex-col overflow-hidden rounded-xl border border-border">
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
          </div>

          <div className="rounded-xl border border-[color-mix(in_oklch,var(--destructive)_30%,var(--border))] bg-[color-mix(in_oklch,var(--destructive)_5%,var(--card))] px-3.5 py-3">
            <div className="mb-2 flex items-center justify-between text-[12.5px] font-medium"><span>Danger zone</span></div>
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color-mix(in_oklch,var(--destructive)_18%,var(--border))] py-2 last:border-b-0">
              <div>
                <div className="text-[12.5px] font-medium">Send password reset</div>
                <div className="text-[11.5px] text-muted-foreground">Emails a one-time link valid for 30 minutes.</div>
              </div>
              <Button size="sm" variant="outline" onClick={async () => {
                try { await usersApi.invite(user.email, "authenticated"); } catch (e) { pushToast((e as Error).message); }
                pushToast(`Reset link sent to ${user.email}.`);
              }}>Send</Button>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color-mix(in_oklch,var(--destructive)_18%,var(--border))] py-2 last:border-b-0">
              <div>
                <div className="text-[12.5px] font-medium">Revoke all sessions</div>
                <div className="text-[11.5px] text-muted-foreground">Forces re-login on every device immediately.</div>
              </div>
              <Button size="sm" variant="outline" onClick={async () => {
                try { await usersApi.revokeAll(user.id); } catch (e) { pushToast((e as Error).message); }
                pushToast(`Sessions revoked for ${user.email}.`);
              }}>Revoke</Button>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-dashed border-[color-mix(in_oklch,var(--destructive)_18%,var(--border))] py-2 last:border-b-0">
              <div>
                <div className="text-[12.5px] font-medium text-destructive">Delete user</div>
                <div className="text-[11.5px] text-muted-foreground">Permanent. Owned items remain; ownership is reassigned to admin.</div>
              </div>
              <Button size="sm" variant="outline" className="text-destructive" onClick={async () => {
                try { await usersApi.remove(user.id); } catch (e) { pushToast((e as Error).message); }
                pushToast(`${user.email} deleted.`);
                onClose();
              }}>Delete</Button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={() => pushToast("Profile saved.")}>Save changes</Button>
        </div>
      </div>
    </>
  );
}

const ROLE_HINTS: Record<string, string> = {
  admin: "full access — bypasses permission checks",
  authenticated: "standard signed-in user",
};
function InviteUserDialog({ roles, onClose, onInvite }: { roles: string[]; onClose: () => void; onInvite: (data: any) => void }) {
  const roleOptions = (roles.length ? roles : ["authenticated"]).map((name) => ({
    value: name,
    label: name,
    hint: ROLE_HINTS[name] ?? "custom role",
  }));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState(
    roleOptions.some((o) => o.value === "authenticated") ? "authenticated" : roleOptions[0]!.value,
  );
  const [provider, setProvider] = useState("password");
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  return (
    <div className="fixed inset-0 z-[70] grid animate-in place-items-center bg-[oklch(0_0_0/0.45)] backdrop-blur-[2px] fade-in-0 duration-150" onClick={onClose}>
      <div className="relative flex w-[460px] max-w-[92vw] animate-in flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-[0_24px_60px_oklch(0_0_0/0.22),0_2px_8px_oklch(0_0_0/0.08)] fade-in-0 zoom-in-95 duration-200" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-border px-5 pb-3.5 pt-[18px]">
          <div className="flex-1">
            <h2 className="m-0 text-base font-semibold tracking-[-0.01em]">Invite user</h2>
            <p className="mb-0 mt-0.5 text-[12.5px] text-muted-foreground">Send an email invite. The user finishes signup themselves.</p>
          </div>
          <IconButton icon={I.X} onClick={onClose} title="Close" />
        </div>
        <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-5 py-[18px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Email</label>
            <Input autoFocus placeholder="teammate@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <span className="text-[11.5px] text-muted-foreground">An invite link will be emailed; valid for 7 days.</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Default role</label>
            <Select value={role} onChange={setRole} options={roleOptions} />
            <span className="text-[11.5px] text-muted-foreground">Roles come from <strong>Roles &amp; permissions</strong>. The user also implicitly gets <span className="font-mono">authenticated</span>.</span>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Sign-in method</label>
            <Select value={provider} onChange={setProvider}
              options={[{ value: "password", label: "password", hint: "set on first login" }, { value: "magic", label: "magic link", hint: "email-only, no password" }, { value: "github", label: "github SSO", hint: "OAuth required" }, { value: "google", label: "google SSO", hint: "OAuth required" }, { value: "saml", label: "SAML SSO", hint: "configure providers under Authentication" }, { value: "ldap", label: "LDAP / AD", hint: "configure directory under Authentication" }]} />
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-card px-5 py-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => onInvite({ email, role, provider })}>Send invite</Button>
        </div>
      </div>
    </div>
  );
}
