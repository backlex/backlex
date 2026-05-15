// @ts-nocheck
// Shared UI primitives + layout for the workeros admin design.
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { I, type IconComponent, type IconKey } from "./icons";
import { NAV_ITEMS, NAV_SETTINGS } from "./config";
import { tenantsApi, type ApiTenant } from "./api";

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
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconComponent;
  iconRight?: IconComponent;
  children?: ReactNode;
}

export function Button({
  variant = "outline",
  size = "sm",
  icon: IconComp,
  iconRight: IconRight,
  onClick,
  disabled,
  children,
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = `btn btn-${variant} ${size === "lg" ? "btn-lg" : size === "sm" ? "btn-sm" : ""} ${className}`;
  return (
    <button className={cls} type={type} onClick={onClick} disabled={disabled} {...rest}>
      {IconComp ? <IconComp size={14} /> : null}
      {children}
      {IconRight ? <IconRight size={14} /> : null}
    </button>
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

export function IconButton({ icon: IconComp, onClick, size = "sm", variant = "ghost", title, className = "" }: IconButtonProps) {
  const cls = `btn btn-${variant} ${size === "sm" ? "btn-icon-sm" : "btn-icon"} ${className}`;
  return (
    <button className={cls} onClick={onClick} title={title} type="button">
      <IconComp size={14} />
    </button>
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

export function Badge({ variant = "default", mono, children, className = "", style }: BadgeProps) {
  return (
    <span className={`badge badge-${variant} ${mono ? "badge-mono" : ""} ${className}`} style={style}>
      {children}
    </span>
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
    <div
      className="switch"
      data-on={checked}
      data-disabled={disabled || undefined}
      onClick={() => { if (!disabled) onChange(!checked); }}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled || undefined}
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
    <div
      className="checkbox"
      data-checked={checked && !indeterminate}
      data-indeterminate={indeterminate}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
    >
      {indeterminate ? <I.Minus size={11} stroke={3} /> : checked ? <I.Check size={11} stroke={3} /> : null}
    </div>
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
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="acme-prod" onKeyDown={(e) => e.key === "Enter" && submit()} />
            {taken && <span className="field-hint" style={{ color: "var(--destructive)" }}>Workspace "{slug}" already exists.</span>}
            {!taken && slug && <span className="field-hint">URL: <span className="font-mono">workeros.dev/{slug}</span></span>}
            {!slug && <span className="field-hint">Lowercase, alphanumeric, 2–24 chars.</span>}
          </div>
          <div className="field">
            <label className="field-label">Default project</label>
            <input className="input" value={project} onChange={(e) => setProject(e.target.value)} placeholder="default" />
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

export interface TopbarProps {
  crumbs: ReactNode[];
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  dark: boolean;
  onToggleSidebar: () => void;
  onSignOut?: () => void;
}

export function Topbar({ crumbs, onOpenPalette, onToggleTheme, dark, onToggleSidebar, onSignOut }: TopbarProps) {
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
      <div className="user-menu-wrap" style={{ position: "relative" }}>
        <button onClick={() => setOpen((v) => !v)} title="rana@workeros.dev" style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
          <div className="avatar">RM</div>
          <I.ChevronDown size={12} style={{ color: "var(--muted-foreground)" }} />
        </button>
        {open && (
          <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", minWidth: 220, background: "var(--popover)", border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", boxShadow: "0 12px 32px oklch(0 0 0 / 0.12)", padding: 6, zIndex: 100, fontSize: 13 }}>
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
              <div style={{ fontWeight: 500 }}>Rana Marin</div>
              <div className="muted font-mono" style={{ fontSize: 11.5 }}>rana@workeros.dev</div>
              <div style={{ marginTop: 4 }}><span className="badge badge-default">admin</span></div>
            </div>
            <button type="button" style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "transparent", border: 0, color: "var(--foreground)", width: "100%", textAlign: "left", cursor: "pointer", font: "inherit" }}>
              <I.Settings size={13} /> Account settings
            </button>
            <button type="button" onClick={onSignOut} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderRadius: "var(--radius-md)", background: "transparent", border: 0, color: "var(--destructive)", width: "100%", textAlign: "left", cursor: "pointer", font: "inherit" }}>
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
    <div className="page-header">
      <div className="page-title-block">
        <h1 className="page-title">
          {slug ? <span className="slug">{slug}</span> : title}
          {badges}
        </h1>
        {description && <div className="page-desc">{description}</div>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
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
