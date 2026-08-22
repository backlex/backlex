// Websites — the registry three features resolve a site against.
//
// It was a TAB inside the Analytics page, and that was the defect: the tag
// manager and the consent policy both attach to a site, and both are top-level
// entries, so a shared registry sat inside one of its three consumers. An
// operator setting up a cookie banner had to go into Analytics to register the
// website it protects. `docs/DESIGN.md` already carried the rule this restores:
// a feature that warrants a submenu gets a top-level nav entry instead.
//
// What deliberately did NOT come with it: `IngestKeyDialog`, which the Analytics
// header renders, not this page. The key is a measurement credential.
//
// The page also owns its own loading and error state now. As a tab it inherited
// the Analytics page's gate — `if (overviewQ.isLoading) return <AnalyticsSkeleton/>`
// and an error wrapper around `overviewQ.isError` — so a 500 from
// `/api/admin/analytics/overview` made the site registry unreachable, even
// though nothing here reads `overview`, `days` or `segmentId`.
import type { PushToast } from "../../types";
import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { WebsitesSkeleton } from "../../page-skeletons";
import { Badge, Button, EmptyState, PageHeader } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { type ApiAnalyticsSite } from "../../api";
import {
  useAnalyticsSites,
  useCreateAnalyticsSite,
  useDeleteAnalyticsSite,
  useUpdateAnalyticsSite,
} from "../../queries";
import { queryKeys } from "../../queries";
import { useQueryClient } from "@tanstack/react-query";

/** The snippet an operator pastes. Built from the browser's own origin so a
 *  workspace on a custom domain needs no configuration to get it right. */
const snippetFor = (siteId: string): string =>
  `<script defer src="${typeof window === "undefined" ? "" : window.location.origin}/api/analytics/script.js" data-site="${siteId}"></script>`;

export function WebsitesPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const sitesQ = useAnalyticsSites();
  const createSite = useCreateAnalyticsSite();
  const updateSite = useUpdateAnalyticsSite();
  const deleteSite = useDeleteAnalyticsSite();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ApiAnalyticsSite | null>(null);
  const sites = sitesQ.data?.data ?? [];
  const qc = useQueryClient();

  const copy = (text: string) => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => pushToast(t`Snippet copied.`))
      .catch(() => pushToast(t`Could not copy — select the snippet manually.`));
  };

  if (sitesQ.isLoading) return <WebsitesSkeleton />;

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        title={t`Websites`}
        description={t`The sites you measure, tag and ask for consent on. Everything on this page is per website.`}
        actions={
          <>
            {/* Its own Refresh. As a tab it had none — the Analytics header's
                button did a PREFIX invalidate on ["analytics"], which happened
                to reach the site list. After the split that prefix no longer
                covers anything this page shows. */}
            <Button
              icon={I.Refresh}
              onClick={() => qc.invalidateQueries({ queryKey: queryKeys.analyticsSites() })}
            >
              <Trans>Refresh</Trans>
            </Button>
            <Button variant="primary" icon={I.Plus} onClick={() => setAddOpen(true)}>
              <Trans>Add website</Trans>
            </Button>
          </>
        }
      />

      {sites.length === 0 ? (
        <EmptyState
          icon={I.Globe}
          title={t`No websites registered`}
          description={t`Register a website to get a one-line script tag. It measures pageviews with no cookie and no consent banner — visitors are counted by a hash that rotates every day.`}
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sites.map((s: ApiAnalyticsSite) => (
            <Card key={s.id} className="gap-3 px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium">{s.name}</div>
                  <div className="truncate text-[12.5px] text-muted-foreground">
                    {s.domain}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    icon={I.Copy}
                    onClick={() => copy(snippetFor(s.id))}
                  >
                    <Trans>Copy snippet</Trans>
                  </Button>
                  <Button
                    variant="outline"
                    icon={I.Settings}
                    onClick={() => setEditing(s)}
                  >
                    <Trans>Settings</Trans>
                  </Button>
                  <Button
                    variant="outline"
                    icon={I.Trash}
                    onClick={() => {
                      deleteSite.mutate(s.id, {
                        onError: () => pushToast(t`Could not remove the site.`),
                      });
                      pushToast(t`Site removed.`);
                    }}
                  >
                    <Trans>Remove</Trans>
                  </Button>
                </div>
              </div>

              {/* The snippet is long and full of punctuation — the classic
                  mobile overflow. Its own scroll container keeps the card and
                  the page from ever scrolling sideways. */}
              <ScrollArea className="w-full rounded-control border bg-muted/40">
                <div className="p-2">
                  <code className="block whitespace-pre text-[11.5px] leading-relaxed">
                    {snippetFor(s.id)}
                  </code>
                </div>
              </ScrollArea>

              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant={s.filterBots ? "primary" : "outline"}
                  onClick={() =>
                    updateSite.mutate({ id: s.id, patch: { filterBots: !s.filterBots } })
                  }
                >
                  {s.filterBots ? <Trans>Bots filtered</Trans> : <Trans>Bots kept</Trans>}
                </Button>
                <Button
                  variant={s.requireKnownOrigin ? "primary" : "outline"}
                  onClick={() =>
                    updateSite.mutate({
                      id: s.id,
                      patch: { requireKnownOrigin: !s.requireKnownOrigin },
                    })
                  }
                >
                  {s.requireKnownOrigin ? (
                    <Trans>Origin checked</Trans>
                  ) : (
                    <Trans>Any origin</Trans>
                  )}
                </Button>
                <Badge variant="secondary">
                  <Trans>Cookieless</Trans>
                </Badge>
              </div>
            </Card>
          ))}
        </div>
      )}

      <SiteSettingsDialog
        site={editing}
        onClose={() => setEditing(null)}
        onSave={(patch) => {
          if (!editing) return;
          updateSite.mutate(
            { id: editing.id, patch },
            { onError: () => pushToast(t`Could not save the settings.`) },
          );
          setEditing(null);
          pushToast(t`Site settings saved.`);
        }}
      />

      <AddSiteDialog
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onSubmit={(input) => {
          // Optimistic: the row is in the list before the request resolves, and
          // the dialog closes immediately. `onError` rolls the cache back.
          createSite.mutate(input, {
            onError: () => pushToast(t`Could not add the site.`),
          });
          setAddOpen(false);
          pushToast(t`Site added — copy its snippet.`);
        }}
      />
    </div>
  );
}

function AddSiteDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; domain: string }) => void;
}) {
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const valid = name.trim().length > 0 && domain.trim().length > 0;

  const submit = () => {
    if (!valid) return;
    onSubmit({ name: name.trim(), domain: domain.trim() });
    setName("");
    setDomain("");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add a website</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              You get a one-line script tag. It stores nothing on the visitor's
              device, so it needs no cookie banner.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Name</Trans>
              </span>
              <Input
                value={name}
                placeholder="Marketing site"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Domain</Trans>
              </span>
              <Input
                value={domain}
                placeholder="example.com"
                onChange={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  A full URL is fine — it is reduced to the host. Subdomains
                  count as the same site.
                </Trans>
              </span>
            </label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="primary" disabled={!valid} onClick={submit}>
            <Trans>Add site</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Realtime ─────────────────────────────────────────────────────────── */

/**
 * Per-site collection settings.
 *
 * These are the controls that actually bound what a public write endpoint
 * accepts, and every one of them is enforced SERVER-side. The tag's own
 * opt-outs (DNT, GPC, skipping localhost) are advice a modified script can
 * decline to follow; these are not.
 */
function SiteSettingsDialog({
  site,
  onClose,
  onSave,
}: {
  site: ApiAnalyticsSite | null;
  onClose: () => void;
  onSave: (patch: { excludedPaths: string[]; ignoredIps: string[] }) => void;
}) {
  const [paths, setPaths] = useState("");
  const [ips, setIps] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Seed the fields from the site the first time this opens for it. Doing it
  // in render rather than an effect keeps the dialog a pure function of props
  // and avoids the StrictMode double-effect that has bitten this codebase.
  if (site && loadedFor !== site.id) {
    setLoadedFor(site.id);
    setPaths(site.excludedPaths.join("\n"));
    setIps(site.ignoredIps.join("\n"));
  }

  const lines = (v: string) =>
    v
      .split(/[\n,]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 50);

  return (
    <Dialog open={!!site} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[520px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>
            <Trans>Collection settings</Trans>
          </DialogTitle>
          <DialogDescription>
            {site ? site.domain : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex min-w-0 flex-col gap-3">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Excluded paths</Trans>
              </span>
              <Input
                value={paths}
                placeholder="/admin/*, /health"
                onChange={(e) => setPaths(e.target.value)}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  Comma separated. A leading or trailing * is supported. Never
                  recorded, and enforced on the server.
                </Trans>
              </span>
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Ignored IPs</Trans>
              </span>
              <Input
                value={ips}
                placeholder="203.0.113.4, 198.51.100.9"
                onChange={(e) => setIps(e.target.value)}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  Your office, a monitoring probe. The address is compared and
                  discarded — it is never stored on an event.
                </Trans>
              </span>
            </label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            onClick={() => onSave({ excludedPaths: lines(paths), ignoredIps: lines(ips) })}
          >
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
