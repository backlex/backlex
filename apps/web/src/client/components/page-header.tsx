import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "@workeros/ui/lib/utils";
import { useLingui } from "@lingui/react/macro";

export interface BreadcrumbItem {
  label: string;
  to?: string;
}

interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  actions?: ReactNode;
  /** Override default tag/styling for the title (e.g. font-mono for slugs). */
  titleClassName?: string;
}

/**
 * Consistent page header — every primary admin page should render this at
 * the top. Standardizes title typography, breadcrumb pattern, and the
 * top-right actions area.
 */
export const PageHeader = ({
  title,
  description,
  breadcrumbs,
  actions,
  titleClassName,
}: PageHeaderProps) => {
  const { t } = useLingui();
  return (
  <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
    <div className="min-w-0 space-y-1">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav
          aria-label={t`Breadcrumb`}
          className="flex items-center gap-1 text-xs text-muted-foreground"
        >
          {breadcrumbs.map((item, i) => (
            <span key={i} className="flex items-center gap-1">
              {i > 0 && <ChevronRightIcon className="size-3" />}
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
      <h1 className={cn("text-2xl font-semibold leading-tight", titleClassName)}>
        {title}
      </h1>
      {description && (
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      )}
    </div>
    {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
  </div>
  );
};
