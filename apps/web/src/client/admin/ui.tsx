// @ts-nocheck
// Shared UI primitives + layout for the backlex admin design.
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { msg } from "@lingui/core/macro";
import type { MessageDescriptor } from "@lingui/core";
import { cn } from "@backlex/ui/lib/utils";
import { I, type IconComponent, type IconKey } from "./icons";
import { NAV_PRIMARY, NAV_DATA, NAV_AUTOMATION, NAV_OBSERVABILITY, NAV_SETTINGS, NAV_DEVELOPERS, isNavVisible, type MeNav } from "./config";
import { prefetchPage } from "./lib/page-prefetch";
import { notificationsApi, tenantsApi, type ApiNotification, type ApiTenant } from "./api";
import { orderCollections, useCollections, useNotifications, useNotificationsUnread, queryKeys } from "./queries";
import { useWorkspaceBranding } from "@/lib/branding";
import { Button as ShadcnButton } from "@backlex/ui/components/button";
import { Card } from "@backlex/ui/components/card";
import { Badge as ShadcnBadge } from "@backlex/ui/components/badge";
import { Switch as ShadcnSwitch } from "@backlex/ui/components/switch";
import { Checkbox as ShadcnCheckbox } from "@backlex/ui/components/checkbox";
import { Input } from "@backlex/ui/components/input";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@backlex/ui/components/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import {
  Sidebar as ShadcnSidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@backlex/ui/components/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@backlex/ui/components/collapsible";
import { TooltipProvider } from "@backlex/ui/components/tooltip";

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
  const { t } = useLingui();
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
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <I.Braces size={12} />
        <span className="font-semibold uppercase tracking-[0.06em]">{label}</span>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="xs"
          onClick={copy}
          className="font-mono text-[10.5px] text-muted-foreground"
        >
          {copied ? t`copied` : t`copy`}
        </Button>
      </div>
      <ScrollArea className="rounded-surface" viewportStyle={{ maxHeight }}>
        <pre className="m-0 whitespace-pre rounded-surface border border-border bg-[color-mix(in_oklch,var(--muted)_40%,var(--card))] p-3 font-mono text-[11.5px] leading-[1.55]">
          {json}
        </pre>
      </ScrollArea>
    </div>
  );
}

export interface BrandMarkProps {
  size?: number;
  /** Uploaded workspace logo. When set it renders instead of the default mark. */
  logoUrl?: string | null;
  /** Reserved for callers that still pass a label; the default mark ignores it. */
  label?: string;
}

export function BrandMark({ size = 32, logoUrl }: BrandMarkProps) {
  const uid = useId().replace(/:/g, "");
  if (logoUrl) {
    return (
      <img
        src={logoUrl}
        alt=""
        className="brand-mark brand-mark--image"
        style={{ width: size, height: size }}
      />
    );
  }
  // Saturn: violet planet, tilted coral ring with front/back occlusion, moon.
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className="brand-mark brand-mark--logo"
      style={{ width: size, height: size, display: "block", overflow: "visible" }}
      fill="none"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id={`bp-${uid}`} cx="36%" cy="30%" r="72%">
          <stop offset="0%" stopColor="#e9e1ff" />
          <stop offset="55%" stopColor="#7c5cff" />
          <stop offset="100%" stopColor="#3a2384" />
        </radialGradient>
        <clipPath id={`bf-${uid}`}>
          <rect x="0" y="16" width="32" height="16" />
        </clipPath>
      </defs>
      <g transform="rotate(-22 16 16)">
        <ellipse cx="16" cy="16" rx="14.2" ry="5.3" stroke="#ff9d83" strokeOpacity="0.85" strokeWidth="1.7" />
      </g>
      <circle cx="16" cy="16" r="7.3" fill={`url(#bp-${uid})`} />
      <g transform="rotate(-22 16 16)" clipPath={`url(#bf-${uid})`}>
        <ellipse cx="16" cy="16" rx="14.2" ry="5.3" stroke="#ffb59e" strokeWidth="1.7" />
      </g>
      <g transform="rotate(-22 16 16)">
        <circle r="1.5" fill="#ffe2d4">
          <animateMotion dur="6s" repeatCount="indefinite" path="M 1.8 16 a 14.2 5.3 0 1 0 28.4 0 a 14.2 5.3 0 1 0 -28.4 0" />
        </circle>
      </g>
    </svg>
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

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "size"> {
  icon: IconComponent;
  size?: "sm" | "md";
  variant?: ButtonVariant;
}

// `...rest` must reach ShadcnButton so that `<DropdownMenuTrigger asChild><IconButton/></DropdownMenuTrigger>`
// (and any other Radix `asChild` slot) can forward its handlers/ref/aria-* onto the underlying button —
// without it the trigger never wires up and the menu won't open. Mirrors the text `Button` above.
export function IconButton({ icon: IconComp, onClick, title, className, disabled, variant = "ghost", size: _size, type = "button", ...rest }: IconButtonProps) {
  return (
    <ShadcnButton variant={mapButtonVariant(variant)} size="icon-sm" type={type} onClick={onClick} title={title} disabled={disabled} className={className} {...rest}>
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
  color: string | null;
}

const fromApiTenant = (t: ApiTenant): Tenant => ({
  id: t.id,
  slug: t.slug,
  name: t.name,
  project: t.project,
  branch: t.branch,
  env: t.env,
  color: t.color,
});

export interface SidebarProps {
  activeNav: string;
  setActiveNav: (id: string) => void;
  pushToast: (msg: string, type?: "success" | "error") => void;
  collectionsCount?: number;
  /** Slug of the collection whose items page is open — highlights the
   *  matching row in the sidebar collections tree. */
  activeCollection?: string | null;
  /** Tri-state admin flag from `/api/me`. `false` hides admin-only nav
   *  items; `null`/`undefined` (still loading) shows everything so admins
   *  don't watch their menu pop in. Cosmetic — the API stays gated. */
  isAdmin?: boolean | null;
  /** Per-permission nav grants from `/api/me` — narrows the non-admin
   *  allow-list to pages the user holds an actual read grant for. */
  navGrants?: MeNav | null;
}

/** Collapsed-state of sidebar collection groups. Per-device UI state —
 *  localStorage, not the server (a chevron click shouldn't be a write). */
const COLLAPSED_GROUPS_LS = "backlex.sidebar.collection-groups.collapsed";
/** Pinned collection slugs shown at the top of the sidebar tree. Same
 *  per-device posture as the collapse state. */
const PINNED_COLLECTIONS_LS = "backlex.sidebar.collections.pinned";
/** Show the filter input only once the list is long enough to need it. */
const TREE_FILTER_MIN = 8;

/**
 * Grouped collections tree under the "Collections" nav item: pinned rows
 * first, then groups as collapsible headers in the saved `meta.groups`
 * order, collections beneath in their saved manual order, ungrouped rows at
 * the end. Long lists get a filter input (flat match list while typing).
 * Reads the same `["collections", {includeArchived:false}]` query the app
 * shell already holds — React Query dedupes, so this adds no network call.
 */
function CollectionsTree({ activeCollection, onOpen }: { activeCollection?: string | null; onOpen: (slug: string) => void }) {
  const { t } = useLingui();
  const { data, isLoading } = useCollections(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem(COLLAPSED_GROUPS_LS) ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(PINNED_COLLECTIONS_LS) ?? "[]");
      return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    } catch {
      return [];
    }
  });
  const toggleGroup = (g: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [g]: !prev[g] };
      try {
        localStorage.setItem(COLLAPSED_GROUPS_LS, JSON.stringify(next));
      } catch {
        // Private-mode storage failures just lose persistence, not function.
      }
      return next;
    });
  };
  const togglePin = (slug: string) => {
    setPinned((prev) => {
      const next = prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug];
      try {
        localStorage.setItem(PINNED_COLLECTIONS_LS, JSON.stringify(next));
      } catch {
        // Same as above — persistence only.
      }
      return next;
    });
  };

  const rows = useMemo(
    () =>
      (data?.data ?? []).filter(
        (c) => ((c as { status?: string }).status ?? "active") === "active",
      ),
    [data],
  );
  const sections = useMemo(
    () => orderCollections(rows, data?.meta?.groups ?? []).filter(([, list]) => list.length > 0),
    [rows, data],
  );

  if (isLoading) {
    return (
      <SidebarMenuSub>
        {Array.from({ length: 3 }).map((_, i) => (
          <SidebarMenuSubItem key={i}>
            <Skeleton className="my-1 h-4 w-4/5" />
          </SidebarMenuSubItem>
        ))}
      </SidebarMenuSub>
    );
  }
  if (sections.length === 0) return null;

  const q = query.trim().toLowerCase();
  const matches = q ? rows.filter((c) => c.slug.toLowerCase().includes(q)) : null;
  // Preserve the user's pin order; drop slugs whose collection is gone.
  const pinnedRows = pinned
    .map((slug) => rows.find((c) => c.slug === slug))
    .filter((c): c is (typeof rows)[number] => !!c);

  const renderRow = (c: { slug: string }, keyPrefix = "") => {
    const isPinned = pinned.includes(c.slug);
    return (
      <SidebarMenuSubItem key={keyPrefix + c.slug}>
        <SidebarMenuSubButton
          isActive={c.slug === activeCollection}
          onClick={() => onOpen(c.slug)}
          onMouseEnter={() => prefetchPage("collections")}
          className="group/pin cursor-pointer"
        >
          <span className="truncate font-mono text-[12px]">{c.slug}</span>
          {/* Not a <button>: SidebarMenuSubButton is an <a>, nesting is invalid. */}
          <span
            role="button"
            tabIndex={-1}
            title={isPinned ? t`Unpin` : t`Pin to top`}
            onClick={(e) => {
              e.stopPropagation();
              togglePin(c.slug);
            }}
            className={`ml-auto shrink-0 transition-opacity ${isPinned ? "text-primary [&_polygon]:fill-current" : "text-muted-foreground opacity-0 group-hover/pin:opacity-100"}`}
          >
            <I.Star size={11} />
          </span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  };

  return (
    <ScrollArea viewportClassName="max-h-[40vh]">
      <SidebarMenuSub>
        {rows.length >= TREE_FILTER_MIN && (
          <SidebarMenuSubItem>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t`Filter collections…`}
              className="mb-1 h-7 rounded-control px-2.5 font-mono text-[12px]"
            />
          </SidebarMenuSubItem>
        )}
        {matches ? (
          matches.length > 0 ? (
            matches.map((c) => renderRow(c))
          ) : (
            <SidebarMenuSubItem>
              <div className="px-3 py-1 text-[11.5px] text-muted-foreground"><Trans>No collections match</Trans></div>
            </SidebarMenuSubItem>
          )
        ) : (
          <>
            {pinnedRows.length > 0 && (
              <>
                <SidebarMenuSubItem>
                  <div className="flex h-6 items-center gap-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    <I.Star size={10} /> <Trans>Pinned</Trans>
                  </div>
                </SidebarMenuSubItem>
                {pinnedRows.map((c) => renderRow(c, "pin-"))}
              </>
            )}
            {sections.map(([g, list]) => {
              const items = list.map((c) => renderRow(c));
              if (g === null) {
                // Ungrouped rows render flat at the end — no header to collapse.
                return items;
              }
              const open = !collapsed[g];
              return (
                <Collapsible key={g} asChild open={open} onOpenChange={() => toggleGroup(g)}>
                  <SidebarMenuSubItem>
                    <CollapsibleTrigger asChild>
                      <SidebarMenuSubButton className="cursor-pointer text-muted-foreground">
                        <I.ChevronRight
                          size={11}
                          className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
                        />
                        <span className="truncate text-[11px] font-semibold uppercase tracking-[0.06em]">{g}</span>
                        <span className="ml-auto tabular-nums text-[10px]">{list.length}</span>
                      </SidebarMenuSubButton>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <SidebarMenuSub className="mr-0 pr-0">{items}</SidebarMenuSub>
                    </CollapsibleContent>
                  </SidebarMenuSubItem>
                </Collapsible>
              );
            })}
          </>
        )}
      </SidebarMenuSub>
    </ScrollArea>
  );
}

/**
 * Display labels for the sidebar / command-palette nav, keyed by the nav id
 * defined in `config.ts`. Kept here (a JSX module) rather than in `config.ts`
 * because the Lingui `msg` macro is only transformed in files plugin-react
 * runs Babel on — i.e. files that contain JSX.
 */
const NAV_LABELS: Record<string, MessageDescriptor> = {
  overview: msg`Overview`,
  "ask-ai": msg`Ask AI`,
  collections: msg`Collections`,
  access: msg`Access`,
  database: msg`Database`,
  storage: msg`Storage`,
  search: msg`Search`,
  flows: msg`Flows`,
  agents: msg`Agents`,
  functions: msg`Functions`,
  jobs: msg`Jobs`,
  "feature-flags": msg`Feature flags`,
  webhooks: msg`Webhooks`,
  integrations: msg`Integrations`,
  realtime: msg`Realtime`,
  logs: msg`Logs`,
  traces: msg`Traces`,
  advisor: msg`Advisor`,
  "schema-graph": msg`Schema graph`,
  "schema-versions": msg`Schema versions`,
  "database-import": msg`Database import`,
  insights: msg`Insights`,
  revisions: msg`Revisions`,
  translations: msg`Translations`,
  "rest-explorer": msg`REST Explorer`,
  graphql: msg`GraphQL`,
  openapi: msg`OpenAPI`,
  authentication: msg`Authentication`,
  "platform-sso": msg`Platform SSO`,
  users: msg`Team`,
  "app-users": msg`Users`,
  "api-keys": msg`API keys`,
  "email-templates": msg`Email templates`,
  settings: msg`Settings`,
};

/** Lingui descriptor for a nav id; falls back to the raw id if unknown. */
export const navLabel = (id: string): MessageDescriptor =>
  NAV_LABELS[id] ?? { id };

export function Sidebar({ activeNav, setActiveNav, pushToast, collectionsCount, activeCollection, isAdmin, navGrants }: SidebarProps) {
  const settings = NAV_SETTINGS;
  const developers = NAV_DEVELOPERS;
  const { t, i18n } = useLingui();
  const { isMobile, openMobile, setOpenMobile } = useSidebar();
  const branding = useWorkspaceBranding();

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [tenantsLoaded, setTenantsLoaded] = useState(false);
  const [newWsOpen, setNewWsOpen] = useState(false);

  // Collapse the Collections tree in the sidebar (per-device UI state).
  const [collectionsOpen, setCollectionsOpen] = useState(() => {
    try {
      return localStorage.getItem("backlex.sidebar.collections.open") !== "false";
    } catch {
      return true;
    }
  });
  const toggleCollections = () =>
    setCollectionsOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem("backlex.sidebar.collections.open", String(next));
      } catch {
        // Private-mode storage failures just lose persistence, not function.
      }
      return next;
    });

  const reloadTenants = useCallback(async () => {
    try {
      const res = await tenantsApi.list();
      const mapped = res.data.map(fromApiTenant);
      setTenants(mapped);
      setTenantId(res.active ?? mapped[0]?.id ?? null);
    } catch {
      // Auth gate handles 401; quietly leave the placeholder tile in place.
    } finally {
      setTenantsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reloadTenants();
  }, [reloadTenants]);

  // The mobile drawer is a Radix Sheet that remounts its content on every open,
  // so the nav list's scroll resets to the top — on a long list the active
  // page's item ends up below the fold and the user has to scroll back down to
  // it each time. Bring it into view once the freshly-opened content is in the
  // DOM (two rAFs: one for the React commit, one for Radix's portal mount).
  useEffect(() => {
    if (!isMobile || !openMobile) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>('[data-mobile="true"] [data-active="true"]')
          ?.scrollIntoView({ block: "center" });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [isMobile, openMobile, activeNav]);

  const switchTenant = async (id: string) => {
    try {
      await tenantsApi.switchTo(id);
      setTenantId(id);
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
      pushToast?.(t`Workspace "${res.data.slug}" created.`);
      setNewWsOpen(false);
      await tenantsApi.switchTo(res.data.id);
      window.location.reload();
    } catch (e) {
      pushToast?.((e as Error).message, "error");
    }
  };

  const tenant: Tenant =
    tenants.find((t) => t.id === tenantId) ||
    tenants[0] || {
      id: "placeholder",
      name: "—",
      project: "—",
      branch: "—",
      env: "—",
      color: null,
    };
  // The workspace tile mirrors a skeleton until the tenant list resolves.
  const tenantPending = !tenantsLoaded && tenants.length === 0;
  // Brand name: the admin-set workspace name (Settings → Appearance) wins;
  // otherwise fall back to the tenant/project name. The brand mark shows the
  // uploaded logo when present, else the initial of whichever name applies.
  const brandName = branding?.workspaceName?.trim() || tenant.name;

  return (
    <TooltipProvider>
    <ShadcnSidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                  <BrandMark size={32} logoUrl={branding?.logoUrl} label={brandName} />
                  <div className="grid flex-1 gap-1 text-left leading-tight">
                    {tenantPending ? (
                      <>
                        <Skeleton className="h-3.5 w-28" />
                        <Skeleton className="h-3 w-20" />
                      </>
                    ) : (
                      <>
                        <span className="truncate text-[13.5px] font-semibold">{brandName}</span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">{tenant.env}</span>
                      </>
                    )}
                  </div>
                  <I.ChevronDown className="ml-auto" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side={isMobile ? "bottom" : "right"} sideOffset={4} className="min-w-64">
            <DropdownMenuLabel className="flex items-center justify-between">
              <span><Trans>Workspaces</Trans></span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{tenants.length}</span>
            </DropdownMenuLabel>
            <ScrollArea viewportClassName="max-h-[280px]">
              {tenants.map((t) => (
                <DropdownMenuItem key={t.id} className="gap-2.5" onSelect={() => void switchTenant(t.id)}>
                  <span className="ws-mark" style={{ "--ws-color": t.color ?? undefined } as React.CSSProperties}>{t.name.charAt(0).toUpperCase()}</span>
                  <span className="ws-meta">
                    <span className="ws-name">{t.name}</span>
                    <span className="ws-sub font-mono">{t.project} · {t.branch} · {t.env}</span>
                  </span>
                  {t.id === tenantId && <I.Check size={12} />}
                </DropdownMenuItem>
              ))}
            </ScrollArea>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setNewWsOpen(true)}><I.Plus size={12} /> <Trans>New workspace</Trans></DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setActiveNav?.("settings")}><I.Settings size={12} /> <Trans>Manage</Trans></DropdownMenuItem>
          </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent className="group-data-[collapsible=icon]:overflow-y-auto!">
        {[
          { key: "primary", label: null, entries: NAV_PRIMARY },
          { key: "data", label: <Trans>Data</Trans>, entries: NAV_DATA },
          { key: "automation", label: <Trans>Automation</Trans>, entries: NAV_AUTOMATION },
          { key: "observability", label: <Trans>Observability</Trans>, entries: NAV_OBSERVABILITY },
          { key: "developers", label: <Trans>Developers</Trans>, entries: developers },
          { key: "admin", label: <Trans>Admin</Trans>, entries: settings },
        ].map((group) => ({
          ...group,
          // Non-admins only get the entries whose pages they can actually
          // use; empty groups drop out below (Docs keeps "developers" alive).
          entries: group.entries.filter((it) => isNavVisible(it.id, isAdmin, navGrants)),
        })).filter((group) => group.entries.length > 0 || group.key === "developers").map((group) => (
          <SidebarGroup key={group.key}>
            {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarMenu>
              {group.entries.map((it) => {
                const IconComp = (I as Record<string, IconComponent>)[it.icon as IconKey];
                // Collections gets a live badge from the parent; other items use
                // the (currently empty) static `badge` field on the nav def.
                const liveBadge = it.id === "collections" ? collectionsCount : it.badge;
                return (
                  <SidebarMenuItem key={it.id}>
                    <SidebarMenuButton
                      isActive={activeNav === it.id}
                      onClick={() => {
                        setActiveNav(it.id);
                        if (isMobile) setOpenMobile(false);
                      }}
                      // Warm the page's lazy chunk on intent so the click's view
                      // transition opens instantly instead of flashing a skeleton.
                      onMouseEnter={() => prefetchPage(it.id)}
                      onFocus={() => prefetchPage(it.id)}
                      tooltip={i18n._(navLabel(it.id))}
                    >
                      {IconComp && <IconComp size={15} />}
                      <span>{i18n._(navLabel(it.id))}</span>
                    </SidebarMenuButton>
                    {liveBadge != null && (
                      <SidebarMenuBadge className={cn("rounded-control bg-white/8 px-1.5 font-mono text-[10.5px] tabular-nums text-muted-foreground", it.id === "collections" && "right-7")}>{liveBadge}</SidebarMenuBadge>
                    )}
                    {it.id === "collections" && (
                      <>
                        <button
                          type="button"
                          aria-label={collectionsOpen ? t`Collapse collections` : t`Expand collections`}
                          aria-expanded={collectionsOpen}
                          onClick={toggleCollections}
                          className="absolute top-1.5 right-1 z-10 grid size-5 place-items-center rounded-control text-sidebar-foreground/60 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                        >
                          <I.ChevronDown size={14} className={cn("transition-transform", !collectionsOpen && "-rotate-90")} />
                        </button>
                        {collectionsOpen && (
                          <CollectionsTree
                            activeCollection={activeCollection}
                            onOpen={(slug) => {
                              setActiveNav("collections/" + slug);
                              if (isMobile) setOpenMobile(false);
                            }}
                          />
                        )}
                      </>
                    )}
                  </SidebarMenuItem>
                );
              })}
              {group.key === "developers" && (
                // Public docs live on a separate site — external link, new tab.
                <SidebarMenuItem>
                  <SidebarMenuButton asChild tooltip={t`Docs`}>
                    <a href="https://backlex.com/docs" target="_blank" rel="noreferrer">
                      <I.BookOpen size={15} />
                      <span><Trans>Docs</Trans></span>
                      <I.ExternalLink size={12} className="ml-auto opacity-60" />
                    </a>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              )}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarRail />

      {newWsOpen && <NewWorkspaceDialog onClose={() => setNewWsOpen(false)} onCreate={createWorkspace} existing={tenants.map((t) => t.name)} />}
    </ShadcnSidebar>
    </TooltipProvider>
  );
}

function NewWorkspaceDialog({ onClose, onCreate, existing }: { onClose: () => void; onCreate: (data: { name: string; project: string; env: string }) => void; existing: string[] }) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [project, setProject] = useState("default");
  const [env, setEnv] = useState("development");
  // Focus the Name field once the dialog has settled. Deferred so it lands
  // after the workspace-switcher dropdown finishes restoring focus on close
  // (otherwise the first typed character is lost). Plain post-mount focus —
  // deliberately NOT via Radix onOpenAutoFocus, which caused a focus-scope
  // render loop.
  useEffect(() => {
    const id = window.setTimeout(() => {
      document.querySelector<HTMLInputElement>('[role="dialog"] input')?.focus();
    }, 80);
    return () => window.clearTimeout(id);
  }, []);
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24);
  const taken = slug && existing.includes(slug);
  const valid = slug.length >= 2 && !taken;
  const submit = () => { if (valid) onCreate({ name: slug, project, env }); };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[min(86vh,720px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        <DialogHeader className="flex-row items-center gap-2.5 space-y-0 border-b border-border px-4 py-3.5 pr-12 text-left">
          <I.Plus size={14} />
          <DialogTitle className="text-sm font-medium"><Trans>New workspace</Trans></DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 p-[22px]">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Name</Trans></label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="acme-prod" onKeyDown={(e) => e.key === "Enter" && submit()} />
            {taken && <span className="text-[11.5px] text-destructive"><Trans>Workspace "{slug}" already exists.</Trans></span>}
            {!taken && slug && <span className="text-[11.5px] text-muted-foreground"><Trans>URL:</Trans> <span className="font-mono">backlex.dev/{slug}</span></span>}
            {!slug && <span className="text-[11.5px] text-muted-foreground"><Trans>Lowercase, alphanumeric, 2–24 chars.</Trans></span>}
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Default project</Trans></label>
            <Input value={project} onChange={(e) => setProject(e.target.value)} placeholder="default" />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Environment</Trans></label>
            <Select value={env} onValueChange={setEnv}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t`Select environment`} />
              </SelectTrigger>
              <SelectContent>
                {[
                  { id: "development", label: t`Development`, hint: t`local D1` },
                  { id: "staging", label: t`Staging`, hint: t`preview` },
                  { id: "production", label: t`Production`, hint: t`live` },
                ].map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label} <span className="ml-1 text-[10.5px] text-muted-foreground">{p.hint}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="border-t border-border px-[18px] py-3">
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={submit}><Trans>Create workspace</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

/** Compact relative-time formatter for notification / comment timestamps.
 *  Accepts a Unix-ms number, an ISO string, or a Date — the notifications
 *  schema stores `created_at` as Unix-ms on SQLite and a `Date` on PG. */
export function relativeTime(input: unknown): string {
  if (input == null) return "";
  const d =
    input instanceof Date
      ? input
      : typeof input === "number"
        ? new Date(input)
        : new Date(String(input));
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return "";
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toISOString().slice(0, 10);
}

export function NotificationsBell() {
  const { t } = useLingui();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");

  const listQuery = useNotifications();
  const unreadQuery = useNotificationsUnread();
  const items: ApiNotification[] = listQuery.data?.data ?? [];
  // `read_at == null` is the source of truth for unread; the dedicated
  // count endpoint drives the badge so it stays fresh even while the popover
  // is closed.
  const unread = unreadQuery.data?.data.count ?? items.filter((n) => n.readAt == null).length;

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: queryKeys.notifications() });
  };

  const markReadMut = useMutation({
    mutationFn: (id: string) => notificationsApi.markRead(id),
    onSuccess: invalidate,
  });
  const markAllMut = useMutation({
    mutationFn: () => notificationsApi.markAllRead(),
    onSuccess: invalidate,
  });

  const visible = filter === "unread" ? items.filter((n) => n.readAt == null) : items;

  const onItem = (n: ApiNotification) => {
    if (n.readAt == null) markReadMut.mutate(n.id);
    // Internal URLs deep-link via the router; external / missing URLs just
    // mark-read. The real schema has no `kind`, so there's no per-category
    // routing — `url` is the only navigation signal.
    if (n.url && n.url.startsWith("/")) {
      setOpen(false);
      navigate(n.url);
    }
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="notif-trigger"
          aria-label={t`Notifications`}
        >
          <I.Bell size={14} />
          {unread > 0 && <span className="notif-dot tabular-nums font-mono">{unread}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex max-h-[540px] w-[380px] flex-col overflow-hidden p-0">
          <div className="notif-head">
            <span style={{ fontSize: 13, fontWeight: 500 }}><Trans>Notifications</Trans></span>
            <div className="spacer" />
            <Tabs value={filter} onValueChange={(v) => setFilter(v as "all" | "unread")}>
              <TabsList className="h-7">
                <TabsTrigger value="all" className="text-xs"><Trans>All</Trans></TabsTrigger>
                <TabsTrigger value="unread" className="text-xs">
                  <Trans>Unread</Trans> {unread > 0 && <span className="count">{unread}</span>}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="notif-list">
            {listQuery.isLoading ? (
              <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : visible.length === 0 ? (
              <div
                style={{
                  padding: 36,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 8,
                  color: "var(--muted-foreground)",
                  fontSize: 13,
                }}
              >
                <I.Inbox size={22} style={{ opacity: 0.5 }} />
                <Trans>You're all caught up.</Trans>
              </div>
            ) : (
              visible.map((n) => {
                // No `kind`/`icon` columns on the real row — a flow-sourced
                // notification gets the Bolt glyph, everything else the Bell.
                const isFlow = !!n.flowId;
                const IconComp: IconComponent = isFlow ? I.Bolt : I.Bell;
                const unreadRow = n.readAt == null;
                return (
                  <button
                    key={n.id}
                    type="button"
                    className={`notif-item ${unreadRow ? "unread" : ""}`}
                    onClick={() => onItem(n)}
                  >
                    <span className={isFlow ? "notif-ico notif-ico-flow" : "notif-ico"}>
                      <IconComp size={13} />
                    </span>
                    <div className="notif-body">
                      <div className="notif-title">{n.title}</div>
                      {n.body && <div className="notif-text">{n.body}</div>}
                      <div className="notif-meta font-mono">
                        {relativeTime(n.createdAt)}
                      </div>
                    </div>
                    {unreadRow && <span className="notif-unread-dot" />}
                  </button>
                );
              })
            )}
          </div>
          <div className="notif-foot">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => markAllMut.mutate()}
              disabled={markAllMut.isPending || unread === 0}
            >
              <Trans>Mark all read</Trans>
            </Button>
          </div>
      </PopoverContent>
    </Popover>
  );
}

export function Topbar({ crumbs, onOpenPalette, onSignOut, user, onAccountSettings }: TopbarProps) {
  const { t } = useLingui();
  return (
    <div className="topbar">
      <SidebarTrigger title={t`Toggle sidebar`} />
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
        <span><Trans>Search collections, items, settings…</Trans></span>
        <span className="kbd">⌘K</span>
      </div>
      <NotificationsBell />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title={user?.email ?? t`Account`}
            aria-label={t`Account menu`}
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
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <div style={{ padding: "8px 10px" }}>
            <div style={{ fontWeight: 500 }}>
              {user?.name || user?.email?.split("@")[0] || t`Account`}
            </div>
            {user?.email && (
              <div className="font-mono text-[11.5px] text-muted-foreground">{user.email}</div>
            )}
            {user?.isAdmin && (
              <div className="mt-1">
                <span className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-control border border-[color-mix(in_oklch,var(--primary)_22%,transparent)] bg-[color-mix(in_oklch,var(--primary)_8%,var(--card))] px-2 py-px text-[11px] font-medium tabular-nums text-[oklch(from_var(--primary)_0.38_0.12_h)] dark:text-[oklch(from_var(--primary)_0.92_0.18_h)]">
                  admin
                </span>
              </div>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => { onAccountSettings?.(); }}>
            <I.Settings size={13} /> <Trans>Account settings</Trans>
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onSelect={() => { onSignOut?.(); }}>
            <I.LogOut size={13} /> <Trans>Sign out</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export interface PageHeaderProps {
  title?: ReactNode;
  slug?: string;
  description?: ReactNode;
  /** Extra classes on the description wrapper — e.g. `hidden sm:block` to drop
   *  a long description on mobile where vertical space is scarce. */
  descriptionClassName?: string;
  actions?: ReactNode;
  badges?: ReactNode;
}

export function PageHeader({ title, slug, description, descriptionClassName, actions, badges }: PageHeaderProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-[18px]">
      <div className="flex min-w-0 flex-col gap-1">
        <h1 className="m-0 flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight">
          {slug ? <span className="font-mono text-[22px] font-medium">{slug}</span> : title}
          {badges}
        </h1>
        {description && (
          <div className={cn("max-w-[720px] text-sm text-muted-foreground", descriptionClassName)}>{description}</div>
        )}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}

export interface EmptyStateProps {
  /** Optional leading glyph, e.g. `I.BarChart`. */
  icon?: IconComponent;
  title: ReactNode;
  description?: ReactNode;
  /** Optional CTA rendered under the copy, e.g. a `<Button>`. */
  action?: ReactNode;
  /**
   * `lg` — full page area (the Insights look). `md` — side panels.
   * `sm` — compact inline/sidebar placeholders (no card, no icon by default).
   */
  size?: "lg" | "md" | "sm";
  /** Drop the card border/bg — for use inside a table cell or already-bordered parent. */
  bare?: boolean;
  className?: string;
}

/**
 * Canonical empty / no-data state for the admin. Standardizes the icon size,
 * heading weight, description size, and card chrome so every "nothing here yet"
 * surface reads the same — modeled on the Insights "No insight panels yet" panel.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  size = "lg",
  bare = false,
  className,
}: EmptyStateProps) {
  if (size === "sm") {
    return (
      <div className={cn("px-3 py-4 text-center text-[12.5px] text-muted-foreground", className)}>
        {Icon && <Icon size={20} className="mx-auto mb-1.5 text-muted-foreground" />}
        <div>{title}</div>
        {description && <div className="mt-0.5">{description}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    );
  }
  const content = (
    <>
      {Icon && <Icon size={size === "lg" ? 28 : 22} className="text-muted-foreground" />}
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && <div className="max-w-[460px] text-[12.5px] leading-[1.5]">{description}</div>}
      {action && <div className="mt-1">{action}</div>}
    </>
  );
  if (bare) {
    return (
      <div className={cn("flex flex-col items-center gap-3 text-center text-muted-foreground py-8", className)}>
        {content}
      </div>
    );
  }
  return (
    <Card
      className={cn(
        "items-center gap-3 text-center text-muted-foreground",
        size === "lg" ? "p-12" : "p-9",
        className,
      )}
    >
      {content}
    </Card>
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
    <div className="fixed right-[18px] top-[18px] z-[80] flex flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="flex min-w-[240px] animate-in items-center gap-2.5 rounded-control border border-border bg-popover px-3.5 py-2.5 text-[13px] text-popover-foreground shadow-[0_10px_30px_-8px_oklch(0_0_0/0.2)] fade-in-0 slide-in-from-top-2 duration-200"
        >
          <span className={t.type === "error" ? "flex-none text-destructive" : "flex-none text-primary"}>
            {t.type === "error" ? <I.AlertTriangle size={14} /> : <I.Check size={14} stroke={2.5} />}
          </span>
          <span>{t.msg}</span>
        </div>
      ))}
    </div>
  );
  return [node, push];
}
