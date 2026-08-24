// Tag manager — third-party marketing tags fired by the script the site
// already loads. Tags fire on triggers; nothing a visitor sees changes until
// the operator publishes, and rolling back moves a pointer rather than
// re-deriving anything.
//
// Its own page rather than a seventh tab on analytics.tsx: that file is already
// six tabs and two thousand lines, and this is a different product surface.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, IconButton, PageHeader, Switch } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { TagManagerSkeleton } from "../../page-skeletons";
import {
  useAnalyticsSites,
  useCreateTag,
  useCreateTrigger,
  useDeleteTag,
  useDeleteTrigger,
  usePublishTags,
  useRollbackTags,
  useTagInstall,
  useTagTriggers,
  useTagVersions,
  useTagVocabulary,
  useTags,
  useUpdateTag,
} from "../../queries";
import type { ApiTagDropped } from "../../api";

const TABS = ["tags", "triggers", "versions", "install"] as const;
type Tab = (typeof TABS)[number];

const fmtWhen = (ms: number): string =>
  new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * Every category a tag can be filed under, strictest first.
 *
 * The order is the whole point, not presentation. When a vendor declares more
 * than one — Yandex Metrica and Microsoft Clarity each declare analytics AND
 * marketing, because a Metrica goal can drive Direct retargeting — the column
 * holds exactly one value, so something has to choose. It chooses the strictest
 * one the vendor declared: under-declaring a tag to a consent tool that is
 * behaving correctly is the failure that matters, and it is the one a visitor
 * cannot see.
 */
const CONSENT_CATEGORIES = ["marketing", "analytics", "functional", "none"] as const;

const strictestCategory = (declared: readonly string[] | undefined): string =>
  CONSENT_CATEGORIES.find((c) => declared?.includes(c)) ?? "marketing";

export function TagManagerPage({
  pushToast,
  setActiveNav,
}: {
  pushToast: PushToast;
  /** Prop-drilled, not `useNavigate`: `app.tsx`'s `vNav` saves pane scroll,
   *  warms the target chunk and commits inside a view transition. */
  setActiveNav?: (id: string) => void;
}) {
  const { t } = useLingui();
  const [tab, setTab] = useState<Tab>("tags");
  const [siteId, setSiteId] = useState<string | null>(null);

  const sites = useAnalyticsSites();
  const vocabulary = useTagVocabulary();

  // The first site is selected automatically. A container without a site is a
  // page with nothing to configure, and making the operator pick when there is
  // only one is a click that teaches nothing.
  const siteList = sites.data?.data ?? [];
  const active = siteId ?? siteList[0]?.id ?? null;

  const tags = useTags(active);
  const triggers = useTagTriggers(active);
  const versions = useTagVersions(active);
  const install = useTagInstall(active);

  const createTag = useCreateTag(active ?? "");
  const updateTag = useUpdateTag(active ?? "");
  const removeTag = useDeleteTag(active ?? "");
  const createTrigger = useCreateTrigger(active ?? "");
  const removeTrigger = useDeleteTrigger(active ?? "");
  const publish = usePublishTags(active ?? "");
  const rollback = useRollbackTags(active ?? "");

  const [tagOpen, setTagOpen] = useState(false);
  const [triggerOpen, setTriggerOpen] = useState(false);
  const [dropped, setDropped] = useState<ApiTagDropped[]>([]);

  const templates = vocabulary.data?.data.templates ?? [];
  const triggerTypes = vocabulary.data?.data.triggerTypes ?? [];

  // Each option carries what a refusal actually switches off. "Functional"
  // versus "analytics" is not self-evident, and this is the field that decides
  // whether a visitor saying no reaches this tag at all.
  const consentOptions = [
    {
      value: "marketing",
      label: t`Marketing`,
      hint: t`Advertising and retargeting. Does not fire unless the visitor agrees.`,
    },
    {
      value: "analytics",
      label: t`Analytics`,
      hint: t`Measurement. Does not fire unless the visitor agrees.`,
    },
    {
      value: "functional",
      label: t`Functional`,
      hint: t`Preferences and convenience. Does not fire unless the visitor agrees.`,
    },
    {
      value: "none",
      label: t`Strictly necessary`,
      hint: t`Always fires. The site cannot run without it, so nothing is asked.`,
    },
  ];

  // The row is a list to scan, not a decision being made: the label alone, so
  // four rows do not repeat the same sentence four times. The dialog keeps the
  // hints, which is where an operator is actually choosing.
  const rowConsentOptions = consentOptions.map(({ value, label }) => ({ value, label }));

  /** What the vendor itself says this tag is for, when it says anything. */
  const declaredFor = (templateId: string | null | undefined): string[] =>
    (templateId && templates.find((x) => x.id === templateId)?.consentCategories) || [];

  if (sites.isLoading || vocabulary.isLoading) return <TagManagerSkeleton />;

  if (siteList.length === 0) {
    return (
      <div className="space-y-6">
        <PageHeader title={t`Tag manager`} />
        <EmptyState
          icon={I.Tag}
          title={t`Register a website first`}
          description={t`Tags are configured per website. Register one on the Websites page, then come back.`}
          action={
            setActiveNav && (
              <Button onClick={() => setActiveNav("websites")}>
                <Trans>Go to Websites</Trans>
              </Button>
            )
          }
        />
      </div>
    );
  }

  const onPublish = async () => {
    try {
      const res = await publish.mutateAsync(undefined);
      setDropped(res.data.dropped);
      if (res.data.dropped.length > 0) {
        // Deliberately not an error: the publish succeeded. The card below
        // is what names which tags did not make it and why.
        pushToast(
          t`Published version ${res.data.version.version}, leaving out ${res.data.dropped.length}.`,
          "success",
        );
      } else {
        pushToast(t`Published version ${res.data.version.version}.`, "success");
      }
    } catch {
      pushToast(t`Could not publish.`, "error");
    }
  };

  /** The directives this container's published tags actually need. Empty until
   *  something third-party is published — see the Install tab. */
  const cspLines = (["script", "img", "connect", "frame"] as const)
    .map((k) => {
      const list = install.data?.data.csp[k] ?? [];
      return list.length ? `${k}-src ${list.join(" ")};` : "";
    })
    .filter(Boolean)
    .join("\n");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t`Tag manager`}
        actions={
          <div className="flex items-center gap-2">
            {siteList.length > 1 && (
              <Select
                value={active ?? ""}
                onValueChange={setSiteId}
                size="sm"
                className="min-w-0"
                options={siteList.map((s) => ({ value: s.id, label: s.domain }))}
              />
            )}
            <Button onClick={onPublish} disabled={publish.isPending}>
              {publish.isPending ? <Trans>Publishing…</Trans> : <Trans>Publish</Trans>}
            </Button>
          </div>
        }
      />

      <div className="flex gap-1 overflow-x-auto">
        {TABS.map((id) => (
          <Button
            key={id}
            variant={tab === id ? "primary" : "ghost"}
            size="sm"
            onClick={() => setTab(id)}
          >
            {id === "tags" ? (
              <Trans>Tags</Trans>
            ) : id === "triggers" ? (
              <Trans>Triggers</Trans>
            ) : id === "versions" ? (
              <Trans>Versions</Trans>
            ) : (
              <Trans>Install</Trans>
            )}
          </Button>
        ))}
      </div>

      {dropped.length > 0 && (
        <Card className="border-amber-500/40 p-4">
          <div className="mb-2 text-sm font-medium">
            <Trans>Left out of the last publish</Trans>
          </div>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {dropped.map((d) => (
              <li key={`${d.kind}-${d.id}`}>
                <span className="font-medium">{d.name}</span> — {d.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === "tags" && (
        <Card className="w-full">
          {/* The header row only exists when there is a list under it. On an
              empty tab it was a floating sentence and an outline button above
              an empty state that says the same thing again — two invitations to
              the same act, neither of them the filled one. */}
          {(tags.data?.data.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-4">
              <div className="text-sm text-muted-foreground">
                <Trans>Tags fire on the triggers you attach to them.</Trans>
              </div>
              <Button variant="primary" size="sm" icon={I.Plus} onClick={() => setTagOpen(true)}>
                <Trans>New tag</Trans>
              </Button>
            </div>
          )}
          {tags.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (tags.data?.data.length ?? 0) === 0 ? (
            <EmptyState
              size="sm"
              icon={I.Tag}
              title={t`No tags yet`}
              description={t`A tag is a vendor pixel, an image pixel, or your own code. It fires on the triggers you attach to it.`}
              action={
                <Button variant="primary" size="sm" icon={I.Plus} onClick={() => setTagOpen(true)}>
                  <Trans>New tag</Trans>
                </Button>
              }
            />
          ) : (
            <ScrollArea className="w-full border-t" viewportClassName="max-h-[60vh]">
              <div className="divide-y">
                {(tags.data?.data ?? []).map((tag) => (
                  <div key={tag.id} className="flex flex-wrap items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{tag.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {tag.templateId ?? tag.kind}
                      </div>
                      {/* Only when the operator's filing is LAXER than what the
                          vendor declares. Said rather than corrected: moving a
                          tag between categories changes who it fires for, and
                          that is a compliance call to make deliberately. */}
                      {declaredFor(tag.templateId).length > 0 &&
                        !declaredFor(tag.templateId).includes(tag.consentCategory) && (
                          <div className="truncate text-xs text-amber-600 dark:text-amber-500">
                            {t`This vendor declares itself ${declaredFor(tag.templateId)
                              .map((c) => consentOptions.find((o) => o.value === c)?.label ?? c)
                              .join(" + ")}.`}
                          </div>
                        )}
                    </div>
                    {/* Full width on its own line on a phone, inline from sm:
                        up — the row already carries a name, a switch and a
                        delete, and a fourth control inline overflows 390px. */}
                    <Select
                      value={tag.consentCategory}
                      onValueChange={(consentCategory) =>
                        updateTag.mutate({ id: tag.id, patch: { consentCategory } })
                      }
                      className="order-last w-full min-w-0 sm:order-none sm:w-44"
                      options={rowConsentOptions}
                    />
                    <Switch
                      checked={tag.enabled}
                      onChange={(enabled) =>
                        updateTag.mutate({ id: tag.id, patch: { enabled } })
                      }
                    />
                    <IconButton
                      icon={I.Trash}
                      title={t`Delete tag`}
                      aria-label={t`Delete tag`}
                      onClick={() => removeTag.mutate(tag.id)}
                    />
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </Card>
      )}

      {tab === "triggers" && (
        <Card className="w-full">
          {(triggers.data?.data.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-4">
              <div className="text-sm text-muted-foreground">
                <Trans>A trigger decides when a tag fires.</Trans>
              </div>
              <Button
                variant="primary"
                size="sm"
                icon={I.Plus}
                onClick={() => setTriggerOpen(true)}
              >
                <Trans>New trigger</Trans>
              </Button>
            </div>
          )}
          {triggers.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (triggers.data?.data.length ?? 0) === 0 ? (
            <EmptyState
              size="sm"
              icon={I.Bolt}
              title={t`No triggers yet`}
              description={t`A trigger decides when a tag fires. Start with a page view — a tag needs at least one to run at all.`}
              action={
                <Button
                  variant="primary"
                  size="sm"
                  icon={I.Plus}
                  onClick={() => setTriggerOpen(true)}
                >
                  <Trans>New trigger</Trans>
                </Button>
              }
            />
          ) : (
            <ScrollArea className="w-full border-t" viewportClassName="max-h-[60vh]">
              <div className="divide-y">
                {(triggers.data?.data ?? []).map((tr) => (
                  <div key={tr.id} className="flex items-center gap-3 p-4">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{tr.name}</div>
                      <div className="truncate text-xs text-muted-foreground">{tr.type}</div>
                    </div>
                    <IconButton
                      icon={I.Trash}
                      title={t`Delete trigger`}
                      aria-label={t`Delete trigger`}
                      onClick={() => removeTrigger.mutate(tr.id)}
                    />
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </Card>
      )}

      {tab === "versions" && (
        <Card className="w-full">
          {versions.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-10 w-full" />
            </div>
          ) : (versions.data?.data.length ?? 0) === 0 ? (
            <EmptyState
              size="sm"
              icon={I.History}
              title={t`Nothing published yet`}
              description={t`Until you publish, visitors get the tracker alone.`}
            />
          ) : (
            <ScrollArea className="w-full" viewportClassName="max-h-[60vh]">
              <div className="divide-y">
                {(versions.data?.data ?? []).map((v) => (
                  <div key={v.id} className="flex items-center gap-3 p-4">
                    <Badge>v{v.version}</Badge>
                    {/* A version usually has no note, and `?? "—"` rendered a
                        lone dash where a title should be — a row that reads as
                        broken rather than as "untitled". With nothing to say,
                        the timestamp IS the row. */}
                    <div className="min-w-0 flex-1">
                      {v.note ? (
                        <>
                          <div className="truncate text-sm">{v.note}</div>
                          <div className="text-xs text-muted-foreground">
                            {fmtWhen(v.createdAt)}
                          </div>
                        </>
                      ) : (
                        <div className="truncate text-sm">{fmtWhen(v.createdAt)}</div>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={rollback.isPending}
                      onClick={() => rollback.mutate(v.version)}
                    >
                      <Trans>Serve this again</Trans>
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </Card>
      )}

      {tab === "install" && (
        <Card className="w-full space-y-4 p-4">
          <div>
            <div className="mb-1 text-sm font-medium">
              <Trans>Paste this once, as the first script in your head tag</Trans>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              <Trans>
                Keep defer, and do not change it to async. Deferred scripts run in document
                order, so being first is what puts the consent decision ahead of every other
                deferred tag on the page. It carries the analytics tag as well, so it replaces
                the analytics snippet rather than joining it.
              </Trans>
            </p>
            <ScrollArea className="w-full rounded border" viewportClassName="max-h-32">
              <pre className="p-3 text-xs">{install.data?.data.snippet ?? ""}</pre>
            </ScrollArea>
          </div>

          <div>
            <div className="mb-1 text-sm font-medium">
              <Trans>Your Content-Security-Policy needs these</Trans>
            </div>
            <p className="mb-2 text-xs text-muted-foreground">
              <Trans>
                Generated from the tags this container actually holds. Your page, your policy —
                we cannot relax it for you.
              </Trans>
            </p>
            {install.data?.data.csp.hasInferred && (
              <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                <Trans>
                  Some of these origins are our reading of a vendor's snippet, not guidance the
                  vendor publishes.
                </Trans>
              </p>
            )}
            {install.data?.data.scriptSrcElemCaveat && (
              <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
                <Trans>
                  Google documents its origins against script-src-elem. If your site sets that
                  directive explicitly, add them there too.
                </Trans>
              </p>
            )}
            {/* With no published tags there are no origins to add, and the
                block rendered as an empty bordered box — a control that looks
                like it failed to load. Say the true thing instead. */}
            {cspLines ? (
              <ScrollArea className="w-full rounded border" viewportClassName="max-h-48">
                <pre className="p-3 text-xs">{cspLines}</pre>
              </ScrollArea>
            ) : (
              <p className="m-0 text-xs text-muted-foreground">
                <Trans>
                  Nothing to add yet — the tracker and the consent banner are served
                  from this origin. Publish a tag that loads a third party and the
                  directives appear here.
                </Trans>
              </p>
            )}
          </div>
        </Card>
      )}

      <NewTagDialog
        open={tagOpen}
        onOpenChange={setTagOpen}
        templates={templates}
        consentOptions={consentOptions}
        triggers={(triggers.data?.data ?? []).map((tr) => ({ id: tr.id, name: tr.name }))}
        onCreate={(input) => {
          // Optimistic: the dialog closes and the row appears before the
          // round-trip finishes; a failure rolls the row back and toasts.
          setTagOpen(false);
          createTag.mutate(input, {
            onError: () => pushToast(t`Could not create that tag.`, "error"),
          });
        }}
      />

      <NewTriggerDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        types={triggerTypes}
        onCreate={(input) => {
          setTriggerOpen(false);
          createTrigger.mutate(input, {
            onError: () => pushToast(t`Could not create that trigger.`, "error"),
          });
        }}
      />
    </div>
  );
}

function NewTagDialog({
  open,
  onOpenChange,
  templates,
  consentOptions,
  triggers,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  consentOptions: { value: string; label: string; hint: string }[];
  templates: { id: string; label: string; consentCategories?: string[]; params: { key: string; label: string; required: boolean; kind: string; options?: { value: string; label: string }[]; placeholder?: string; help?: string; formatDocumented: boolean }[] }[];
  triggers: { id: string; name: string }[];
  onCreate: (input: Record<string, unknown>) => void;
}) {
  const [templateId, setTemplateId] = useState("");
  const [name, setName] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const { t } = useLingui();
  const [triggerId, setTriggerId] = useState("");
  const [consentCategory, setConsentCategory] = useState("marketing");
  const [categoryTouched, setCategoryTouched] = useState(false);

  const template = templates.find((x) => x.id === templateId);

  // Follow the vendor until the operator says otherwise. Every tag ever created
  // here was filed `marketing` because that was the column default, which is
  // wrong for the analytics-only vendors and is the reason this field is on the
  // dialog at all. `categoryTouched` is what keeps a deliberate choice from
  // being overwritten by the next vendor change.
  useEffect(() => {
    if (!template || categoryTouched) return;
    setConsentCategory(strictestCategory(template.consentCategories));
  }, [template, categoryTouched]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* min-w-0 on the grid children: one long select label is enough to drag
          a dialog past a 390px viewport, which has happened here before. */}
      <DialogContent className="max-h-[85vh] overflow-hidden [&>*]:min-w-0">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>New tag</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Pick a vendor, fill in what it needs, and choose when it fires.</Trans>
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium">
                <Trans>Vendor</Trans>
              </span>
              <Select
                value={templateId}
                onValueChange={(v) => {
                  setTemplateId(v);
                  setParams({});
                  if (!name) setName(templates.find((x) => x.id === v)?.label ?? "");
                }}
                className="w-full min-w-0"
                options={templates.map((x) => ({ value: x.id, label: x.label }))}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">
                <Trans>Name</Trans>
              </span>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
            </label>

            {(template?.params ?? []).map((p) => (
              <label key={p.key} className="block space-y-1">
                <span className="text-sm font-medium">{p.label}</span>
                {p.kind === "select" ? (
                  <Select
                    value={params[p.key] ?? ""}
                    onValueChange={(v) => setParams((s) => ({ ...s, [p.key]: v }))}
                    className="w-full min-w-0"
                    options={p.options ?? []}
                  />
                ) : (
                  <Input
                    value={params[p.key] ?? ""}
                    placeholder={p.placeholder}
                    onChange={(e) => setParams((s) => ({ ...s, [p.key]: e.target.value }))}
                    className="w-full"
                  />
                )}
                {/* Says plainly when the vendor publishes no format, rather
                    than implying a rule that does not exist. */}
                {p.help && <span className="block text-xs text-muted-foreground">{p.help}</span>}
              </label>
            ))}

            <label className="block space-y-1">
              <span className="text-sm font-medium">
                <Trans>Consent category</Trans>
              </span>
              <Select
                value={consentCategory}
                onValueChange={(v) => {
                  setCategoryTouched(true);
                  setConsentCategory(v);
                }}
                className="w-full min-w-0"
                options={consentOptions}
              />
              <span className="block text-xs text-muted-foreground">
                {template?.consentCategories?.length
                  ? t`This vendor declares itself ${template.consentCategories
                      .map((c) => consentOptions.find((o) => o.value === c)?.label ?? c)
                      .join(" + ")}.`
                  : t`What a visitor's refusal switches off.`}
              </span>
            </label>

            <label className="block space-y-1">
              <span className="text-sm font-medium">
                <Trans>Fires on</Trans>
              </span>
              <Select
                value={triggerId}
                onValueChange={setTriggerId}
                className="w-full min-w-0"
                options={triggers.map((tr) => ({ value: tr.id, label: tr.name }))}
              />
            </label>
          </div>
        </DialogBody>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!templateId || !triggerId}
            onClick={() =>
              onCreate({
                name: name || template?.label,
                kind: "template",
                templateId,
                consentCategory,
                params,
                triggerIds: [triggerId],
              })
            }
          >
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewTriggerDialog({
  open,
  onOpenChange,
  types,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  types: string[];
  onCreate: (input: Record<string, unknown>) => void;
}) {
  const [type, setType] = useState("pageview");
  const [name, setName] = useState("");
  const [selector, setSelector] = useState("");
  const [eventName, setEventName] = useState("");

  const needsSelector = type === "click" || type === "link_click" || type === "form_submit";
  const needsEvent = type === "custom_event";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden [&>*]:min-w-0">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>New trigger</Trans>
          </DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium">
                <Trans>When</Trans>
              </span>
              <Select
                value={type}
                onValueChange={setType}
                className="w-full min-w-0"
                options={types.map((x) => ({ value: x, label: x }))}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium">
                <Trans>Name</Trans>
              </span>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
            </label>
            {needsSelector && (
              <label className="block space-y-1">
                <span className="text-sm font-medium">
                  <Trans>CSS selector</Trans>
                </span>
                <Input
                  value={selector}
                  onChange={(e) => setSelector(e.target.value)}
                  className="w-full"
                />
                <span className="block text-xs text-muted-foreground">
                  <Trans>Leave empty to match every element.</Trans>
                </span>
              </label>
            )}
            {needsEvent && (
              <label className="block space-y-1">
                <span className="text-sm font-medium">
                  <Trans>Event name</Trans>
                </span>
                <Input
                  value={eventName}
                  onChange={(e) => setEventName(e.target.value)}
                  className="w-full"
                />
                <span className="block text-xs text-muted-foreground">
                  <Trans>The name your site already passes to backlex().</Trans>
                </span>
              </label>
            )}
          </div>
        </DialogBody>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={needsEvent && !eventName}
            onClick={() =>
              onCreate({
                name: name || type,
                type,
                config: needsSelector
                  ? { selector: selector || null }
                  : needsEvent
                    ? { eventName }
                    : type === "scroll"
                      ? { thresholds: [50] }
                      : {},
              })
            }
          >
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
