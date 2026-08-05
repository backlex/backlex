import type { ComponentType, ReactNode } from "react";
import { Card } from "@backlex/ui/components/card";
import { cn } from "@backlex/ui/lib/utils";

/** The two glyph families in this app — `admin/icons`' `I.*` and lucide's —
 *  agree on exactly the props this component sets. */
type GlyphComponent = ComponentType<{ size?: number; className?: string }>;

export interface EmptyStateProps {
  /** Leading glyph, e.g. `I.Puzzle`. Every page/section-level empty state has
   *  one — a bare paragraph in a card reads as a bug, not as "nothing yet". */
  icon?: GlyphComponent;
  title: ReactNode;
  description?: ReactNode;
  /** Optional CTA rendered under the copy, e.g. a `<Button>`. */
  action?: ReactNode;
  /**
   * `lg` — full page area (the Extensions look). `md` — side panels.
   * `sm` — compact inline placeholders inside an already-bordered parent
   * (a sidebar list, a table cell). `sm` draws no card of its own, so a
   * page-level empty state must never use it: it ends up as floating text
   * with no background.
   */
  size?: "lg" | "md" | "sm";
  /** Drop the card border/bg — for use inside a parent that already has one. */
  bare?: boolean;
  className?: string;
}

/**
 * Canonical empty / no-data state for the admin. Standardizes the icon size,
 * heading weight, description size, and card chrome so every "nothing here yet"
 * surface reads the same.
 *
 * This is the ONLY implementation — `admin/ui.tsx` re-exports it. A second copy
 * used to live here with its own `py-12` (which doubled up on the parent
 * CardContent's padding) and its own filled icon chip, so the same state looked
 * different page to page.
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
      // px matters: `bare` has no card chrome of its own, so without it the copy
      // runs edge-to-edge against the parent card's border on narrow screens.
      <div className={cn("flex flex-col items-center gap-3 px-6 py-8 text-center text-muted-foreground", className)}>
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
