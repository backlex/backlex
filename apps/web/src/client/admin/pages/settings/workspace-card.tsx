/**
 * Settings › Workspace — the workspace as an object with a lifecycle.
 *
 * Everything else on the Settings page configures things that live *inside* a
 * workspace; this card is about the workspace itself, which is why it sits
 * first in the tab order. It exists because `tenants.name` had no writer
 * anywhere in the server: a workspace was named once, at creation, from a
 * dialog in the sidebar, and a typo in that dialog was permanent. The sidebar
 * header and the workspace switcher then disagreed about what the place was
 * called — the header prefers the Appearance-tab brand name, the switcher shows
 * `tenants.name` — and there was no surface anywhere that could reconcile them.
 *
 * Three shapes here are deliberate:
 *
 *  1. **The slug is shown, not offered.** It keys the physical table namespace
 *     (`c_<tenantPrefix12>_<slug>`) and every later `X-Backlex-Tenant` header
 *     names it, so it is fixed at creation. A read-only field that does not say
 *     why reads as an oversight, so the reason is written next to it rather
 *     than left to the reader.
 *  2. **Writes are optimistic and then reconciled.** The heading paints the new
 *     name before the request resolves and rolls back to the snapshot if the
 *     server refuses. The reconcile afterwards is not ceremony: a PATCH that
 *     answers 2xx while changing nothing is the house failure mode, and reading
 *     the row back through the list endpoint is what would catch it.
 *  3. **Archiving is confirmed with the consequence spelled out.** Archiving is
 *     recoverable — no rows are dropped — but it removes the workspace from
 *     every member's list, not just the actor's, and a confirmation that does
 *     not say so is not informed consent.
 */
import type { PushToast } from "../../types";
import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@/lib/api";
import { I } from "../../icons";
import { Badge, Button, Field, IconButton } from "../../ui";
import { Select } from "../../select";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
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
import { tenantsApi, type ApiTenant } from "../../api";
import { copyText } from "../_shared";

/**
 * A workspace row as this card needs it.
 *
 * `createdAt` / `createdBy` are optional because `GET /api/tenants` is shared
 * with the sidebar switcher, which never needed provenance — a server that has
 * not grown those columns on its response answers without them, and the block
 * that renders them simply does not appear. Guessing a value would be worse
 * than omitting the row: "created by —" is a claim, and an empty section is not.
 */
export type WorkspaceRow = ApiTenant & {
  createdAt?: string | null;
  createdBy?: string | null;
};

/** The fields `PATCH /api/tenants/{id}` accepts. `slug` is refused server-side. */
interface WorkspacePatch {
  name?: string;
  mark?: string | null;
  color?: string | null;
}

const patchWorkspace = (id: string, input: WorkspacePatch) =>
  api<{ ok?: true; data?: WorkspaceRow }>(`/api/tenants/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });

const archiveWorkspace = (id: string) =>
  api<{ ok?: true }>(`/api/tenants/${id}`, { method: "DELETE" });

/**
 * The colours a workspace mark may take.
 *
 * Mirrors the palette `POST /api/tenants` picks from, so a workspace edited
 * here can only land on a value the creator could also have been given. They
 * are theme tokens rather than hex, which is the point — a workspace tile has
 * to stay legible in both themes, and a hand-picked hex does not follow the
 * theme. The custom escape hatch exists for the deployments that brand their
 * workspaces to something outside the palette.
 */
const PALETTE: { value: string; label: string }[] = [
  { value: "var(--primary)", label: "Brand" },
  { value: "var(--chart-1)", label: "Accent 1" },
  { value: "var(--chart-2)", label: "Accent 2" },
  { value: "var(--chart-3)", label: "Accent 3" },
  { value: "var(--chart-4)", label: "Accent 4" },
  { value: "var(--chart-5)", label: "Accent 5" },
];

const CUSTOM = "__custom__";

/** The `default` workspace is the instance's own root and cannot be archived —
 *  the server refuses it, and offering the button anyway would be a trap. */
const ROOT_SLUG = "default";

const formatDate = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const ms = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString();
};

export function WorkspaceCard({
  pushToast,
  onArchived,
}: {
  pushToast: PushToast;
  /** What to do once the workspace is gone. Defaults to a full reload, because
   *  every query still in flight is scoped to a workspace the caller can no
   *  longer reach. Injected so a test does not have to navigate. */
  onArchived?: () => void;
}) {
  const { t } = useLingui();
  // `saved` is what the server is believed to hold; `draft` is what the form
  // shows. They are separate so the heading can paint the optimistic value
  // while the inputs keep the operator's own typing.
  const [saved, setSaved] = useState<WorkspaceRow | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState("");
  const [mark, setMark] = useState("");
  const [color, setColor] = useState("");
  const [customColor, setCustomColor] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const seed = useCallback((row: WorkspaceRow) => {
    setSaved(row);
    setName(row.name);
    setMark(row.mark ?? "");
    setColor(row.color ?? "");
    setCustomColor(row.color != null && !PALETTE.some((p) => p.value === row.color));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await tenantsApi.list();
        if (cancelled) return;
        const rows = res.data as WorkspaceRow[];
        // `active` is the workspace every other request on this page is
        // scoped to, so it is the one being configured. Falling back to the
        // first row keeps the card useful on a server that does not report an
        // active workspace rather than rendering an empty shell.
        const row = rows.find((r) => r.id === res.active) ?? rows[0];
        if (row) seed(row);
      } catch (e) {
        if (!cancelled) pushToast((e as Error).message, "error");
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pushToast, seed]);

  const dirty =
    saved != null &&
    (name.trim() !== saved.name ||
      (mark.trim() || null) !== (saved.mark ?? null) ||
      (color.trim() || null) !== (saved.color ?? null));

  const save = async () => {
    if (!saved) return;
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      pushToast(t`A workspace name needs at least two characters.`, "error");
      return;
    }
    // Snapshot first: this is what a rejection restores. Taking it after the
    // optimistic write would restore the optimistic value, which is the way an
    // "optimistic" update quietly becomes a permanent lie.
    const snapshot = saved;
    const next: WorkspaceRow = {
      ...saved,
      name: trimmed,
      mark: mark.trim() || null,
      color: color.trim() || null,
    };
    setSaved(next);
    setSaving(true);
    try {
      await patchWorkspace(saved.id, {
        name: next.name,
        mark: next.mark,
        color: next.color,
      });
      pushToast(t`Workspace saved.`);
      // Read it back. A 2xx that changed nothing is indistinguishable from a
      // 2xx that changed everything until something re-reads the row, and this
      // page is where a silent no-op would be least visible.
      try {
        const res = await tenantsApi.list();
        const fresh = (res.data as WorkspaceRow[]).find((r) => r.id === snapshot.id);
        if (fresh) seed(fresh);
      } catch {
        // The write succeeded; a failed reconcile is not worth a second toast.
      }
    } catch (e) {
      setSaved(snapshot);
      setName(snapshot.name);
      setMark(snapshot.mark ?? "");
      setColor(snapshot.color ?? "");
      pushToast((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const archive = async () => {
    if (!saved) return;
    setArchiving(true);
    try {
      await archiveWorkspace(saved.id);
      setConfirmOpen(false);
      pushToast(t`Workspace "${saved.name}" archived.`);
      (onArchived ?? (() => window.location.reload()))();
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setArchiving(false);
    }
  };

  if (!loaded) {
    return (
      <Card className="max-w-[920px] gap-4 p-[22px]">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-2/3" />
      </Card>
    );
  }

  if (!saved) {
    return (
      <Card className="max-w-[920px] gap-2 p-[22px]">
        <span className="text-[13px] font-medium">
          <Trans>No workspace to configure</Trans>
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>
            This account is not a member of any workspace yet. Create one from the
            switcher at the top of the sidebar.
          </Trans>
        </span>
      </Card>
    );
  }

  const createdAt = formatDate(saved.createdAt);
  const isRoot = saved.slug === ROOT_SLUG;
  const isOwner = saved.role === "owner";

  return (
    <div className="flex flex-col gap-4">
      <Card className="max-w-[920px] gap-4 p-[22px]">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="ws-mark shrink-0"
            style={{ "--ws-color": saved.color ?? undefined } as CSSProperties}
          >
            {(saved.mark || saved.name.charAt(0)).toUpperCase()}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            {/* The heading reads `saved`, never the input — that is what makes
                the optimistic paint visible at all. */}
            <span className="truncate text-[14px] font-semibold">{saved.name}</span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">
              {saved.project} · {saved.branch} · {saved.env}
            </span>
          </div>
          <div className="ml-auto shrink-0">
            <Badge variant="secondary">{saved.role}</Badge>
          </div>
        </div>

        <Field
          label={t`Name`}
          htmlFor="ws-name"
          hint={t`Shown in the workspace switcher and anywhere this workspace is named. Changing it renames nothing else.`}
        >
          <Input
            id="ws-name"
            value={name}
            maxLength={60}
            disabled={saving}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>

        <Field
          label={t`Address`}
          hint={t`Fixed at creation. The address keys this workspace's physical table namespace — every collection's table name is built from it, and every API request that names a workspace uses it — so changing it would leave those tables addressed by a name nothing resolves.`}
        >
          <div className="flex min-w-0 items-center gap-2 rounded-control border border-border bg-muted px-3 py-2">
            <I.Lock size={13} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 break-all font-mono text-[12.5px]">{saved.slug}</span>
            <IconButton
              icon={I.Copy}
              title={t`Copy address`}
              onClick={() => void copyText(saved.slug, () => pushToast(t`Address copied.`))}
            />
          </div>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t`Mark`} htmlFor="ws-mark" hint={t`One or two letters on the workspace tile.`}>
            <Input
              id="ws-mark"
              value={mark}
              maxLength={2}
              disabled={saving}
              placeholder={saved.name.charAt(0).toUpperCase()}
              onChange={(e) => setMark(e.target.value)}
            />
          </Field>
          <Field label={t`Colour`} hint={t`Tints the workspace tile. Theme tokens stay legible in both light and dark.`}>
            <Select
              className="min-w-0"
              value={customColor ? CUSTOM : color || PALETTE[0]!.value}
              disabled={saving}
              onChange={(v) => {
                if (v === CUSTOM) {
                  setCustomColor(true);
                  return;
                }
                setCustomColor(false);
                setColor(v);
              }}
              options={[
                ...PALETTE.map((p) => ({ value: p.value, label: p.label })),
                { value: CUSTOM, label: t`Custom…` },
              ]}
            />
            {customColor && (
              <Input
                className="mt-1.5"
                value={color}
                disabled={saving}
                placeholder="#7c5cff"
                onChange={(e) => setColor(e.target.value)}
              />
            )}
          </Field>
        </div>

        {(createdAt || saved.createdBy) && (
          <div className="flex flex-col gap-1 border-t border-border pt-3.5 text-[11.5px] text-muted-foreground">
            {saved.createdBy && (
              <span>
                <Trans>Created by</Trans>{" "}
                <span className="font-mono text-foreground">{saved.createdBy}</span>
              </span>
            )}
            {createdAt && (
              <span>
                <Trans>Created</Trans> <span className="text-foreground">{createdAt}</span>
              </span>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-border pt-2.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => seed(saved)}
          >
            <Trans>Discard</Trans>
          </Button>
          {/* Fixed min width so the Save ⇄ Saving… swap doesn't resize the
              button and shift Discard beside it. */}
          <Button
            variant="primary"
            size="sm"
            className="min-w-[5.5rem]"
            disabled={!dirty || saving}
            onClick={() => void save()}
          >
            {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
          </Button>
        </div>
      </Card>

      <Card className="max-w-[920px] gap-3 p-[22px]">
        {/* Column on a phone with the action hugging the right edge, one row
            from `sm` up — the house layout for a section that pairs an
            explanation with a single button. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-2.5">
          <div className="flex items-start gap-2.5">
            <I.Archive size={14} className="mt-0.5 shrink-0" />
            <div className="flex flex-col gap-0.5">
              <span className="text-[13px] font-medium">
                <Trans>Archive this workspace</Trans>
              </span>
              <span className="text-[11.5px] text-muted-foreground">
                {isRoot ? (
                  <Trans>
                    This is the instance's root workspace. It cannot be archived —
                    everything that is not explicitly scoped elsewhere lives here.
                  </Trans>
                ) : isOwner ? (
                  <Trans>
                    Takes the workspace out of circulation without deleting anything.
                    Only an owner can do this.
                  </Trans>
                ) : (
                  <Trans>Only a workspace owner can archive a workspace.</Trans>
                )}
              </span>
            </div>
          </div>
          <div className="hidden flex-1 sm:block" />
          <Button
            variant="destructive"
            size="sm"
            icon={I.Archive}
            className="shrink-0 self-end sm:self-auto"
            disabled={isRoot || !isOwner}
            onClick={() => setConfirmOpen(true)}
          >
            <Trans>Archive…</Trans>
          </Button>
        </div>
      </Card>

      <Dialog open={confirmOpen} onOpenChange={(open) => !archiving && setConfirmOpen(open)}>
        <DialogContent className="max-w-[520px]">
          <DialogHeader>
            <DialogTitle>
              <Trans>Archive this workspace?</Trans>
            </DialogTitle>
            <DialogDescription>
              <Trans>
                Read what this does before confirming — it affects everyone, not
                just you.
              </Trans>
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="flex flex-col gap-3 text-[12.5px]">
              {/* The name is rendered outside the <Trans> on purpose. A
                  translator gets a whole sentence rather than a fragment
                  around a placeholder, and Turkish puts the subject first
                  exactly as English does here. */}
              <div className="flex items-start gap-2.5 rounded-surface border border-border bg-muted p-3">
                <I.AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span className="text-muted-foreground">
                  <b className="text-foreground">{saved.name}</b>{" "}
                  <Trans>
                    disappears from the workspace list of every member, not only
                    yours, and nobody can switch into it or reach its data
                    through the API while it is archived.
                  </Trans>
                </span>
              </div>
              <span className="text-muted-foreground">
                <Trans>
                  Nothing is deleted. The collections, their tables and every row
                  in them stay exactly as they are, and an operator can bring the
                  workspace back.
                </Trans>
              </span>
              <span className="text-muted-foreground">
                <Trans>
                  API keys and integrations that address this workspace stop being
                  answered until it is restored.
                </Trans>
              </span>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={archiving} onClick={() => setConfirmOpen(false)}>
              <Trans>Cancel</Trans>
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="min-w-[9rem]"
              disabled={archiving}
              onClick={() => void archive()}
            >
              {archiving ? <Trans>Archiving…</Trans> : <Trans>Archive workspace</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
