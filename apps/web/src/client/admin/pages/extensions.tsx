// Extensions page — install/enable/remove sandboxed admin add-ons (#13).
// Extensions are npm packages (or direct uploads) shipping a
// `backlex-extension.json` manifest that contributes admin panels, item-form
// field editors, and server-side hooks.
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import { Badge, Button, EmptyState, formatJson, IconButton, PageHeader, Switch } from "../ui";
import { ConfirmDialog } from "../sheet";
import { Select } from "../select";
import { type ApiExtension, type ApiExtensionHookResult, extensionsApi } from "../api";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Tabs, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@backlex/ui/components/table";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@backlex/ui/components/dropdown-menu";
import { Card } from "@backlex/ui/components/card";
import { ExtensionsSkeleton } from "../page-skeletons";

const ADMIN_TABLE_CLS =
  "[&_td]:px-3.5 [&_td]:text-[13px] [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-[0.06em] [&_th]:text-muted-foreground";

const LIST_KEY = ["extensions", "list"] as const;

export function ExtensionsPage({ pushToast }: { pushToast: (m: string, type?: "success" | "error") => void }) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const listQuery = useQuery({ queryKey: LIST_KEY, queryFn: () => extensionsApi.list() });
  const rows = listQuery.data?.data ?? [];
  const [installOpen, setInstallOpen] = useState(false);
  // Extension name pending an uninstall confirmation (null = no dialog open).
  const [confirmUninstall, setConfirmUninstall] = useState<string | null>(null);
  // Names with a reinstall in flight — drives the per-row busy affordance.
  const [reinstalling, setReinstalling] = useState<Set<string>>(new Set());
  // Extension whose "Run hook" dialog is open (null = closed).
  const [runHookExt, setRunHookExt] = useState<ApiExtension | null>(null);

  // Every mutation ends with a shared-prefix invalidate so the sidebar panels
  // + field-editor injection (["extensions","enabled"]) reconcile too.
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["extensions"] });
  };
  const patchList = (fn: (list: ApiExtension[]) => ApiExtension[]) => {
    qc.setQueryData(LIST_KEY, (old: { data: ApiExtension[] } | undefined) =>
      old ? { ...old, data: fn(old.data) } : old,
    );
  };

  // Optimistic toggle — the switch flips instantly, rolls back on error.
  const setEnabled = async (name: string, enabled: boolean) => {
    const snap = qc.getQueryData(LIST_KEY);
    patchList((list) => list.map((x) => (x.name === name ? { ...x, enabled } : x)));
    try {
      await extensionsApi.setEnabled(name, enabled);
      pushToast(enabled ? t`Extension "${name}" enabled.` : t`Extension "${name}" disabled.`);
    } catch (e) {
      qc.setQueryData(LIST_KEY, snap);
      pushToast((e as Error).message, "error");
    } finally {
      invalidate();
    }
  };

  // Optimistic uninstall — the row disappears immediately, restored on error.
  const uninstall = async (name: string) => {
    const snap = qc.getQueryData(LIST_KEY);
    patchList((list) => list.filter((x) => x.name !== name));
    try {
      await extensionsApi.uninstall(name);
      pushToast(t`Extension "${name}" uninstalled.`);
    } catch (e) {
      qc.setQueryData(LIST_KEY, snap);
      pushToast((e as Error).message, "error");
    } finally {
      invalidate();
    }
  };

  // Re-run the npm install to pick up the latest published version. No
  // meaningful optimistic patch exists (the new version is unknown until the
  // registry answers), so this one shows a busy state instead.
  const reinstall = async (ext: ApiExtension) => {
    if (!ext.npmPackage) return;
    setReinstalling((s) => new Set(s).add(ext.name));
    try {
      const r = await extensionsApi.install(ext.npmPackage);
      patchList((list) => list.map((x) => (x.name === ext.name ? r.data : x)));
      pushToast(t`Extension "${ext.name}" updated to v${r.data.version}.`);
    } catch (e) {
      pushToast((e as Error).message, "error");
    } finally {
      setReinstalling((s) => {
        const next = new Set(s);
        next.delete(ext.name);
        return next;
      });
      invalidate();
    }
  };

  // First whole-page fetch — extensions haven't landed yet.
  if (listQuery.isLoading) return <ExtensionsSkeleton />;

  const contributions = (ext: ApiExtension) => {
    const c = ext.manifest?.contributes ?? {};
    const parts: { label: string; count: number }[] = [
      { label: t`panels`, count: c.panels?.length ?? 0 },
      { label: t`field editors`, count: c.fieldEditors?.length ?? 0 },
      { label: t`hooks`, count: c.hooks?.length ?? 0 },
    ];
    const present = parts.filter((p) => p.count > 0);
    if (present.length === 0) return <span className="text-[12px] text-muted-foreground">—</span>;
    return (
      <div className="flex flex-wrap gap-1">
        {present.map((p) => (
          <Badge key={p.label} variant="outline">{p.count} {p.label}</Badge>
        ))}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Extensions`}
        description={t`Installable add-ons — sandboxed panels, field editors, and hooks from npm packages.`}
        actions={<Button variant="primary" icon={I.Plus} onClick={() => setInstallOpen(true)}><Trans>Install extension</Trans></Button>}
      />

      {rows.length === 0 ? (
        // Outside the table on purpose: the header columns force a min table
        // width wider than a phone viewport, so an in-table empty state would
        // center inside the horizontal scroller and hang off-screen.
        <EmptyState
          icon={I.Puzzle}
          title={<Trans>No extensions installed</Trans>}
          description={<Trans>Extensions add sandboxed admin panels, custom field editors, and server hooks. Install any npm package that ships a backlex-extension.json manifest.</Trans>}
          action={<Button variant="primary" icon={I.Plus} onClick={() => setInstallOpen(true)}><Trans>Install extension</Trans></Button>}
        />
      ) : (
      <Card className="py-0 gap-0">
        <Table className={ADMIN_TABLE_CLS}>
          <TableHeader>
            <TableRow>
              <TableHead><Trans>Extension</Trans></TableHead>
              <TableHead className="w-[180px]"><Trans>Source</Trans></TableHead>
              <TableHead><Trans>Contributes</Trans></TableHead>
              <TableHead className="w-[100px]"><Trans>Enabled</Trans></TableHead>
              <TableHead className="sticky right-0 w-11 bg-card" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((ext) => (
              <TableRow key={ext.name}>
                <TableCell>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[13px] font-medium">{ext.manifest?.title || ext.name}</span>
                    <span className="max-w-[320px] truncate font-mono text-[11.5px] text-muted-foreground">
                      {ext.name} · v{ext.version}
                    </span>
                  </div>
                </TableCell>
                <TableCell>
                  {ext.source === "npm" ? (
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <Badge variant="outline" mono>npm</Badge>
                      <span className="max-w-[160px] truncate font-mono text-[11px] text-muted-foreground">{ext.npmPackage}</span>
                    </div>
                  ) : (
                    <Badge variant="outline" mono><Trans>upload</Trans></Badge>
                  )}
                </TableCell>
                <TableCell>{contributions(ext)}</TableCell>
                <TableCell>
                  <Switch checked={ext.enabled} onChange={(next: boolean) => void setEnabled(ext.name, next)} />
                </TableCell>
                <TableCell className="sticky right-0 bg-card text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <IconButton icon={I.More} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => void setEnabled(ext.name, !ext.enabled)}>
                        {ext.enabled ? <><I.Lock size={12} /><Trans>Disable</Trans></> : <><I.Play size={12} /><Trans>Enable</Trans></>}
                      </DropdownMenuItem>
                      {(ext.manifest?.contributes?.hooks?.length ?? 0) > 0 && (
                        <DropdownMenuItem onSelect={() => setRunHookExt(ext)}>
                          <I.Zap size={12} /><Trans>Run hook</Trans>
                        </DropdownMenuItem>
                      )}
                      {ext.source === "npm" && ext.npmPackage && (
                        <DropdownMenuItem
                          disabled={reinstalling.has(ext.name)}
                          onSelect={() => void reinstall(ext)}
                        >
                          <I.Refresh size={12} />
                          {reinstalling.has(ext.name) ? <Trans>Updating…</Trans> : <Trans>Reinstall / upgrade</Trans>}
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setConfirmUninstall(ext.name)}>
                        <I.Trash size={12} /><Trans>Uninstall</Trans>
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
      )}

      {installOpen && (
        <InstallExtensionDialog
          onClose={() => setInstallOpen(false)}
          onInstalled={(installed) => {
            // Reconcile the fresh row into the cache immediately; the settled
            // invalidate re-reads the canonical list (and the enabled feed).
            patchList((list) => [
              ...list.filter((x) => x.name !== installed.name),
              installed,
            ]);
            invalidate();
            setInstallOpen(false);
            pushToast(t`Extension "${installed.name}" installed.`);
          }}
        />
      )}

      {runHookExt && (
        <RunHookDialog ext={runHookExt} onClose={() => setRunHookExt(null)} />
      )}

      <ConfirmDialog
        open={!!confirmUninstall}
        title={confirmUninstall ? <><Trans>Uninstall extension</Trans> <span className="font-mono">{confirmUninstall}</span>?</> : <Trans>Uninstall extension?</Trans>}
        description={t`Its panels, field editors, and hooks stop working immediately. Fields using its editors fall back to the default editor for their type. This can't be undone — reinstall to bring it back.`}
        actionLabel={t`Uninstall extension`}
        destructive
        onCancel={() => setConfirmUninstall(null)}
        onConfirm={() => {
          const name = confirmUninstall;
          setConfirmUninstall(null);
          if (name) void uninstall(name);
        }}
      />
    </div>
  );
}

/** Per-file ceiling for the folder upload — anything bigger is skipped
 *  client-side (matches the server's payload expectations, keeps the dev
 *  loop from posting bundled artifacts). */
const MAX_UPLOAD_FILE_BYTES = 1024 * 1024;

interface UploadSelection {
  files: Record<string, string>;
  count: number;
  skipped: number;
  /** Top-level directory name from webkitRelativePath (display only). */
  folder: string | null;
}

function InstallExtensionDialog({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: (ext: ApiExtension) => void;
}) {
  const { t } = useLingui();
  const [mode, setMode] = useState<"npm" | "upload">("npm");
  const [pkg, setPkg] = useState("");
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  // Folder picked in upload mode — already read into path→content pairs.
  const [upload, setUpload] = useState<UploadSelection | null>(null);
  // True while the picked folder's files are being read in the browser.
  const [reading, setReading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Server-side failure message (AppError envelope) shown inline in the form.
  const [error, setError] = useState<string | null>(null);

  const manifestMissing = mode === "upload" && !!upload && !upload.files["backlex-extension.json"];
  const inlineError =
    error ??
    (manifestMissing ? t`The selected folder has no backlex-extension.json at its root.` : null);

  const valid =
    mode === "npm"
      ? pkg.trim().length > 0
      : !!upload && upload.count > 0 && !manifestMissing && !reading;

  // Read the picked folder into path→content pairs. Paths come from
  // webkitRelativePath with the top-level directory name stripped (falling
  // back to file.name); junk (>1 MB, node_modules/, dotfile paths) is skipped.
  const pickFiles = async (picked: File[]) => {
    setError(null);
    if (picked.length === 0) return;
    setReading(true);
    try {
      const files: Record<string, string> = {};
      let skipped = 0;
      let folder: string | null = null;
      for (const f of picked) {
        const parts = f.webkitRelativePath ? f.webkitRelativePath.split("/") : [];
        if (parts.length > 1 && folder === null) folder = parts[0] ?? null;
        const path = parts.length > 1 ? parts.slice(1).join("/") : f.name;
        if (path.startsWith(".") || path.includes("node_modules/") || f.size > MAX_UPLOAD_FILE_BYTES) {
          skipped += 1;
          continue;
        }
        files[path] = await f.text();
      }
      setUpload({ files, count: Object.keys(files).length, skipped, folder });
    } finally {
      setReading(false);
    }
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r =
        mode === "npm"
          ? await extensionsApi.install(pkg.trim(), version.trim() || undefined)
          : await extensionsApi.upload((upload as UploadSelection).files);
      onInstalled(r.data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[520px]">
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]"><Trans>Install extension</Trans></DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px]">
            {mode === "npm" ? (
              <Trans>Fetched from the npm registry. The package must ship a backlex-extension.json manifest at its root.</Trans>
            ) : (
              <Trans>Upload a local folder — the fast dev loop, no publish needed. The folder must ship a backlex-extension.json manifest at its root.</Trans>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-[18px]">
          <Tabs value={mode} onValueChange={(v) => { setMode(v as "npm" | "upload"); setError(null); }}>
            <TabsList>
              <TabsTrigger value="npm"><Trans>npm registry</Trans></TabsTrigger>
              <TabsTrigger value="upload"><Trans>Upload folder</Trans></TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === "npm" ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>npm package</Trans> <span className="text-destructive">*</span></label>
                <Input
                  className="font-mono"
                  autoFocus
                  placeholder="@acme/backlex-kanban"
                  value={pkg}
                  onChange={(e) => { setPkg(e.target.value); setError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                />
                <span className="text-[11.5px] text-muted-foreground"><Trans>Exact package name as published on npm.</Trans></span>
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Version <span className="text-muted-foreground">(optional)</span></Trans></label>
                <Input
                  className="font-mono"
                  placeholder="1.2.3"
                  value={version}
                  onChange={(e) => { setVersion(e.target.value); setError(null); }}
                  onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
                />
                <span className="text-[11.5px] text-muted-foreground"><Trans>Leave empty for the latest published version.</Trans></span>
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Extension folder</Trans> <span className="text-destructive">*</span></label>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  const picked = e.target.files ? Array.from(e.target.files) : [];
                  // Reset so re-picking the same folder fires onChange again.
                  e.target.value = "";
                  void pickFiles(picked);
                }}
                {...({ webkitdirectory: "" } as Record<string, unknown>)}
              />
              <div>
                <Button
                  variant="outline"
                  icon={I.Folder}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy || reading}
                >
                  {reading ? (
                    <Trans>Reading files…</Trans>
                  ) : upload ? (
                    <Trans>Choose a different folder</Trans>
                  ) : (
                    <Trans>Choose folder…</Trans>
                  )}
                </Button>
              </div>
              {upload && !reading && (
                <span className="text-[11.5px] text-foreground">
                  {upload.folder ? (
                    <Trans>{upload.count} files selected from "{upload.folder}".</Trans>
                  ) : (
                    <Trans>{upload.count} files selected.</Trans>
                  )}
                  {upload.skipped > 0 && <> <Trans>{upload.skipped} skipped.</Trans></>}
                </span>
              )}
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Files are read as text in your browser and sent to the server. Files over 1 MB, dotfiles, and node_modules are skipped.</Trans>
              </span>
            </div>
          )}

          {inlineError && (
            <div className="flex items-start gap-1.5 rounded-control border border-destructive/40 bg-destructive/10 p-2.5 text-[12px] text-destructive">
              <I.AlertTriangle size={13} className="mt-px shrink-0" />
              <span className="min-w-0">{inlineError}</span>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0 border-t border-border bg-card px-5 py-3 sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Cancel</Trans></Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? (
              mode === "npm" ? <Trans>Installing…</Trans> : <Trans>Uploading…</Trans>
            ) : mode === "npm" ? (
              <Trans>Install</Trans>
            ) : (
              <Trans>Upload &amp; install</Trans>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Manual hook invoke — pick one of the extension's hooks, post a JSON
 *  payload, and inspect the SandboxResult (ok/duration, value, error, logs).
 *  Invoking is an action, not a list mutation: the dialog stays open showing
 *  the result and no cache reconciliation happens. */
function RunHookDialog({ ext, onClose }: { ext: ApiExtension; onClose: () => void }) {
  const { t } = useLingui();
  const hooks = ext.manifest?.contributes?.hooks ?? [];
  const [hookId, setHookId] = useState(hooks[0]?.id ?? "");
  const [payload, setPayload] = useState("{}");
  // Client-side JSON validation failure for the payload textarea.
  const [payloadError, setPayloadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Transport/server failure (AppError envelope) — distinct from a hook that
  // ran and returned ok:false, which lands in `result` instead.
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiExtensionHookResult | null>(null);

  const run = async () => {
    if (!hookId || busy) return;
    let parsed: unknown;
    try {
      parsed = payload.trim() === "" ? {} : JSON.parse(payload);
    } catch {
      setPayloadError(t`Payload must be valid JSON.`);
      return;
    }
    setPayloadError(null);
    setError(null);
    setBusy(true);
    try {
      setResult(await extensionsApi.invokeHook(ext.name, hookId, parsed));
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sectionLabelCls = "text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground";

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="w-full gap-0 p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
          <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
            <Trans>Run hook</Trans> <span className="font-mono text-[14px] font-medium">{ext.name}</span>
          </DialogTitle>
          <DialogDescription className="mt-0.5 text-[12.5px]">
            <Trans>Invoke one of this extension's server-side hooks with a JSON payload and inspect the sandbox result.</Trans>
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-4 px-5 py-[18px]">
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Hook</Trans></label>
              <Select
                value={hookId}
                onChange={setHookId}
                options={hooks.map((h) => ({
                  value: h.id,
                  label: `${h.id} · ${h.trigger}`,
                  hint: h.pattern,
                }))}
              />
              <span className="text-[11.5px] text-muted-foreground"><Trans>Event hooks also fire on their matching pattern; running one here executes it once with your payload.</Trans></span>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Payload</Trans></label>
              <Textarea
                className="min-h-[120px] w-full font-mono text-xs whitespace-pre"
                aria-invalid={!!payloadError}
                value={payload}
                onChange={(e) => { setPayload(e.target.value); setPayloadError(null); }}
                spellCheck={false}
              />
              {payloadError ? (
                <div className="flex items-center gap-1 text-[11.5px] text-destructive"><I.AlertTriangle size={11} />{payloadError}</div>
              ) : (
                <span className="text-[11.5px] text-muted-foreground"><Trans>JSON body passed to the hook as its input.</Trans></span>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-1.5 rounded-control border border-destructive/40 bg-destructive/10 p-2.5 text-[12px] text-destructive">
                <I.AlertTriangle size={13} className="mt-px shrink-0" />
                <span className="min-w-0">{error}</span>
              </div>
            )}

            {result && (
              <div className="flex flex-col gap-2.5 rounded-control border border-border bg-[color-mix(in_oklch,var(--muted)_40%,var(--card))] p-3">
                <div className="flex items-center gap-2">
                  <Badge variant={result.ok ? "outline" : "destructive"} mono>
                    {result.ok ? <Trans>ok</Trans> : <Trans>failed</Trans>}
                  </Badge>
                  <span className="font-mono text-[11.5px] text-muted-foreground"><Trans>{result.durationMs} ms</Trans></span>
                </div>
                {result.error && (
                  <div className="flex flex-col gap-1">
                    <span className={sectionLabelCls}><Trans>Error</Trans></span>
                    <pre className="m-0 whitespace-pre-wrap font-mono text-xs text-destructive [word-break:break-word]">{result.error}</pre>
                  </div>
                )}
                {result.value !== undefined && (
                  <div className="flex flex-col gap-1">
                    <span className={sectionLabelCls}><Trans>Value</Trans></span>
                    <pre className="m-0 whitespace-pre-wrap font-mono text-xs [word-break:break-word]">{formatJson(result.value)}</pre>
                  </div>
                )}
                {result.logs.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className={sectionLabelCls}><Trans>Logs</Trans></span>
                    <div className="flex flex-col gap-0.5">
                      {result.logs.map((line, i) => (
                        <span key={i} className="whitespace-pre-wrap font-mono text-xs text-muted-foreground [word-break:break-word]">{line}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-border bg-card px-5 py-3 sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={busy}><Trans>Close</Trans></Button>
          <Button variant="primary" onClick={() => void run()} disabled={!hookId || busy}>
            {busy ? <Trans>Running…</Trans> : <Trans>Run</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
