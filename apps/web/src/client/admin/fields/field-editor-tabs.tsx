// Shared tab shell for the Add / Edit field dialogs. Renders an operator-style
// vertical rail on desktop (Schema · Relationship · Field · Interface ·
// Validation · Conditions) and collapses to a Select on mobile so the tab
// strip never overflows the viewport.
//
// This *is* the dialog's body — it carries `data-slot="dialog-body"` so
// DialogContent gives it the one grid row that shrinks, the same as a plain
// <DialogBody>. The scrolling pane then fills that row absolutely rather than
// with a percentage height, which is what a Radix viewport cannot resolve
// against a flex parent (it grows to content height and draws over the
// footer). Nothing here guesses at the dialog's chrome in rem.
import type { ReactNode } from "react";
import { I, type IconComponent, type IconKey } from "../icons";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Select } from "../select";

export interface FieldTabItem {
  key: string;
  label: string;
  icon: IconKey;
  /** Show a warning dot on the tab when its section has an unresolved error. */
  invalid?: boolean;
}

export interface FieldTabLayoutProps {
  tabs: FieldTabItem[];
  active: string;
  onSelect: (key: string) => void;
  children: ReactNode;
}

export function FieldTabLayout({ tabs, active, onSelect, children }: FieldTabLayoutProps) {
  return (
    // The scrolling pane fills its row absolutely, so it contributes no
    // intrinsic height and the dialog would otherwise collapse to the height
    // of the tab rail. `min-h` gives it a comfortable opening size that is the
    // same on every tab (no jump when you switch), and stays clear of the 85vh
    // cap on short screens because it is written in the same unit.
    <div data-slot="dialog-body" className="flex min-h-[min(56vh,520px)] flex-col sm:flex-row">
      {/* Desktop: vertical rail */}
      <nav className="hidden w-[170px] shrink-0 flex-col gap-0.5 border-r border-border bg-[color-mix(in_oklch,var(--muted)_30%,var(--card))] p-2 sm:flex">
        {tabs.map((t) => {
          const Ic = (I as Record<string, IconComponent>)[t.icon as IconKey] || I.Code;
          const on = active === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              className={`flex items-center gap-2 rounded-control px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors ${on ? "bg-selected-surface text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"}`}
            >
              <Ic size={14} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t.label}</span>
              {t.invalid && <span className="size-1.5 shrink-0 rounded-full bg-destructive" title="Needs attention" />}
            </button>
          );
        })}
      </nav>

      {/* Mobile: Select (avoids a raw horizontal-overflow tab strip) */}
      <div className="shrink-0 border-b border-border p-2 sm:hidden">
        <Select
          value={active}
          onChange={onSelect}
          options={tabs.map((t) => ({
            value: t.key,
            label: t.label,
            ...(t.invalid ? { hint: "!" } : {}),
          }))}
        />
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <ScrollArea className="min-h-0 flex-1" viewportClassName="absolute inset-0">
          <div className="px-5 py-[18px] max-[640px]:px-4">{children}</div>
        </ScrollArea>
      </div>
    </div>
  );
}
