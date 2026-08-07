// @ts-nocheck
import type { PushToast } from "../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Badge } from "@backlex/ui/components/badge";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Switch } from "@backlex/ui/components/switch";
import { Textarea } from "@backlex/ui/components/textarea";
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
import { documentsApi, signaturesApi, type ApiSignatureRequest } from "../api";
import { SignaturesSkeleton } from "../page-skeletons";

/**
 * Signature requests — what has been sent out, who has signed, and what is
 * stuck.
 *
 * A list, not an editor: the document itself is authored on the *Document
 * templates* page, and by the time a request exists its contents are frozen.
 * So the page answers the three questions an operator actually has — has it
 * been signed, can I chase it, can I get the signed copy.
 *
 * The signing links appear exactly once, right after sending. Only their
 * hashes are stored, so this dialog is the only chance to copy one; every
 * later action mints a fresh link instead of showing the old one.
 */

const STATUS_TONE: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "secondary",
  completed: "default",
  declined: "destructive",
  voided: "outline",
  expired: "outline",
};

const stamp = (value: unknown): string => {
  if (value == null) return "—";
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "—";
};

/** One `email:name:role` line per signer, which is also what the CLI takes —
 *  a repeated three-field sub-form for what is usually one address would be
 *  more chrome than content. */
const parseSigners = (raw: string): Array<{ email: string; name?: string; role?: string }> =>
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [email, name, ...role] = line.split(":");
      return {
        email: (email ?? "").trim(),
        ...(name?.trim() ? { name: name.trim() } : {}),
        ...(role.join(":").trim() ? { role: role.join(":").trim() } : {}),
      };
    });

export function SignaturesPage({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [rows, setRows] = useState<ApiSignatureRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Send dialog state.
  const [templates, setTemplates] = useState<{ value: string; label: string }[]>([]);
  const [templateKey, setTemplateKey] = useState("");
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [signersRaw, setSignersRaw] = useState("");
  const [varsRaw, setVarsRaw] = useState('{\n  "data": {}\n}');
  const [ordered, setOrdered] = useState(false);
  const [expiresInDays, setExpiresInDays] = useState("30");
  const [links, setLinks] = useState<Array<{ email: string; url: string }> | null>(null);

  const load = async (next = status) => {
    const res = await signaturesApi.list(next || undefined);
    setRows((res.data ?? []) as ApiSignatureRequest[]);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await signaturesApi.list();
        if (!cancelled) setRows((res.data ?? []) as ApiSignatureRequest[]);
      } catch {
        // leave the list empty; the page still offers "Send for signature"
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sendOpen) return;
    void (async () => {
      try {
        const res = await documentsApi.list();
        setTemplates((res.data ?? []).map((tpl) => ({ value: tpl.key, label: tpl.name || tpl.key })));
      } catch {
        setTemplates([]);
      }
    })();
  }, [sendOpen]);

  const onFilter = async (next: string) => {
    setStatus(next);
    try {
      await load(next);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onSend = async () => {
    const signers = parseSigners(signersRaw);
    if (!templateKey) {
      pushToast(t`Pick the document to send.`);
      return;
    }
    if (signers.length === 0) {
      pushToast(t`Add at least one signer.`);
      return;
    }
    let vars: Record<string, unknown> = {};
    try {
      vars = JSON.parse(varsRaw);
    } catch {
      pushToast(t`Row data must be valid JSON.`);
      return;
    }
    setBusy(true);
    try {
      const res = await signaturesApi.create({
        templateKey,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
        vars,
        signers,
        ordered,
        ...(Number(expiresInDays) > 0 ? { expiresInDays: Number(expiresInDays) } : {}),
      });
      // Optimistic in the direction that matters: the new request is on the
      // list before the refetch, so the page never looks like nothing happened.
      setRows((arr) => [res.data.request as ApiSignatureRequest, ...arr]);
      setLinks(res.data.links.map((l) => ({ email: l.email, url: l.url })));
      setSignersRaw("");
      void load().catch(() => {});
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onVoid = async (row: ApiSignatureRequest) => {
    const snapshot = rows;
    setRows((arr) => arr.map((r) => (r.id === row.id ? { ...r, status: "voided" } : r)));
    try {
      await signaturesApi.void(row.id);
      pushToast(t`Cancelled — every outstanding link is now dead.`);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const onResend = async (row: ApiSignatureRequest, signerId: string) => {
    const snapshot = rows;
    setRows((arr) =>
      arr.map((r) =>
        r.id === row.id
          ? { ...r, signers: r.signers.map((s) => (s.id === signerId ? { ...s, sentAt: Date.now() } : s)) }
          : r,
      ),
    );
    try {
      const res = await signaturesApi.resend(row.id, signerId);
      pushToast(
        res.data.sent
          ? t`A fresh link is on its way to ${res.data.email} — the previous one is dead.`
          : t`Could not send to ${res.data.email}.`,
      );
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const onDownload = async (row: ApiSignatureRequest) => {
    try {
      const which = row.signedDocumentKey ? "signed" : "original";
      const blob = await signaturesApi.document(row.id, which);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      // Revoked on a delay: the new tab still has to fetch it, and revoking
      // first opens a blank window.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };

  const onFinalize = async (row: ApiSignatureRequest) => {
    const snapshot = rows;
    setRows((arr) => arr.map((r) => (r.id === row.id ? { ...r, status: "completed" } : r)));
    try {
      const res = await signaturesApi.finalize(row.id);
      setRows((arr) => arr.map((r) => (r.id === row.id ? (res.data as ApiSignatureRequest) : r)));
      pushToast(t`The signed copy has been produced.`);
    } catch (e) {
      setRows(snapshot);
      pushToast((e as Error).message);
    }
  };

  const closeSend = () => {
    setSendOpen(false);
    setLinks(null);
  };

  if (!loaded) return <SignaturesSkeleton />;

  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={t`Signatures`}
        description={
          <Trans>
            A document template sent out to be signed. The copy is frozen when it goes — editing the
            template afterwards never changes what somebody already read.
          </Trans>
        }
        actions={
          <div className="flex items-center gap-2">
            {/* `size="sm"` matches the h-8 the admin `Button` defaults to — a
                default-size Select is h-9 and sits a pixel proud of every
                button beside it. */}
            <Select
              size="sm"
              value={status}
              onChange={onFilter}
              options={[
                { value: "", label: t`All` },
                { value: "pending", label: t`Awaiting signature` },
                { value: "completed", label: t`Signed` },
                { value: "declined", label: t`Declined` },
                { value: "expired", label: t`Expired` },
                { value: "voided", label: t`Cancelled` },
              ]}
              className="min-w-0 max-sm:w-[150px]"
            />
            <Button variant="primary" size="sm" icon={I.Plus} onClick={() => setSendOpen(true)}>
              <Trans>Send for signature</Trans>
            </Button>
          </div>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          icon={I.Signature}
          title={<Trans>Nothing out for signature</Trans>}
          description={
            <Trans>
              Send a document template to one or more signers. The copy is frozen the moment it
              goes out, and each signer gets their own single-use link.
            </Trans>
          }
          action={
            <Button variant="primary" icon={I.Plus} onClick={() => setSendOpen(true)}>
              <Trans>Send for signature</Trans>
            </Button>
          }
        />
      ) : (
      <Card className="gap-0 py-0">
        {rows.map((row) => {
          const signed = row.signers.filter((s) => s.status === "signed").length;
          const allSigned = row.signers.length > 0 && signed === row.signers.length;
          const expanded = open === row.id;
          return (
            <div key={row.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                className="flex w-full items-center gap-3 px-3.5 py-3 text-left hover:bg-accent/60"
                onClick={() => setOpen(expanded ? null : row.id)}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{row.title}</div>
                  <div className="truncate text-[11.5px] text-muted-foreground">
                    <Trans>
                      {signed} of {row.signers.length} signed
                    </Trans>
                    {" · "}
                    {row.ordered ? <Trans>sequential</Trans> : <Trans>any order</Trans>}
                  </div>
                </div>
                <Badge variant={STATUS_TONE[row.status] ?? "secondary"}>{row.status}</Badge>
                <I.ChevronDown
                  className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                    expanded ? "rotate-180" : ""
                  }`}
                />
              </button>

              {expanded && (
                <div className="flex flex-col gap-3 border-t border-border bg-muted/30 px-3.5 py-3">
                  <div className="flex flex-col gap-2">
                    {row.signers.map((s) => (
                      <div key={s.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{s.name || s.email}</span>
                          {s.role ? (
                            <span className="text-muted-foreground"> · {s.role}</span>
                          ) : null}
                          <span className="block truncate text-[11px] text-muted-foreground">
                            {s.email}
                            {s.status === "signed" ? ` · ${stamp(s.signedAt)}` : ""}
                            {s.status === "signed" && s.ip ? ` · ${s.ip}` : ""}
                          </span>
                        </span>
                        <Badge variant={s.status === "signed" ? "default" : "secondary"}>{s.status}</Badge>
                        {row.status === "pending" && s.status !== "signed" && s.status !== "declined" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={I.Send}
                            onClick={() => onResend(row, s.id)}
                          >
                            <Trans>Resend</Trans>
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>

                  {row.voidReason ? (
                    <div className="text-[11.5px] text-muted-foreground">
                      <Trans>Cancelled:</Trans> {row.voidReason}
                    </div>
                  ) : null}
                  <div className="break-all font-mono text-[10.5px] text-muted-foreground">
                    <Trans>Document fingerprint</Trans>: {row.documentHash}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-auto text-[11.5px] text-muted-foreground">
                      <Trans>Expires</Trans> {stamp(row.expiresAt)}
                    </span>
                    <Button size="sm" variant="outline" icon={I.Download} onClick={() => onDownload(row)}>
                      {row.signedDocumentKey ? <Trans>Signed PDF</Trans> : <Trans>Document</Trans>}
                    </Button>
                    {/* Everybody signed but no artefact — the renderer was down
                        when the last signature landed, and every link is spent. */}
                    {row.status === "pending" && allSigned && (
                      <Button size="sm" variant="outline" icon={I.Refresh} onClick={() => onFinalize(row)}>
                        <Trans>Produce signed copy</Trans>
                      </Button>
                    )}
                    {row.status === "pending" && (
                      <Button size="sm" variant="outline" icon={I.X} onClick={() => onVoid(row)}>
                        <Trans>Cancel</Trans>
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </Card>
      )}

      <Dialog open={sendOpen} onOpenChange={(v) => (v ? setSendOpen(true) : closeSend())}>
        <DialogContent className="gap-0 p-0 sm:max-w-[560px]">
          <DialogHeader className="shrink-0 border-b border-border px-5 pb-3.5 pr-12 pt-[18px] text-left">
            <DialogTitle className="text-base font-semibold tracking-[-0.01em]">
              {links ? <Trans>Sent</Trans> : <Trans>Send for signature</Trans>}
            </DialogTitle>
            <DialogDescription className="text-[12.5px]">
              {links ? (
                <Trans>
                  Each signer has been emailed their own link. These are shown once — only their
                  hashes are stored.
                </Trans>
              ) : (
                <Trans>
                  The document is rendered and frozen now. A later edit to the template will not
                  change it.
                </Trans>
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogBody>
            <div className="flex flex-col gap-4 px-5 py-[18px]">
              {links ? (
                links.map((l) => (
                  <div key={l.url} className="flex flex-col gap-1.5">
                    <span className="text-[12.5px] font-medium">{l.email}</span>
                    <Input readOnly value={l.url} className="font-mono text-[11.5px]" />
                  </div>
                ))
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12.5px] font-medium"><Trans>Document</Trans></label>
                    <Select
                      value={templateKey}
                      onChange={setTemplateKey}
                      // The empty entry is an OPTION rather than the Select's
                      // `placeholder`: the admin Select maps `""` to a real
                      // Radix value, so a placeholder with no matching option
                      // renders a blank trigger — and swapping `""` for
                      // `undefined` to dodge that turns the field
                      // uncontrolled on first pick.
                      options={[{ value: "", label: t`Pick a document template` }, ...templates]}
                      className="min-w-0"
                    />
                    <span className="text-[11.5px] text-muted-foreground">
                      <Trans>Authored on the Document templates page.</Trans>
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12.5px] font-medium" htmlFor="sig-signers">
                      <Trans>Signers</Trans>
                    </label>
                    <Textarea
                      id="sig-signers"
                      rows={3}
                      className="font-mono text-[12px]"
                      value={signersRaw}
                      onChange={(e) => setSignersRaw(e.target.value)}
                      placeholder={"tenant@example.com:Ayşe Yılmaz:Tenant\noffice@example.com:Acme:Landlord"}
                    />
                    <span className="text-[11.5px] text-muted-foreground">
                      <Trans>One per line — email, optionally :name:role. Role shows on the certificate.</Trans>
                    </span>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12.5px] font-medium" htmlFor="sig-title">
                      <Trans>Title</Trans>
                    </label>
                    <Input
                      id="sig-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder={t`Defaults to the template's name`}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12.5px] font-medium" htmlFor="sig-message">
                      <Trans>Note in the invitation</Trans>
                    </label>
                    <Textarea
                      id="sig-message"
                      rows={2}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                    />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12.5px] font-medium" htmlFor="sig-vars">
                      <Trans>Row data</Trans>
                    </label>
                    <Textarea
                      id="sig-vars"
                      rows={4}
                      className="font-mono text-[12px]"
                      value={varsRaw}
                      onChange={(e) => setVarsRaw(e.target.value)}
                    />
                    <span className="text-[11.5px] text-muted-foreground">
                      <Trans>The render context — what the template's placeholders resolve against.</Trans>
                    </span>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col">
                      <span className="text-[12.5px] font-medium"><Trans>Sign in order</Trans></span>
                      <span className="text-[11.5px] text-muted-foreground">
                        <Trans>Each link opens only once the one above it has signed.</Trans>
                      </span>
                    </div>
                    <Switch checked={ordered} onCheckedChange={setOrdered} />
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <label className="text-[12.5px] font-medium" htmlFor="sig-expires">
                      <Trans>Expires in (days)</Trans>
                    </label>
                    <Input
                      id="sig-expires"
                      type="number"
                      min={1}
                      max={365}
                      value={expiresInDays}
                      onChange={(e) => setExpiresInDays(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>
          </DialogBody>

          <DialogFooter className="shrink-0 border-t border-border px-5 py-3.5">
            {links ? (
              <Button onClick={closeSend}>
                <Trans>Done</Trans>
              </Button>
            ) : (
              <>
                <Button variant="outline" onClick={closeSend}>
                  <Trans>Cancel</Trans>
                </Button>
                <Button disabled={busy} onClick={onSend}>
                  {busy ? <Trans>Sending…</Trans> : <Trans>Send</Trans>}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
