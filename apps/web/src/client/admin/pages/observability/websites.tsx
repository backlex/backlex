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
// header renders, not this page. That key is for app SDKs — a website's tag
// authenticates by its site id and reads no key at all, so a key control here
// would invent a setup step the web path does not have.
//
// The page owns its own loading AND error state. As a tab it inherited the
// Analytics page's gate — `if (overviewQ.isLoading) return <AnalyticsSkeleton/>`
// and an error wrapper around `overviewQ.isError` — so a 500 from
// `/api/admin/analytics/overview` made the site registry unreachable, even
// though nothing here reads `overview`, `days` or `segmentId`.
//
// It is also the hub of its group rather than a leaf of it: Consent and Tag
// manager both send an operator here, so every card offers the way back out to
// what that site measures, tags and asks.
import type { PushToast } from "../../types";
import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { WebsitesSkeleton } from "../../page-skeletons";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { Badge, Button, EmptyState, PageHeader, Switch } from "../../ui";
import { ConfirmDialog } from "../../sheet";
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
  useConsentPolicies,
  useCreateAnalyticsSite,
  useDeleteAnalyticsSite,
  useUpdateAnalyticsSite,
} from "../../queries";
import { queryKeys } from "../../queries";
import { useQueryClient } from "@tanstack/react-query";
import {
  domainProblem,
  ipProblem,
  normalizeDomain,
  pathProblem,
  splitList,
} from "../../lib/site-input";

/** The server caps both list settings at 50 entries (`SiteInputSchema`). The
 *  form counts against the same number rather than silently slicing, so a 51st
 *  path is refused where it is typed instead of disappearing on save. */
const MAX_LIST_ENTRIES = 50;

export function WebsitesPage({
  pushToast,
  setActiveNav,
}: {
  pushToast: PushToast;
  /** Prop-drilled rather than `useNavigate`, matching ConsentPage: `app.tsx`'s
   *  `vNav` saves pane scroll, warms the target's lazy chunk and commits inside
   *  a view transition. A raw navigate skips all three. */
  setActiveNav?: (id: string) => void;
}) {
  const { t } = useLingui();
  const sitesQ = useAnalyticsSites();
  // Read-only here: the card says whether a site asks its visitors anything, so
  // the operator does not have to open Consent to find out. A failure is not
  // fatal — the chip simply says the state is unknown.
  const policiesQ = useConsentPolicies();
  const createSite = useCreateAnalyticsSite();
  const updateSite = useUpdateAnalyticsSite();
  const deleteSite = useDeleteAnalyticsSite();
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<ApiAnalyticsSite | null>(null);
  const [removing, setRemoving] = useState<ApiAnalyticsSite | null>(null);
  const sites = sitesQ.data?.data ?? [];
  const policies = policiesQ.data?.data ?? [];
  const qc = useQueryClient();

  // `navigator.clipboard?.…` short-circuits the WHOLE chain when the API is
  // absent — an insecure origin, an older WebView — so neither `.then` nor
  // `.catch` ran and the button silently did nothing, with its own fallback
  // message unreachable in exactly the case it was written for.
  const copy = (text: string) => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      pushToast(t`Could not copy — select the snippet manually.`, "error");
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => pushToast(t`Snippet copied.`))
      .catch(() => pushToast(t`Could not copy — select the snippet manually.`, "error"));
  };

  const header = (
    <PageHeader
      title={t`Websites`}
      description={t`The sites you measure, tag and ask for consent on. Everything on this page is per website.`}
      descriptionClassName="hidden sm:block"
      actions={
        <>
          {/* Its own Refresh. As a tab it had none — the Analytics header's
              button did a PREFIX invalidate on ["analytics"], which happened
              to reach the site list. After the split that prefix no longer
              covers anything this page shows. */}
          <Button
            icon={I.Refresh}
            disabled={sitesQ.isFetching}
            onClick={() => {
              void qc.invalidateQueries({ queryKey: queryKeys.analyticsSites() });
              void qc.invalidateQueries({ queryKey: queryKeys.consentPolicies() });
            }}
          >
            <Trans>Refresh</Trans>
          </Button>
          <Button variant="primary" icon={I.Plus} onClick={() => setAddOpen(true)}>
            <Trans>Add website</Trans>
          </Button>
        </>
      }
    />
  );

  if (sitesQ.isLoading) return <WebsitesSkeleton />;

  // A failed read used to fall through to `sites = []` and render "No websites
  // registered" — telling an operator with a working registry that it is empty,
  // and inviting them to add a duplicate. Nothing enforces domain uniqueness,
  // so that mistake double-counts every pageview.
  if (sitesQ.isError) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <EmptyState
          icon={I.AlertTriangle}
          title={t`Couldn't load your websites`}
          description={
            (sitesQ.error as Error)?.message ||
            t`The request failed. This is usually temporary — try again.`
          }
          action={
            <Button variant="primary" icon={I.Refresh} onClick={() => void sitesQ.refetch()}>
              <Trans>Try again</Trans>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {header}

      {sites.length === 0 ? (
        <EmptyState
          icon={I.Globe}
          title={t`No websites registered`}
          description={t`Register a website to get its one script tag. It carries your analytics, the tags you publish and your cookie banner — the analytics half stores nothing on the visitor's device, so it needs no banner of its own.`}
          action={
            <Button variant="primary" icon={I.Plus} onClick={() => setAddOpen(true)}>
              <Trans>Add website</Trans>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {/* Said once, above the list. Per card it was four lines of prose
              repeated for every registered site, and the instruction it carries
              does not change between them.

              Placement is not a nicety: deferred scripts execute in DOCUMENT
              ORDER, so first-in-head is what puts the consent decision ahead of
              every other deferred tag — and `async` forfeits it outright,
              because async scripts execute in completion order. */}
          <p className="m-0 rounded-control border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Trans>
              Paste a site's tag as the first script in your head tag, and keep defer —
              do not switch it to async. Deferred scripts run in document order, and
              being first is what puts the consent decision ahead of your other tags.
              One tag carries analytics, your published tags and the cookie banner, so
              it replaces an older analytics snippet rather than joining it.
            </Trans>
          </p>
          {sites.map((s: ApiAnalyticsSite) => {
            const policy = policies.find((p) => p.siteId === s.id) ?? null;
            return (
              <Card key={s.id} className="gap-3 px-4 py-3.5">
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-medium">{s.name}</div>
                    <div className="truncate text-[12.5px] text-muted-foreground">
                      {s.domain}
                    </div>
                  </div>
                  {/* Wraps and right-aligns rather than holding one rigid row:
                      three full labels are already ~320px in English and longer
                      in Turkish, against ~330px of card width on a 390px phone. */}
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    <Button
                      variant="outline"
                      icon={I.Copy}
                      // Disabled during the optimistic window: the snippet embeds
                      // the site's real id and the placeholder row has none yet,
                      // so copying would hand over a tag that collects nothing.
                      disabled={!s.snippet}
                      title={!s.snippet ? t`The snippet is ready in a moment.` : undefined}
                      onClick={() => copy(s.snippet)}
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
                    {/* Confirmed rather than immediate: the server's delete
                        cascades to the consent policy and every recorded
                        visitor decision — the compliance evidence for this
                        site. The row button keeps the admin's neutral list
                        styling and the confirm carries the red, which is where
                        the decision is actually made. */}
                    <Button
                      variant="outline"
                      icon={I.Trash}
                      onClick={() => setRemoving(s)}
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
                    {s.snippet ? (
                      <code className="block whitespace-pre text-[11.5px] leading-relaxed">
                        {s.snippet}
                      </code>
                    ) : (
                      // The optimistic row, before the server answers with the
                      // real id. A skeleton rather than an empty box, which reads
                      // as "this site has no snippet".
                      <Skeleton className="h-[18px] w-full" />
                    )}
                  </div>
                </ScrollArea>

                {/* Two booleans that bound what a PUBLIC write endpoint accepts.
                    They were buttons whose label was the current state ("Bots
                    kept"), so nothing on screen said whether that described now
                    or what clicking would do — and a screen reader heard only a
                    name that changed. A switch says both. */}
                <div className="grid max-w-[720px] gap-2.5 border-t pt-3 sm:grid-cols-2">
                  <label className="flex min-w-0 items-start gap-2.5">
                    <Switch
                      checked={s.filterBots}
                      onChange={(v) =>
                        updateSite.mutate(
                          { id: s.id, patch: { filterBots: v } },
                          {
                            onError: () =>
                              pushToast(t`Couldn't change bot filtering.`, "error"),
                          },
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium">
                        <Trans>Filter bot traffic</Trans>
                      </span>
                      <span className="block text-[11.5px] text-muted-foreground">
                        <Trans>Known crawlers are not counted as visitors.</Trans>
                      </span>
                    </span>
                  </label>
                  <label className="flex min-w-0 items-start gap-2.5">
                    <Switch
                      checked={s.requireKnownOrigin}
                      onChange={(v) =>
                        updateSite.mutate(
                          { id: s.id, patch: { requireKnownOrigin: v } },
                          {
                            onError: () =>
                              pushToast(t`Couldn't change the origin check.`, "error"),
                          },
                        )
                      }
                    />
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium">
                        <Trans>Only accept this domain</Trans>
                      </span>
                      <span className="block text-[11.5px] text-muted-foreground">
                        <Trans>Events from any other origin are dropped.</Trans>
                      </span>
                    </span>
                  </label>
                </div>

                {/* The way back out. Consent and Tag manager both send an
                    operator here and this page used to send nobody anywhere,
                    so the three read as three destinations rather than one
                    website with three aspects. */}
                <div className="flex flex-wrap items-center gap-1.5 border-t pt-3">
                  <Badge
                    variant="secondary"
                    title={t`Backlex's own analytics sets nothing on the device. Third-party tags you publish for this site may.`}
                  >
                    <Trans>Cookieless analytics</Trans>
                  </Badge>
                  {policiesQ.isError ? null : policy?.enabled ? (
                    <Badge variant="default">
                      <Trans>Banner live</Trans>
                    </Badge>
                  ) : policy ? (
                    <Badge variant="outline">
                      <Trans>Banner off</Trans>
                    </Badge>
                  ) : (
                    <Badge variant="outline">
                      <Trans>No consent policy</Trans>
                    </Badge>
                  )}
                  <span className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      icon={I.BarChart}
                      onClick={() => setActiveNav?.("analytics")}
                    >
                      <Trans>Analytics</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      icon={I.Tag}
                      onClick={() => setActiveNav?.("tag-manager")}
                    >
                      <Trans>Tags</Trans>
                    </Button>
                    <Button
                      variant="ghost"
                      icon={I.Cookie}
                      onClick={() => setActiveNav?.("consent")}
                    >
                      <Trans>Cookie banner</Trans>
                    </Button>
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Keyed on the target so the form re-seeds from the stored row every
          time it opens. Without it `loadedFor` matched on reopen, so Cancel was
          not a discard — abandoned edits came back, one click from Save. */}
      <SiteSettingsDialog
        key={editing?.id ?? "none"}
        site={editing}
        pushToast={pushToast}
        onClose={() => setEditing(null)}
        onSave={(patch) => {
          if (!editing) return;
          updateSite.mutate(
            { id: editing.id, patch },
            {
              onSuccess: () => pushToast(t`Site settings saved.`),
              // The server's refusal explains what it rejected — a 422 naming
              // the field beats "Could not save the settings."
              onError: (e) =>
                pushToast((e as Error)?.message || t`Couldn't save the settings.`, "error"),
            },
          );
          setEditing(null);
        }}
      />

      <AddSiteDialog
        open={addOpen}
        existingDomains={sites.map((s: ApiAnalyticsSite) => s.domain)}
        onClose={() => setAddOpen(false)}
        onSubmit={(input) => {
          // Optimistic: the row is in the list before the request resolves, and
          // the dialog closes immediately. `onError` rolls the cache back.
          createSite.mutate(input, {
            onSuccess: () => pushToast(t`Site added — copy its snippet.`),
            onError: (e) =>
              pushToast((e as Error)?.message || t`Couldn't add the site.`, "error"),
          });
          setAddOpen(false);
        }}
      />

      <ConfirmDialog
        open={!!removing}
        destructive
        title={t`Remove this website?`}
        description={t`Its snippet stops working, and the cookie banner policy plus every consent decision recorded for it are deleted too. This cannot be undone.`}
        confirmText={removing?.domain}
        confirmTextLabel={t`Type the domain to confirm`}
        actionLabel={t`Remove website`}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          if (!target) return;
          setRemoving(null);
          deleteSite.mutate(target.id, {
            onSuccess: () => pushToast(t`Site removed.`),
            onError: (e) =>
              pushToast((e as Error)?.message || t`Couldn't remove the site.`, "error"),
          });
        }}
      />
    </div>
  );
}

function AddSiteDialog({
  open,
  onClose,
  onSubmit,
  existingDomains,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (input: { name: string; domain: string }) => void;
  /** Already-registered hosts, normalized. Not a refusal — two sites on one
   *  domain is legal and occasionally deliberate — but it is nearly always the
   *  operator not realising the site is already here, and only one of the two
   *  snippets would be the one installed. */
  existingDomains: string[];
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const badDomain = domainProblem(domain);
  const duplicate =
    !badDomain && domain.trim() !== "" && existingDomains.includes(normalizeDomain(domain));
  const valid = name.trim().length > 0 && domain.trim().length > 0 && !badDomain;

  // Cancel and Esc used to leave the fields filled, so reopening the dialog
  // offered a site the operator had already decided against, one Enter from
  // being created.
  const close = () => {
    setName("");
    setDomain("");
    onClose();
  };

  const submit = () => {
    if (!valid) return;
    onSubmit({ name: name.trim(), domain: domain.trim() });
    setName("");
    setDomain("");
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle>
            <Trans>Add a website</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              You get one script tag for this site. It carries your analytics, the
              tags you publish and your cookie banner.
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
                aria-invalid={badDomain ? true : undefined}
                onChange={(e) => setDomain(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submit()}
              />
              {badDomain ? (
                // Checked here because this value decides whether the tag
                // collects at all: the origin check compares it to the real
                // request host, so a domain a browser cannot send drops every
                // event silently.
                <span className="text-[11.5px] text-destructive">
                  <Trans>
                    That is not a host. Use something like example.com — a full URL
                    is fine, a space or a path is not.
                  </Trans>
                </span>
              ) : duplicate ? (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>
                    This domain is already registered. Adding it twice is allowed, but
                    only the snippet you install will report.
                  </Trans>
                </span>
              ) : (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>
                    A full URL is fine — it is reduced to the host. Subdomains
                    count as the same site.
                  </Trans>
                </span>
              )}
            </label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            title={!valid ? t`Enter a name and a domain.` : undefined}
            onClick={submit}
          >
            <Trans>Add site</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── Per-site settings ────────────────────────────────────────────────── */

/**
 * What a site records, and what identifies it.
 *
 * The two list settings are the controls that actually bound what a public
 * write endpoint accepts, and both are enforced SERVER-side. The tag's own
 * opt-outs (DNT, GPC, skipping localhost) are advice a modified script can
 * decline to follow; these are not.
 *
 * Name and domain live here too. They were editable through the API the whole
 * time and through nothing in the UI, so the only way to fix a typo'd domain —
 * the field that decides whether the origin check accepts traffic at all — was
 * Remove and re-add, which destroys the consent policy and every consent record
 * for that site.
 */
function SiteSettingsDialog({
  site,
  pushToast,
  onClose,
  onSave,
}: {
  site: ApiAnalyticsSite | null;
  pushToast: PushToast;
  onClose: () => void;
  onSave: (patch: {
    name: string;
    domain: string;
    excludedPaths: string[];
    ignoredIps: string[];
  }) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [domain, setDomain] = useState("");
  const [paths, setPaths] = useState("");
  const [ips, setIps] = useState("");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  // Seed the fields from the site the first time this opens for it. Doing it
  // in render rather than an effect keeps the dialog a pure function of props
  // and avoids the StrictMode double-effect that has bitten this codebase.
  // The parent keys this component on the site id, so "the first time" is once
  // per opening rather than once per session.
  if (site && loadedFor !== site.id) {
    setLoadedFor(site.id);
    setName(site.name);
    setDomain(site.domain);
    // Joined with ", " and not "\n": an `<input>` is single-line and HTML's
    // value sanitization strips LF, so two rules seeded with a newline rendered
    // glued together as one — and the first keystroke wrote that back.
    setPaths(site.excludedPaths.join(", "));
    setIps(site.ignoredIps.join(", "));
  }

  const pathEntries = splitList(paths);
  const ipEntries = splitList(ips);
  const pathCount = pathEntries.length;
  const ipCount = ipEntries.length;
  const overCap = pathCount > MAX_LIST_ENTRIES || ipCount > MAX_LIST_ENTRIES;
  // Every one of these is a rule that cannot fire rather than a rule that is
  // wrong, so nothing downstream would ever complain — which is exactly why the
  // form has to.
  const badDomain = domainProblem(domain);
  const badPath = pathProblem(pathEntries);
  const badIp = ipProblem(ipEntries);
  const valid =
    name.trim().length > 0 &&
    domain.trim().length > 0 &&
    !badDomain &&
    !badPath &&
    !badIp &&
    !overCap;

  return (
    <Dialog open={!!site} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[520px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>
            <Trans>Website settings</Trans>
          </DialogTitle>
          <DialogDescription>
            {site ? `${site.name} · ${site.domain}` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex min-w-0 flex-col gap-3">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Name</Trans>
              </span>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Domain</Trans>
              </span>
              <Input
                value={domain}
                aria-invalid={badDomain ? true : undefined}
                onChange={(e) => setDomain(e.target.value)}
              />
              {badDomain ? (
                <span className="text-[11.5px] text-destructive">
                  <Trans>
                    That is not a host. Use something like example.com — a full URL
                    is fine, a space or a path is not.
                  </Trans>
                </span>
              ) : (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>
                    What the origin check matches against. Change it and the tag stops
                    accepting traffic from the old host.
                  </Trans>
                </span>
              )}
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Excluded paths</Trans>
              </span>
              <Input
                value={paths}
                placeholder="/admin/*, /health"
                aria-invalid={badPath ? true : undefined}
                onChange={(e) => setPaths(e.target.value)}
              />
              {badPath ? (
                <span className="text-[11.5px] text-destructive">
                  {badPath.reason === "everything"
                    ? t`"${badPath.entry}" would exclude every page. Name a path, or use a prefix like /admin/*.`
                    : badPath.reason === "query"
                      ? t`"${badPath.entry}" can never match: paths are compared without the query string, and cannot contain a space.`
                      : t`"${badPath.entry}" can never match: a path starts with / — try "/${badPath.entry}".`}
                </span>
              ) : (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>
                    Comma separated. A leading or trailing * is supported. Never
                    recorded, and enforced on the server.
                  </Trans>
                </span>
              )}
              {/* Only once there is something to count. On an empty field
                  "0 of 50" is a number with nothing to say. */}
              {pathCount > 0 && (
                <span
                  className={
                    pathCount > MAX_LIST_ENTRIES
                      ? "text-[11.5px] text-destructive"
                      : "text-[11.5px] text-muted-foreground"
                  }
                >
                  {t`${pathCount} of ${MAX_LIST_ENTRIES} paths`}
                </span>
              )}
            </label>
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Ignored IPs</Trans>
              </span>
              <Input
                value={ips}
                placeholder="203.0.113.4, 198.51.100.9"
                aria-invalid={badIp ? true : undefined}
                onChange={(e) => setIps(e.target.value)}
              />
              {badIp ? (
                <span className="text-[11.5px] text-destructive">
                  {badIp.reason === "range"
                    ? t`"${badIp.entry}" looks like a range. Ranges are not matched — list the addresses themselves.`
                    : t`"${badIp.entry}" is not an IP address. The request IP is compared exactly, so only a literal address can match.`}
                </span>
              ) : (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>
                    Your office, a monitoring probe. The address is compared and
                    discarded — it is never stored on an event.
                  </Trans>
                </span>
              )}
              {ipCount > 0 && (
                <span
                  className={
                    ipCount > MAX_LIST_ENTRIES
                      ? "text-[11.5px] text-destructive"
                      : "text-[11.5px] text-muted-foreground"
                  }
                >
                  {t`${ipCount} of ${MAX_LIST_ENTRIES} addresses`}
                </span>
              )}
            </label>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            // Names the reason it is disabled. "A site needs a name and a
            // domain" while the actual problem is an unmatched path is the same
            // dead end as no tooltip at all.
            title={
              overCap
                ? t`Remove a few entries — the cap is ${MAX_LIST_ENTRIES} each.`
                : badDomain
                  ? t`The domain is not a host.`
                  : badPath
                    ? t`One of the excluded paths can never match.`
                    : badIp
                      ? t`One of the ignored addresses is not an IP.`
                      : !valid
                        ? t`A site needs a name and a domain.`
                        : undefined
            }
            onClick={() => {
              // The cap used to be applied by a silent `.slice(0, 50)`, so entry
              // 51 vanished on save under a toast reading "Site settings saved."
              if (overCap) {
                pushToast(
                  t`Keep it to ${MAX_LIST_ENTRIES} entries each — remove a few and save again.`,
                  "error",
                );
                return;
              }
              onSave({
                name: name.trim(),
                domain: domain.trim(),
                excludedPaths: pathEntries,
                ignoredIps: ipEntries,
              });
            }}
          >
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
