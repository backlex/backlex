// Data-subject erasure. Sits under the end-user list because that is where an
// operator is standing when a request arrives.
//
// The interface is deliberately two-step and deliberately slow at the second
// step. Everything else in the admin is optimistic; this is the one place where
// showing a result before it is true would be wrong, because the action cannot
// be taken back. So: preview renders the counts, the confirm step restates the
// subject, and nothing changes on screen until the server says it happened.
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, EmptyState, relativeTime } from "../ui";
import { Select } from "../select";
import { Input } from "@backlex/ui/components/input";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { api } from "@/lib/api";
import { fetchSafely } from "./_shared";

export type ErasureRequest = {
  id: string;
  subjectType: string;
  subjectRef: string;
  mode: string;
  status: string;
  plan: { counts?: Record<string, number> } | null;
  report: { counts?: Record<string, number> } | null;
  error: string | null;
  reference: string | null;
  previewedAt: number | string | null;
  completedAt: number | string | null;
  createdAt: number | string | null;
  limits: string[];
};

type Subject = { type: "app_user" | "email"; value: string };

const countLine = (counts: Record<string, number> | undefined) => {
  if (!counts) return "";
  const hits = Object.entries(counts).filter(([, n]) => n > 0);
  if (hits.length === 0) return "";
  return hits.map(([k, n]) => `${n} ${k}`).join(" · ");
};

export function ErasureCard({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ErasureRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  const reload = async () => {
    const res = await fetchSafely<{ data: ErasureRequest[] }>("/api/admin/erasure");
    setRows(res?.data ?? []);
    setLoaded(true);
  };

  useEffect(() => {
    void reload();
  }, []);

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <h2 className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>Erasure requests</Trans>
          </h2>
          <p className="text-[12.5px] text-muted-foreground">
            <Trans>
              Remove one person from collections, revision history, activity, comments, notifications,
              analytics, crash reports, devices and files. Preview first — a run cannot be undone.
            </Trans>
          </p>
        </div>
        <Button className="ml-auto shrink-0" onClick={() => setOpen(true)}>
          <Trans>New request</Trans>
        </Button>
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={I.ShieldAlert}
          title={t`No erasure requests`}
          description={t`When someone asks to be removed, start here — the preview shows everything that would go.`}
          size="sm"
        />
      ) : (
        <div className="flex flex-col gap-2">
          {rows.map((row) => (
            <Card
              key={row.id}
              className="flex flex-col gap-2 p-3.5 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {/* A short digest, never the address — the record of an
                      erasure must not become a copy of what it removed. */}
                  <code className="text-[12px]">{row.subjectRef}</code>
                  <Badge variant={row.mode === "delete" ? "destructive" : "secondary"} className="text-[10px]">
                    {row.mode === "delete" ? <Trans>Delete</Trans> : <Trans>Anonymize</Trans>}
                  </Badge>
                  {row.status === "completed" ? (
                    <Badge variant="default" className="text-[10px]">
                      <Trans>Carried out</Trans>
                    </Badge>
                  ) : row.status === "failed" ? (
                    <Badge variant="destructive" className="text-[10px]">
                      <Trans>Failed</Trans>
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="text-[10px]">
                      <Trans>Previewed</Trans>
                    </Badge>
                  )}
                  {row.reference ? (
                    <span className="text-[11.5px] text-muted-foreground">{row.reference}</span>
                  ) : null}
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {row.status === "completed"
                    ? countLine(row.report?.counts) || t`nothing found`
                    : countLine(row.plan?.counts) || t`nothing found`}
                  {row.completedAt ? ` · ${relativeTime(row.completedAt)}` : ""}
                </div>
                {row.error ? (
                  <p className="mt-1 text-[11.5px] leading-snug text-destructive">{row.error}</p>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      )}

      {open && (
        <ErasureDialog
          onClose={() => setOpen(false)}
          onDone={(msg) => {
            setOpen(false);
            pushToast(msg);
            void reload();
          }}
        />
      )}
    </section>
  );
}

/* ── Preview, then confirm ──────────────────────────────────────────────── */
function ErasureDialog({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const { t } = useLingui();
  const [subject, setSubject] = useState<Subject>({ type: "email", value: "" });
  const [mode, setMode] = useState<"anonymize" | "delete">("anonymize");
  const [reference, setReference] = useState("");
  const [preview, setPreview] = useState<ErasureRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ data: ErasureRequest }>("/api/admin/erasure/preview", {
        method: "POST",
        body: JSON.stringify({ subject, mode, reference: reference.trim() || undefined }),
      });
      setPreview(res.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const runErasure = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ data: ErasureRequest }>(`/api/admin/erasure/${preview.id}/run`, {
        method: "POST",
        // The subject travels again: the request row holds only a hash, so
        // this is what proves the second call means the same person.
        body: JSON.stringify({ subject, confirm: true }),
      });
      onDone(
        res.data.mode === "delete"
          ? t`Erasure carried out. The rows are gone.`
          : t`Erasure carried out. Rows were kept with identifying fields scrubbed.`,
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const counts = Object.entries(preview?.plan?.counts ?? {}).filter(([, n]) => n > 0);
  const nothingFound = preview !== null && counts.length === 0;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[min(86vh,760px)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-[540px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            {preview ? <Trans>Confirm erasure</Trans> : <Trans>New erasure request</Trans>}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            {preview ? (
              <Trans>Review what will go. This cannot be undone.</Trans>
            ) : (
              <Trans>Nothing is removed at this step — the preview only counts.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea viewportClassName="max-h-[calc(min(86vh,760px)-10rem)] max-[640px]:max-h-[calc(min(86vh,760px)-15rem)]">
          <div className="flex flex-col gap-3.5 px-5 py-4">
            {!preview ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">
                    <Trans>Identify the person by</Trans>
                  </span>
                  <Select
                    value={subject.type}
                    onChange={(v: string) => setSubject({ type: v as Subject["type"], value: "" })}
                    options={[
                      { value: "email", label: t`Email address` },
                      { value: "app_user", label: t`End-user ID` },
                    ]}
                    className="min-w-0"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">
                    {subject.type === "email" ? <Trans>Email address</Trans> : <Trans>End-user ID</Trans>}
                  </span>
                  <Input
                    placeholder={subject.type === "email" ? "alice@example.com" : t`the user's id`}
                    value={subject.value}
                    onChange={(e) => setSubject((s) => ({ ...s, value: e.target.value }))}
                  />
                  {subject.type === "email" ? (
                    <span className="mt-1 block text-[11px] text-muted-foreground">
                      <Trans>
                        An address with no account still counts — it may appear in a collection.
                      </Trans>
                    </span>
                  ) : null}
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">
                    <Trans>What to do</Trans>
                  </span>
                  <Select
                    value={mode}
                    onChange={(v: string) => setMode(v as "anonymize" | "delete")}
                    options={[
                      { value: "anonymize", label: t`Anonymize — keep rows, scrub who they name` },
                      { value: "delete", label: t`Delete — remove the rows entirely` },
                    ]}
                    className="min-w-0"
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    <Trans>
                      Anonymize is usually the lawful option — an invoice generally cannot be deleted.
                      Revision history goes either way.
                    </Trans>
                  </span>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[11.5px] font-medium">
                    <Trans>Your reference (optional)</Trans>
                  </span>
                  <Input
                    placeholder="DSR-42"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    <Trans>Stored as typed — keep personal data out of it.</Trans>
                  </span>
                </label>
              </>
            ) : (
              <>
                {nothingFound ? (
                  <p className="text-[12.5px] text-muted-foreground">
                    <Trans>Nothing was found for this person. There is nothing to carry out.</Trans>
                  </p>
                ) : (
                  <div className="rounded-control border border-border">
                    {counts.map(([surface, n]) => (
                      <div
                        key={surface}
                        className="flex items-center justify-between border-b border-border px-3 py-2 text-[12.5px] last:border-b-0"
                      >
                        <span className="text-muted-foreground">{surface}</span>
                        <span className="font-medium tabular-nums">{n}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Not a footnote. An operator signing off on a legal request
                    has to know what this does NOT reach. */}
                <div className="rounded-control border border-border bg-muted/40 px-3 py-2.5">
                  <span className="mb-1 block text-[11.5px] font-medium">
                    <Trans>This does not reach</Trans>
                  </span>
                  <ul className="list-disc space-y-1 pl-4 text-[11.5px] leading-snug text-muted-foreground">
                    {(preview.limits ?? []).map((limit) => (
                      <li key={limit}>{limit}</li>
                    ))}
                  </ul>
                </div>
              </>
            )}

            {error ? <p className="text-[12px] leading-snug text-destructive">{error}</p> : null}
          </div>
        </ScrollArea>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          {!preview ? (
            <Button disabled={busy || !subject.value.trim()} onClick={() => void runPreview()}>
              {busy ? <Trans>Checking…</Trans> : <Trans>Preview</Trans>}
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={busy || nothingFound}
              onClick={() => void runErasure()}
            >
              {busy ? <Trans>Erasing…</Trans> : <Trans>Erase permanently</Trans>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
