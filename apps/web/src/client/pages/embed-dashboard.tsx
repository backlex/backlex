// Public, unauthenticated embed view of a BI dashboard.
//
// Reached via `/embed/d/:token` — registered OUTSIDE the AuthGate so a
// logged-out visitor (or an iframe on a third-party site) can open it. The
// only network call is the public `GET /api/public/dashboards/:token`; no
// authed endpoints are touched. Panels render via the same `PanelBody` the
// admin Insights grid uses, so both surfaces agree on how each viz maps rows.
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Trans } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { dashboardsPublicApi } from "@/admin/api";
import { PanelBody, panelSubtitle } from "@/admin/pages/observability/panel-render";
import { useDocumentTitle } from "./use-document-title";

export function EmbedDashboard() {
  const { token } = useParams<{ token: string }>();

  const query = useQuery({
    queryKey: ["embed-dashboard", token],
    queryFn: () => dashboardsPublicApi.get(token ?? ""),
    enabled: !!token,
    retry: false,
  });

  useDocumentTitle(query.data?.data?.name);

  if (query.isLoading) {
    return (
      <div className="min-h-svh w-full bg-background p-5 text-foreground">
        <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
          <Skeleton className="h-7 w-48" />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (query.isError || !query.data) {
    return (
      <div className="flex min-h-svh w-full items-center justify-center bg-background px-4 text-foreground">
        <Card className="max-w-[420px] p-6 text-center">
          <div className="text-base font-semibold"><Trans>This dashboard is no longer available</Trans></div>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            <Trans>The embed link may have been revoked, or the dashboard was removed.</Trans>
          </p>
        </Card>
      </div>
    );
  }

  const { name, description, panels } = query.data.data;

  return (
    <div className="min-h-svh w-full bg-background p-5 text-foreground">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4">
        <header className="flex flex-col gap-0.5">
          <h1 className="text-lg font-semibold tracking-[-0.01em]">{name}</h1>
          {description && <p className="text-[13px] text-muted-foreground">{description}</p>}
        </header>

        {panels.length === 0 ? (
          <Card className="p-6 text-center text-[13px] text-muted-foreground">
            <Trans>This dashboard has no panels yet.</Trans>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {panels.map((p) => (
              <Card key={p.panelId} className="gap-2 p-4">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] font-medium">{p.name}</span>
                  <span className="flex-1 text-[11.5px] text-muted-foreground">
                    {panelSubtitle(
                      { description: null, kind: p.kind, config: p.config },
                      p.data.length,
                    )}
                  </span>
                </div>
                <PanelBody
                  viz={p.viz}
                  rows={p.data}
                  error={p.error ?? null}
                  emptyLabel={<Trans>No data.</Trans>}
                />
              </Card>
            ))}
          </div>
        )}

        <footer className="pt-1 text-center text-[11px] text-muted-foreground">
          <Trans>Powered by backlex · this embed can be revoked at any time.</Trans>
        </footer>
      </div>
    </div>
  );
}
