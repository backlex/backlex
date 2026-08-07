// Thin wrapper over @backlex/ui/components/select. Keeps the legacy
// admin-side API (value/onChange + options[]) so existing callsites don't
// need to change, but delegates rendering + keyboard nav to the shadcn
// Radix-based Select primitive.
import { createElement, type CSSProperties, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import { cn } from "@backlex/ui/lib/utils";
import type { IconComponent } from "./icons";
import { Badge } from "./ui";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  /** Render the option but refuse selection — used where an option is real but
   *  not available yet (a status move whose required field is still empty).
   *  Pair it with `hint` so the row says why. */
  disabled?: boolean;
  badge?: ReactNode;
  icon?: IconComponent | ReactNode;
}

/** `readonly` on purpose: Select only ever maps over the list, and callers
 *  routinely declare their options `as const` so a value union can be derived
 *  from them. A mutable type forced every one of those to spread into a fresh
 *  array at the callsite for no benefit. */
export type SelectOptions = readonly (string | SelectOption)[];

export interface SelectProps {
  value: string | undefined;
  onChange?: (v: string) => void;
  /**
   * Alias for `onChange`. This wraps a Radix Select, whose own handler is
   * called `onValueChange`, so that is the name callers reach for — and four
   * of them did. This file used to carry `@ts-nocheck`, so the prop was accepted,
   * dropped, and the dropdown silently refused to select anything on the
   * booking page for as long as it shipped. Accepting both names is cheaper
   * than policing one.
   */
  onValueChange?: (v: string) => void;
  options: SelectOptions;
  placeholder?: string;
  className?: string;
  style?: CSSProperties;
  size?: "sm" | "md";
  disabled?: boolean;
  // Kept for API compat with the previous popover-based Select. The shadcn
  // primitive has no built-in search, so this prop is currently ignored — see
  // the note in the migration commit. Most callers pass short lists.
  searchable?: "auto" | true | false;
  searchPlaceholder?: string;
  defaultValue?: string;
}

function renderIcon(icon: SelectOption["icon"]) {
  if (!icon) return null;
  if (typeof icon === "function") {
    return createElement(icon as IconComponent, { size: 13 });
  }
  return icon;
}

export function Select({
  value,
  onChange,
  onValueChange,
  options,
  placeholder,
  className = "",
  style,
  size = "md",
  disabled,
  defaultValue,
}: SelectProps) {
  const { t } = useLingui();
  const emit = onChange ?? onValueChange;
  if (!emit && import.meta.env.DEV) {
    // Loud in dev rather than a dropdown that opens, highlights, and does
    // nothing — the failure mode that shipped.
    console.error("[admin/Select] neither onChange nor onValueChange was passed; the control is inert");
  }
  const resolvedPlaceholder = placeholder ?? t`Select…`;
  const norm: SelectOption[] = (options || []).map((o) =>
    typeof o === "object" ? (o as SelectOption) : { value: String(o), label: String(o) },
  );

  // Radix Select treats "" as "no value". Existing admin callers (e.g.
  // edit-field's "Default (auto)" entry) sometimes pass value === "" to mean
  // "this option is selected". Map "" to a sentinel on the way in and back to
  // "" on the way out so those callsites keep working.
  const EMPTY = "__empty__";
  const toRadix = (v: string | undefined) =>
    v === "" ? EMPTY : v === undefined ? undefined : v;
  const fromRadix = (v: string) => (v === EMPTY ? "" : v);

  const triggerSize = size === "sm" ? "sm" : "default";

  return (
    <UiSelect
      value={toRadix(value)}
      defaultValue={toRadix(defaultValue)}
      onValueChange={(v) => emit?.(fromRadix(v))}
      disabled={disabled}
    >
      <SelectTrigger
        size={triggerSize}
        disabled={disabled}
        style={style}
        className={cn(
          // Match the legacy admin trigger footprint a little more closely:
          // legacy was a full-width input-ish control, not a w-fit pill.
          // `min-w-0` lets the trigger shrink inside flex/grid parents (e.g. a
          // narrow dialog) instead of forcing the container wider than the
          // viewport when the selected option's label+hint is long.
          "w-full min-w-0 justify-between overflow-hidden",
          size === "sm" && "text-xs",
          className,
        )}
      >
        <SelectValue placeholder={resolvedPlaceholder} />
      </SelectTrigger>
      <SelectContent>
        {norm.map((o) => {
          const radixValue = o.value === "" ? EMPTY : o.value;
          const icon = renderIcon(o.icon);
          return (
            <SelectItem key={o.value} value={radixValue} disabled={o.disabled}>
              {/* Radix clones the selected item's children into the trigger, so
                  this row has to be able to shrink: without min-w-0 + truncate a
                  long label+hint (e.g. the agent Model picker's) pushes the
                  trigger past the viewport inside a narrow dialog. */}
              <span className="flex min-w-0 items-center gap-2">
                {icon && <span className="inline-flex items-center">{icon}</span>}
                {/* The label always reads in full; the hint is the part that
                    gives way when space runs out. */}
                <span className="shrink-0 whitespace-nowrap">{o.label}</span>
                {o.hint && (
                  <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">
                    {o.hint}
                  </span>
                )}
                {o.badge && (
                  <Badge variant="outline" mono>
                    {o.badge}
                  </Badge>
                )}
              </span>
            </SelectItem>
          );
        })}
      </SelectContent>
    </UiSelect>
  );
}
