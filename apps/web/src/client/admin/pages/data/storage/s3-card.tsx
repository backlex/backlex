// S3-endpoint credentials.
//
// The card exists to do one thing well: hand over a credential and the exact
// command to use it. The secret appears once, in a panel that stays until the
// operator dismisses it, because there is no read-back path — a toast would be
// the wrong shape for a value they cannot recover.
import type { PushToast } from "../../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../../icons";
import { Badge, Button, EmptyState, Switch } from "../../../ui";
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
import { s3Api, type ApiS3Credential } from "../../../api";
import { fetchSafely } from "../../_shared";

export function S3Card({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiS3Credential[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [minted, setMinted] = useState<{ row: ApiS3Credential; secret: string } | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: ApiS3Credential[] }>("/api/admin/s3-credentials");
      if (!live) return;
      setRows(res?.data ?? []);
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Optimistic: snapshot → apply → reconcile → roll back on error.
  const toggle = async (row: ApiS3Credential, enabled: boolean) => {
    const snapshot = rows;
    setRows(rows.map((r) => (r.id === row.id ? { ...r, enabled } : r)));
    try {
      const res = await s3Api.update(row.id, { enabled });
      setRows((prev) => prev.map((r) => (r.id === row.id ? res.data : r)));
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const remove = async (row: ApiS3Credential) => {
    const snapshot = rows;
    setRows(rows.filter((r) => r.id !== row.id));
    try {
      await s3Api.remove(row.id);
      pushToast(t`Credential deleted — anything using it stops working now.`);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const create = async (input: { name: string; prefix: string; readOnly: boolean }) => {
    setCreating(false);
    try {
      const res = await s3Api.create({
        name: input.name,
        prefix: input.prefix || null,
        readOnly: input.readOnly,
      });
      setRows((prev) => [...prev, res.data]);
      setMinted({ row: res.data, secret: res.secretAccessKey });
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.Key size={13} />
        <span className="text-[13px] font-medium">
          <Trans>S3-compatible access</Trans>
        </span>
        <span className="font-mono text-[11.5px] text-muted-foreground">
          {rows.length} {rows.length === 1 ? t`credential` : t`credentials`}
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" icon={I.Plus} onClick={() => setCreating(true)}>
          <Trans>New credential</Trans>
        </Button>
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          Point rclone, aws-cli, mc or any backup tool at this workspace's objects. The bucket name
          is the workspace slug, and objects written this way appear in the browser above.
        </Trans>
      </div>

      {minted && (
        // Deliberately a panel, not a toast: there is no read-back path, so
        // this value has to stay on screen until the operator dismisses it.
        <div className="border-b border-border px-4 py-3">
          <div className="mb-1.5 text-[12px] font-medium">
            <Trans>Copy the secret now — it is not shown again</Trans>
          </div>
          <div className="flex flex-col gap-1 font-mono text-[11.5px]">
            <div className="break-all">
              <span className="text-muted-foreground">access key id: </span>
              {minted.row.accessKeyId}
            </div>
            <div className="break-all">
              <span className="text-muted-foreground">secret: </span>
              {minted.secret}
            </div>
          </div>
          <div className="mt-2 flex justify-end">
            <Button size="sm" variant="ghost" onClick={() => setMinted(null)}>
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
            icon={I.Key}
            title={<Trans>No S3 credentials</Trans>}
            description={
              <Trans>Mint one to use this workspace as a bucket from any S3 tool.</Trans>
            }
          />
        </div>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="border-b border-border px-3.5 py-3 last:border-b-0">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
              <div className="min-w-0 sm:flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium">{row.name}</span>
                  {row.readOnly ? (
                    <Badge variant="default">
                      <Trans>read-only</Trans>
                    </Badge>
                  ) : (
                    // The consequential setting: this one can delete.
                    <Badge variant="destructive">
                      <Trans>read-write</Trans>
                    </Badge>
                  )}
                  {row.prefix && <Badge variant="outline">{row.prefix}</Badge>}
                </div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {row.accessKeyId}
                </div>
              </div>
              <div className="flex shrink-0 items-center justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => void remove(row)}>
                  <Trans>Delete</Trans>
                </Button>
                <Switch checked={row.enabled} onChange={(v) => void toggle(row, v)} />
              </div>
            </div>
          </div>
        ))
      )}

      {creating && <S3Dialog onClose={() => setCreating(false)} onSave={(v) => void create(v)} />}
    </Card>
  );
}

function S3Dialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (v: { name: string; prefix: string; readOnly: boolean }) => void;
}) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [prefix, setPrefix] = useState("");
  // Read-only by default: the common case is a backup or sync tool, and the
  // wider grant should be the one the operator asks for.
  const [readOnly, setReadOnly] = useState(true);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[520px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border px-5 pt-5 pb-3.5 text-left">
          <DialogTitle className="text-[15px] font-semibold -tracking-[0.01em]">
            <Trans>New S3 credential</Trans>
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-muted-foreground">
            <Trans>
              The secret is shown once and cannot be read back. Unlike an API key it has to be
              stored rather than hashed, so scope it as narrowly as the tool allows.
            </Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-3.5 px-5 py-4">
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Name`}</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="nightly-backup"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11.5px] font-medium">{t`Key prefix`}</span>
              <Input
                className="font-mono"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="backups/"
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                <Trans>
                  Leave blank for the whole workspace. A scoped credential cannot see or write
                  outside its prefix, listings included.
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
                  <Trans>Refuses every write and delete. What a backup tool should hold.</Trans>
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
            disabled={!name.trim()}
            onClick={() => onSave({ name: name.trim(), prefix: prefix.trim(), readOnly })}
          >
            <Trans>Create</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
