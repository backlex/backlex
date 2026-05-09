import type { ReactNode } from "react";
import { type LucideIcon, InboxIcon } from "lucide-react";

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
}

export const EmptyState = ({
  icon: Icon = InboxIcon,
  title,
  description,
  action,
}: EmptyStateProps) => (
  <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border px-6 py-12 text-center">
    <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
      <Icon className="size-5" />
    </div>
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      {description && (
        <p className="max-w-sm text-xs text-muted-foreground">{description}</p>
      )}
    </div>
    {action && <div className="mt-1">{action}</div>}
  </div>
);
