// Public forms page — build embeddable, unauthenticated forms that write
// submissions into a collection. The token is shown exactly once (create /
// rotate); the list can only re-link via rotation. Mutations are optimistic:
// snapshot → apply → await → reconcile, rollback + toast on error.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../icons";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  PageHeader,
  Switch,
} from "../ui";
import { Select } from "../select";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Checkbox } from "@backlex/ui/components/checkbox";
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
import { ConfirmDialog } from "../sheet";
import {
  collectionsApi,
  formsApi,
  type ApiForm,
  type ApiFormEligibleField,
  type ApiFormFieldConfig,
} from "../api";

interface EditState {
  id: string | null; // null = new
  name: string;
  collection: string;
  fields: ApiFormFieldConfig[];
  submitLabel: string;
  successMessage: string;
  redirectUrl: string;
  turnstile: boolean;
  active: boolean;
}

const blank = (): EditState => ({
  id: null,
  name: "",
  collection: "",
  fields: [],
  submitLabel: "",
  successMessage: "",
  redirectUrl: "",
  turnstile: false,
  active: true,
});

const fromForm = (f: ApiForm): EditState => ({
  id: f.id,
  name: f.name,
  collection: f.collection,
  fields: f.fields,
  submitLabel: f.settings?.submitLabel ?? "",
  successMessage: f.settings?.successMessage ?? "",
  redirectUrl: f.settings?.redirectUrl ?? "",
  turnstile: f.settings?.turnstile ?? false,
  active: f.active,
});

const toInput = (e: EditState) => ({
  name: e.name.trim(),
  collection: e.collection,
  fields: e.fields,
  settings: {
    ...(e.submitLabel.trim() ? { submitLabel: e.submitLabel.trim() } : {}),
    ...(e.successMessage.trim() ? { successMessage: e.successMessage.trim() } : {}),
    ...(e.redirectUrl.trim() ? { redirectUrl: e.redirectUrl.trim() } : {}),
    ...(e.turnstile ? { turnstile: true } : {}),
  },
  active: e.active,
});

/** One-time token payload shown right after create / rotate. */
interface TokenReveal {
  formName: string;
  url: string;
  embedUrl: string;
}

function TokenRevealDialog({
  reveal,
  onClose,
  pushToast,
}: {
  reveal: TokenReveal | null;
  onClose: () => void;
  pushToast: (m: string) => void;
}) {
  const { t } = useLingui();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const absolute = `${origin}${reveal?.url ?? ""}`;
  const iframe = `<iframe src="${origin}${reveal?.embedUrl ?? ""}" width="100%" height="600" frameborder="0"></iframe>`;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast(t`Copied.`);
    } catch {
      pushToast(t`Copy failed — select and copy manually.`);
    }
  };
  return (
    <Dialog open={!!reveal} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle><Trans>Form link ready</Trans></DialogTitle>
          <DialogDescription>
            <Trans>This link is shown once — rotating the token later replaces it and
            kills the old one.</Trans>
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3.5 py-1">
          <div className="flex flex-col gap-1 text-[12.5px] font-medium">
            <Trans>Public link</Trans>
            <div className="flex items-center gap-1.5">
              <Input readOnly value={absolute} className="font-mono text-[12px]" />
              <IconButton icon={I.Copy} title={t`Copy link`} onClick={() => void copy(absolute)} />
            </div>
          </div>
          <div className="flex flex-col gap-1 text-[12.5px] font-medium">
            <Trans>Embed snippet</Trans>
            <div className="flex items-start gap-1.5">
              <Textarea readOnly rows={3} value={iframe} className="font-mono text-[11.5px]" />
              <IconButton icon={I.Copy} title={t`Copy embed snippet`} onClick={() => void copy(iframe)} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="primary" onClick={onClose}><Trans>Done</Trans></Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function FormsPage({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [forms, setForms] = useState<ApiForm[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [collections, setCollections] = useState<{ slug: string }[]>([]);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [eligible, setEligible] = useState<ApiFormEligibleField[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState<TokenReveal | null>(null);
  const [confirm, setConfirm] = useState<
    | { kind: "delete"; form: ApiForm }
    | { kind: "rotate"; form: ApiForm }
    | null
  >(null);

  const reload = async () => {
    try {
      const r = await formsApi.list();
      setForms(r.data ?? []);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  useEffect(() => {
    void Promise.all([
      reload(),
      collectionsApi
        .list()
        .then((r) => setCollections(r.data.map((c) => ({ slug: c.slug }))))
        .catch(() => setCollections([])),
    ]).finally(() => setLoaded(true));
  }, []);

  // The field picker re-fetches whenever the edit dialog's collection changes.
  useEffect(() => {
    if (!edit?.collection) {
      setEligible([]);
      return;
    }
    let cancelled = false;
    setEligibleLoading(true);
    formsApi
      .eligibleFields(edit.collection)
      .then((r) => {
        if (!cancelled) setEligible(r.data);
      })
      .catch((e) => {
        if (!cancelled) {
          setEligible([]);
          pushToast((e as Error).message);
        }
      })
      .finally(() => {
        if (!cancelled) setEligibleLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edit?.collection]);

  const save = async () => {
    if (!edit) return;
    if (!edit.name.trim()) { pushToast(t`Name is required.`); return; }
    if (!edit.collection) { pushToast(t`Pick a collection.`); return; }
    if (edit.fields.length === 0) { pushToast(t`Pick at least one field.`); return; }

    const input = toInput(edit);
    setSaving(true);
    if (edit.id) {
      // Optimistic update: patch the row, close the dialog, reconcile after.
      const snapshot = forms;
      setForms((prev) =>
        prev.map((f) => (f.id === edit.id ? { ...f, ...input, settings: input.settings } : f)),
      );
      setEdit(null);
      try {
        await formsApi.update(edit.id, input);
        void reload();
      } catch (e) {
        setForms(snapshot);
        pushToast((e as Error).message);
      } finally {
        setSaving(false);
      }
    } else {
      // Create must wait for the response — it carries the one-time token.
      try {
        const r = await formsApi.create(input);
        setForms((prev) => [r.data.form, ...prev]);
        setEdit(null);
        setReveal({ formName: r.data.form.name, url: r.data.url, embedUrl: r.data.embedUrl });
      } catch (e) {
        pushToast((e as Error).message);
      } finally {
        setSaving(false);
      }
    }
  };

  const toggleActive = async (form: ApiForm) => {
    const snapshot = forms;
    setForms((prev) => prev.map((f) => (f.id === form.id ? { ...f, active: !f.active } : f)));
    try {
      await formsApi.update(form.id, { active: !form.active });
    } catch (e) {
      setForms(snapshot);
      pushToast((e as Error).message);
    }
  };

  const doDelete = async (form: ApiForm) => {
    const snapshot = forms;
    setForms((prev) => prev.filter((f) => f.id !== form.id));
    setConfirm(null);
    try {
      await formsApi.remove(form.id);
    } catch (e) {
      setForms(snapshot);
      pushToast((e as Error).message);
    }
  };

  const doRotate = async (form: ApiForm) => {
    setConfirm(null);
    try {
      const r = await formsApi.rotateToken(form.id);
      setReveal({ formName: form.name, url: r.data.url, embedUrl: r.data.embedUrl });
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const toggleField = (name: string) => {
    if (!edit) return;
    const has = edit.fields.some((f) => f.name === name);
    setEdit({
      ...edit,
      fields: has
        ? edit.fields.filter((f) => f.name !== name)
        : [...edit.fields, { name }],
    });
  };

  const patchField = (name: string, patch: Partial<ApiFormFieldConfig>) => {
    if (!edit) return;
    setEdit({
      ...edit,
      fields: edit.fields.map((f) => (f.name === name ? { ...f, ...patch } : f)),
    });
  };

  const collectionOptions = useMemo(
    () => collections.map((c) => ({ value: c.slug, label: c.slug })),
    [collections],
  );

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Forms`}
        description={t`Public, embeddable forms that write submissions into a collection — share a link or drop the iframe into any site.`}
        actions={
          <div className="flex items-center gap-2">
            <IconButton icon={I.Refresh} title={t`Refresh`} onClick={() => void reload()} />
            <Button variant="primary" icon={I.Plus} onClick={() => setEdit(blank())}>
              <Trans>New form</Trans>
            </Button>
          </div>
        }
      />

      <Card className="py-0 gap-0">
        {!loaded ? (
          <div className="flex flex-col">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0">
                <Skeleton className="h-4 w-44" />
                <Skeleton className="h-4 w-28" />
                <Skeleton className="ml-auto h-5 w-9 rounded-full" />
              </div>
            ))}
          </div>
        ) : forms.length === 0 ? (
          <EmptyState
            size="md"
            icon={I.Inbox}
            title={<Trans>No forms yet</Trans>}
            description={<Trans>Create a form to collect submissions from visitors — no account or code required on their side.</Trans>}
          />
        ) : (
          <ScrollArea viewportClassName="max-h-[calc(100vh-16rem)]" className="w-full">
            <div className="min-w-[680px]">
              <div className="grid grid-cols-[1fr_150px_80px_90px_130px] items-center gap-3 border-b border-border px-3.5 py-2.5 text-[11.5px] font-medium text-muted-foreground">
                <span><Trans>Form</Trans></span>
                <span><Trans>Collection</Trans></span>
                <span><Trans>Fields</Trans></span>
                <span><Trans>Active</Trans></span>
                <span className="text-right"><Trans>Actions</Trans></span>
              </div>
              {forms.map((f) => (
                <div
                  key={f.id}
                  className="grid grid-cols-[1fr_150px_80px_90px_130px] items-center gap-3 border-b border-border px-3.5 py-[11px] text-[13px] last:border-b-0 hover:bg-accent/40"
                >
                  <button type="button" onClick={() => setEdit(fromForm(f))} className="min-w-0 text-left hover:underline">
                    <div className="truncate font-medium">{f.name}</div>
                    {f.settings?.turnstile && (
                      <div className="text-[11px] text-muted-foreground"><Trans>Turnstile on</Trans></div>
                    )}
                  </button>
                  <span className="truncate font-mono text-[12px] text-muted-foreground">{f.collection}</span>
                  <span className="font-mono text-[12px] text-muted-foreground">{f.fields.length}</span>
                  <span>
                    <Switch checked={f.active} onChange={() => void toggleActive(f)} />
                  </span>
                  <span className="flex items-center justify-end gap-1">
                    <IconButton icon={I.Refresh} title={t`Rotate link`} onClick={() => setConfirm({ kind: "rotate", form: f })} />
                    <IconButton icon={I.Pencil} title={t`Edit`} onClick={() => setEdit(fromForm(f))} />
                    <IconButton icon={I.Trash} title={t`Delete`} onClick={() => setConfirm({ kind: "delete", form: f })} />
                  </span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </Card>

      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent className="max-w-xl flex flex-col overflow-hidden max-h-[85vh] [&>*]:min-w-0">
          <DialogHeader className="shrink-0">
            <DialogTitle>{edit?.id ? <Trans>Edit form</Trans> : <Trans>New form</Trans>}</DialogTitle>
            <DialogDescription>
              <Trans>Only scalar fields can be exposed. Submissions run the collection's
              validation and land as drafts on versioned collections.</Trans>
            </DialogDescription>
          </DialogHeader>
          {edit && (
            <ScrollArea viewportClassName="max-h-[calc(85vh-13rem)] max-[640px]:max-h-[calc(85vh-15rem)] [&>div]:!block">
              <div className="flex flex-col gap-3.5 overflow-x-clip px-0.5 py-1">
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Name</Trans>
                  <Input
                    value={edit.name}
                    placeholder={t`Contact us`}
                    onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Collection</Trans>
                  <Select
                    value={edit.collection}
                    onChange={(v) => setEdit({ ...edit, collection: v, fields: [] })}
                    options={collectionOptions}
                    placeholder={t`Pick a collection…`}
                  />
                  <span className="text-[11.5px] font-normal text-muted-foreground">
                    <Trans>Where submissions are stored.</Trans>
                  </span>
                </label>

                {edit.collection && (
                  <div className="flex flex-col gap-1.5 text-[12.5px] font-medium">
                    <Trans>Fields</Trans>
                    {eligibleLoading ? (
                      <div className="flex flex-col gap-2">
                        <Skeleton className="h-8 w-full" />
                        <Skeleton className="h-8 w-full" />
                      </div>
                    ) : eligible.length === 0 ? (
                      <span className="text-[12px] font-normal text-muted-foreground">
                        <Trans>This collection has no form-eligible fields (only scalar,
                        non-private fields can be exposed).</Trans>
                      </span>
                    ) : (
                      <div className="flex flex-col rounded-surface border border-border">
                        {eligible.map((ef) => {
                          const selected = edit.fields.find((f) => f.name === ef.name);
                          return (
                            <div key={ef.name} className="flex flex-col gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
                              <label className="flex items-center gap-2.5 text-[13px] font-normal">
                                <Checkbox
                                  checked={!!selected}
                                  onCheckedChange={() => toggleField(ef.name)}
                                />
                                <span className="font-mono text-[12.5px]">{ef.name}</span>
                                <span className="text-[11px] text-muted-foreground">{ef.type}</span>
                                {ef.required && <Badge variant="outline"><Trans>required</Trans></Badge>}
                              </label>
                              {selected && (
                                <div className="grid grid-cols-2 gap-2 pl-6 max-[520px]:grid-cols-1">
                                  <Input
                                    value={selected.label ?? ""}
                                    placeholder={t`Label override`}
                                    onChange={(e) => patchField(ef.name, { label: e.target.value || undefined })}
                                  />
                                  <Input
                                    value={selected.help ?? ""}
                                    placeholder={t`Help text`}
                                    onChange={(e) => patchField(ef.name, { help: e.target.value || undefined })}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Submit button label</Trans>
                  <Input
                    value={edit.submitLabel}
                    placeholder={t`Submit`}
                    onChange={(e) => setEdit({ ...edit, submitLabel: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Success message</Trans>
                  <Input
                    value={edit.successMessage}
                    placeholder={t`Thanks — we got it!`}
                    onChange={(e) => setEdit({ ...edit, successMessage: e.target.value })}
                  />
                </label>
                <label className="flex flex-col gap-1 text-[12.5px] font-medium">
                  <Trans>Redirect URL (optional)</Trans>
                  <Input
                    value={edit.redirectUrl}
                    placeholder="https://example.com/thanks"
                    onChange={(e) => setEdit({ ...edit, redirectUrl: e.target.value })}
                  />
                  <span className="text-[11.5px] font-normal text-muted-foreground">
                    <Trans>Sends the visitor here after submitting, instead of the message.</Trans>
                  </span>
                </label>
                <label className="flex items-center justify-between gap-2 text-[12.5px] font-medium">
                  <span className="flex flex-col">
                    <Trans>Turnstile spam protection</Trans>
                    <span className="text-[11.5px] font-normal text-muted-foreground">
                      <Trans>Needs TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY on the server.</Trans>
                    </span>
                  </span>
                  <Switch checked={edit.turnstile} onChange={(v) => setEdit({ ...edit, turnstile: v })} />
                </label>
                <label className="flex items-center justify-between gap-2 text-[12.5px] font-medium">
                  <Trans>Active</Trans>
                  <Switch checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} />
                </label>
              </div>
            </ScrollArea>
          )}
          <DialogFooter className="shrink-0">
            <Button variant="ghost" onClick={() => setEdit(null)}><Trans>Cancel</Trans></Button>
            <Button variant="primary" disabled={saving} onClick={() => void save()}>
              {saving ? <Trans>Saving…</Trans> : edit?.id ? <Trans>Save form</Trans> : <Trans>Create form</Trans>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TokenRevealDialog reveal={reveal} onClose={() => setReveal(null)} pushToast={pushToast} />

      <ConfirmDialog
        open={confirm?.kind === "delete"}
        title={t`Delete this form?`}
        description={t`The public link stops working immediately. Submitted rows stay in the collection.`}
        actionLabel={t`Delete form`}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void doDelete(confirm.form)}
      />
      <ConfirmDialog
        open={confirm?.kind === "rotate"}
        title={t`Rotate the form link?`}
        description={t`The current link stops working immediately and a new one is generated. Anywhere the old link is embedded must be updated.`}
        actionLabel={t`Rotate link`}
        onCancel={() => setConfirm(null)}
        onConfirm={() => confirm && void doRotate(confirm.form)}
      />
    </div>
  );
}
