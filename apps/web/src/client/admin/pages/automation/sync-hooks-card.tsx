// Sync hooks — the blocking counterpart to outbound webhooks, shown on the same
// page so the contrast is visible: a webhook is told what happened, a sync hook
// decides whether it happens.
//
// Two things drive the whole editor. `onError` has no safe default, so the form
// refuses to submit until it is chosen rather than pre-selecting one for the
// operator. And the signing secret is write-only, so edit mode offers "leave
// blank to keep" instead of an empty required field.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, Switch, relativeTime } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { syncHooksApi, type ApiSyncHook, type SyncHookTestResult } from "../../api";
import { fetchSafely } from "../_shared";

const PHASES = ["beforeCreate", "beforeUpdate", "beforeDelete"] as const;

export function SyncHooksCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [hooks, setHooks] = useState<ApiSyncHook[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<{ row: ApiSyncHook | null } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; res: SyncHookTestResult } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // The table may predate the migration on an older instance — an empty
      // list is the right rendering, not an error.
      const res = await fetchSafely<{ data: ApiSyncHook[] }>("/api/admin/sync-hooks");
      if (!live) return;
      setHooks(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Optimistic: snapshot → apply → reconcile → roll back on error.
  const toggle = async (row: ApiSyncHook, enabled: boolean) => {
    const snapshot = hooks;
    setHooks(hooks.map((h) => (h.id === row.id ? { ...h, enabled, disabledReason: null } : h)));
    try {
      const res = await syncHooksApi.update(row.id, { enabled });
      setHooks((prev) => prev.map((h) => (h.id === row.id ? res.data : h)));
    } catch (e) {
      setHooks(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (row: ApiSyncHook) => {
    const snapshot = hooks;
    setHooks(hooks.filter((h) => h.id !== row.id));
    try {
      await syncHooksApi.remove(row.id);
      pushToast(t`Hook removed.`);
    } catch (e) {
      setHooks(snapshot);
      pushToast((e as Error).message);
    }
  };

  const save = async (input: any, existing: ApiSyncHook | null) => {
    const snapshot = hooks;
    setEditing(null);
    try {
      if (existing) {
        const res = await syncHooksApi.update(existing.id, input);
        setHooks((prev) => prev.map((h) => (h.id === existing.id ? res.data : h)));
        pushToast(t`Hook updated.`);
      } else {
        const res = await syncHooksApi.create(input);
        setHooks((prev) => [...prev, res.data]);
        pushToast(t`Hook created.`);
      }
    } catch (e) {
      setHooks(snapshot);
      pushToast((e as Error).message);
    }
  };

  const runTest = async (row: ApiSyncHook) => {
    setTesting(row.id);
    setResult(null);
    try {
      setResult({ id: row.id, res: await syncHooksApi.test(row.id) });
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setTesting(null);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Shield size={13} />
        <span className="text-[13px] font-medium">
          <Trans>Sync hooks</Trans>
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {hooks.length} {hooks.length === 1 ? t`hook` : t`hooks`}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setEditing({ row: null })}>
          <Trans>Add hook</Trans>
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          A webhook is told what happened. A sync hook runs before the write and decides whether it
          happens — it can reject the write or, when allowed to, patch the payload.
        </Trans>
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : hooks.length === 0 ? (
        <div className="px-4 py-6">
          <EmptyState
            bare
            size="sm"
            icon={I.Shield}
            title={<Trans>No sync hooks</Trans>}
            description={
              <Trans>Add one to let your own service validate, enrich or reject writes.</Trans>
            }
          />
        </div>
      ) : (
        hooks.map((row) => (
          <div key={row.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            {/* Stacks on a phone. Side-by-side, the action group is ~250px of
                the 390px viewport, which squeezed the name into a wrap and put
                the badges under the buttons. Below `sm` the info takes the full
                width and the actions get their own right-hugging row. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
              <div className="min-w-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{row.name}</span>
                  {/* `deny` is the consequential setting — surface it, do not
                      make the operator open the editor to find out. */}
                  <Badge variant={row.onError === "deny" ? "destructive" : "default"}>
                    {row.onError === "deny" ? t`blocks on failure` : t`allows on failure`}
                  </Badge>
                  {row.canMutate && (
                    <Badge variant="default">
                      <Trans>can patch</Trans>
                    </Badge>
                  )}
                  {!row.enabled && row.disabledReason && (
                    <Badge variant="destructive">
                      <Trans>Paused</Trans>
                    </Badge>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.url}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.events.join(", ")} · {row.timeoutMs}ms
                </div>
                {row.disabledReason && (
                  <div className="text-[11px] text-destructive">{row.disabledReason}</div>
                )}
                {row.enabled && row.consecutiveFailures > 0 && (
                  <div className="text-[11px] text-destructive">
                    <Trans>{row.consecutiveFailures} consecutive failures</Trans>
                    {row.lastFailureAt ? ` · ${relativeTime(row.lastFailureAt)}` : ""}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={testing === row.id}
                  onClick={() => void runTest(row)}
                >
                  {testing === row.id ? <Trans>Testing…</Trans> : <Trans>Test</Trans>}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing({ row })}>
                  <Trans>Edit</Trans>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(row)}>
                  <Trans>Delete</Trans>
                </Button>
                <Switch checked={row.enabled} onChange={(v) => void toggle(row, v)} />
              </div>
            </div>

            {result?.id === row.id && (
              <div className="mt-2 rounded-control border border-border px-3 py-2 text-[11.5px]">
                {result.res.ok ? (
                  <span className={result.res.verdict?.allow ? "" : "text-destructive"}>
                    {result.res.verdict?.allow ? (
                      <Trans>Allowed in {result.res.ms}ms</Trans>
                    ) : (
                      <Trans>
                        Rejected in {result.res.ms}ms: {result.res.verdict?.reason ?? "—"}
                      </Trans>
                    )}
                  </span>
                ) : (
                  <span className="text-destructive">
                    <Trans>Unreachable: {result.res.error ?? "—"}</Trans>
                    {row.onError === "deny" ? (
                      <>
                        {" "}
                        <Trans>— writes to matching collections are being blocked.</Trans>
                      </>
                    ) : null}
                  </span>
                )}
              </div>
            )}
          </div>
        ))
      )}

      {editing && (
        <SyncHookDialog
          existing={editing.row}
          onClose={() => setEditing(null)}
          onSave={(input) => void save(input, editing.row)}
        />
      )}
    </Card>
  );
}

/* ── editor ── */
function SyncHookDialog({
  existing,
  onClose,
  onSave,
}: {
  existing: ApiSyncHook | null;
  onClose: () => void;
  onSave: (input: any) => void;
}) {
  const { t } = useLingui();
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [events, setEvents] = useState((existing?.events ?? []).join("\n"));
  // No pre-selected value: the API refuses a missing `onError` precisely
  // because neither answer is safe to assume, and the form must not paper over
  // that by choosing for the operator.
  const [onError, setOnError] = useState<string>(existing?.onError ?? "");
  const [canMutate, setCanMutate] = useState(existing?.canMutate ?? false);
  const [timeoutMs, setTimeoutMs] = useState(String(existing?.timeoutMs ?? 2000));
  const [secret, setSecret] = useState("");

  const eventList = events
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const ready = name.trim() && url.trim() && eventList.length > 0 && onError;

  const submit = () => {
    const body: Record<string, unknown> = {
      name: name.trim(),
      url: url.trim(),
      events: eventList,
      onError,
      canMutate,
      timeoutMs: Number(timeoutMs) || 2000,
    };
    // Omit rather than send an empty string: a blank field must not blank the
    // stored credential, and the API reads "absent" as "keep".
    if (secret.trim()) body.secret = secret.trim();
    onSave(body);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            {isEdit ? t`Edit sync hook` : t`New sync hook`}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>This runs on the write path — a slow or failing hook affects live writes.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <Field label={t`Name`}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="tax-calculator" />
            </Field>
            <Field label={t`URL`}>
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.example/hook" />
            </Field>
            <Field
              label={t`Events`}
              hint={t`One per line. \`orders.beforeCreate\`, \`orders.*\`, \`*.beforeDelete\`, or \`*\`.`}
            >
              <Textarea
                className="font-mono"
                rows={3}
                value={events}
                onChange={(e) => setEvents(e.target.value)}
                placeholder={PHASES.map((p) => `orders.${p}`).join("\n")}
              />
            </Field>

            <Field
              label={t`When the hook cannot answer`}
              hint={t`No default on purpose: "allow" drops the guarantee this hook provides, "deny" turns your app's outage into your customers'.`}
            >
              <Select
                className="min-w-0"
                value={onError}
                onChange={setOnError}
                options={[
                  { value: "", label: t`Choose…` },
                  { value: "deny", label: t`Block the write (deny)` },
                  { value: "allow", label: t`Let it through (allow)` },
                ]}
              />
            </Field>

            <Field
              label={t`Timeout (ms)`}
              hint={t`How long a write may block on this hook. Max 10000.`}
            >
              <Input
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                min={50}
                max={10000}
              />
            </Field>

            <label className="flex items-start gap-2.5">
              <Switch checked={canMutate} onChange={setCanMutate} />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">
                  <Trans>Allow this hook to patch the payload</Trans>
                </span>
                <span className="block text-[11.5px] text-muted-foreground">
                  <Trans>
                    Off for a hook that only validates — otherwise returning `data` would let it
                    rewrite rows. A patch is re-validated against the schema.
                  </Trans>
                </span>
              </span>
            </label>

            <Field
              label={t`Signing secret`}
              hint={
                isEdit && existing?.hasSecret
                  ? t`Leave blank to keep the current secret.`
                  : t`Optional. Signs each call so your service can verify it came from backlex.`
              }
            >
              <Input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder={isEdit && existing?.hasSecret ? "••••••••" : ""}
              />
            </Field>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button onClick={submit} disabled={!ready}>
            {isEdit ? <Trans>Save</Trans> : <Trans>Create</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}
