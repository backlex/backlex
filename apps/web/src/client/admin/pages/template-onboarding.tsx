// Onboarding card — shown on the Overview page only while the workspace has no
// collections. Lets the user pick a schema template (preselected to the
// cloud-chosen SEED_TEMPLATE), browse by category, search, preview its
// collections + sample data, and apply it.
import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { I } from "../icons";
import { Badge, Button } from "../ui";
import { templatesApi, type TemplateSummary } from "../api";

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

export function TemplateOnboarding({
  pushToast,
  onApplied,
}: {
  pushToast: (msg: string, type?: "success" | "error") => void;
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  const { t } = useLingui();
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string>("blank");
  const [query, setQuery] = useState("");
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await templatesApi.list();
        if (cancelled) return;
        if (res.hasCollections) {
          setHidden(true); // workspace already has collections — nothing to do
          return;
        }
        setTemplates(res.data);
        setSelected(res.defaultTemplateId || "blank");
      } catch {
        setHidden(true); // unauthenticated / no tenant — stay out of the way
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Group the (search-filtered) templates by category, in a stable order.
  const groups = useMemo(() => {
    if (!templates) return [];
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

  if (hidden || !templates) return null;

  const current = templates.find((tpl) => tpl.id === selected);

  const apply = async () => {
    setApplying(true);
    try {
      if (selected === "blank") {
        setHidden(true);
        return;
      }
      const res = await templatesApi.apply(selected);
      // The template just bulk-created collections server-side; refresh the
      // cached list (prefix match covers active + archived entries) so the
      // Collections page renders them without a manual page reload — same as
      // the manual create flow's `invalidateCollections()`.
      void qc.invalidateQueries({ queryKey: ["collections"] });
      void qc.invalidateQueries({ queryKey: ["metrics"] });
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
              Seed a ready-made set of collections — with sample data — for your use case. You can
              edit or add more anytime.
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
        {/* template list */}
        <div className="border-r border-border max-md:border-r-0 max-md:border-b flex flex-col min-h-0">
          <div className="p-2.5 border-b border-border/60">
            <div className="relative">
              <I.Search
                size={13}
                className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t`Search templates…`}
                className="w-full rounded-md border border-border bg-background pl-7 pr-2 py-1.5 text-[12.5px] outline-none focus:border-primary"
              />
            </div>
          </div>
          <ScrollArea viewportClassName="max-h-[360px]">
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
                      onClick={() => setSelected(tpl.id)}
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

        {/* preview */}
        <div className="p-5 flex flex-col">
          {current && (
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-[14px] font-semibold">{current.label}</h4>
              {current.recommended && (
                <Badge variant="default" className="gap-1">
                  <I.Star size={10} />
                  <Trans>Recommended</Trans>
                </Badge>
              )}
            </div>
          )}
          <p className="text-[12.5px] text-muted-foreground mb-3">{current?.description}</p>
          {current && current.collections.length > 0 ? (
            <>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {current.collections.map((c) => (
                  <Badge key={c.slug} variant="default">
                    {c.label} · {c.fieldCount}
                  </Badge>
                ))}
              </div>
              {current.sampleRows > 0 && (
                <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground mb-4">
                  <I.Sparkles size={12} className="text-primary" />
                  <Trans>Includes {current.sampleRows} sample rows to explore</Trans>
                </p>
              )}
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground mb-4">
              <Trans>No collections — you'll start from scratch.</Trans>
            </p>
          )}
          <div className="mt-auto flex gap-2">
            <Button variant="primary" icon={I.Check} onClick={apply} disabled={applying}>
              {selected === "blank" ? <Trans>Start blank</Trans> : <Trans>Apply template</Trans>}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
