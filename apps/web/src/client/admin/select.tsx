// @ts-nocheck
// Thin wrapper over @workeros/ui/components/select. Keeps the legacy
// admin-side API (value/onChange + options[]) so existing callsites don't
// need to change, but delegates rendering + keyboard nav to the shadcn
// Radix-based Select primitive.
import { createElement, type CSSProperties, type ReactNode } from "react";
import {
  Select as UiSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workeros/ui/components/select";
import { cn } from "@workeros/ui/lib/utils";
import type { IconComponent } from "./icons";
import { Badge } from "./ui";

export interface SelectOption {
  value: string;
  label: string;
  hint?: string;
  badge?: ReactNode;
  icon?: IconComponent | ReactNode;
}

export type SelectOptions = (string | SelectOption)[];

export interface SelectProps {
  value: string | undefined;
  onChange: (v: string) => void;
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
  options,
  placeholder = "Select…",
  className = "",
  style,
  size = "md",
  disabled,
  defaultValue,
}: SelectProps) {
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
      onValueChange={(v) => onChange(fromRadix(v))}
      disabled={disabled}
    >
      <SelectTrigger
        size={triggerSize}
        disabled={disabled}
        style={style}
        className={cn(
          // Match the legacy admin trigger footprint a little more closely:
          // legacy was a full-width input-ish control, not a w-fit pill.
          "w-full justify-between",
          size === "sm" && "text-xs",
          className,
        )}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {norm.map((o) => {
          const radixValue = o.value === "" ? EMPTY : o.value;
          const icon = renderIcon(o.icon);
          return (
            <SelectItem key={o.value} value={radixValue}>
              <span className="flex items-center gap-2">
                {icon && <span className="inline-flex items-center">{icon}</span>}
                <span>{o.label}</span>
                {o.hint && (
                  <span className="text-muted-foreground font-mono text-xs">{o.hint}</span>
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
