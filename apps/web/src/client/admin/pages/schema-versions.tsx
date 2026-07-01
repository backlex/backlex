// Schema versions — migration diffing / schema branching (#9).
//
// Two surfaces over `/api/admin/schema`: **snapshots** (immutable schema
// checkpoints you can diff/restore) and **branches** (named pointers you stage
// changes on). From any row you can open the diff viewer (live → that ref),
// which categorizes every change additive / destructive / metadata and applies
// it — destructive changes (drop column/table, type change) behind an explicit
// confirm. A safety snapshot is always captured before an apply.
import { Trans, useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";
import { Badge as ShadcnBadge } from "@backlex/ui/components/badge";
import { Card } from "@backlex/ui/components/card";
import { Checkbox } from "@backlex/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Input } from "@backlex/ui/components/input";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@backlex/ui/components/table";
import { Textarea } from "@backlex/ui/components/textarea";
import {
  type ApiSchemaApplyResult,
  type ApiSchemaBranch,
  type ApiSchemaChange,
  type ApiSchemaDiff,
  type ApiSchemaRef,
  type ApiSchemaSnapshot,
  schemaVersionsApi,
  settingsApi,
} from "../api";
import { I } from "../icons";
import { SchemaVersionsSkeleton } from "../page-skeletons";
import { Select } from "../select";
import { ConfirmDialog } from "../sheet";
import { Badge, Button, EmptyState, IconButton, PageHeader } from "../ui";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

type Tab = "snapshots" | "branches";

/** A ref + a human label, the unit the diff dialog operates on. */
interface RefTarget {
  ref: ApiSchemaRef;
  label: string;
}

const SEVERITY_STYLE: Record<ApiSchemaChange["severity"], { dot: string; badge: "destructive" | "default" | "secondary" }> = {
  additive: { dot: "text-[oklch(0.72_0.16_150)]", badge: "default" },
  destructive: { dot: "text-destructive", badge: "destructive" },
  metadata: { dot: "text-muted-foreground", badge: "secondary" },
};

export function SchemaVersionsPage({
  pushToast,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const [tab, setTab] = useState<Tab>("snapshots");
  const [loading, setLoading] = useState(true);
  const [snapshots, setSnapshots] = useState<ApiSchemaSnapshot[]>([]);
  const [branches, setBranches] = useState<ApiSchemaBranch[]>([]);
  // Auto-snapshot schedule (workspace setting).
  const [schedule, setSchedule] = useState<"off" | "daily" | "weekly">("off");
  const [keepLast, setKeepLast] = useState(7);

  // Dialog state.
  const [captureOpen, setCaptureOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [diffTarget, setDiffTarget] = useState<RefTarget | null>(null);
  // Pending delete — gated behind a confirm so a click never destroys silently.
  const [pendingDelete, setPendingDelete] = useState<
    { type: "snapshot"; item: ApiSchemaSnapshot } | { type: "branch"; item: ApiSchemaBranch } | null
  >(null);

  const reload = useCallback(async () => {
    try {
      const [s, b, settings] = await Promise.all([
        schemaVersionsApi.listSnapshots(),
        schemaVersionsApi.listBranches(),
        settingsApi.load(),
      ]);
      setSnapshots(s.data);
      setBranches(b.data);
      const cfg = settings.data;
      const sched = cfg.schemaSnapshotSchedule;
      if (sched === "daily" || sched === "weekly" || sched === "off") setSchedule(sched);
      if (typeof cfg.schemaSnapshotKeepLast === "number") setKeepLast(cfg.schemaSnapshotKeepLast);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  // Persist a schedule change optimistically (snapshot → set → patch → rollback).
  const saveSchedule = useCallback(
    async (next: { schedule?: "off" | "daily" | "weekly"; keepLast?: number }) => {
      const prev = { schedule, keepLast };
      const merged = { schedule: next.schedule ?? schedule, keepLast: next.keepLast ?? keepLast };
      setSchedule(merged.schedule);
      setKeepLast(merged.keepLast);
      try {
        await settingsApi.patch({
          schemaSnapshotSchedule: merged.schedule,
          schemaSnapshotKeepLast: merged.keepLast,
        });
      } catch (e) {
        setSchedule(prev.schedule);
        setKeepLast(prev.keepLast);
        pushToast((e as Error).message, "error");
      }
    },
    [schedule, keepLast, pushToast],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // ── Optimistic mutations ────────────────────────────────────────────────
  const deleteSnapshot = useCallback(
    async (snap: ApiSchemaSnapshot) => {
      const prev = snapshots;
      setSnapshots((cur) => cur.filter((s) => s.id !== snap.id));
      try {
        await schemaVersionsApi.deleteSnapshot(snap.id);
        pushToast(t`Snapshot deleted.`);
      } catch (e) {
        setSnapshots(prev);
        pushToast((e as Error).message, "error");
      }
    },
    [snapshots, pushToast, t],
  );

  const deleteBranch = useCallback(
    async (branch: ApiSchemaBranch) => {
      const prevBranches = branches;
      const prevSnaps = snapshots;
      setBranches((cur) => cur.filter((b) => b.id !== branch.id));
      // Deleting a branch also drops its branch-owned snapshots server-side —
      // reflect that in the snapshots tab immediately so no orphan lingers.
      setSnapshots((cur) => cur.filter((s) => s.branchId !== branch.id));
      try {
        await schemaVersionsApi.deleteBranch(branch.id);
        pushToast(t`Branch deleted.`);
      } catch (e) {
        setBranches(prevBranches);
        setSnapshots(prevSnaps);
        pushToast((e as Error).message, "error");
      }
    },
    [branches, snapshots, pushToast, t],
  );

  const isEmpty = tab === "snapshots" ? snapshots.length === 0 : branches.length === 0;

  if (loading) return <SchemaVersionsSkeleton />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t`Schema versions`}
        description={
          <Trans>
            Snapshot and branch your schema, diff any version against the live one, and apply a
            target to migrate — destructive changes stay behind a confirm.
          </Trans>
        }
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {tab === "snapshots" ? (
              <>
                <Button variant="outline" icon={I.Upload} onClick={() => setImportOpen(true)}>
                  <Trans>Import</Trans>
                </Button>
                <Button variant="primary" icon={I.Plus} onClick={() => setCaptureOpen(true)}>
                  <Trans>Capture snapshot</Trans>
                </Button>
              </>
            ) : (
              <Button variant="primary" icon={I.Plus} onClick={() => setBranchOpen(true)}>
                <Trans>New branch</Trans>
              </Button>
            )}
          </div>
        }
      />

      {/* Tab strip — full width on mobile, hugging the convention. */}
      <div className="flex items-center gap-1.5 border-b">
        {(["snapshots", "branches"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              tab === id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {id === "snapshots" ? <I.History size={14} /> : <I.Network size={14} />}
            {id === "snapshots" ? <Trans>Snapshots</Trans> : <Trans>Branches</Trans>}
            <span className="text-xs text-muted-foreground">
              {id === "snapshots" ? snapshots.length : branches.length}
            </span>
          </button>
        ))}
      </div>

      {/* Per-tab helper — makes the snapshot vs branch distinction explicit. */}
      <p className="-mt-3 text-sm text-muted-foreground">
        {tab === "snapshots" ? (
          <Trans>
            <strong className="font-medium text-foreground">Snapshots</strong> are immutable
            checkpoints of your schema. Capture the live schema or import an authored one, then diff
            or apply it.
          </Trans>
        ) : (
          <Trans>
            <strong className="font-medium text-foreground">Branches</strong> are named working
            copies forked from the live schema — stage changes on a branch, then apply it to live. A
            branch keeps its own history; a snapshot is a single frozen point.
          </Trans>
        )}
      </p>

      {/* Auto-snapshot cadence — a scheduled capture + retention, per workspace. */}
      {tab === "snapshots" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
          <I.Clock size={14} className="shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">
            <Trans>Auto-snapshot</Trans>
          </span>
          <Select
            size="sm"
            className="w-28"
            value={schedule}
            onChange={(v) => saveSchedule({ schedule: v as "off" | "daily" | "weekly" })}
            options={[
              { value: "off", label: t`Off` },
              { value: "daily", label: t`Daily` },
              { value: "weekly", label: t`Weekly` },
            ]}
          />
          {schedule !== "off" && (
            <>
              <span className="text-muted-foreground">
                <Trans>· keep last</Trans>
              </span>
              <Select
                size="sm"
                className="w-16"
                value={String(keepLast)}
                onChange={(v) => saveSchedule({ keepLast: Number(v) })}
                options={["3", "5", "7", "14", "30"]}
              />
              <span className="text-muted-foreground">
                <Trans>snapshots — older ones are pruned automatically.</Trans>
              </span>
            </>
          )}
        </div>
      )}

      <Card className="overflow-hidden">
        {isEmpty ? (
          <EmptyState
            icon={tab === "snapshots" ? I.History : I.Network}
            title={tab === "snapshots" ? t`No snapshots yet` : t`No branches yet`}
            description={
              tab === "snapshots"
                ? t`Capture a snapshot to checkpoint the current schema.`
                : t`Fork a branch to stage schema changes off to the side.`
            }
          />
        ) : tab === "snapshots" ? (
          <Table className={ADMIN_TABLE_CLS}>
            <TableHeader>
              <TableRow>
                <TableHead>{t`Name`}</TableHead>
                <TableHead>{t`Kind`}</TableHead>
                <TableHead className="text-right">{t`Collections`}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {snapshots.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <div className="font-medium">{s.name}</div>
                    {s.note && <div className="text-xs text-muted-foreground">{s.note}</div>}
                  </TableCell>
                  <TableCell>
                    <ShadcnBadge
                      variant={s.kind === "auto" || s.kind === "scheduled" ? "secondary" : "outline"}
                    >
                      {s.kind}
                    </ShadcnBadge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.collectionCount}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        icon={I.Activity}
                        onClick={() =>
                          setDiffTarget({ ref: { kind: "snapshot", id: s.id }, label: s.name })
                        }
                      >
                        <Trans>Review & apply</Trans>
                      </Button>
                      <IconButton
                        icon={I.Trash}
                        title={t`Delete`}
                        onClick={() => setPendingDelete({ type: "snapshot", item: s })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table className={ADMIN_TABLE_CLS}>
            <TableHeader>
              <TableRow>
                <TableHead>{t`Name`}</TableHead>
                <TableHead>{t`Head`}</TableHead>
                <TableHead className="w-px" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {branches.map((b) => (
                <TableRow key={b.id}>
                  <TableCell>
                    <div className="font-medium">{b.name}</div>
                    {b.note && <div className="text-xs text-muted-foreground">{b.note}</div>}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {b.headSnapshotId ? b.headSnapshotId.slice(0, 8) : "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        icon={I.Activity}
                        onClick={() =>
                          setDiffTarget({ ref: { kind: "branch", id: b.id }, label: b.name })
                        }
                      >
                        <Trans>Review & apply</Trans>
                      </Button>
                      <IconButton
                        icon={I.Trash}
                        title={t`Delete`}
                        onClick={() => setPendingDelete({ type: "branch", item: b })}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <CaptureDialog
        open={captureOpen}
        onOpenChange={setCaptureOpen}
        onDone={(snap) => {
          setSnapshots((cur) => [snap, ...cur]);
          pushToast(t`Snapshot captured.`);
        }}
        pushToast={pushToast}
      />
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onDone={(snap) => {
          setSnapshots((cur) => [snap, ...cur]);
          pushToast(t`Schema imported as snapshot.`);
        }}
        pushToast={pushToast}
      />
      <NewBranchDialog
        open={branchOpen}
        onOpenChange={setBranchOpen}
        snapshots={snapshots}
        onDone={(branch) => {
          setBranches((cur) => [branch, ...cur]);
          pushToast(t`Branch created.`);
        }}
        pushToast={pushToast}
      />
      <DiffApplyDialog
        target={diffTarget}
        onOpenChange={(o) => !o && setDiffTarget(null)}
        onApplied={(res) => {
          pushToast(
            res.noop ? t`Already in sync — no changes.` : t`Applied ${res.applied.length} change(s).`,
          );
          setDiffTarget(null);
          void reload();
        }}
        pushToast={pushToast}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        destructive
        title={pendingDelete?.type === "branch" ? t`Delete branch?` : t`Delete snapshot?`}
        description={
          pendingDelete?.type === "branch"
            ? t`Delete "${pendingDelete.item.name}" and its branch-owned snapshots? This can't be undone.`
            : pendingDelete
              ? t`Delete snapshot "${pendingDelete.item.name}"? This can't be undone.`
              : ""
        }
        actionLabel={t`Delete`}
        onConfirm={() => {
          const p = pendingDelete;
          setPendingDelete(null);
          if (p?.type === "snapshot") void deleteSnapshot(p.item);
          else if (p?.type === "branch") void deleteBranch(p.item);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

// ── Capture ────────────────────────────────────────────────────────────────
function CaptureDialog({
  open,
  onOpenChange,
  onDone,
  pushToast,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (snap: ApiSchemaSnapshot) => void;
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { data } = await schemaVersionsApi.capture(name.trim());
      onOpenChange(false);
      onDone(data);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>Capture snapshot</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Save the current live schema as an immutable checkpoint.</Trans>
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder={t`Snapshot name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? t`Capturing…` : t`Capture`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Import ─────────────────────────────────────────────────────────────────
function ImportDialog({
  open,
  onOpenChange,
  onDone,
  pushToast,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (snap: ApiSchemaSnapshot) => void;
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setName("");
      setText("");
    }
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      pushToast(t`Schema JSON is not valid JSON.`, "error");
      return;
    }
    if (!Array.isArray(parsed)) {
      pushToast(t`Schema must be a JSON array of collections.`, "error");
      return;
    }
    setBusy(true);
    try {
      const { data } = await schemaVersionsApi.importSnapshot(name.trim(), parsed as never);
      onOpenChange(false);
      onDone(data);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>Import schema</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Paste an authored schema (a JSON array of collections, e.g. from{" "}
              <code>backlex collections export-schema</code>) to store as a snapshot you can diff
              and apply.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <ScrollArea viewportClassName="max-h-[calc(85vh-13rem)] max-[640px]:max-h-[calc(85vh-16rem)]">
          <div className="flex flex-col gap-3 px-0.5">
            <Input
              placeholder={t`Snapshot name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <Textarea
              placeholder='[{ "slug": "posts", "fields": [{ "name": "title", "type": "text" }] }]'
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="min-h-[220px] font-mono text-xs"
            />
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="primary" disabled={busy || !name.trim() || !text.trim()} onClick={submit}>
            {busy ? t`Importing…` : t`Import`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── New branch ───────────────────────────────────────────────────────────────
function NewBranchDialog({
  open,
  onOpenChange,
  snapshots,
  onDone,
  pushToast,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  snapshots: ApiSchemaSnapshot[];
  onDone: (branch: ApiSchemaBranch) => void;
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName("");
  }, [open]);

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const { data } = await schemaVersionsApi.createBranch(name.trim());
      onOpenChange(false);
      onDone(data);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>New branch</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Fork a branch from the current live schema. Stage changes, then apply.</Trans>
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          placeholder={t`Branch name (e.g. add-orders)`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <p className="text-xs text-muted-foreground">
          <Trans>{snapshots.length} snapshot(s) available to fork from.</Trans>
        </p>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button variant="primary" disabled={busy || !name.trim()} onClick={submit}>
            {busy ? t`Creating…` : t`Create branch`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Diff + apply ─────────────────────────────────────────────────────────────
function DiffApplyDialog({
  target,
  onOpenChange,
  onApplied,
  pushToast,
}: {
  target: RefTarget | null;
  onOpenChange: (o: boolean) => void;
  onApplied: (res: ApiSchemaApplyResult) => void;
  pushToast: (m: string, type?: "success" | "error") => void;
}) {
  const { t } = useLingui();
  const [diff, setDiff] = useState<ApiSchemaDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!target) {
      setDiff(null);
      setConfirmDestructive(false);
      return;
    }
    setLoading(true);
    setDiff(null);
    schemaVersionsApi
      .diff({ kind: "live" }, target.ref)
      .then((r) => setDiff(r.data.diff))
      .catch((e) => pushToast((e as Error).message, "error"))
      .finally(() => setLoading(false));
  }, [target, pushToast]);

  const apply = async () => {
    if (!target) return;
    setApplying(true);
    try {
      const { data } = await schemaVersionsApi.apply(target.ref, confirmDestructive);
      onApplied(data);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setApplying(false);
    }
  };

  const blocked = Boolean(diff?.hasDestructive && !confirmDestructive);
  const noChanges = diff !== null && diff.counts.total === 0;

  return (
    <Dialog open={Boolean(target)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            <Trans>Review & apply — {target?.label ?? ""}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>Changes the live schema would receive if you apply this version.</Trans>
          </DialogDescription>
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[calc(85vh-13rem)] max-[640px]:max-h-[calc(85vh-16rem)]">
          <div className="flex flex-col gap-2 px-0.5">
            {loading && (
              <div className="flex flex-col gap-2" aria-busy="true" aria-label={t`Computing diff`}>
                <div className="flex gap-2">
                  <Skeleton className="h-5 w-24 rounded-full" />
                  <Skeleton className="h-5 w-24 rounded-full" />
                  <Skeleton className="h-5 w-24 rounded-full" />
                </div>
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-8 w-full rounded-md" />
                ))}
              </div>
            )}
            {noChanges && (
              <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                <Trans>Live schema already matches this version.</Trans>
              </div>
            )}
            {diff && diff.counts.total > 0 && (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge variant="default">+{diff.counts.additive} {t`additive`}</Badge>
                  <Badge variant="destructive">{diff.counts.destructive} {t`destructive`}</Badge>
                  <Badge variant="secondary">{diff.counts.metadata} {t`metadata`}</Badge>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {diff.changes.map((ch, i) => {
                    const sty = SEVERITY_STYLE[ch.severity];
                    return (
                      <li
                        key={`${ch.kind}-${ch.collection}-${ch.field ?? ""}-${i}`}
                        className="flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[13px]"
                      >
                        <span className={`mt-0.5 font-mono ${sty.dot}`}>
                          {ch.severity === "destructive" ? "!" : ch.severity === "additive" ? "+" : "·"}
                        </span>
                        <span className="min-w-0 break-words">{ch.summary}</span>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            {diff?.hasDestructive && (
              <label className="mt-1 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <Checkbox
                  checked={confirmDestructive}
                  onCheckedChange={(v) => setConfirmDestructive(Boolean(v))}
                  className="mt-0.5"
                />
                <span>
                  <Trans>
                    I understand this drops columns/tables or changes types and will lose data.
                  </Trans>
                </span>
              </label>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant={diff?.hasDestructive ? "destructive" : "primary"}
            disabled={applying || loading || noChanges || blocked || !diff}
            onClick={apply}
          >
            {applying ? t`Applying…` : t`Apply to live schema`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
