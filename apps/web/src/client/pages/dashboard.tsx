import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import {
  ActivityIcon,
  CheckCircle2Icon,
  CircleAlertIcon,
  DatabaseIcon,
  FolderTreeIcon,
  GlobeIcon,
  HardDriveIcon,
  KeyRoundIcon,
  RadioIcon,
  ServerIcon,
  WebhookIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@workeros/ui/components/card";
import { Skeleton } from "@workeros/ui/components/skeleton";
import { Badge } from "@workeros/ui/components/badge";
import { PageHeader } from "@/components/page-header";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

interface Health {
  ok: boolean;
  dialect: string;
  ts: number;
}

interface AdapterEntry {
  label: string;
  value: string;
  status: "connected" | "idle";
  icon: LucideIcon;
}

const buildAdapterRows = (health: Health | null): AdapterEntry[] => {
  // The API exposes dialect via /health; the rest is inferred from the same
  // selection rules that buildContext uses (R2 / Vectorize / Durable Object
  // bindings on Workers, fall through to local fs / pgvector / SSE on Bun).
  const dialect = health?.dialect ?? "?";
  const onWorkers = typeof window !== "undefined" &&
    /workers\.dev|cloudflare/.test(window.location.host);
  return [
    {
      label: "Database",
      value: dialect === "sqlite" ? (onWorkers ? "d1" : "sqlite (Bun)") : "postgres",
      status: health?.ok ? "connected" : "idle",
      icon: DatabaseIcon,
    },
    {
      label: "Storage",
      value: onWorkers ? "r2" : "local fs",
      status: "connected",
      icon: HardDriveIcon,
    },
    {
      label: "Realtime",
      value: onWorkers ? "durable object" : "in-proc + SSE",
      status: "connected",
      icon: RadioIcon,
    },
    {
      label: "Sandbox",
      value: onWorkers ? "cf-dispatch / quickjs" : "bun-worker",
      status: "idle",
      icon: ZapIcon,
    },
    {
      label: "Email",
      value: "console (dev)",
      status: "idle",
      icon: ServerIcon,
    },
  ];
};

interface Collection {
  slug: string;
  ownerScoped: boolean | number;
}

interface ActivityEntry {
  id: string;
  userId: string | null;
  action: string;
  collection: string;
  itemId: string | null;
  createdAt: string;
}

interface Counts {
  collections: number;
  files: number;
  flows: number;
  functions: number;
  webhooks: number;
  apiKeys: number;
}

interface StatProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon: typeof DatabaseIcon;
  to?: string;
  loading?: boolean;
}

const Stat = ({ label, value, hint, icon: Icon, to, loading }: StatProps) => {
  const inner = (
    <Card className="h-full transition-colors hover:bg-muted/40">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          {label}
          <Icon className="size-4 text-muted-foreground" />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Skeleton className="h-7 w-16" />
        ) : (
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
        )}
        {hint && !loading ? (
          <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
  return to ? (
    <Link to={to} className="block">
      {inner}
    </Link>
  ) : (
    inner
  );
};

const actionDot: Record<string, string> = {
  create: "bg-emerald-500",
  update: "bg-amber-500",
  delete: "bg-destructive",
};

const methodFor = (action: string): string => {
  switch (action) {
    case "create":
      return "POST";
    case "update":
      return "PATCH";
    case "delete":
      return "DELETE";
    default:
      return "GET";
  }
};

const statusFor = (method: string): number => {
  if (method === "POST") return 201;
  if (method === "DELETE") return 204;
  return 200;
};

export const Dashboard = () => {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthErr, setHealthErr] = useState(false);
  const [collections, setCollections] = useState<Collection[] | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);

  useEffect(() => {
    api<Health>("/health")
      .then(setHealth)
      .catch(() => setHealthErr(true));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const [c, a, files, flows, fns, hooks, keys] = await Promise.all([
          api<{ data: Collection[] }>("/api/collections"),
          api<{ data: ActivityEntry[] }>("/api/activity?limit=10"),
          api<{ data: unknown[] }>("/api/storage").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/api/flows").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/api/functions").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/api/webhooks").catch(() => ({ data: [] })),
          api<{ data: unknown[] }>("/api/api-keys").catch(() => ({ data: [] })),
        ]);
        setCollections(c.data);
        setActivity(a.data);
        setCounts({
          collections: c.data.length,
          files: files.data.length,
          flows: flows.data.length,
          functions: fns.data.length,
          webhooks: hooks.data.length,
          apiKeys: keys.data.length,
        });
      } catch (e) {
        notifyError(e, "Loading dashboard");
      }
    })();
  }, []);

  const heroStat = useMemo(() => {
    if (!collections) return null;
    return {
      total: collections.length,
      ownerScoped: collections.filter((c) => c.ownerScoped).length,
    };
  }, [collections]);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="At-a-glance health + counts. Click a card to drill down."
        actions={
          health ? (
            <Badge variant="outline" className="gap-1.5">
              <CheckCircle2Icon className="size-3 text-emerald-500" />
              healthy · {health.dialect}
            </Badge>
          ) : healthErr ? (
            <Badge variant="destructive" className="gap-1.5">
              <CircleAlertIcon className="size-3" />
              API unreachable
            </Badge>
          ) : (
            <Skeleton className="h-6 w-32" />
          )
        }
      />

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Collections"
          icon={FolderTreeIcon}
          to="/collections"
          loading={!counts}
          value={counts?.collections ?? 0}
          hint={
            heroStat && heroStat.ownerScoped > 0
              ? `${heroStat.ownerScoped} owner-scoped`
              : undefined
          }
        />
        <Stat
          label="Files"
          icon={HardDriveIcon}
          to="/storage"
          loading={!counts}
          value={counts?.files ?? 0}
        />
        <Stat
          label="Flows"
          icon={WorkflowIcon}
          to="/flows"
          loading={!counts}
          value={counts?.flows ?? 0}
        />
        <Stat
          label="Functions"
          icon={ZapIcon}
          to="/functions"
          loading={!counts}
          value={counts?.functions ?? 0}
        />
        <Stat
          label="Webhooks"
          icon={WebhookIcon}
          to="/webhooks"
          loading={!counts}
          value={counts?.webhooks ?? 0}
        />
        <Stat
          label="API keys"
          icon={KeyRoundIcon}
          to="/api-keys"
          loading={!counts}
          value={counts?.apiKeys ?? 0}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2 overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm">
            <ActivityIcon className="size-4" />
            <span className="font-medium">Request log</span>
            <span className="font-mono text-xs text-muted-foreground">
              activity stream · last 10
            </span>
            <div className="flex-1" />
            <Link
              to="/activity"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Open in Activity →
            </Link>
          </div>
          <CardContent className="p-0">
            {activity === null ? (
              <ul className="divide-y divide-border">
                {Array.from({ length: 5 }).map((_, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-2">
                    <Skeleton className="h-3 w-24" />
                    <Skeleton className="h-3 w-16" />
                    <Skeleton className="h-3 flex-1" />
                  </li>
                ))}
              </ul>
            ) : activity.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                Nothing yet — create a collection or item to get started.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {activity.map((a) => {
                  const method = methodFor(a.action);
                  const path = a.itemId
                    ? `/api/items/${a.collection}/${a.itemId.slice(0, 8)}`
                    : `/api/items/${a.collection}`;
                  return (
                    <li
                      key={a.id}
                      className="grid grid-cols-[110px_64px_1fr_60px_50px] items-center gap-3 px-4 py-2 text-sm"
                    >
                      <span className="font-mono text-xs text-muted-foreground tabular-nums">
                        {new Date(a.createdAt).toLocaleTimeString()}
                      </span>
                      <Badge variant="outline" className="font-mono justify-self-start">
                        {method}
                      </Badge>
                      <span className="truncate font-mono text-xs">{path}</span>
                      <Badge
                        variant={method === "DELETE" ? "destructive" : "default"}
                        className="justify-self-end font-mono tabular-nums"
                      >
                        {statusFor(method)}
                      </Badge>
                      <span className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                        —
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <FolderTreeIcon className="size-4" /> Top collections
            </CardTitle>
          </CardHeader>
          <CardContent>
            {collections === null ? (
              <ul className="space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <li key={i}>
                    <Skeleton className="h-4 w-2/3" />
                  </li>
                ))}
              </ul>
            ) : collections.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No collections yet.
              </p>
            ) : (
              <ul className="space-y-1">
                {collections.slice(0, 8).map((c) => (
                  <li key={c.slug}>
                    <Link
                      to={`/collections/${c.slug}`}
                      className="flex items-center justify-between rounded-md px-2 py-1 text-sm hover:bg-muted"
                    >
                      <span className="font-mono">{c.slug}</span>
                      {c.ownerScoped ? (
                        <Badge variant="secondary" className="text-[10px]">
                          owner
                        </Badge>
                      ) : null}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <GlobeIcon className="size-4" /> Adapter profile
              <Badge variant="outline" className="ml-2 gap-1.5 font-mono text-[10px]">
                <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_3px_color-mix(in_oklab,_var(--primary)_20%,_transparent)]" />
                {health?.dialect ?? "…"}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {buildAdapterRows(health).map((row) => (
                <li
                  key={row.label}
                  className="flex items-center justify-between gap-3 py-2.5"
                >
                  <div className="flex items-center gap-3">
                    <row.icon className="size-4 text-muted-foreground" />
                    <div>
                      <div className="text-sm font-medium">{row.label}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {row.value}
                      </div>
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className="gap-1.5 font-mono text-[10px] uppercase tracking-wide"
                  >
                    <span
                      className={`size-1.5 rounded-full ${
                        row.status === "connected"
                          ? "bg-emerald-500"
                          : "bg-amber-500"
                      }`}
                    />
                    {row.status}
                  </Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};
