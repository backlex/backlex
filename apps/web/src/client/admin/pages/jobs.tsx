// Jobs page — durable job queue: status-filtered list, retry/cancel/delete, and
// an enqueue dialog. Jobs are drained by the cross-runtime cron tick.
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import {
  Badge,
  type BadgeVariant,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  relativeTime,
} from "../ui";
import { Select } from "../select";
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
import { DatePicker } from "@/components/date-picker";
import { jobsApi, functionsApi, type ApiFunction, type ApiJob, type ApiJobStatus } from "../api";

const STATUS_VARIANT: Record<ApiJobStatus, BadgeVariant> = {
  pending: "outline",
  active: "secondary",
  succeeded: "default",
  failed: "destructive",
  dead_letter: "destructive",
  cancelled: "outline",
};

const STATUS_FILTERS: (ApiJobStatus | "all")[] = [
  "all",
  "pending",
  "active",
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
];

export function JobsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [jobs, setJobs] = useState<ApiJob[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState<ApiJobStatus | "all">("all");
  const [detail, setDetail] = useState<ApiJob | null>(null);
  const [enqueueOpen, setEnqueueOpen] = useState(false);

  const statusLabel = (s: ApiJobStatus | "all"): string =>
    s === "all" ? t`All`
    : s === "pending" ? t`Pending`
    : s === "active" ? t`Active`
    : s === "succeeded" ? t`Succeeded`
    : s === "failed" ? t`Failed`
    : s === "dead_letter" ? t`Dead-letter`
    : t`Cancelled`;

  const reload = async () => {
    try {
      const r = await jobsApi.list({ status: status === "all" ? undefined : status, limit: 200 });
      setJobs(r.jobs ?? []);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  useEffect(() => { void reload().finally(() => setLoaded(true)); }, [status]);

  const retry = async (job: ApiJob) => {
    try { await jobsApi.retry(job.id); await reload(); pushToast(t`Job requeued.`); }
    catch (e) { pushToast((e as Error).message); }
  };
  const cancel = async (job: ApiJob) => {
    try { await jobsApi.cancel(job.id); await reload(); pushToast(t`Job cancelled.`); }
    catch (e) { pushToast((e as Error).message); }
  };
  const remove = async (job: ApiJob) => {
    try { await jobsApi.remove(job.id); await reload(); pushToast(t`Job deleted.`); }
    catch (e) { pushToast((e as Error).message); }
  };

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Jobs`}
        description={t`Durable background queue — retries with backoff, dead-letters, and delayed/scheduled runs. Drained by the cron tick (~1 min on Workers).`}
        actions={
          <div className="flex items-center gap-2">
            <IconButton icon={I.Refresh} title={t`Refresh`} onClick={() => void reload()} />
            <Button variant="primary" icon={I.Plus} onClick={() => setEnqueueOpen(true)}>
              <Trans>Enqueue job</Trans>
            </Button>
          </div>
        }
      />

      {/* Status filter strip — full width on mobile, decluttered. */}
      <div className="flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1 text-[12.5px] ${
              status === s
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent"
            }`}
          >
            {statusLabel(s)}
          </button>
        ))}
      </div>

      <Card className="py-0 gap-0">
        {!loaded ? (
          <div className="flex flex-col">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="ml-auto h-4 w-16" />
              </div>
            ))}
          </div>
        ) : jobs.length === 0 ? (
          <EmptyState
            size="md"
            icon={I.Clock}
            title={<Trans>No jobs</Trans>}
            description={<Trans>Enqueue a job, or migrate work onto the queue. Webhook deliveries land here automatically.</Trans>}
          />
        ) : (
          <ScrollArea viewportClassName="max-h-[calc(100vh-16rem)]" className="w-full">
            <div className="min-w-[720px]">
              <div className="grid grid-cols-[110px_1fr_120px_90px_120px_140px] items-center gap-3 border-b border-border px-3.5 py-2.5 text-[11.5px] font-medium text-muted-foreground">
                <span><Trans>Status</Trans></span>
                <span><Trans>Type</Trans></span>
                <span><Trans>Queue</Trans></span>
                <span><Trans>Attempts</Trans></span>
                <span><Trans>Run at</Trans></span>
                <span className="text-right"><Trans>Actions</Trans></span>
              </div>
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="grid grid-cols-[110px_1fr_120px_90px_120px_140px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 hover:bg-accent/40"
                >
                  <span>
                    <Badge variant={STATUS_VARIANT[job.status]}>{statusLabel(job.status)}</Badge>
                  </span>
                  <button
                    type="button"
                    onClick={() => setDetail(job)}
                    className="min-w-0 truncate text-left font-mono text-[12.5px] hover:underline"
                    title={job.type}
                  >
                    {job.type}
                  </button>
                  <span className="truncate font-mono text-[12px] text-muted-foreground">{job.queue}</span>
                  <span className="font-mono text-[12px] text-muted-foreground">
                    {job.attempts}/{job.maxAttempts}
                  </span>
                  <span className="font-mono text-[11.5px] text-muted-foreground">{relativeTime(job.runAt)}</span>
                  <span className="flex items-center justify-end gap-1">
                    {(job.status === "failed" || job.status === "dead_letter" || job.status === "cancelled") && (
                      <IconButton icon={I.RotateCcw} title={t`Retry`} onClick={() => void retry(job)} />
                    )}
                    {job.status === "pending" && (
                      <IconButton icon={I.XCircle} title={t`Cancel`} onClick={() => void cancel(job)} />
                    )}
                    <IconButton icon={I.Eye} title={t`Details`} onClick={() => setDetail(job)} />
                    <IconButton icon={I.Trash} title={t`Delete`} onClick={() => void remove(job)} className="text-destructive" />
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </Card>

      {detail && <JobDetailDialog job={detail} onClose={() => setDetail(null)} />}
      {enqueueOpen && (
        <EnqueueJobDialog
          onClose={() => setEnqueueOpen(false)}
          onEnqueued={async () => { setEnqueueOpen(false); await reload(); pushToast(t`Job enqueued.`); }}
          onError={(m) => pushToast(m)}
        />
      )}
    </div>
  );
}

function JobDetailDialog({ job, onClose }: { job: ApiJob; onClose: () => void }) {
  const { t } = useLingui();
  const pretty = (v: unknown) => JSON.stringify(v ?? null, null, 2);
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-[640px] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            <span className="font-mono">{job.type}</span>
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px]">
            {t`Job`} <span className="font-mono">{job.id}</span> · {job.status} · {job.attempts}/{job.maxAttempts} {t`attempts`}
          </DialogDescription>
        </DialogHeader>
        <ScrollArea viewportClassName="max-h-[calc(90vh-8rem)]">
          <div className="flex flex-col gap-4 px-5 py-[18px] text-[12.5px]">
            <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
              <Field label={t`Queue`} value={job.queue} mono />
              <Field label={t`Priority`} value={String(job.priority)} mono />
              <Field label={t`Created`} value={relativeTime(job.createdAt)} />
              <Field label={t`Completed`} value={job.completedAt ? relativeTime(job.completedAt) : "—"} />
            </div>
            {job.lastError && (
              <div className="flex flex-col gap-1.5">
                <span className="font-medium text-destructive"><Trans>Last error</Trans></span>
                <pre className="rounded-surface bg-destructive/10 p-3 font-mono text-[11.5px] text-destructive whitespace-pre-wrap [overflow-wrap:anywhere]">{job.lastError}</pre>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="font-medium"><Trans>Payload</Trans></span>
              <pre className="rounded-surface bg-muted p-3 font-mono text-[11.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">{pretty(job.payload)}</pre>
            </div>
            {job.result != null && (
              <div className="flex flex-col gap-1.5">
                <span className="font-medium"><Trans>Result</Trans></span>
                <pre className="rounded-surface bg-muted p-3 font-mono text-[11.5px] whitespace-pre-wrap [overflow-wrap:anywhere]">{pretty(job.result)}</pre>
              </div>
            )}
          </div>
        </ScrollArea>
        <DialogFooter className="border-t border-border bg-card px-5 py-3 sm:justify-end">
          <Button variant="ghost" onClick={onClose}><Trans>Close</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11.5px] text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono text-[12px]" : "text-[12px]"}>{value}</span>
    </div>
  );
}

function EnqueueJobDialog({
  onClose,
  onEnqueued,
  onError,
}: {
  onClose: () => void;
  onEnqueued: () => void;
  onError: (m: string) => void;
}) {
  const { t } = useLingui();
  type JobType = "function" | "webhook.deliver";
  const [type, setType] = useState<JobType>("function");
  const [fnName, setFnName] = useState("");
  const [functions, setFunctions] = useState<ApiFunction[]>([]);
  const [fnLoaded, setFnLoaded] = useState(false);
  const [payloadText, setPayloadText] = useState("{}");
  const [queue, setQueue] = useState("");
  const [runAt, setRunAt] = useState("");
  const [maxAttempts, setMaxAttempts] = useState<number | "">("");
  const [busy, setBusy] = useState(false);

  // Function jobs must reference an existing function, so offer a pick-list
  // rather than free text — avoids enqueuing a name the server will reject.
  useEffect(() => {
    let cancelled = false;
    functionsApi
      .list()
      .then((r) => { if (!cancelled) setFunctions(r.data ?? []); })
      .catch(() => { /* leave list empty; the empty-state hint covers it */ })
      .finally(() => { if (!cancelled) setFnLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  let payloadError: string | null = null;
  let parsedPayload: Record<string, unknown> = {};
  try {
    const v = JSON.parse(payloadText || "{}");
    if (v && typeof v === "object" && !Array.isArray(v)) parsedPayload = v as Record<string, unknown>;
    else payloadError = t`Must be a JSON object.`;
  } catch {
    payloadError = t`Invalid JSON.`;
  }
  const fnError = type === "function" && !fnName.trim() ? t`Function name is required.` : null;
  const valid = !payloadError && !fnError && !busy;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const payload =
        type === "function"
          ? { name: fnName.trim(), input: parsedPayload.input ?? parsedPayload }
          : parsedPayload;
      await jobsApi.enqueue({
        type,
        payload,
        queue: queue.trim() || undefined,
        runAt: runAt ? new Date(runAt).toISOString() : undefined,
        maxAttempts: maxAttempts === "" ? undefined : Number(maxAttempts),
      });
      onEnqueued();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="flex max-h-[90vh] w-[560px] max-w-[94vw] flex-col gap-0 overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Enqueue job</Trans></DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px]">
            <Trans>Queue durable background work. Function jobs run a named function; jobs retry with backoff and dead-letter.</Trans>
          </DialogDescription>
        </DialogHeader>
        <ScrollArea viewportClassName="max-h-[calc(90vh-10rem)] max-[640px]:max-h-[calc(90vh-15rem)]">
          <div className="flex flex-col gap-4 overflow-x-clip px-5 py-[18px]">
            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium"><Trans>Type</Trans></label>
              <Select
                value={type}
                onChange={(v) => setType(v as JobType)}
                options={[
                  { value: "function", label: "function", hint: t`run a named function` },
                  { value: "webhook.deliver", label: "webhook.deliver", hint: t`deliver one webhook` },
                ]}
              />
            </div>

            {type === "function" && (
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium"><Trans>Function name</Trans> <span className="text-destructive">*</span></label>
                {fnLoaded && functions.length === 0 ? (
                  <div className="flex items-center gap-1.5 rounded-surface border border-border bg-muted/40 px-3 py-2.5 text-[12px] text-muted-foreground">
                    <I.AlertTriangle size={13} />
                    <Trans>No functions defined yet. Create a function before enqueuing a function job.</Trans>
                  </div>
                ) : (
                  <Select
                    value={fnName}
                    onChange={setFnName}
                    disabled={!fnLoaded}
                    placeholder={fnLoaded ? t`Select a function` : t`Loading…`}
                    options={functions.map((f) => ({
                      value: f.name,
                      label: f.name,
                      hint: f.active ? undefined : t`inactive`,
                    }))}
                  />
                )}
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium">
                {type === "function" ? <Trans>Input (JSON)</Trans> : <Trans>Payload (JSON)</Trans>}
              </label>
              <Textarea
                className="font-mono min-h-[120px] text-xs whitespace-pre"
                aria-invalid={!!payloadError}
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
                spellCheck={false}
              />
              {payloadError ? (
                <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{payloadError}</div>
              ) : type === "webhook.deliver" ? (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>Expects</Trans> <code className="font-mono">{"{ webhookId, channel, event, body }"}</code>.
                </span>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium"><Trans>Queue</Trans></label>
                <Input value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="default" />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-[12.5px] font-medium"><Trans>Max attempts</Trans></label>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={maxAttempts}
                  onChange={(e) => setMaxAttempts(e.target.value === "" ? "" : Number(e.target.value))}
                  placeholder="5"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-[12.5px] font-medium"><Trans>Run at (optional)</Trans></label>
              <DatePicker value={runAt || null} onChange={(iso) => setRunAt(iso ?? "")} />
              <span className="text-[11.5px] text-muted-foreground"><Trans>Leave empty to run on the next tick.</Trans></span>
            </div>
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0 border-t border-border bg-card px-5 py-3 sm:justify-end">
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Cancel</Trans></Button>
          <Button variant="primary" onClick={submit} disabled={!valid}>
            {busy ? <Trans>Enqueuing…</Trans> : <Trans>Enqueue</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
