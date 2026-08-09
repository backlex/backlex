// Auth hooks — the workspace's own code running at four moments in its
// END-USER authentication. Sits on the auth settings page beside the identity
// providers, because that is what it extends: the providers decide who can sign
// in, these decide what happens when they do.
//
// Three things drive the editor. The event is a fixed set, so it is a dropdown
// rather than free text — and once a hook exists for an event, that event is no
// longer offered (the API refuses a second one, and a form that let you try
// would be a form that 409s). `onError` has no safe default, so the form
// refuses to submit until it is chosen. And the signing secret is write-only,
// so edit mode offers "leave blank to keep" instead of an empty required field.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, Switch, relativeTime } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
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
import {
  authHooksApi,
  type ApiAuthHook,
  type ApiAuthHookEvent,
  type AuthHookTestResult,
} from "../../api";
import { fetchSafely } from "../_shared";

/** Order matters: this is the sequence the events occur in for a person signing
 *  up, so the list reads top-to-bottom like the flow it hooks. */
const EVENTS: ApiAuthHookEvent[] = [
  "before-user-created",
  "custom-access-token",
  "password-verification",
  "send-email",
];

/**
 * Per-event copy, built inside a hook so the `t` the Lingui macro rewrites is
 * the one `useLingui()` returned in this scope. A helper taking `t` as an
 * ARGUMENT compiles to a call the macro cannot see, so the strings never reach
 * the catalog and render untranslated in every locale — the same class as
 * [[lingui-compiler-stripped-in-prod]], and invisible until someone switches
 * language.
 */
function useEventCopy(): {
  label: Record<ApiAuthHookEvent, string>;
  hint: Record<ApiAuthHookEvent, string>;
} {
  const { t } = useLingui();
  return {
    label: {
      "before-user-created": t`Before a user is created`,
      "custom-access-token": t`Access token claims`,
      "password-verification": t`Password verification`,
      "send-email": t`Send auth email`,
    },
    hint: {
      "before-user-created": t`Approve or reject a new end-user, whatever they signed up with — password, social, SAML, LDAP or a trusted third-party token.`,
      "custom-access-token": t`Add your own claims (plan, org, entitlements) to the access token. Reserved claims are always dropped.`,
      "password-verification": t`Called after every password sign-in with the result — including failures. Return allow: false to refuse one.`,
      "send-email": t`Deliver magic-link and one-time-code mail through your own transport and templates.`,
    },
  };
}

export function AuthHooksCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const copy = useEventCopy();
  const [hooks, setHooks] = useState<ApiAuthHook[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<{ row: ApiAuthHook | null } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; res: AuthHookTestResult } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // The table may predate the migration on an older instance — an empty
      // list is the right rendering, not an error.
      const res = await fetchSafely<{ data: ApiAuthHook[] }>("/api/admin/auth-hooks");
      if (!live) return;
      setHooks(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const taken = new Set(hooks.map((h) => h.event));

  // Optimistic: snapshot → apply → reconcile → roll back on error.
  const toggle = async (row: ApiAuthHook, enabled: boolean) => {
    const snapshot = hooks;
    setHooks(hooks.map((h) => (h.id === row.id ? { ...h, enabled, disabledReason: null } : h)));
    try {
      const res = await authHooksApi.update(row.id, { enabled });
      setHooks((prev) => prev.map((h) => (h.id === row.id ? res.data : h)));
    } catch (e) {
      setHooks(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (row: ApiAuthHook) => {
    const snapshot = hooks;
    setHooks(hooks.filter((h) => h.id !== row.id));
    try {
      await authHooksApi.remove(row.id);
      pushToast(t`Hook removed.`);
    } catch (e) {
      setHooks(snapshot);
      pushToast((e as Error).message);
    }
  };

  const save = async (input: any, existing: ApiAuthHook | null) => {
    const snapshot = hooks;
    setEditing(null);
    try {
      if (existing) {
        const res = await authHooksApi.update(existing.id, input);
        setHooks((prev) => prev.map((h) => (h.id === existing.id ? res.data : h)));
        pushToast(t`Hook updated.`);
      } else {
        const res = await authHooksApi.create(input);
        setHooks((prev) =>
          [...prev, res.data].sort((a, b) => EVENTS.indexOf(a.event) - EVENTS.indexOf(b.event)),
        );
        pushToast(t`Hook created.`);
      }
    } catch (e) {
      setHooks(snapshot);
      pushToast((e as Error).message);
    }
  };

  const runTest = async (row: ApiAuthHook) => {
    setTesting(row.id);
    setResult(null);
    try {
      setResult({ id: row.id, res: await authHooksApi.test(row.id) });
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setTesting(null);
    }
  };

  const allTaken = EVENTS.every((e) => taken.has(e));

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Shield size={13} />
        <span className="text-[13px] font-medium">
          <Trans>Auth hooks</Trans>
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {hooks.length} {hooks.length === 1 ? t`hook` : t`hooks`}
        </span>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          icon={I.Plus}
          disabled={allTaken}
          onClick={() => setEditing({ row: null })}
        >
          <Trans>Add hook</Trans>
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          Your own code at four moments in your end-users' sign-in: admit a new user, put your
          claims in their access token, judge a password attempt, or send the mail yourself. One
          hook per moment. These never apply to the people who administer this workspace.
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
            title={<Trans>No auth hooks</Trans>}
            description={
              <Trans>
                Add one to gate sign-ups on your own rules or put your plan and role claims into the
                access token.
              </Trans>
            }
          />
        </div>
      ) : (
        hooks.map((row) => (
          <div key={row.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            {/* Stacks on a phone: side-by-side, the action group takes most of
                a 390px viewport and squeezes the identity block to a few
                characters per line. `flex-1` distributes leftovers, it does not
                claim a line — hence `w-full` below `sm`. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
              <div className="w-full min-w-0 sm:w-auto sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{copy.label[row.event]}</span>
                  {/* `deny` is the consequential setting — surface it, do not
                      make the operator open the editor to find out. */}
                  <Badge variant={row.onError === "deny" ? "destructive" : "default"}>
                    {row.onError === "deny" ? t`fails auth on error` : t`proceeds on error`}
                  </Badge>
                  {row.targetType === "function" && (
                    <Badge variant="default">
                      <Trans>function</Trans>
                    </Badge>
                  )}
                  {!row.enabled && row.disabledReason && (
                    <Badge variant="destructive">
                      <Trans>Paused</Trans>
                    </Badge>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.targetType === "function" ? `fn:${row.functionName ?? ""}` : row.url}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.event} · {row.timeoutMs}ms
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
                  <>
                    <span className={result.res.verdict?.allow === false ? "text-destructive" : ""}>
                      {result.res.verdict?.allow === false ? (
                        <Trans>
                          Refused in {result.res.ms}ms: {result.res.verdict?.reason ?? "—"}
                        </Trans>
                      ) : (
                        <Trans>Answered in {result.res.ms}ms</Trans>
                      )}
                    </span>
                    {/* The only place a dropped claim is ever reported: at
                        sign-in time it simply is not in the token. */}
                    {result.res.droppedClaims && result.res.droppedClaims.length > 0 && (
                      <div className="mt-1 text-destructive">
                        <Trans>
                          Dropped as reserved, never reaches the token:{" "}
                          {result.res.droppedClaims.join(", ")}
                        </Trans>
                      </div>
                    )}
                  </>
                ) : (
                  <span className="text-destructive">
                    <Trans>Unreachable: {result.res.error ?? "—"}</Trans>
                    {row.onError === "deny" ? (
                      <>
                        {" "}
                        <Trans>— this auth step is failing for your end-users.</Trans>
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
        <AuthHookDialog
          existing={editing.row}
          taken={taken}
          onClose={() => setEditing(null)}
          onSave={(input) => void save(input, editing.row)}
        />
      )}
    </Card>
  );
}

/* ── editor ── */
function AuthHookDialog({
  existing,
  taken,
  onClose,
  onSave,
}: {
  existing: ApiAuthHook | null;
  taken: Set<ApiAuthHookEvent>;
  onClose: () => void;
  onSave: (input: any) => void;
}) {
  const { t } = useLingui();
  const copy = useEventCopy();
  const isEdit = !!existing;
  // Only events that are still free are offered — the API refuses a second
  // hook for one event, and a form that let you pick a taken one would be a
  // form whose only outcome is a 409.
  const available = EVENTS.filter((e) => !taken.has(e) || e === existing?.event);
  const [event, setEvent] = useState<string>(existing?.event ?? available[0] ?? "");
  const [targetType, setTargetType] = useState<string>(existing?.targetType ?? "url");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [functionName, setFunctionName] = useState(existing?.functionName ?? "");
  // No pre-selected value: the API refuses a missing `onError` precisely
  // because neither answer is safe to assume, and the form must not paper over
  // that by choosing for the operator.
  const [onError, setOnError] = useState<string>(existing?.onError ?? "");
  const [timeoutMs, setTimeoutMs] = useState(String(existing?.timeoutMs ?? 2000));
  const [secret, setSecret] = useState("");

  const target = targetType === "function" ? functionName.trim() : url.trim();
  const ready = !!event && !!target && !!onError;

  const submit = () => {
    const body: Record<string, unknown> = {
      event,
      targetType,
      onError,
      timeoutMs: Number(timeoutMs) || 2000,
      ...(targetType === "function"
        ? { functionName: functionName.trim() }
        : { url: url.trim() }),
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
            {isEdit ? t`Edit auth hook` : t`New auth hook`}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              This runs while someone is waiting to sign in — a slow or failing hook is felt live.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <Field label={t`Moment`} hint={event ? copy.hint[event as ApiAuthHookEvent] : undefined}>
              <Select
                className="min-w-0"
                value={event}
                onChange={setEvent}
                disabled={isEdit}
                options={available.map((e) => ({ value: e, label: copy.label[e] }))}
              />
            </Field>

            <Field
              label={t`Target`}
              hint={t`A URL is called over HTTPS with Standard Webhooks headers. A function runs in the sandbox with no network hop — the cheaper choice for token claims.`}
            >
              <Select
                className="min-w-0"
                value={targetType}
                onChange={setTargetType}
                options={[
                  { value: "url", label: t`HTTPS endpoint` },
                  { value: "function", label: t`backlex function` },
                ]}
              />
            </Field>

            {targetType === "function" ? (
              <Field label={t`Function name`} hint={t`Must already exist in this workspace.`}>
                <Input
                  value={functionName}
                  onChange={(e) => setFunctionName(e.target.value)}
                  placeholder="admission-gate"
                />
              </Field>
            ) : (
              <Field label={t`URL`}>
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://app.example/auth-hook"
                />
              </Field>
            )}

            <Field
              label={t`When the hook cannot answer`}
              hint={t`No default on purpose: "proceed" can mint a token missing the claim your authorizer reads, and "fail" turns your outage into a sign-in outage.`}
            >
              <Select
                className="min-w-0"
                value={onError}
                onChange={setOnError}
                options={[
                  { value: "", label: t`Choose…` },
                  { value: "deny", label: t`Fail the auth action (deny)` },
                  { value: "allow", label: t`Proceed without it (allow)` },
                ]}
              />
            </Field>

            <Field
              label={t`Timeout (ms)`}
              hint={t`How long the sign-in may block on this hook. Max 5000.`}
            >
              <Input
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
                min={50}
                max={5000}
              />
            </Field>

            {targetType === "url" && (
              <Field
                label={t`Signing secret`}
                hint={
                  isEdit && existing?.hasSecret
                    ? t`Leave blank to keep the current secret.`
                    : t`Optional. Signs each call with Standard Webhooks headers, so any off-the-shelf verifier can confirm it came from backlex.`
                }
              >
                <Input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={isEdit && existing?.hasSecret ? "••••••••" : "whsec_…"}
                />
              </Field>
            )}
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
