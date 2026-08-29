// Settings page shell — the cards live in sibling modules. The directory
// preserves the historical ./pages/settings import path.
// Settings page — general/appearance/email/bindings/env/about tabs
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, type IconComponent } from "../../icons";
import { type AdapterId } from "../../config";
import { Badge, Button, PageHeader } from "../../ui";
import {
  settingsApi,
  type ApiRuntime,
} from "../../api";
import { Card } from "@backlex/ui/components/card";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { SettingsSkeleton } from "../../page-skeletons";
import { useUrlTab } from "../../use-url-tab";


import { EmailSettingsCard, PushSettingsCard, SmsSettingsCard } from "./messaging-cards";
import { AiSettingsCard } from "./ai-card";
import { AppearanceSettingsCard, SignInBrandingCard } from "./appearance-cards";
import { WorkspaceLocaleCard } from "./locale-card";
import { WorkspaceCard } from "./workspace-card";

// Workspace comes first because it is the page's subject: every other tab
// configures something that lives INSIDE a workspace, while this one is about
// the workspace itself — its name, the address its tables are keyed by, and
// whether it is still in circulation at all.
const SETTINGS_TABS = [
  "workspace",
  "general",
  "appearance",
  "email",
  "push",
  "sms",
  "ai",
  "bindings",
  "env",
  "about",
] as const;

export function SettingsPage({ adapter, pushToast }: { adapter: AdapterId; pushToast: PushToast }) {
  const { t } = useLingui();
  const [tab, setTab] = useUrlTab(SETTINGS_TABS, "workspace");
  const [appUrl, setAppUrl] = useState("http://localhost:8787");
  const [from, setFrom] = useState("hello@example.com");
  // First-load gate — drives the page skeleton until the General-tab settings
  // hydrate from the server.
  const [loaded, setLoaded] = useState(false);
  // Hydrate the General-tab form from /api/admin/settings on mount. APP_URL and
  // EMAIL_FROM come from env (read-only here). Public sign-up is governed by
  // Auth Settings (auth_config.policy.openSignup), not this page. The display
  // name lives in workspace_config and is edited from the Appearance tab.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.load();
        if (cancelled) return;
        const d = r.data as Record<string, unknown>;
        if (typeof d.appUrl === "string") setAppUrl(d.appUrl);
        if (typeof d.emailFrom === "string") setFrom(d.emailFrom);
      } catch {
        // keep seed
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const [bindings, setBindings] = useState<{ id: number; type: string; name: string; target: string; status: string; warn: string | undefined }[]>([]);
  const [envVars, setEnvVars] = useState<{ id: number | string; key: string; value: string; secret: boolean; source: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await settingsApi.runtime();
        if (cancelled) return;
        const rt = r.data as ApiRuntime;
        setBindings(
          rt.bindings.map((b, i) => ({
            id: i + 1,
            type: b.type,
            name: b.name,
            target: b.target,
            status: b.status,
            warn: b.status === "optional" ? `${b.name} unbound` : undefined,
          })),
        );
        setEnvVars(
          rt.envVars.map((v, i) => ({
            id: i + 1,
            key: v.key,
            value: v.set ? (v.secret ? "••••••••" : "set") : "(unset)",
            secret: v.secret,
            source: v.source,
          })),
        );
      } catch {
        // keep seed
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const bindingIcon = (t: string): IconComponent => (({ D1: I.Database, KV: I.Folder, R2: I.Server, DurableObj: I.Bolt, Vectorize: I.Bolt, Hyperdrive: I.Database, Dispatch: I.Bolt, Queue: I.Webhook, AI: I.Bolt } as Record<string, IconComponent>)[t] || I.Folder);

  // First whole-page fetch — General-tab settings haven't hydrated yet.
  if (!loaded) return <SettingsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title={t`Settings`} description={t`Self-hosted on Cloudflare Workers. Most config lives in wrangler.toml; this page is a live view + UI for runtime-mutable values.`} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as (typeof SETTINGS_TABS)[number])}>
        <TabsList>
          {[
            { id: "workspace", label: t`Workspace` },
            { id: "general", label: t`General` },
            { id: "appearance", label: t`Appearance` },
            { id: "email", label: t`Email` },
            { id: "push", label: t`Push` },
            { id: "sms", label: t`SMS` },
            { id: "ai", label: t`AI` },
            { id: "bindings", label: t`Bindings`, count: bindings.length },
            { id: "env", label: t`Environment`, count: envVars.length },
            { id: "about", label: t`About` },
          ].map((tabItem) => (
            <TabsTrigger key={tabItem.id} value={tabItem.id}>
              <span>{tabItem.label}</span>
              {tabItem.count !== undefined && <span className="rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground">{tabItem.count}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {tab === "workspace" && <WorkspaceCard pushToast={pushToast} />}

      {tab === "general" && (
        <div className="flex flex-col gap-4">
        <Card className="max-w-[920px] gap-4 p-[22px]">
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">APP_URL</div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>Public origin of this Worker — set via <span className="font-mono">wrangler.toml [vars]</span> (or <span className="font-mono">.env</span> on self-host). Used for CORS, OAuth callbacks and absolute links. Read-only here.</Trans></div>
            </div>
            <span className="break-all text-right font-mono text-[12.5px] text-muted-foreground">{appUrl}</span>
          </div>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">EMAIL_FROM</div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>Sender address for transactional email — set via <span className="font-mono">wrangler secret put</span> / <span className="font-mono">.env</span>. When unset (or RESEND_API_KEY is missing) email is logged to stdout. Read-only here.</Trans></div>
            </div>
            <span className="break-all text-right font-mono text-[12.5px] text-muted-foreground">{from || t`(not set)`}</span>
          </div>
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div>
              <div className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Runtime</Trans></div>
              <div className="text-[11.5px] text-muted-foreground"><Trans>Auto-detected from <span className="font-mono">env</span> bindings.</Trans></div>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-control border border-border bg-background py-0.5 pl-1.5 pr-2 text-[11px]"><span className="size-[7px] shrink-0 rounded-full bg-primary shadow-[0_0_0_3px_color-mix(in_oklch,var(--primary)_20%,transparent)]" />{adapter}</span>
          </div>
        </Card>
        <WorkspaceLocaleCard pushToast={pushToast} />
        </div>
      )}

      {tab === "appearance" && (
        <div className="flex flex-col gap-4">
          <AppearanceSettingsCard pushToast={pushToast} />
          <SignInBrandingCard pushToast={pushToast} />
        </div>
      )}

      {tab === "email" && <EmailSettingsCard pushToast={pushToast} />}

      {tab === "push" && <PushSettingsCard pushToast={pushToast} />}

      {tab === "sms" && <SmsSettingsCard pushToast={pushToast} />}

      {tab === "ai" && <AiSettingsCard pushToast={pushToast} />}

      {tab === "bindings" && (
        <div className="flex max-w-[920px] flex-col gap-3">
          <div className="flex items-start gap-2.5 overflow-hidden rounded-surface border border-border bg-muted p-3.5">
            <I.Info size={14} className="mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium"><Trans>Bindings are read-only here</Trans></span>
              <span className="text-xs text-muted-foreground"><Trans>Edit them in <span className="font-mono text-foreground">wrangler.toml</span> and redeploy. This panel reflects the live binding map from <span className="font-mono text-foreground">env</span>.</Trans></span>
            </div>
          </div>
          <Card className="py-0 gap-0">
            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border px-4 py-3.5">
              <I.Server size={14} className="shrink-0" /><span className="whitespace-nowrap text-[13px] font-medium"><Trans>worker bindings</Trans></span>
              <span className="font-mono text-xs text-muted-foreground"><Trans>{bindings.filter((b) => b.status === "connected").length} connected · {bindings.filter((b) => b.status !== "connected").length} optional</Trans></span>
              <div className="flex-1" />
              <Button variant="ghost" size="sm" icon={I.Refresh} onClick={() => pushToast(t`Bindings refreshed.`)}><Trans>Refresh</Trans></Button>
            </div>
            <div className="hidden grid-cols-[24px_110px_160px_1fr_120px] items-center gap-3 border-b border-border bg-muted px-3.5 py-[11px] text-[11px] uppercase tracking-[0.4px] text-muted-foreground md:grid">
              <span></span><span><Trans>Type</Trans></span><span><Trans>Name</Trans></span><span><Trans>Resource</Trans></span><span><Trans>Status</Trans></span>
            </div>
            {bindings.map((b) => {
              const Ic = bindingIcon(b.type);
              return (
                <div key={b.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0 md:grid md:grid-cols-[24px_110px_160px_1fr_120px] md:gap-3 md:py-[11px]">
                  <span className="shrink-0"><Ic size={14} /></span>
                  <span className="font-mono text-[12.5px]">{b.type}</span>
                  <span className="order-last w-full break-all font-mono text-[13px] md:order-none md:w-auto md:break-normal">{b.name}</span>
                  <div className="order-last flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 md:order-none md:w-auto md:flex-nowrap">
                    <span className="break-all font-mono text-xs text-muted-foreground">{b.target}</span>
                    {b.warn && <span className="text-[11.5px] text-muted-foreground">· {b.warn}</span>}
                  </div>
                  <span className="ml-auto shrink-0 md:ml-0">
                    {b.status === "connected" && <Badge variant="default"><Trans>connected</Trans></Badge>}
                    {b.status === "optional" && <Badge variant="secondary"><Trans>unbound</Trans></Badge>}
                  </span>
                </div>
              );
            })}
          </Card>
          <Card className="p-4 gap-0">
            <div className="mb-2 flex items-center gap-2">
              <I.Code size={13} />
              <span className="text-[12.5px] font-medium"><Trans>wrangler.toml snippet</Trans></span>
            </div>
            <pre className="m-0 whitespace-pre-wrap rounded-control bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-[11.5px] leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)]">{`[[d1_databases]]
binding = "D1"
database_name = "backlex"

[[r2_buckets]]
binding = "R2"
bucket_name = "backlex-files"

[[vectorize]]
binding = "VECTORIZE"
index_name = "backlex-embeddings"

[[durable_objects.bindings]]
name = "REALTIME"
class_name = "RealtimeRoom"`}</pre>
          </Card>
        </div>
      )}

      {tab === "env" && (
        <div className="flex max-w-[920px] flex-col gap-3">
          <div className="flex items-start gap-2.5 overflow-hidden rounded-surface border border-border bg-muted p-3.5">
            <I.Info size={14} className="mt-0.5" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[12.5px] font-medium"><Trans>Environment variables are read-only here</Trans></span>
              <span className="text-xs text-muted-foreground"><Trans>Set them in <span className="font-mono text-foreground">wrangler.toml [vars]</span> / <span className="font-mono text-foreground">wrangler secret put</span> (or <span className="font-mono text-foreground">apps/web/.env</span> on self-host) and redeploy. This panel only reports which keys are present — secret values are never sent to the browser.</Trans></span>
            </div>
          </div>
          <Card className="py-0 gap-0">
            <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3.5">
              <I.Lock size={14} /><span className="text-[13px] font-medium"><Trans>environment</Trans></span>
              <span className="font-mono text-xs text-muted-foreground"><Trans>{envVars.filter((v) => v.value !== "(unset)").length} set · {envVars.filter((v) => v.value === "(unset)").length} unset</Trans></span>
            </div>
            <div className="hidden grid-cols-[24px_1fr_120px_110px] items-center gap-3 border-b border-border bg-muted px-3.5 py-[11px] text-[11px] uppercase tracking-[0.4px] text-muted-foreground md:grid">
              <span></span><span><Trans>Key</Trans></span><span><Trans>Kind</Trans></span><span><Trans>Status</Trans></span>
            </div>
            {envVars.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3.5 py-3 text-[13px] last:border-b-0 md:grid md:grid-cols-[24px_1fr_120px_110px] md:gap-3 md:py-[11px]">
                <span className="shrink-0">{v.secret ? <I.Lock size={13} /> : <I.Hash size={13} />}</span>
                <span className="min-w-0 flex-1 break-all font-mono text-[12.5px] md:flex-none md:break-normal">{v.key}</span>
                <span className="text-[11.5px] text-muted-foreground">{v.secret ? <Trans>secret</Trans> : <Trans>plain</Trans>}</span>
                <span className="ml-auto shrink-0 md:ml-0">{v.value === "(unset)" ? <Badge variant="secondary"><Trans>unset</Trans></Badge> : <Badge variant="default"><Trans>set</Trans></Badge>}</span>
              </div>
            ))}
          </Card>
        </div>
      )}

      {tab === "about" && (
        <div className="flex max-w-[920px] flex-col gap-3">
          <Card className="gap-3 p-[22px]">
            {[
              [t`Version`, `${__APP_VERSION__} (${__GIT_COMMIT__})`],
              [t`Released`, __BUILD_DATE__],
              [t`Runtime`, adapter],
              [t`Wrangler`, __WRANGLER_VERSION__],
              [t`License`, "Apache-2.0"],
              [t`Repository`, "github.com/backlex/backlex"],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{k}</span>
                <span className="font-mono text-[12.5px] text-muted-foreground">{v}</span>
              </div>
            ))}
          </Card>
          <Card className="flex flex-col gap-3 p-[18px] sm:flex-row sm:items-center sm:gap-2.5">
            <I.Shield size={14} className="shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium"><Trans>Open-source · Apache-2.0 licensed</Trans></span>
              <span className="text-xs text-muted-foreground"><Trans>Self-hosted on Cloudflare Workers. No telemetry, no billing — just clone, deploy, run.</Trans></span>
            </div>
            <div className="hidden flex-1 sm:block" />
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                icon={I.Code}
                onClick={() => window.open("https://github.com/backlex/backlex", "_blank", "noopener,noreferrer")}
              >
                <Trans>GitHub</Trans>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={I.Folder}
                onClick={() => window.open("https://backlex.com/docs", "_blank", "noopener,noreferrer")}
              >
                <Trans>Docs</Trans>
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
