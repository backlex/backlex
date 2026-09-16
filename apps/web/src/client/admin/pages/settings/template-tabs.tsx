import type { ReactNode } from "react";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { useLingui } from "@lingui/react/macro";

/**
 * The panels a template is edited through — the strip under the editor's
 * toolbar on both template pages.
 *
 * The editor used to be one long column: the fields, the body, the appearance,
 * the variables and their warnings, all stacked, so choosing a theme meant
 * scrolling past a page of HTML and the preview beside it had scrolled away.
 * Tabs cut that to one job at a time, in the same shape a collection's
 * Items / Schema / Settings strip already has, so the two read alike.
 *
 * `warn` is what stops a tab from hiding something: a variable the sample data
 * leaves empty raises a dot on the Variables tab, because the warning it used
 * to sit next to is now behind a click.
 */
export interface TemplateTab<T extends string> {
  value: T;
  label: ReactNode;
  /** Shown only where the strip has room — four labelled tabs already fill an
   *  editor column at 1440, and a clipped "Variables" is worse than no icon. */
  icon: ReactNode;
  /** Shown as a count badge; omitted when there is nothing to count. */
  count?: number;
  /** Raises the attention dot — something in that tab needs looking at. */
  warn?: boolean;
}

export function TemplateEditorTabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (next: T) => void;
  tabs: TemplateTab<T>[];
}) {
  const { t } = useLingui();
  return (
    <Tabs value={value} onValueChange={(v) => onChange(v as T)} className="w-full">
      <TabsList className="w-full">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value} data-testid={`template-tab-${tab.value}`}>
            <span className="max-[1600px]:hidden">{tab.icon}</span>
            {tab.label}
            {tab.count !== undefined && (
              <span className="rounded-sm border border-border bg-muted px-[5px] py-px font-mono text-[11px] text-muted-foreground">
                {tab.count}
              </span>
            )}
            {tab.warn && (
              <span
                className="size-1.5 shrink-0 rounded-full bg-amber-500"
                title={t`Needs attention`}
                data-testid={`template-tab-warn-${tab.value}`}
              />
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
