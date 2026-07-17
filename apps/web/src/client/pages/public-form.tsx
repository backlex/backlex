// Public, unauthenticated form page — renders a form definition resolved from
// `GET /api/public/forms/:token` and submits to `POST .../submit`.
//
// Two routes share this component: `/f/:token` (standalone) and
// `/embed/f/:token` (iframe embed — compact chrome, framable CSP). Neither
// touches an authed endpoint.
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@backlex/ui/components/card";
import { Button } from "@backlex/ui/components/button";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Checkbox } from "@backlex/ui/components/checkbox";
import { Label } from "@backlex/ui/components/label";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import { formsPublicApi, type ApiPublicForm, type ApiPublicFormField } from "@/admin/api";

declare global {
  interface Window {
    turnstile?: {
      render: (
        el: HTMLElement,
        opts: { sitekey: string; callback: (token: string) => void; "expired-callback"?: () => void },
      ) => string;
    };
  }
}

const TURNSTILE_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** Humanize a raw field name (snake/camel → Title Case) — used when neither
 *  the form config nor the collection field defines a display label. */
const humanizeLabel = (name: string): string =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^\w/, (ch) => ch.toUpperCase());

/** Load the Turnstile script once and render the widget into a div. */
function TurnstileWidget({ siteKey, onToken }: { siteKey: string; onToken: (t: string | null) => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const rendered = useRef(false);

  useEffect(() => {
    const render = () => {
      if (rendered.current || !ref.current || !window.turnstile) return;
      rendered.current = true;
      window.turnstile.render(ref.current, {
        sitekey: siteKey,
        callback: (t) => onToken(t),
        "expired-callback": () => onToken(null),
      });
    };
    if (window.turnstile) {
      render();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SRC}"]`);
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = TURNSTILE_SRC;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", render);
    return () => script.removeEventListener("load", render);
  }, [siteKey, onToken]);

  return <div ref={ref} />;
}

/** One field input, dispatched on type/choices. Values live in `values` keyed
 *  by field name; empty string means "not provided". */
function FieldInput({
  field,
  value,
  onChange,
}: {
  field: ApiPublicFormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const { t } = useLingui();
  if (field.choices && field.choices.length > 0) {
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        onValueChange={(v) => onChange(v)}
      >
        <SelectTrigger className="w-full min-w-0">
          <SelectValue placeholder={t`Select…`} />
        </SelectTrigger>
        <SelectContent>
          {field.choices.map((ch) => (
            <SelectItem key={ch.value} value={ch.value}>
              {ch.label ?? ch.value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  switch (field.type) {
    case "longtext":
      return (
        <Textarea
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
          required={field.required}
        />
      );
    case "integer":
    case "number":
      return (
        <Input
          type="number"
          step={field.type === "integer" ? 1 : "any"}
          value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      );
    case "boolean":
      return (
        <div className="flex items-center gap-2 py-1">
          <Checkbox
            checked={value === true}
            onCheckedChange={(v) => onChange(v === true)}
            id={`pf-${field.name}`}
          />
          <Label htmlFor={`pf-${field.name}`} className="text-[13px] font-normal text-muted-foreground">
            <Trans>Yes</Trans>
          </Label>
        </div>
      );
    case "timestamp":
      return (
        <Input
          type="datetime-local"
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      );
    default: {
      const format = (field.validation?.format as string | undefined) ?? undefined;
      return (
        <Input
          type={format === "email" ? "email" : format === "url" ? "url" : "text"}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value)}
          required={field.required}
        />
      );
    }
  }
}

/** Coerce raw input state into the submit payload the API expects. */
function buildPayload(
  fields: ApiPublicFormField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = values[f.name];
    if (raw === undefined || raw === "" || raw === null) continue;
    if (f.type === "integer" || f.type === "number") {
      const n = Number(raw);
      if (!Number.isNaN(n)) data[f.name] = n;
    } else if (f.type === "boolean") {
      data[f.name] = raw === true;
    } else if (f.type === "timestamp" && typeof raw === "string") {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) data[f.name] = d.toISOString();
    } else {
      data[f.name] = raw;
    }
  }
  return data;
}

function Shell({ embed, children }: { embed: boolean; children: React.ReactNode }) {
  if (embed) {
    return (
      <div className="min-h-svh w-full bg-background p-3 text-foreground sm:p-4">
        <div className="mx-auto w-full max-w-[560px]">{children}</div>
      </div>
    );
  }
  return (
    <div className="flex min-h-svh w-full items-start justify-center bg-background px-4 py-10 text-foreground">
      <div className="w-full max-w-[560px]">{children}</div>
    </div>
  );
}

function FormSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-4 w-64" />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-9 w-28" />
      </CardContent>
    </Card>
  );
}

export function PublicForm({ embed = false }: { embed?: boolean }) {
  const { token } = useParams<{ token: string }>();
  const { t } = useLingui();

  const query = useQuery({
    queryKey: ["public-form", token],
    queryFn: () => formsPublicApi.get(token ?? ""),
    enabled: !!token,
    retry: false,
  });

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [honeypot, setHoneypot] = useState("");
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const def: ApiPublicForm | null = query.data?.data ?? null;
  const needsTurnstile = Boolean(def?.turnstileSiteKey);
  const canSubmit = !submitting && (!needsTurnstile || turnstileToken !== null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!def || !token || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await formsPublicApi.submit(token, {
        data: buildPayload(def.fields, values),
        ...(turnstileToken ? { turnstileToken } : {}),
        ...(honeypot ? { website: honeypot } : {}),
      });
      if (res.data.redirectUrl) {
        window.location.assign(res.data.redirectUrl);
        return;
      }
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Submission failed — please try again`);
    } finally {
      setSubmitting(false);
    }
  };

  const footer = useMemo(
    () =>
      embed ? null : (
        <p className="mt-4 text-center text-[11.5px] text-muted-foreground">
          <Trans>Powered by backlex</Trans>
        </p>
      ),
    [embed],
  );

  if (query.isLoading) {
    return (
      <Shell embed={embed}>
        <FormSkeleton />
      </Shell>
    );
  }

  if (query.isError || !def) {
    return (
      <Shell embed={embed}>
        <Card>
          <CardHeader>
            <CardTitle><Trans>This form is no longer available</Trans></CardTitle>
            <CardDescription>
              <Trans>The form may have been deactivated, or its link replaced.</Trans>
            </CardDescription>
          </CardHeader>
        </Card>
        {footer}
      </Shell>
    );
  }

  if (submitted) {
    return (
      <Shell embed={embed}>
        <Card>
          <CardHeader>
            <CardTitle><Trans>Thank you</Trans></CardTitle>
            <CardDescription>
              {def.successMessage ?? t`Your submission has been received.`}
            </CardDescription>
          </CardHeader>
        </Card>
        {footer}
      </Shell>
    );
  }

  return (
    <Shell embed={embed}>
      <Card>
        <CardHeader>
          <CardTitle>{def.name}</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            {def.fields.map((f) => (
              <div key={f.name} className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`pf-${f.name}`} className="text-[13px]">
                  {f.label === f.name ? humanizeLabel(f.name) : f.label}
                  {f.required && <span className="text-destructive"> *</span>}
                </Label>
                <FieldInput
                  field={f}
                  value={values[f.name]}
                  onChange={(v) => setValues((prev) => ({ ...prev, [f.name]: v }))}
                />
                {f.help && (
                  <p className="text-[11.5px] text-muted-foreground">{f.help}</p>
                )}
              </div>
            ))}

            {/* Honeypot — humans never see it; bots fill it. */}
            <input
              type="text"
              name="website"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              tabIndex={-1}
              autoComplete="off"
              aria-hidden="true"
              className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden"
            />

            {def.turnstileSiteKey && (
              <TurnstileWidget siteKey={def.turnstileSiteKey} onToken={setTurnstileToken} />
            )}

            {error && (
              <p className="text-[12.5px] text-destructive" role="alert">
                {error}
              </p>
            )}

            <div>
              <Button type="submit" disabled={!canSubmit}>
                {submitting ? (
                  <Trans>Submitting…</Trans>
                ) : (
                  (def.submitLabel ?? t`Submit`)
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      {footer}
    </Shell>
  );
}
