// @ts-nocheck
import type { PushToast } from "../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@backlex/ui/components/badge";
import { Card } from "@backlex/ui/components/card";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { I } from "../icons";
import { Select } from "../select";
import { Button, EmptyState, PageHeader } from "../ui";
import { approvalsApi, type ApiApprovalRequest } from "../api";
import { ApprovalsSkeleton } from "../page-skeletons";

/**
 * Approval requests — what is waiting on a person, and what it was decided.
 *
 * A list, not an editor. Requests are raised by a flow's `approval.request`
 * step (or the API), and by the time one exists the summary an approver sees
 * is frozen. So the page answers the three questions an operator has: what is
 * outstanding, who is holding it up, and can I withdraw it.
 *
 * There is deliberately no "approve on their behalf" action. Deciding is
 * authenticated by the approver's own link and nothing else, and an
 * admin-authenticated decision would also fire whatever the waiting flow does
 * next.
 */

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  approved: "default",
  rejected: "destructive",
  expired: "outline",
  cancelled: "outline",
};

const APPROVER_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  viewed: "secondary",
  approved: "default",
  rejected: "destructive",
};

const stamp = (value: unknown): string => {
  if (value == null) return "—";
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
};

/** "2 of 3 answered" is the number an operator chasing a request wants; the
 *  raw statuses are one click away in the detail dialog. */
const answered = (row: ApiApprovalRequest): string =>
  `${row.approvers.filter((a) => a.status === "approved" || a.status === "rejected").length}/${row.approvers.length}`;

/** What settles the request, in the operator's words rather than the enum's. */
const policyLabel = (row: ApiApprovalRequest): string =>
  row.policy === "quorum"
    ? `${row.quorum} of ${row.approvers.length}`
    : row.policy === "any"
      ? "any one"
      : "everyone";

export function ApprovalsPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiApprovalRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = async (next = status) => {
    try {
      const res = await approvalsApi.list(next || undefined);
      setRows((res.data ?? []) as ApiApprovalRequest[]);
    } catch {
      setRows([]);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await approvalsApi.list();
        if (!cancelled) setRows((res.data ?? []) as ApiApprovalRequest[]);
      } catch {
        // Leave the list empty; the page is still readable.
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Optimistic: the row flips to `cancelled` before the request lands, and
   *  rolls back to the snapshot if the server refuses (somebody decided in the
   *  meantime, which answers 409). */
  const cancel = async (id: string) => {
    const snapshot = rows;
    setRows((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: "cancelled" as const } : r)),
    );
    setOpen(null);
    try {
      await approvalsApi.cancel(id, null);
      pushToast(t`Request withdrawn`);
      void load();
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const detail = rows.find((r) => r.id === open) ?? null;

  if (!loaded) return <ApprovalsSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Approvals`}
        description={t`What is waiting on a person — and what they decided.`}
        actions={
          <Select
            size="sm"
            value={status}
            onChange={(v) => {
              setStatus(v);
              void load(v);
            }}
            className="min-w-0 sm:w-56"
            options={[
              { value: "", label: t`All statuses` },
              { value: "pending", label: t`Pending` },
              { value: "approved", label: t`Approved` },
              { value: "rejected", label: t`Rejected` },
              { value: "expired", label: t`Expired` },
              { value: "cancelled", label: t`Cancelled` },
            ]}
          />
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={I.ShieldCheck}
          title={<Trans>Nothing is waiting on anybody</Trans>}
          description={
            <Trans>
              Add a "Wait for approval" step to a flow, and the requests it raises show up here.
            </Trans>
          }
        />
      ) : (
        <Card className="w-full">
          <ScrollArea className="w-full" viewportClassName="max-h-[70vh]">
            <div className="flex flex-col divide-y divide-border">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setOpen(row.id)}
                  className="flex w-full min-w-0 flex-col gap-1 px-4 py-3 text-left hover:bg-muted/40"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</span>
                    <Badge variant={STATUS_TONE[row.status] ?? "outline"} className="shrink-0">
                      {row.status}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-muted-foreground">
                    <span>
                      <Trans>Answered</Trans> {answered(row)}
                    </span>
                    <span>{policyLabel(row)}</span>
                    {row.ordered ? (
                      <span>
                        <Trans>in order</Trans>
                      </span>
                    ) : null}
                    <span>
                      {row.status === "pending" ? (
                        <Trans>expires</Trans>
                      ) : (
                        <Trans>settled</Trans>
                      )}{" "}
                      {stamp(row.status === "pending" ? row.expiresAt : row.settledAt)}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </Card>
      )}

      <Dialog open={detail != null} onOpenChange={(v) => !v && setOpen(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{detail?.title}</DialogTitle>
            <DialogDescription>
              <Trans>Who was asked, who answered, and why.</Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogBody
          >
            <div className="flex flex-col gap-4 px-0.5 pb-1">
              {detail?.message ? <p className="text-[13px]">{detail.message}</p> : null}

              {detail?.summary?.length ? (
                <div className="flex flex-col gap-1 rounded-control border border-border p-3">
                  {detail.summary.map((cell, i) => (
                    <div key={i} className="flex min-w-0 gap-3 text-[13px]">
                      <span className="w-2/5 shrink-0 text-muted-foreground">{cell.label}</span>
                      <span className="min-w-0 flex-1 break-words">{cell.value}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-col gap-2">
                {(detail?.approvers ?? []).map((a) => (
                  <div
                    key={a.id}
                    className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-control border border-border px-3 py-2"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                      {a.name || a.email}
                    </span>
                    {a.role ? (
                      <span className="shrink-0 text-[12px] text-muted-foreground">{a.role}</span>
                    ) : null}
                    <Badge variant={APPROVER_TONE[a.status] ?? "outline"} className="shrink-0">
                      {a.status}
                    </Badge>
                    <span className="w-full text-[12px] text-muted-foreground">
                      {a.decidedAt ? stamp(a.decidedAt) : <Trans>no answer yet</Trans>}
                      {a.reason ? ` — ${a.reason}` : ""}
                    </span>
                  </div>
                ))}
              </div>

              {detail?.outcomeReason ? (
                <p className="text-[12.5px] text-muted-foreground">
                  <Trans>Outcome reason</Trans>: {detail.outcomeReason}
                </p>
              ) : null}
            </div>
          </DialogBody>
          <DialogFooter className="shrink-0">
            <Button variant="ghost" onClick={() => setOpen(null)}>
              <Trans>Close</Trans>
            </Button>
            {detail?.status === "pending" ? (
              <Button variant="destructive" onClick={() => detail && cancel(detail.id)}>
                <Trans>Withdraw</Trans>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
