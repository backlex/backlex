// Public, unauthenticated read-only view of a single shared record.
//
// Reached via `/s/:token` — registered OUTSIDE the AuthGate so a logged-out
// visitor can open it. The only network call is the public
// `GET /api/shared/:token` endpoint; no authed endpoints are touched.
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { LinkIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@backlex/ui/components/card";
import { Badge } from "@backlex/ui/components/badge";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { sharedPublicApi } from "@/admin/api";

type Translator = (strings: TemplateStringsArray, ...values: unknown[]) => string;

/** Render a single field value readably — timestamps, booleans, JSON, null. */
function formatValue(value: unknown, t: Translator): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? t`Yes` : t`No`;
  if (typeof value === "string") {
    // ISO-8601 strings render as a localized datetime.
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d.toLocaleString();
    }
    return value;
  }
  if (typeof value === "number") {
    // Heuristic: large integers in the unix-ms range render as dates.
    if (value > 1_000_000_000_000 && value < 4_000_000_000_000) {
      return new Date(value).toLocaleString();
    }
    return String(value);
  }
  if (Array.isArray(value) || typeof value === "object") {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** Humanize a field name for the label (snake/camel → Title Case). */
function humanizeLabel(name: string): string {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

/** A label + value row inside the record card. */
function FieldRow({
  label,
  type,
  value,
}: {
  label: string;
  type: string;
  value: unknown;
}) {
  const { t } = useLingui();
  const display = formatValue(value, t);
  const multiline = display.includes("\n");
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0">
      <div className="flex items-baseline gap-2">
        <span className="text-[12.5px] font-medium text-foreground">
          {label}
        </span>
        <span className="font-mono text-[10.5px] text-muted-foreground">
          {type}
        </span>
      </div>
      {multiline ? (
        <ScrollArea className="rounded-lg">
          <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted px-2.5 py-2 font-mono text-[12px] text-foreground">
            {display}
          </pre>
        </ScrollArea>
      ) : (
        <span className="break-words text-[13.5px] text-foreground">
          {display}
        </span>
      )}
    </div>
  );
}

/** Centered shell shared by the loading / error / record states. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh w-full items-center justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-[520px]">
        <div className="mb-5 flex items-center gap-2.5 font-mono text-sm font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-primary text-xs font-bold text-primary-foreground">
            w
          </span>
          workeros
        </div>
        {children}
      </div>
    </div>
  );
}

export function SharedRecord() {
  const { token } = useParams<{ token: string }>();

  const query = useQuery({
    queryKey: ["shared-record", token],
    queryFn: () => sharedPublicApi.get(token ?? ""),
    enabled: !!token,
    retry: false,
  });

  if (query.isLoading) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-56" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if (query.isError || !query.data) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle><Trans>This link is no longer available</Trans></CardTitle>
            <CardDescription>
              <Trans>The share link may have been revoked, or the record it pointed
              to was removed.</Trans>
            </CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  const { collection, item, fields } = query.data.data;
  // Build the rendered field list: declared fields first (in schema order),
  // then any system columns the payload carries (id / createdAt / …).
  const declared = fields.map((f) => ({
    name: f.name,
    type: f.type,
    value: (item as Record<string, unknown>)[f.name],
  }));
  const declaredNames = new Set(fields.map((f) => f.name));
  const systemRows = Object.entries(item as Record<string, unknown>)
    .filter(([k]) => !declaredNames.has(k))
    .map(([name, value]) => ({ name, type: "system", value }));

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LinkIcon size={15} className="text-muted-foreground" />
            <Trans>Shared record</Trans>
          </CardTitle>
          <CardDescription>
            <Trans>A read-only view of one record from{" "}
            <span className="font-mono text-foreground">{collection}</span>.</Trans>
          </CardDescription>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge variant="secondary"><Trans>read-only</Trans></Badge>
            <Badge variant="secondary"><Trans>public link</Trans></Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col">
            {declared.map((f) => (
              <FieldRow
                key={f.name}
                label={humanizeLabel(f.name)}
                type={f.type}
                value={f.value}
              />
            ))}
            {systemRows.map((f) => (
              <FieldRow
                key={f.name}
                label={humanizeLabel(f.name)}
                type={f.type}
                value={f.value}
              />
            ))}
          </div>
        </CardContent>
      </Card>
      <p className="mt-4 text-center text-[11.5px] text-muted-foreground">
        <Trans>Shared via workeros · this link can be revoked at any time.</Trans>
      </p>
    </Shell>
  );
}
