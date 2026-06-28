// Feature flags page — toggle flags, set a remote-config value, and target a
// rollout % or a permission-DSL condition. Global defaults + per-workspace
// overrides; evaluated for callers at /api/flags.
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
} from "../ui";
import { Select } from "../select";
import { Switch } from "../ui";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { flagsApi, type ApiFlag } from "../api";

interface EditState {
  key: string;
  enabled: boolean;
  value: string; // JSON text
  rollout: string; // "" or 0-100
  condition: string; // JSON text
  description: string;
  scope: "tenant" | "global";
  isNew: boolean;
}

const blank = (): EditState => ({
  key: "",
  enabled: true,
  value: "",
  rollout: "",
  condition: "",
  description: "",
  scope: "tenant",
  isNew: true,
});

export function FeatureFlagsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [flags, setFlags] = useState<ApiFlag[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = async () => {
    try {
      const r = await flagsApi.list();
      setFlags(r.data ?? []);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  useEffect(() => { void reload().finally(() => setLoaded(true)); }, []);

  const openEdit = (f: ApiFlag) =>
    setEdit({
      key: f.key,
      enabled: f.enabled,
      value: f.value == null ? "" : JSON.stringify(f.value, null, 2),
      rollout: typeof f.rules?.rollout === "number" ? String(f.rules.rollout) : "",
      condition: f.rules?.condition ? JSON.stringify(f.rules.condition, null, 2) : "",
      description: f.description ?? "",
      scope: f.tenantId == null ? "global" : "tenant",
      isNew: false,
    });

  const save = async () => {
    if (!edit) return;
    if (!edit.key.trim()) { pushToast(t`Key is required.`); return; }
    let value: unknown;
    let condition: unknown;
    try {
      value = edit.value.trim() ? JSON.parse(edit.value) : null;
    } catch { pushToast(t`Value must be valid JSON.`); return; }
    try {
      condition = edit.condition.trim() ? JSON.parse(edit.condition) : undefined;
    } catch { pushToast(t`Condition must be valid JSON.`); return; }
    const rolloutNum = edit.rollout.trim() === "" ? undefined : Number(edit.rollout);
    if (rolloutNum !== undefined && (!Number.isFinite(rolloutNum) || rolloutNum < 0 || rolloutNum > 100)) {
      pushToast(t`Rollout must be 0–100.`); return;
    }
    const rules =
      condition === undefined && rolloutNum === undefined
        ? null
        : { ...(condition !== undefined ? { condition } : {}), ...(rolloutNum !== undefined ? { rollout: rolloutNum } : {}) };
    setSaving(true);
    try {
      await flagsApi.upsert(
        edit.key.trim(),
        { enabled: edit.enabled, value, rules, description: edit.description || null },
        edit.scope,
      );
      pushToast(t`Flag saved.`);
      setEdit(null);
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async (f: ApiFlag) => {
    try {
      await flagsApi.remove(f.key, f.tenantId == null ? "global" : "tenant");
      pushToast(t`Flag deleted.`);
      await reload();
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Feature flags`}
        description={t`Toggle features and ship remote config. Target a rollout % or a permission-DSL condition; client apps read the evaluated map at /api/flags.`}
        actions={
          <div className="flex items-center gap-2">
            <IconButton icon={I.Refresh} title={t`Refresh`} onClick={() => void reload()} />
            <Button variant="primary" icon={I.Plus} onClick={() => setEdit(blank())}>
              <Trans>New flag</Trans>
            </Button>
          </div>
        }
      />

      <Card className="py-0 gap-0">
        {!loaded ? (
          <div className="flex flex-col">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="ml-auto h-5 w-9 rounded-full" />
              </div>
            ))}
          </div>
        ) : flags.length === 0 ? (
          <EmptyState
            size="md"
            icon={I.ToggleLeft}
            title={<Trans>No feature flags</Trans>}
            description={<Trans>Create a flag to gate a feature or ship remote config to your apps.</Trans>}
          />
        ) : (
          <ScrollArea viewportClassName="max-h-[calc(100vh-16rem)]" className="w-full">
            <div className="min-w-[680px]">
              <div className="grid grid-cols-[1fr_90px_90px_90px_110px] items-center gap-3 border-b border-border px-3.5 py-2.5 text-[11.5px] font-medium text-muted-foreground">
                <span><Trans>Key</Trans></span>
                <span><Trans>State</Trans></span>
                <span><Trans>Scope</Trans></span>
                <span><Trans>Rollout</Trans></span>
                <span className="text-right"><Trans>Actions</Trans></span>
              </div>
              {flags.map((f) => (
                <div
                  key={f.id}
                  className="grid grid-cols-[1fr_90px_90px_90px_110px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 hover:bg-accent/40"
                >
                  <button type="button" onClick={() => openEdit(f)} className="min-w-0 text-left hover:underline">
                    <div className="truncate font-mono text-[12.5px]">{f.key}</div>
                    {f.description && <div className="truncate text-[11.5px] text-muted-foreground">{f.description}</div>}
                  </button>
                  <span>
                    <Badge variant={f.enabled ? "default" : "outline"}>
                      {f.enabled ? <Trans>On</Trans> : <Trans>Off</Trans>}
                    </Badge>
                  </span>
                  <span>
                    <Badge variant="secondary">{f.tenantId == null ? <Trans>Global</Trans> : <Trans>Workspace</Trans>}</Badge>
                  </span>
                  <span className="font-mono text-[12px] text-muted-foreground">
                    {typeof f.rules?.rollout === "number" ? `${f.rules.rollout}%` : "—"}
                  </span>
                  <span className="flex items-center justify-end gap-1">
                    <IconButton icon={I.Pencil} title={t`Edit`} onClick={() => openEdit(f)} />
                    <IconButton icon={I.Trash} title={t`Delete`} onClick={() => void remove(f)} />
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </Card>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-lg flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle>{edit?.isNew ? <Trans>New flag</Trans> : <Trans>Edit flag</Trans>}</DialogTitle>
            <DialogDescription>
              <Trans>A flag is on for a caller when enabled AND its targeting (condition + rollout) matches.</Trans>
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <ScrollArea viewportClassName="max-h-[calc(85vh-13rem)] max-[640px]:max-h-[calc(85vh-15rem)] [&>div]:!block">
              <div className="flex flex-col gap-3.5 overflow-x-clip px-0.5 py-1">
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Key</Trans>
                  <Input
                    value={edit.key}
                    disabled={!edit.isNew}
                    placeholder="new-checkout"
                    onChange={(e) => setEdit({ ...edit, key: e.target.value })}
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-[12.5px] font-medium">
                  <Trans>Enabled</Trans>
                  <Switch checked={edit.enabled} onChange={(v) => setEdit({ ...edit, enabled: v })} />
                </label>
                {edit.isNew && (
                  <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                    <Trans>Scope</Trans>
                    <Select
                      value={edit.scope}
                      onChange={(v) => setEdit({ ...edit, scope: v as "tenant" | "global" })}
                      options={[
                        { value: "tenant", label: t`This workspace` },
                        { value: "global", label: t`Global default` },
                      ]}
                    />
                  </label>
                )}
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Value (JSON, optional)</Trans>
                  <Textarea
                    rows={3}
                    value={edit.value}
                    placeholder='{ "variant": "B" }'
                    className="font-mono text-[12px]"
                    onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Rollout % (0–100, optional)</Trans>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    value={edit.rollout}
                    placeholder="100"
                    onChange={(e) => setEdit({ ...edit, rollout: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Condition (permission DSL JSON, optional)</Trans>
                  <Textarea
                    rows={3}
                    value={edit.condition}
                    placeholder='{ "roles": { "_contains": "beta" } }'
                    className="font-mono text-[12px]"
                    onChange={(e) => setEdit({ ...edit, condition: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Description</Trans>
                  <Input
                    value={edit.description}
                    onChange={(e) => setEdit({ ...edit, description: e.target.value })}
                  />
                </label>
              </div>
            </ScrollArea>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEdit(null)}><Trans>Cancel</Trans></Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? <Trans>Saving…</Trans> : <Trans>Save flag</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
