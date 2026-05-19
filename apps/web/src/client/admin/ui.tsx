// @ts-nocheck
// Shared UI primitives + layout for the workeros admin design.
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { I, type IconComponent, type IconKey } from "./icons";
import { NAV_ITEMS, NAV_SETTINGS, NAV_DEVELOPERS } from "./config";
import { tenantsApi, type ApiTenant } from "./api";
import { Button as ShadcnButton } from "@workeros/ui/components/button";
import { Badge as ShadcnBadge } from "@workeros/ui/components/badge";
import { Switch as ShadcnSwitch } from "@workeros/ui/components/switch";
import { Checkbox as ShadcnCheckbox } from "@workeros/ui/components/checkbox";
import { Input } from "@workeros/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@workeros/ui/components/tabs";

export function formatJson(value: unknown): string {
  try {
    return typeof value === "string"
      ? value
      : JSON.stringify(value ?? null, null, 2);
  } catch {
    return "null";
  }
}

export function JsonBlock({ label, value, maxHeight = 280 }: { label: string; value: unknown; maxHeight?: number }) {
  const json = useMemo(() => formatJson(value), [value]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // clipboard unavailable — silent
    }
  };
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, color: "var(--muted-foreground)", fontSize: 11.5 }}>
        <I.Braces size={12} />
        <span style={{ textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>{label}</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={copy}
          className="font-mono"
          style={{
            fontSize: 10.5,
            padding: "2px 8px",
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--card)",
            color: "var(--muted-foreground)",
            cursor: "pointer",
          }}
        >
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre
        className="font-mono"
        style={{
          margin: 0,
          padding: 12,
          background: "color-mix(in oklch, var(--muted) 40%, var(--card))",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontSize: 11.5,
          lineHeight: 1.55,
          maxHeight,
          overflow: "auto",
          whiteSpace: "pre",
        }}
      >
        {json}
      </pre>
    </div>
  );
}

export interface BrandMarkProps {
  size?: number;
}

export function BrandMark({ size = 32 }: BrandMarkProps) {
  return (
    <div className="brand-mark" style={{ width: size, height: size, fontSize: size * 0.55 }}>
      w
    </div>
  );
}

export type ButtonVariant = "primary" | "outline" | "ghost" | "destructive" | "secondary";
export type ButtonSize = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconComponent;
  iconRight?: IconComponent;
  children?: ReactNode;
}

// Map our legacy variant names → shadcn's. The only rename is primary→default.
const mapButtonVariant = (v: ButtonVariant): "default" | "outline" | "ghost" | "destructive" | "secondary" =>
  v === "primary" ? "default" : v;

// Map our legacy size names → shadcn's. The only rename is md→default.
const mapButtonSize = (s: ButtonSize): "xs" | "sm" | "default" | "lg" =>
  s === "md" ? "default" : s;

export function Button({
  variant = "outline",
  size = "sm",
  icon: IconComp,
  iconRight: IconRight,
  onClick,
  disabled,
  children,
  className,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <ShadcnButton
      variant={mapButtonVariant(variant)}
      size={mapButtonSize(size)}
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={className}
      {...rest}
    >
      {IconComp ? <IconComp data-icon="inline-start" /> : null}
      {children}
      {IconRight ? <IconRight data-icon="inline-end" /> : null}
    </ShadcnButton>
  );
}

export interface IconButtonProps {
  icon: IconComponent;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  size?: "sm" | "md";
  variant?: ButtonVariant;
  title?: string;
  className?: string;
}

export function IconButton({ icon: IconComp, onClick, title, className }: IconButtonProps) {
  return (
    <ShadcnButton variant="ghost" size="icon-sm" type="button" onClick={onClick} title={title} className={className}>
      <IconComp size={14} />
    </ShadcnButton>
  );
}

export type BadgeVariant = "default" | "secondary" | "outline" | "destructive";

export interface BadgeProps {
  variant?: BadgeVariant;
  mono?: boolean;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Badge({ variant = "default", mono, children, className, style }: BadgeProps) {
  const cls = [mono ? "font-mono" : null, className].filter(Boolean).join(" ") || undefined;
  return (
    <ShadcnBadge variant={variant} className={cls} style={style}>
      {children}
    </ShadcnBadge>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  title?: string;
}

export function Switch({ checked, onChange, disabled, title }: SwitchProps) {
  return (
    <ShadcnSwitch
      checked={checked}
      onCheckedChange={onChange}
      disabled={disabled}
      title={title}
    />
  );
}

export interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
}

export function Checkbox({ checked, indeterminate, onChange }: CheckboxProps) {
  return (
    <ShadcnCheckbox
      checked={indeterminate ? "indeterminate" : checked}
      onCheckedChange={(next) => onChange(next === true)}
    />
  );
}

interface Tenant {
  id: string;
  slug?: string;
  name: string;
  project: string;
  branch: string;
  env: string;
  members?: number;
  mark: string;
  color: string;
}

const PALETTE_FALLBACK = [
  "oklch(0.78 0.16 95)",
  "oklch(0.72 0.18 145)",
  "oklch(0.72 0.16 240)",
  "oklch(0.7 0.16 28)",
  "oklch(0.7 0.18 320)",
  "oklch(0.74 0.14 200)",
];

const fromApiTenant = (t: ApiTenant, fallback: number): Tenant => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  project: t.project,
  branch: t.branch,
  env: t.env,
  mark: t.mark || t.name.charAt(0).toUpperCase(),
  color: t.color || PALETTE_FALLBACK[fallback % PALETTE_FALLBACK.length],
});

export interface SidebarProps {
  activeNav: string;
  setActiveNav: (id: string) => void;
  collapsed?: boolean;
  pushToast: (msg: string, type?: "success" | "error") => void;
  collectionsCount?: number;
}

export function Sidebar({ activeNav, setActiveNav, pushToast, collectionsCount }: SidebarProps) {
  const items = NAV_ITEMS;
  const settings = NAV_SETTINGS;
  const developers = NAV_DEVELOPERS;

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [newWsOpen, setNewWsOpen] = useState(false);

  const reloadTenants = useCallback(async () => {
    try {
      const res = await tenantsApi.list();
      const mapped = res.data.map((t, i) => fromApiTenant(t, i));
      setTenants(mapped);
      setTenantId(res.active ?? mapped[0]?.id ?? null);
    } catch {
      // Auth gate handles 401; quietly leave the placeholder tile in place.
    }
  }, []);

  useEffect(() => {
    void reloadTenants();
  }, [reloadTenants]);

  const switchTenant = async (id: string) => {
    try {
      await tenantsApi.switchTo(id);
      setTenantId(id);
      setWsOpen(false);
      // Trigger a soft reload so all in-flight queries pick up the new tenant
      // without losing the SPA route.
      window.location.reload();
    } catch (e) {
      pushToast?.((e as Error).message, "error");
    }
  };

  const createWorkspace = async (data: { name: string; project: string; env: string }) => {
    try {
      const res = await tenantsApi.create({
        name: data.name,
        project: data.project || undefined,
        env: data.env as "development" | "staging" | "production",
      });
      pushToast?.(`Workspace "${res.data.slug}" created.`);
      setNewWsOpen(false);
      setWsOpen(false);
      await tenantsApi.switchTo(res.data.id);
      window.location.reload();
    } catch (e) {
      pushToast?.((e as Error).message, "error");
    }
  };

  const tenant: Tenant =
    tenants.find((t) => t.id === tenantId) ||
    tenants[0] || {
      id: "loading",
      name: "loading…",
      project: "—",
      branch: "—",
      env: "—",
      mark: "·",
      color: PALETTE_FALLBACK[0],
    };

  useEffect(() => {
    if (!wsOpen) return;
    const close = (e: MouseEvent | Event) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".ws-wrap")) setWsOpen(false);
    };
    document.addEventListener("click", close as EventListener);
    return () => document.removeEventListener("click", close as EventListener);
  }, [wsOpen]);

  return (
    <aside className="sidebar">
      <div className="ws-wrap" style={{ position: "relative" }}>
        <button className="brand ws-trigger" onClick={() => setWsOpen((v) => !v)} type="button">
          <BrandMark />
          <div className="brand-text">
            <b>{tenant.name}</b>
            <span>{tenant.project} · {tenant.branch}</span>
          </div>
          <I.ChevronDown size={12} className="ws-chev" />
        </button>
        {wsOpen && (
          <div className="ws-pop">
            <div className="ws-pop-head">
              <span className="muted">Workspaces</span>
              <span className="font-mono muted" style={{ fontSize: 10.5 }}>{tenants.length}</span>
            </div>
            {tenants.map((t) => (
              <button key={t.id} type="button" className={`ws-opt ${t.id === tenantId ? "on" : ""}`} onClick={() => void switchTenant(t.id)}>
                <span className="ws-mark" style={{ background: t.color }}>{t.mark}</span>
                <span className="ws-meta">
                  <span className="ws-name">{t.name}</span>
                  <span className="ws-sub font-mono">{t.project} · {t.branch} · {t.env}</span>
                </span>
                {t.id === tenantId && <I.Check size={12} />}
              </button>
            ))}
            <div className="ws-pop-foot">
              <button type="button" className="ws-foot-btn" onClick={() => { setWsOpen(false); setNewWsOpen(true); }}><I.Plus size={12} /> New workspace</button>
              <button type="button" className="ws-foot-btn" onClick={() => { setWsOpen(false); setActiveNav?.("settings"); }}><I.Settings size={12} /> Manage</button>
            </div>
          </div>
        )}
      </div>

      <div className="sidebar-scroll">
        <div className="sidebar-section-label">Workspace</div>
        <div className="nav">
          {items.map((it) => {
            const IconComp = (I as Record<string, IconComponent>)[it.icon as IconKey];
            // Collections gets a live badge from the parent; other items use the
            // (currently empty) static `badge` field on the nav definition.
            const liveBadge = it.id === "collections" ? collectionsCount : it.badge;
            return (
              <div key={it.id} className="nav-item" data-active={activeNav === it.id} onClick={() => setActiveNav(it.id)}>
                {IconComp && <IconComp size={15} />}
                <span className="nav-label">{it.label}</span>
                {liveBadge != null && <span className="nav-end tabular-nums">{liveBadge}</span>}
              </div>
            );
          })}
        </div>

        <div className="sidebar-section-label">Developers</div>
        <div className="nav">
          {developers.map((it) => {
            const IconComp = (I as Record<string, IconComponent>)[it.icon as IconKey];
            return (
              <div key={it.id} className="nav-item" data-active={activeNav === it.id} onClick={() => setActiveNav(it.id)}>
                {IconComp && <IconComp size={15} />}
                <span className="nav-label">{it.label}</span>
              </div>
            );
          })}
        </div>

        <div className="sidebar-section-label">Admin</div>
        <div className="nav">
          {settings.map((it) => {
            const IconComp = (I as Record<string, IconComponent>)[it.icon as IconKey];
            return (
              <div key={it.id} className="nav-item" data-active={activeNav === it.id} onClick={() => setActiveNav(it.id)}>
                {IconComp && <IconComp size={15} />}
                <span className="nav-label">{it.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {newWsOpen && <NewWorkspaceDialog onClose={() => setNewWsOpen(false)} onCreate={createWorkspace} existing={tenants.map((t) => t.name)} />}
    </aside>
  );
}

function NewWorkspaceDialog({ onClose, onCreate, existing }: { onClose: () => void; onCreate: (data: { name: string; project: string; env: string }) => void; existing: string[] }) {
  const [name, setName] = useState("");
  const [project, setProject] = useState("default");
  const [env, setEnv] = useState("development");
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  const taken = slug && existing.includes(slug);
  const valid = slug.length >= 2 && !taken;
  const submit = () => { if (valid) onCreate({ name: slug, project, env }); };
  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-lg" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520, width: "100%" }}>
        <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <I.Plus size={14} />
          <span style={{ fontSize: 14, fontWeight: 500 }}>New workspace</span>
          <div className="spacer" />
          <IconButton icon={I.X} onClick={onClose} />
        </div>
        <div style={{ padding: 22, display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="field">
            <label className="field-label">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="acme-prod" onKeyDown={(e) => e.key === "Enter" && submit()} />
            {taken && <span className="field-hint" style={{ color: "var(--destructive)" }}>Workspace "{slug}" already exists.</span>}
            {!taken && slug && <span className="field-hint">URL: <span className="font-mono">workeros.dev/{slug}</span></span>}
            {!slug && <span className="field-hint">Lowercase, alphanumeric, 2–24 chars.</span>}
          </div>
          <div className="field">
            <label className="field-label">Default project</label>
            <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="default" />
          </div>
          <div className="field">
            <label className="field-label">Environment</label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[
                { id: "development", label: "Development", hint: "local D1" },
                { id: "staging", label: "Staging", hint: "preview" },
                { id: "production", label: "Production", hint: "live" },
              ].map((p) => (
                <button key={p.id} type="button" className={`chip ${env === p.id ? "active" : ""}`} onClick={() => setEnv(p.id)}>
                  {p.label} <span className="muted" style={{ fontSize: 10.5, marginLeft: 4 }}>{p.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--border)" }}>
          <div className="spacer" />
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={submit}>Create workspace</Button>
        </div>
      </div>
    </div>
  );
}

export interface TopbarUser {
  name?: string | null;
  email?: string | null;
  image?: string | null;
  isAdmin?: boolean;
}

export interface TopbarProps {
  crumbs: ReactNode[];
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  dark: boolean;
  onToggleSidebar: () => void;
  onSignOut?: () => void;
  user?: TopbarUser | null;
  onAccountSettings?: () => void;
}

const avatarInitials = (u: TopbarUser | null | undefined): string => {
  const name = (u?.name ?? "").trim();
  if (name) {
    const parts = name.split(/\s+/);
    const a = (parts[0] ?? "").slice(0, 1);
    const b = (parts[1] ?? "").slice(0, 1);
    return ((a + b) || a || "?").toUpperCase();
  }
  const local = (u?.email ?? "").split("@")[0] ?? "";
  return (local.slice(0, 2) || "?").toUpperCase();
};

const resolveAvatarSrc = (image: string | null | undefined): string | null => {
  if (!image) return null;
  if (/^https?:\/\//i.test(image) || image.startsWith("/")) return image;
  return `/api/storage/${encodeURIComponent(image)}`;
};

type NotificationKind = "mention" | "advisor" | "flow" | "deploy" | "member" | "function";

interface NotificationItem {
  id: string;
  kind: NotificationKind;
  unread: boolean;
  who: string;
  t: string;
  title: string;
  body: string;
  icon: IconKey;
}

// TODO(notifications): replace with /api/notifications when the endpoint
// lands. Same shape the design uses; visual-only mark-as-read for now.
const NOTIFICATIONS_SEED: NotificationItem[] = [
  { id: "n_01", kind: "mention", unread: true, who: "kai", t: "2m ago", title: "@rana mentioned you in c_posts/01HZ7K8Q6XYZ", body: "\"Can you confirm the cf-image fit param before I publish?\"", icon: "MessageSquare" },
  { id: "n_02", kind: "advisor", unread: true, who: "workeros", t: "14m ago", title: "New security check failed", body: "Public read on c_users — anonymous traffic can list emails.", icon: "ShieldAlert" },
  { id: "n_03", kind: "flow", unread: true, who: "system", t: "38m ago", title: "Flow \"Notify on new comment\" failed 12 times", body: "Webhook target returned 503 — retry budget exhausted.", icon: "Bolt" },
  { id: "n_04", kind: "deploy", unread: false, who: "jules", t: "1h ago", title: "Production deploy succeeded", body: "workeros-api · cf-workers · build a4e2b9c · in 1m 42s.", icon: "CheckCircle" },
  { id: "n_05", kind: "member", unread: false, who: "admin", t: "3h ago", title: "priya@workeros.dev joined workspace", body: "Default role: authenticated · invited by rana.", icon: "Users" },
  { id: "n_06", kind: "function", unread: false, who: "system", t: "1d ago", title: "Cron job \"nightly-rollup\" took 4× longer than baseline", body: "Last run 38.4s · baseline 9.6s · check the p95 query in Logs.", icon: "Clock" },
];

export function NotificationsBell() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [items, setItems] = useState<NotificationItem[]>(NOTIFICATIONS_SEED);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const unread = items.filter((n) => n.unread).length;

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as Node | null;
      if (wrapRef.current && target && !wrapRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const visible = filter === "unread" ? items.filter((n) => n.unread) : items;
  const markRead = (id: string) =>
    setItems((arr) => arr.map((n) => (n.id === id ? { ...n, unread: false } : n)));
  const markAllRead = () => setItems((arr) => arr.map((n) => ({ ...n, unread: false })));

  const onItem = (n: NotificationItem) => {
    markRead(n.id);
    // Advisor notifications deep-link to the new Advisor page; other kinds
    // currently just mark-read.
    if (n.kind === "advisor") {
      setOpen(false);
      navigate("/advisor");
    }
  };

  return (
    <div ref={wrapRef} className="notif-wrap">
      <button
        type="button"
        className="notif-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="Notifications"
      >
        <I.Bell size={14} />
        {unread > 0 && <span className="notif-dot tabular-nums font-mono">{unread}</span>}
      </button>
      {open && (
        <div className="notif-pop">
          <div className="notif-head">
            <span style={{ fontSize: 13, fontWeight: 500 }}>Notifications</span>
            <div className="spacer" />
            <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "unread")}>
              <TabsList className="h-7">
                <TabsTrigger value="all" className="text-xs">All</TabsTrigger>
                <TabsTrigger value="unread" className="text-xs">
                  Unread {unread > 0 && <span className="count">{unread}</span>}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="notif-list">
            {visible.length === 0 ? (
              <div
                style={{
                  padding: 36,
                  textAlign: "center",
                  color: "var(--muted-foreground)",
                  fontSize: 13,
                }}
              >
                <I.Inbox size={22} style={{ marginBottom: 8, opacity: 0.5 }} />
                <br />
                You're all caught up.
              </div>
            ) : (
              visible.map((n) => {
                const IconComp = (I as Record<string, IconComponent>)[n.icon] ?? I.Bell;
                return (
                  <button
                    key={n.id}
                    type="button"
                    className={`notif-item ${n.unread ? "unread" : ""}`}
                    onClick={() => onItem(n)}
                  >
                    <span className={`notif-ico notif-ico-${n.kind}`}>
                      <IconComp size={13} />
                    </span>
                    <div className="notif-body">
                      <div className="notif-title">{n.title}</div>
                      <div className="notif-text">{n.body}</div>
                      <div className="notif-meta font-mono">
                        {n.who} · {n.t}
                      </div>
                    </div>
                    {n.unread && <span className="notif-unread-dot" />}
                  </button>
                );
              })
            )}
          </div>
          <div className="notif-foot">
            <Button variant="ghost" size="sm" onClick={markAllRead}>
              Mark all read
            </Button>
            <div className="spacer" />
            <Button
              variant="ghost"
              size="sm"
              iconRight={I.ChevronRight}
              onClick={() => {
                setOpen(false);
                navigate("/activity");
              }}
            >
              Open inbox
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Topbar({ crumbs, onOpenPalette, onToggleTheme, dark, onToggleSidebar, onSignOut, user, onAccountSettings }: TopbarProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest(".user-menu-wrap")) setOpen(false);
    };
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="topbar">
      <IconButton icon={I.Sidebar} onClick={onToggleSidebar} title="Toggle sidebar" />
      <div className="crumbs path">
        <span className="sep">/</span>
        {crumbs.map((c, i) => (
          <Fragment key={i}>
            {i > 0 && <span className="sep">/</span>}
            <span className={i === crumbs.length - 1 ? "here" : ""}>{c}</span>
          </Fragment>
        ))}
      </div>
      <div className="kbar" onClick={onOpenPalette}>
        <I.Search size={13} />
        <span>Search collections, items, settings…</span>
        <span className="kbd">⌘K</span>
      </div>
      <IconButton icon={dark ? I.Sun : I.Moon} onClick={onToggleTheme} title="Toggle theme" />
      <NotificationsBell />
      <div className="user-menu-wrap" style={{ position: "relative" }}>
        <button
          onClick={() => setOpen((v) => !v)}
          title={user?.email ?? "Account"}
          aria-label="Account menu"
          style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}
        >
          {(() => {
            const src = resolveAvatarSrc(user?.image);
            return src ? (
              <img src={src} alt="" className="avatar" style={{ objectFit: "cover" }} />
            ) : (
              <div className="avatar">{avatarInitials(user)}</div>
            );
          })()}
          <I.ChevronDown size={12} style={{ color: "var(--muted-foreground)" }} />
        </button>
        {open && (
          <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", minWidth: 220, background: "var(--popover)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "0 12px 32px oklch(0 0 0 / 0.12)", padding: 6, zIndex: 100, fontSize: 13 }}>
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
              <div style={{ fontWeight: 500 }}>
                {user?.name || user?.email?.split("@")[0] || "Account"}
              </div>
              {user?.email && (
                <div className="muted font-mono" style={{ fontSize: 11.5 }}>{user.email}</div>
              )}
              {user?.isAdmin && (
                <div style={{ marginTop: 4 }}><span className="badge badge-default">admin</span></div>
              )}
            </div>
            <button
              type="button"
              onClick={() => { setOpen(false); onAccountSettings?.(); }}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "transparent", border: 0, color: "var(--foreground)", width: "100%", textAlign: "left", cursor: "pointer", font: "inherit" }}
            >
              <I.Settings size={13} /> Account settings
            </button>
            <button
              type="button"
              onClick={onSignOut}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "transparent", border: 0, color: "var(--destructive)", width: "100%", textAlign: "left", cursor: "pointer", font: "inherit" }}
            >
              <I.LogOut size={13} /> Sign out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export interface PageHeaderProps {
  title?: ReactNode;
  slug?: string;
  description?: ReactNode;
  actions?: ReactNode;
  badges?: ReactNode;
}

export function PageHeader({ title, slug, description, actions, badges }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-[18px]">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
          {slug ? <span className="font-mono text-[22px] font-medium">{slug}</span> : title}
          {badges}
        </h1>
        {description && (
          <div className="max-w-[720px] text-sm text-muted-foreground">{description}</div>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}

interface Toast {
  id: string;
  msg: string;
  type: "success" | "error";
}

export function useToasts(): [ReactNode, (msg: string, type?: "success" | "error") => void] {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((msg: string, type: "success" | "error" = "success") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, msg, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);
  const node = (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.type === "error" ? "error" : ""}`}>
          <span className="toast-ico">
            {t.type === "error" ? <I.AlertTriangle size={14} /> : <I.Check size={14} stroke={2.5} />}
          </span>
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
  return [node, push];
}
