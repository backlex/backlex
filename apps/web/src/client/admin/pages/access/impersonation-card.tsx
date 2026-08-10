// Impersonation — the audit trail, and the button that starts one.
//
// The card is deliberately shaped as a LOG with an action on it, not as an
// action with a log below. Starting one hands out a working credential for
// somebody else's account; what an operator should see first is that every one
// of these is recorded, by whom, and why.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, EmptyState, relativeTime } from "../../ui";
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
import { Switch } from "../../ui";
import { appUsersApi, impersonationApi, type ApiAppUser, type ApiImpersonation } from "../../api";
import { fetchSafely } from "../_shared";

export function ImpersonationCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiImpersonation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [issued, setIssued] = useState<{ row: ApiImpersonation; token: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: ApiImpersonation[] }>("/api/admin/impersonation");
      if (!live) return;
      setRows(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const start = async (input: { subjectUserId: string; reason: string; readOnly: boolean }) => {
    setStarting(false);
    try {
      const res = await impersonationApi.start(input);
      setRows((prev) => [res.data, ...prev]);
      setIssued({ row: res.data, token: res.token });
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  // Optimistic: snapshot → apply → reconcile → roll back on error.
  const end = async (row: ApiImpersonation) => {
    const snapshot = rows;
    setRows(rows.map((r) => (r.id === row.id ? { ...r, active: false, endedAt: Date.now() } : r)));
    try {
      const res = await impersonationApi.end(row.id);
      setRows((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
      pushToast(t`Ended — the token stops working on its next request.`);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Users size={13} />
        <span className="text-[13px] font-medium">
          <Trans>Impersonation</Trans>
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {rows.filter((r) => r.active).length} {t`live`}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setStarting(true)}>
          <Trans>Act as a user</Trans>
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          See what one of this workspace's end-users sees — their org, their rows, their empty
          states. Read-only unless you say otherwise, capped at an hour, and every one is recorded
          here with the reason given.
        </Trans>
      </div>

      {issued && (
        // A panel, not a toast: this is a working credential for somebody
        // else's account and it is shown once.
        <div className="border-b border-border px-4 py-3">
          <div className="mb-1.5 text-[12px] font-medium">
            <Trans>Send this as an Authorization: Bearer header</Trans>
          </div>
          <div className="font-mono text-[11px] break-all">{issued.token}</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            <Trans>
              Acting as {issued.row.subjectEmail ?? issued.row.subjectUserId} until{" "}
              {new Date(issued.row.expiresAt).toLocaleTimeString()}.
            </Trans>
          </div>
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              <Trans>Done</Trans>
            </Button>
          </div>
        </div>
      )}

      {!loaded ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-4 py-6">
          <EmptyState
            bare
            size="sm"
            icon={I.Users}
            title={<Trans>Nobody has been impersonated</Trans>}
            description={<Trans>When somebody is, it is recorded here — including why.</Trans>}
          />
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
              <div className="min-w-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">
                    {row.subjectEmail ?? row.subjectUserId}
                  </span>
                  {row.active && (
                    <Badge variant="destructive">
                      <Trans>live</Trans>
                    </Badge>
                  )}
                  {!row.readOnly && (
                    // The consequential setting — surface it in the log.
                    <Badge variant="destructive">
                      <Trans>read-write</Trans>
                    </Badge>
                  )}
                </div>
                <div className="truncate text-[11.5px] text-muted-foreground">{row.reason}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.actorEmail ?? row.actorUserId}
                  {row.createdAt ? ` · ${relativeTime(row.createdAt)}` : ""}
                </div>
              </div>
              {row.active && (
                <div className="flex shrink-0 items-center justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => void end(row)}>
                    <Trans>End</Trans>
                  </Button>
                </div>
              )}
            </div>
          </div>
        ))
      )}

      {starting && <StartDialog onClose={() => setStarting(false)} onStart={(v) => void start(v)} />}
    </Card>
  );
}

function StartDialog({
  onClose,
  onStart,
}: {
  onClose: () => void;
  onStart: (v: { subjectUserId: string; reason: string; readOnly: boolean }) => void;
}) {
  const { t } = useLingui();
  const [subjectUserId, setSubjectUserId] = useState("");
  const [reason, setReason] = useState("");
  const [readOnly, setReadOnly] = useState(true);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[520px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>Act as a user</Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              This issues a working credential for their account. It is recorded with your name and
              the reason you give.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <SubjectPicker value={subjectUserId} onChange={setSubjectUserId} />
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Reason`}</span>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t`ticket #4821 — invoices list is empty`}
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                <Trans>
                  Required. A record of who acted as whom, with no why, answers half the question.
                </Trans>
              </span>
            </label>
            <label className="flex items-start gap-2.5">
              <Switch checked={readOnly} onChange={setReadOnly} />
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">
                  <Trans>Read-only</Trans>
                </span>
                <span className="block text-[11.5px] text-muted-foreground">
                  <Trans>
                    Seeing what they see needs reads. Changing their data on their behalf is a
                    different act — turn this off only when that is what you mean.
                  </Trans>
                </span>
              </span>
            </label>
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
          <Button variant="ghost" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            disabled={!subjectUserId.trim() || reason.trim().length < 3}
            onClick={() =>
              onStart({ subjectUserId: subjectUserId.trim(), reason: reason.trim(), readOnly })
            }
          >
            <Trans>Start</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Who to act as, chosen by searching for them.
 *
 * This asked for the raw `app_users.id` and its own hint said "from the App
 * users page" — which is an admission that the one field the whole dialog is
 * about could not be filled in from the dialog. `/api/app-users?q=` already
 * exists and already does email/name substring search (it backs the `user`
 * field interface), so the picker is that endpoint rather than a second way to
 * find a person.
 *
 * The id is still what gets submitted; it is just never typed. It stays visible
 * under the chosen name because an operator reading the audit log afterwards
 * sees ids, and matching the two up is the point.
 */
function SubjectPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (id: string) => void;
}) {
  const { t } = useLingui();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ApiAppUser[]>([]);
  const [chosen, setChosen] = useState<ApiAppUser | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (chosen) return;
    const q = query.trim();
    // Debounced: this fires on every keystroke otherwise, and the endpoint is
    // a LIKE over the workspace's whole end-user pool.
    const timer = setTimeout(() => {
      setSearching(true);
      void appUsersApi
        .list(q ? { q } : undefined)
        .then((r) => setResults(r.data.slice(0, 8)))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, chosen]);

  if (chosen) {
    return (
      <label className="block">
        <span className="mb-1 block text-[11.5px] font-medium">{t`Acting as`}</span>
        <div className="flex items-center gap-2 rounded-surface border border-border px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium">
              {chosen.name || chosen.email}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">{value}</div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setChosen(null);
              onChange("");
            }}
          >
            <Trans>Change</Trans>
          </Button>
        </div>
      </label>
    );
  }

  return (
    <label className="block">
      <span className="mb-1 block text-[11.5px] font-medium">{t`End-user`}</span>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t`Search by email or name`}
      />
      <div className="mt-1.5 flex flex-col gap-1">
        {searching && results.length === 0 ? (
          <Skeleton className="h-8 w-full" />
        ) : results.length === 0 ? (
          <span className="text-[11px] text-muted-foreground">
            <Trans>No end-user matches that. Operators cannot be impersonated.</Trans>
          </span>
        ) : (
          results.map((u) => (
            <button
              key={u.id}
              type="button"
              className="flex items-center gap-2 rounded-surface px-2.5 py-1.5 text-left hover:bg-muted"
              onClick={() => {
                setChosen(u);
                onChange(u.id);
              }}
            >
              <span className="min-w-0 flex-1 truncate text-[12.5px]">
                {u.name ? `${u.name} · ` : ""}
                {u.email}
              </span>
              {u.status === "suspended" && (
                <Badge variant="outline">
                  <Trans>suspended</Trans>
                </Badge>
              )}
            </button>
          ))
        )}
      </div>
    </label>
  );
}
