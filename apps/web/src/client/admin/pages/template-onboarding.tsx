// Schema-template pickers. Two consumers share the browse/preview panes:
//   - TemplateOnboarding — Overview card, shown only while the workspace has
//     no collections (preselected to the cloud-chosen SEED_TEMPLATE).
//   - AddFromTemplateDialog — "From a schema template" on the Collections
//     page; apply is additive + idempotent, so it also works on a non-empty
//     workspace (existing collections are skipped).
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../icons";
import { Badge, Button } from "../ui";
import { templatesApi, type TemplateSummary } from "../api";
import { useTemplatesCatalog } from "../queries";

type IconCmp = (typeof I)["Sparkles"];

const CATEGORY_ORDER = [
  "General",
  "Content & Marketing",
  "Commerce",
  "Sales & CRM",
  "People & HR",
  "Operations",
  "Industry",
  "Other",
];

const CATEGORY_ICON: Record<string, IconCmp> = {
  General: I.Sparkles,
  "Content & Marketing": I.BookOpen,
  Commerce: I.LayoutGrid,
  "Sales & CRM": I.BarChart,
  "People & HR": I.Users,
  Operations: I.LayoutKanban,
  Industry: I.Globe,
  Other: I.Layers,
};

/** Ordered [group|null, collections] sections for a template's preview —
 *  template `groups` order first, then first-appearance, ungrouped last.
 *  Mirrors how the Collections page will render after apply. */
const groupPreview = (
  tpl: TemplateSummary,
): [string | null, TemplateSummary["collections"]][] => {
  const order: string[] = [...tpl.groups];
  for (const c of tpl.collections) {
    if (c.group && !order.includes(c.group)) order.push(c.group);
  }
  const sections: [string | null, TemplateSummary["collections"]][] = [];
  for (const g of order) {
    const cols = tpl.collections.filter((c) => c.group === g);
    if (cols.length > 0) sections.push([g, cols]);
  }
  const ungrouped = tpl.collections.filter((c) => !c.group);
  if (ungrouped.length > 0) sections.push([null, ungrouped]);
  return sections;
};

/** Search + category-grouped template list (left pane). */
function TemplateBrowser({
  templates,
  selected,
  onSelect,
  query,
  onQuery,
  viewportClassName,
}: {
  templates: TemplateSummary[];
  selected: string;
  onSelect: (id: string) => void;
  query: string;
  onQuery: (q: string) => void;
  viewportClassName: string;
}) {
  const { t } = useLingui();
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? templates.filter((tpl) =>
          [tpl.label, tpl.description, tpl.category].some((s) =>
            s.toLowerCase().includes(q),
          ),
        )
      : templates;
    const byCat = new Map<string, TemplateSummary[]>();
    for (const tpl of matched) {
      const arr = byCat.get(tpl.category) ?? [];
      arr.push(tpl);
      byCat.set(tpl.category, arr);
    }
    return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => ({
      category: c,
      icon: CATEGORY_ICON[c] ?? I.Layers,
      items: byCat.get(c) ?? [],
    }));
  }, [templates, query]);

  return (
    <div className="flex flex-col min-h-0">
      <div className="p-2.5 border-b border-border/60">
        <div className="relative">
          <I.Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={t`Search templates…`}
            className="w-full rounded-md border border-border bg-background pl-7 pr-2 py-1.5 text-[12.5px] outline-none focus:border-primary"
          />
        </div>
      </div>
      <ScrollArea viewportClassName={viewportClassName}>
        {groups.length === 0 ? (
          <p className="px-4 py-6 text-[12px] text-muted-foreground text-center">
            <Trans>No templates match your search.</Trans>
          </p>
        ) : (
          groups.map((g) => (
            <div key={g.category}>
              <div className="flex items-center gap-1.5 px-3 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                <g.icon size={11} />
                {g.category}
              </div>
              {g.items.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => onSelect(tpl.id)}
                  className={`w-full text-left px-4 py-2 border-b border-border/40 flex items-center gap-2 ${
                    selected === tpl.id ? "bg-primary/5" : "hover:bg-muted/40"
                  }`}
                >
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-[12.5px] font-medium truncate">{tpl.label}</span>
                      {tpl.recommended && (
                        <I.Star size={11} className="text-primary shrink-0" />
                      )}
                    </span>
                    <span className="block text-[11px] text-muted-foreground truncate">
                      {tpl.collections.length > 0
                        ? t`${tpl.collections.length} collections`
                        : t`Empty`}
                    </span>
                  </span>
                  {selected === tpl.id && (
                    <I.Check size={14} className="text-primary shrink-0" />
                  )}
                </button>
              ))}
            </div>
          ))
        )}
      </ScrollArea>
    </div>
  );
}

/** Template detail (right pane): description, collections grouped exactly as
 *  they'll land on the Collections page, sample + bundle notes. */
function TemplatePreview({ tpl }: { tpl: TemplateSummary }) {
  const sections = groupPreview(tpl);
  return (
    <>
      <div className="flex items-center gap-2 mb-1">
        <h4 className="text-[14px] font-semibold">{tpl.label}</h4>
        {tpl.recommended && (
          <Badge variant="default" className="gap-1">
            <I.Star size={10} />
            <Trans>Recommended</Trans>
          </Badge>
        )}
      </div>
      <p className="text-[12.5px] text-muted-foreground mb-3">{tpl.description}</p>
      {tpl.collections.length > 0 ? (
        <>
          {sections.map(([group, cols]) => (
            <div key={group ?? "∅"} className="mb-2.5">
              {group !== null && (
                <div className="flex items-center gap-1.5 mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <I.Folder size={11} />
                  {group}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {cols.map((c) => (
                  <Badge key={c.slug} variant="default">
                    {c.label} · {c.fieldCount}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
          <div className="flex flex-col gap-1 mb-4">
            {tpl.sampleRows > 0 && (
              <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <I.Sparkles size={12} className="text-primary" />
                <Trans>Includes {tpl.sampleRows} sample rows to explore — removable in one click later</Trans>
              </p>
            )}
            {(tpl.roles.length > 0 || tpl.dashboards.length > 0) && (
              <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <I.LayoutGrid size={12} className="text-primary" />
                {tpl.roles.length > 0 && tpl.dashboards.length > 0 ? (
                  <Trans>
                    Bundles the "{tpl.roles.join('", "')}" role and the "{tpl.dashboards.join('", "')}" dashboard
                  </Trans>
                ) : tpl.roles.length > 0 ? (
                  <Trans>Bundles the "{tpl.roles.join('", "')}" role</Trans>
                ) : (
                  <Trans>Bundles the "{tpl.dashboards.join('", "')}" dashboard</Trans>
                )}
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="text-[12px] text-muted-foreground mb-4">
          <Trans>No collections — you'll start from scratch.</Trans>
        </p>
      )}
    </>
  );
}

export function TemplateOnboarding({
  pushToast,
  onApplied,
}: {
  pushToast: (msg: string, type?: "success" | "error") => void;
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const { t } = useLingui();
  const catalog = useTemplatesCatalog();
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [applying, setApplying] = useState(false);

  // Hidden when dismissed, while loading, on error (unauthenticated / no
  // tenant — stay out of the way), or once the workspace has collections.
  if (hidden || catalog.isLoading || catalog.isError || !catalog.data) return null;
  if (catalog.data.hasCollections) return null;
  const templates = catalog.data.data;
  // `||`, not `??` — an empty-string SEED_TEMPLATE must still land on blank.
  const selectedId = selected ?? (catalog.data.defaultTemplateId || "blank");
  const current = templates.find((tpl) => tpl.id === selectedId);

  const apply = async () => {
    setApplying(true);
    try {
      if (selectedId === "blank") {
        setHidden(true);
        return;
      }
      const res = await templatesApi.apply(selectedId);
      // The template just bulk-created collections server-side; refresh the
      // cached list (prefix match covers active + archived entries) so the
      // Collections page renders them without a manual page reload — same as
      // the manual create flow's `invalidateCollections()`.
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: ["metrics"] });
      void qc.invalidateQueries({ queryKey: ["templates"] });
      const { created, seeded } = res.data;
      pushToast(
        seeded > 0
          ? t`Created ${created.length} collections with ${seeded} sample rows`
          : t`Created ${created.length} collections`,
        "success",
      );
      setHidden(true);
      onApplied();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : t`Could not apply template`, "error");
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden mb-5">
      <div className="px-5 py-4 border-b border-border flex items-start gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-md bg-primary/15 text-primary shrink-0">
          <I.Sparkles size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="text-[14px] font-semibold">
            <Trans>Start with a template</Trans>
          </h3>
          <p className="text-[12px] text-muted-foreground">
            <Trans>
              Seed a ready-made set of collections — grouped, with sample data — for your use
              case. You can edit or add more anytime.
            </Trans>
          </p>
        </div>
        <button
          type="button"
          className="text-[12px] text-muted-foreground hover:text-foreground"
          onClick={() => setHidden(true)}
        >
          <Trans>Dismiss</Trans>
        </button>
      </div>

      <div className="grid grid-cols-[280px_1fr] max-md:grid-cols-1">
        <div className="border-r border-border max-md:border-r-0 max-md:border-b">
          <TemplateBrowser
            templates={templates}
            selected={selectedId}
            onSelect={setSelected}
            query={query}
            onQuery={setQuery}
            viewportClassName="max-h-[360px]"
          />
        </div>
        <div className="p-5 flex flex-col">
          {current && <TemplatePreview tpl={current} />}
          <div className="mt-auto flex gap-2">
            <Button variant="primary" icon={I.Check} onClick={apply} disabled={applying}>
              {selectedId === "blank" ? <Trans>Start blank</Trans> : <Trans>Apply template</Trans>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** "From a schema template" — Collections-page dialog. Apply is additive +
 *  idempotent: existing collections are skipped, new ones land under the
 *  template's groups, so composing a second vertical into a busy workspace is
 *  safe. */
export function AddFromTemplateDialog({
  open,
  onClose,
  pushToast,
}: {
  open: boolean;
  onClose: () => void;
  pushToast: (msg: string, type?: "success" | "error") => void;
}) {
  const qc = useQueryClient();
  const { t } = useLingui();
  const catalog = useTemplatesCatalog(open);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [applying, setApplying] = useState(false);

  if (!open) return null;
  // "blank" adds nothing in additive mode — drop it from the list.
  const templates = (catalog.data?.data ?? []).filter((tpl) => tpl.id !== "blank");
  const selectedId = selected ?? templates.find((tpl) => tpl.recommended)?.id ?? templates[0]?.id ?? "";
  const current = templates.find((tpl) => tpl.id === selectedId);

  // Loading/error need their own bodies — with an empty list both panes would
  // otherwise claim "No templates match your search", which is false here.
  const dialogBody = catalog.isLoading ? (
    <div className="grid grid-cols-[280px_1fr] max-md:grid-cols-1 min-h-0">
      <div className="border-r border-border max-md:border-r-0 max-md:border-b p-3 space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
      <div className="p-5 space-y-2.5">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
        <div className="flex flex-wrap gap-1.5 pt-1">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-20" />
          ))}
        </div>
      </div>
    </div>
  ) : catalog.isError ? (
    <div className="flex flex-col items-start gap-3 p-5">
      <p className="text-[12.5px] text-muted-foreground">
        <Trans>Couldn't load the template catalog.</Trans>
      </p>
      <Button variant="outline" size="sm" onClick={() => void catalog.refetch()}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  ) : (
    <div className="grid grid-cols-[280px_1fr] max-md:grid-cols-1 min-h-0">
      <div className="border-r border-border max-md:border-r-0 max-md:border-b">
        <TemplateBrowser
          templates={templates}
          selected={selectedId}
          onSelect={setSelected}
          query={query}
          onQuery={setQuery}
          viewportClassName="max-h-[calc(88vh-16rem)] max-md:max-h-[24vh]"
        />
      </div>
      <ScrollArea viewportClassName="max-h-[calc(88vh-13rem)] max-md:max-h-[30vh]">
        <div className="p-5">
          {current ? (
            <>
              <TemplatePreview tpl={current} />
              <p className="text-[11.5px] text-muted-foreground">
                <Trans>
                  Applying is additive: collections that already exist are skipped, new ones
                  land under the template's groups.
                </Trans>
              </p>
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              <Trans>No templates available.</Trans>
            </p>
          )}
        </div>
      </ScrollArea>
    </div>
  );

  const apply = async () => {
    if (!current) return;
    setApplying(true);
    try {
      const res = await templatesApi.apply(current.id);
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: ["metrics"] });
      void qc.invalidateQueries({ queryKey: ["templates"] });
      const { created, skipped, seeded } = res.data;
      pushToast(
        created.length === 0
          ? t`Nothing new — all ${skipped.length} collections already exist`
          : seeded > 0
            ? t`Added ${created.length} collections with ${seeded} sample rows`
            : t`Added ${created.length} collections`,
        "success",
      );
      onClose();
    } catch (e) {
      pushToast(e instanceof Error ? e.message : t`Could not apply template`, "error");
    } finally {
      setApplying(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[88vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[760px]">
        <DialogHeader className="shrink-0 flex-row items-center gap-2.5 border-b border-border px-4 py-3.5 pr-12 text-left">
          <I.Sparkles size={14} />
          <DialogTitle className="text-sm font-medium"><Trans>Add from template</Trans></DialogTitle>
        </DialogHeader>
        {dialogBody}
        <div className="shrink-0 flex items-center gap-2 border-t border-border px-4 py-3.5">
          <div className="flex-1" />
          <Button variant="ghost" size="sm" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button
            variant="primary"
            size="sm"
            icon={I.Check}
            onClick={apply}
            disabled={applying || !current}
          >
            {applying ? <Trans>Applying…</Trans> : <Trans>Apply template</Trans>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
