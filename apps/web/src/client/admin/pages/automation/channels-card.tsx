// Broadcast channel rules — who may subscribe to, and who may publish on, the
// realtime channels this workspace's own application invents.
//
// Two things drive the editor. A channel with NO matching rule is refused in
// both directions, so the card leads with that rather than presenting an empty
// list as "nothing configured yet". And `subscribe` / `publish` are separate
// answers with four values each, so they are two identical controls side by
// side instead of one "visibility" dropdown that would have to invent a
// meaning for every combination.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, Switch } from "../../ui";
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
import {
  channelsApi,
  type ApiChannelRule,
  type ChannelAccess,
  type ChannelExplainResult,
} from "../../api";
import { fetchSafely } from "../_shared";

const ACCESS_VALUES = ["none", "public", "authenticated", "roles"] as const;

/** Grammar examples live OUTSIDE the translated strings. A literal `{` inside
 *  a lingui message is an ICU placeholder, and an unmatched one is a parse
 *  error that blank-screens the admin — so anything with braces is rendered as
 *  plain JSX next to the sentence rather than inside it. */
const PATTERN_EXAMPLE = "org:{org}:feed";
const CONDITION_EXAMPLE = '{"org":{"_eq":"$org.id"}}';

export function ChannelsCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rules, setRules] = useState<ApiChannelRule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<{ row: ApiChannelRule | null } | null>(null);
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<ChannelExplainResult | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      // The table may predate the migration on an older instance — an empty
      // list is the right rendering, not an error.
      const res = await fetchSafely<{ data: ApiChannelRule[] }>("/api/admin/realtime-channels");
      if (!live) return;
      setRules(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Optimistic: snapshot → apply → reconcile → roll back on error.
  const toggle = async (row: ApiChannelRule, enabled: boolean) => {
    const snapshot = rules;
    setRules(rules.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      const res = await channelsApi.update(row.id, { enabled });
      setRules((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
    } catch (e) {
      setRules(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (row: ApiChannelRule) => {
    const snapshot = rules;
    setRules(rules.filter((r) => r.id !== row.id));
    try {
      await channelsApi.remove(row.id);
      pushToast(t`Rule removed — channels it matched are no longer reachable.`);
    } catch (e) {
      setRules(snapshot);
      pushToast((e as Error).message);
    }
  };

  const save = async (input: any, existing: ApiChannelRule | null) => {
    const snapshot = rules;
    setEditing(null);
    try {
      if (existing) {
        const res = await channelsApi.update(existing.id, input);
        setRules((prev) => prev.map((r) => (r.id === existing.id ? res.data : r)));
        pushToast(t`Rule updated.`);
      } else {
        const res = await channelsApi.create(input);
        setRules((prev) => [...prev, res.data]);
        pushToast(t`Rule created.`);
      }
    } catch (e) {
      setRules(snapshot);
      pushToast((e as Error).message);
    }
  };

  const runProbe = async () => {
    const channel = probe.trim();
    if (!channel) return;
    try {
      setProbeResult(await channelsApi.explain(channel));
    } catch (e) {
      setProbeResult(null);
      pushToast((e as Error).message);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Zap size={13} />
        <span className="text-[13px] font-medium">
          <Trans>Broadcast channels</Trans>
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {rules.length} {rules.length === 1 ? t`rule` : t`rules`}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setEditing({ row: null })}>
          <Trans>Add rule</Trans>
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          Channels your own application invents — a chat room, a cursor feed, a notification bus.
          A channel with no matching rule is refused in both directions.
        </Trans>
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : rules.length === 0 ? (
        <div className="px-4 py-6">
          <EmptyState
            bare
            size="sm"
            icon={I.Zap}
            title={<Trans>No channel rules</Trans>}
            description={
              <Trans>
                Until one exists, every application-owned channel is refused. Add a rule to open
                one.
              </Trans>
            }
          />
        </div>
      ) : (
        rules.map((row) => (
          <div key={row.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            {/* Stacks on a phone: side by side, the action group takes most of
                a 390px viewport and wraps the pattern mid-token. */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
              <div className="min-w-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{row.name}</span>
                  {row.presence && (
                    <Badge variant="default">
                      <Trans>presence</Trans>
                    </Badge>
                  )}
                  {row.replay && <Badge variant="default">{t`replay ${row.retentionHours}h`}</Badge>}
                  {/* A public publish is the consequential setting — surface it
                      rather than making the operator open the editor. */}
                  {row.publish.access === "public" && (
                    <Badge variant="destructive">
                      <Trans>anyone can publish</Trans>
                    </Badge>
                  )}
                </div>
                <div className="truncate font-mono text-[11.5px]">{row.pattern}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {t`subscribe`}: {describeAccess(row.subscribe)} · {t`publish`}:{" "}
                  {describeAccess(row.publish)}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setEditing({ row })}>
                  <Trans>Edit</Trans>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => void remove(row)}>
                  <Trans>Delete</Trans>
                </Button>
                <Switch checked={row.enabled} onChange={(v) => void toggle(row, v)} />
              </div>
            </div>
          </div>
        ))
      )}

      {/* The pattern is the part that goes wrong — `chat:*` does not match
          `chat:room:1`, and finding that out from a failing subscribe is
          expensive. This asks the server the same question the gate does. */}
      <div className="border-t border-border px-3.5 py-3">
        <span className="mb-1.5 block text-[11.5px] font-medium">
          <Trans>Test a channel name</Trans>
        </span>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            className="font-mono sm:flex-1"
            value={probe}
            onChange={(e) => setProbe(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runProbe();
            }}
            placeholder="chat:room:1"
          />
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            disabled={!probe.trim()}
            onClick={() => void runProbe()}
          >
            <Trans>Explain</Trans>
          </Button>
        </div>
        {probeResult && (
          <div className="mt-2 rounded-control border border-border px-3 py-2 text-[11.5px]">
            <div className="font-mono">{probeResult.reason}</div>
            {Object.keys(probeResult.params).length > 0 && (
              <div className="font-mono text-muted-foreground">
                {Object.entries(probeResult.params)
                  .map(([k, v]) => `${k}=${v}`)
                  .join(" ")}
              </div>
            )}
            {!probeResult.managed && (
              <div className="mt-1 flex gap-3">
                <span className={probeResult.canSubscribe ? "" : "text-destructive"}>
                  {probeResult.canSubscribe ? (
                    <Trans>subscribe: allowed</Trans>
                  ) : (
                    <Trans>subscribe: refused</Trans>
                  )}
                </span>
                <span className={probeResult.canPublish ? "" : "text-destructive"}>
                  {probeResult.canPublish ? (
                    <Trans>publish: allowed</Trans>
                  ) : (
                    <Trans>publish: refused</Trans>
                  )}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {editing && (
        <ChannelDialog
          existing={editing.row}
          onClose={() => setEditing(null)}
          onSave={(input) => void save(input, editing.row)}
        />
      )}
    </Card>
  );
}

const describeAccess = (a: ChannelAccess): string => {
  const base = a.access === "roles" ? `roles:${(a.roles ?? []).join(",")}` : a.access;
  return a.condition ? `${base} +condition` : base;
};

/* ── editor ── */
function ChannelDialog({
  existing,
  onClose,
  onSave,
}: {
  existing: ApiChannelRule | null;
  onClose: () => void;
  onSave: (input: any) => void;
}) {
  const { t } = useLingui();
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? "");
  const [pattern, setPattern] = useState(existing?.pattern ?? "");
  const [subscribe, setSubscribe] = useState<ChannelAccess>(
    existing?.subscribe ?? { access: "authenticated" },
  );
  const [publish, setPublish] = useState<ChannelAccess>(existing?.publish ?? { access: "none" });
  const [presence, setPresence] = useState(existing?.presence ?? false);
  const [replay, setReplay] = useState(existing?.replay ?? false);
  const [retentionHours, setRetentionHours] = useState(String(existing?.retentionHours ?? 24));

  const ready = name.trim() && pattern.trim();

  const submit = () => {
    onSave({
      name: name.trim(),
      pattern: pattern.trim(),
      subscribe,
      publish,
      presence,
      replay,
      retentionHours: Number(retentionHours) || 24,
    });
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            {isEdit ? t`Edit channel rule` : t`New channel rule`}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              One rule authorizes every channel its pattern matches — you never enumerate rooms.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <Field label={t`Name`}>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Org feeds"
              />
            </Field>
            {/* The hint is split in two on purpose. A literal `{` inside a
                translated string is an ICU placeholder, and an unmatched one
                is a parse error that blank-screens the whole SPA — so the
                grammar examples live in untranslated JSX beside the sentence,
                never inside it. */}
            <Field
              label={t`Pattern`}
              hint={t`Colon-separated segments: a literal, a single-segment wildcard, a rest wildcard, or a named capture the condition can read.`}
            >
              <Input
                className="font-mono"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                placeholder={PATTERN_EXAMPLE}
              />
              <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
                {"chat:*"} · {"logs:**"} · {PATTERN_EXAMPLE}
              </span>
            </Field>

            <AccessField
              label={t`Who may subscribe`}
              value={subscribe}
              onChange={setSubscribe}
              conditionHint={t`Runs against the pattern's captures, not against a row — so a capture is readable as a plain field name.`}
            />
            <AccessField
              label={t`Who may publish`}
              value={publish}
              onChange={setPublish}
              conditionHint={t`Same DSL. Leave this at "nobody" for a feed only your own server writes to.`}
            />

            <label className="flex items-start gap-2.5">
              <Switch checked={presence} onChange={setPresence} />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">
                  <Trans>Members may announce themselves</Trans>
                </span>
                <span className="block text-[11.5px] text-muted-foreground">
                  <Trans>
                    hello / ping / bye frames with a small state object. The roster is derived by
                    each client, so it works on every transport. Never retained.
                  </Trans>
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5">
              <Switch checked={replay} onChange={setReplay} />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">
                  <Trans>Keep recent messages for replay</Trans>
                </span>
                <span className="block text-[11.5px] text-muted-foreground">
                  <Trans>
                    A reconnect aid, not an event store — 25 per page, 72 hours at most. Write rows
                    to a collection for real history.
                  </Trans>
                </span>
              </span>
            </label>

            {replay && (
              <Field label={t`Retention (hours)`} hint={t`Capped at 72.`}>
                <Input
                  type="number"
                  min={1}
                  max={72}
                  value={retentionHours}
                  onChange={(e) => setRetentionHours(e.target.value)}
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

/** One half of a rule. `roles` and `condition` only appear when they can
 *  matter, so the form never shows a control whose value would be ignored. */
function AccessField({
  label,
  value,
  onChange,
  conditionHint,
}: {
  label: string;
  value: ChannelAccess;
  onChange: (v: ChannelAccess) => void;
  conditionHint: string;
}) {
  const { t } = useLingui();
  const [conditionText, setConditionText] = useState(
    value.condition ? JSON.stringify(value.condition, null, 0) : "",
  );
  const [conditionError, setConditionError] = useState<string | null>(null);

  const labels: Record<(typeof ACCESS_VALUES)[number], string> = {
    none: t`Nobody`,
    public: t`Anyone, even signed out`,
    authenticated: t`Any signed-in user`,
    roles: t`Only these roles`,
  };

  return (
    <div className="flex flex-col gap-2 rounded-control border border-border px-3 py-2.5">
      <span className="text-[11.5px] font-medium">{label}</span>
      <Select
        className="min-w-0"
        value={value.access}
        onChange={(v) => onChange({ ...value, access: v as ChannelAccess["access"] })}
        options={ACCESS_VALUES.map((a) => ({ value: a, label: labels[a] }))}
      />
      {value.access === "roles" && (
        <Input
          className="font-mono"
          value={(value.roles ?? []).join(", ")}
          onChange={(e) =>
            onChange({
              ...value,
              roles: e.target.value
                .split(",")
                .map((r) => r.trim())
                .filter(Boolean),
            })
          }
          placeholder="member, editor"
        />
      )}
      {value.access !== "none" && (
        <>
          <Textarea
            className="font-mono"
            rows={2}
            value={conditionText}
            onChange={(e) => {
              const next = e.target.value;
              setConditionText(next);
              if (!next.trim()) {
                setConditionError(null);
                const { condition: _drop, ...rest } = value;
                onChange(rest);
                return;
              }
              try {
                // Parsed on every keystroke so an unparseable condition is
                // caught here rather than becoming a 422 on save — or worse,
                // a stored rule that means "nobody".
                const parsed = JSON.parse(next);
                setConditionError(null);
                onChange({ ...value, condition: parsed });
              } catch (err) {
                setConditionError((err as Error).message);
              }
            }}
            placeholder={CONDITION_EXAMPLE}
          />
          {conditionError ? (
            <span className="text-[11px] text-destructive">{conditionError}</span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {conditionHint}{" "}
              <span className="font-mono">{CONDITION_EXAMPLE}</span>
            </span>
          )}
        </>
      )}
    </div>
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
