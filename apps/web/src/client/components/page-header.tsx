import type { ReactNode } from "react";
import { Link } from "react-router";
import { useLingui } from "@lingui/react/macro";
import { cn } from "@backlex/ui/lib/utils";
import { I } from "@/admin/icons";

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

export interface PageHeaderProps {
  title?: ReactNode;
  slug?: string;
  description?: ReactNode;
  /** Extra classes on the description wrapper — e.g. `hidden sm:block` to drop
   *  a long description on mobile where vertical space is scarce. */
  descriptionClassName?: string;
  actions?: ReactNode;
  badges?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  /** Override the title typography — e.g. `font-mono` for a slug. */
  titleClassName?: string;
}

/**
 * The one page header in the admin. `admin/ui.tsx` re-exports it.
 *
 * There used to be a second implementation whose actions were bottom-aligned
 * (`sm:items-end`), so the same button sat at a different height depending on
 * which module a page happened to import — and the drift only became visible
 * once a description wrapped to two lines. Actions are top-aligned here so the
 * primary button lines up with the title however long the description runs.
 */
export function PageHeader({
  title,
  slug,
  description,
  descriptionClassName,
  actions,
  badges,
  breadcrumbs,
  titleClassName,
}: PageHeaderProps) {
  const { t } = useLingui();
  return (
    <div className="flex flex-wrap items-start justify-between gap-[18px]">
      <div className="flex min-w-0 flex-col gap-1">
        {breadcrumbs && breadcrumbs.length > 0 && (
          <nav aria-label={t`Breadcrumb`} className="flex items-center gap-1 text-xs text-muted-foreground">
            {breadcrumbs.map((item, i) => (
              <span key={`${item.label}-${i}`} className="flex items-center gap-1">
                {i > 0 && <I.ChevronRight className="size-3" />}
                {item.to ? (
                  <Link to={item.to} className="hover:text-foreground hover:underline">
                    {item.label}
                  </Link>
                ) : (
                  <span>{item.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1
          className={cn(
            "m-0 flex flex-wrap items-center gap-2.5 text-2xl font-semibold tracking-tight",
            titleClassName,
          )}
        >
          {slug ? <span className="font-mono text-[22px] font-medium">{slug}</span> : title}
          {badges}
        </h1>
        {description && (
          <div className={cn("max-w-[720px] text-sm text-muted-foreground", descriptionClassName)}>{description}</div>
        )}
      </div>
      {actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>}
    </div>
  );
}
