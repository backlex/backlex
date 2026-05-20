// @ts-nocheck
import { useEffect, useState } from "react";
import { Input } from "@workeros/ui/components/input";
import { Textarea } from "@workeros/ui/components/textarea";
import { I } from "../icons";
import { Button, PageHeader } from "../ui";
import { emailTemplatesApi, type ApiEmailTemplate } from "../api";

export function EmailTemplatesPage({ pushToast }: { pushToast: (m: string) => void }) {
  type Tpl = { id: string; key: string; name: string; subject: string; vars: string[]; bodyHtml?: string; fromAddress?: string | null; isNew?: boolean };
  const [templates, setTemplates] = useState<Tpl[]>([]);
  const [active, setActive] = useState<Tpl | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [subject, setSubject] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [saving, setSaving] = useState(false);

  const loadInto = (t: Tpl) => {
    setActive(t);
    setKeyDraft(t.key);
    setName(t.name);
    setSubject(t.subject);
    setBody(t.bodyHtml ?? "");
    setFromAddress(t.fromAddress ?? "");
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await emailTemplatesApi.list();
        if (cancelled) return;
        if (Array.isArray(res.data)) {
          const mapped: Tpl[] = res.data.map((t: ApiEmailTemplate) => ({
            id: t.id,
            key: t.key,
            name: t.name,
            subject: t.subject,
            vars: t.variables ?? [],
            bodyHtml: t.bodyHtml,
            fromAddress: t.fromAddress,
          }));
          setTemplates(mapped);
          if (mapped[0]) loadInto(mapped[0]);
        }
      } catch {
        // leave templates empty
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onSelect = async (t: Tpl) => {
    loadInto(t);
    if (t.bodyHtml !== undefined || t.isNew) return;
    try {
      const res = await emailTemplatesApi.get(t.id);
      setBody(res.data.bodyHtml);
      setFromAddress(res.data.fromAddress ?? "");
      setTemplates((arr) => arr.map((x) => x.id === t.id ? { ...x, bodyHtml: res.data.bodyHtml, fromAddress: res.data.fromAddress } : x));
    } catch {
      // keep current body
    }
  };

  const onNew = () => {
    loadInto({ id: crypto.randomUUID(), key: "", name: "", subject: "", vars: [], bodyHtml: "", isNew: true });
  };

  const onSave = async () => {
    if (!active || saving) return;
    const trimmedKey = keyDraft.trim();
    const trimmedName = name.trim();
    const trimmedFrom = fromAddress.trim();
    if (active.isNew) {
      if (!/^[a-z0-9_-]{2,40}$/i.test(trimmedKey)) { pushToast("Key must be 2–40 chars (letters, digits, dash, underscore)."); return; }
      if (templates.some((t) => !t.isNew && t.key === trimmedKey)) { pushToast(`A template with key "${trimmedKey}" already exists.`); return; }
    }
    if (!subject.trim()) { pushToast("Subject is required."); return; }
    setSaving(true);
    try {
      if (active.isNew) {
        const res = await emailTemplatesApi.create({
          key: trimmedKey,
          name: trimmedName || trimmedKey,
          subject,
          fromAddress: trimmedFrom || null,
          bodyHtml: body,
          bodyText: null,
          variables: active.vars,
        });
        const saved: Tpl = { id: res.data.id, key: res.data.key, name: res.data.name, subject: res.data.subject, vars: res.data.variables ?? [], bodyHtml: res.data.bodyHtml, fromAddress: res.data.fromAddress };
        setTemplates((arr) => [saved, ...arr.filter((t) => t.id !== active.id)]);
        loadInto(saved);
      } else {
        const newName = trimmedName || active.name;
        const fromVal = trimmedFrom || null;
        await emailTemplatesApi.patch(active.id, { name: newName, subject, bodyHtml: body, fromAddress: fromVal });
        const patch = { name: newName, subject, bodyHtml: body, fromAddress: fromVal };
        setTemplates((arr) => arr.map((t) => t.id === active.id ? { ...t, ...patch } : t));
        setActive((a) => a ? { ...a, ...patch } : a);
        setName(newName);
      }
      pushToast("Template saved.");
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const onSendTest = async () => {
    if (!active) return;
    if (active.isNew) { pushToast("Save the template before sending a test."); return; }
    try {
      await emailTemplatesApi.sendTest(active.id);
      pushToast("Test email sent.");
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  const preview = body
    .replace(/{{\s*user\.email\s*}}/g, "rana@workeros.dev")
    .replace(/{{\s*confirm_url\s*}}/g, "https://workeros.dev/auth/verify?token=…")
    .replace(/{{\s*reset_url\s*}}/g, "https://workeros.dev/auth/reset?token=…")
    .replace(/{{\s*magic_url\s*}}/g, "https://workeros.dev/auth/magic?token=…")
    .replace(/{{\s*site\.name\s*}}/g, "workeros");
  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader title="Email templates" description={<>Variables use Liquid-style <span className="font-mono">{"{{ user.email }}"}</span>. Template renders run through the Functions sandbox.</>} actions={<Button size="sm" variant="outline" icon={I.Plus} onClick={onNew}>New template</Button>} />
      <div className="grid grid-cols-[240px_minmax(0,1fr)_minmax(0,1fr)] items-start gap-3.5 max-[1024px]:grid-cols-[minmax(0,1fr)]">
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          {templates.length === 0 && !active?.isNew && (
            <div className="px-3.5 py-3 text-xs text-muted-foreground">No templates yet — use “New template” to add one.</div>
          )}
          {active?.isNew && !templates.some((t) => t.id === active.id) && (
            <div className="border-t border-border bg-accent px-3 py-2.5">
              <div className="text-[12.5px] font-medium">{name.trim() || "(new template)"}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{keyDraft.trim() || "unsaved"}</div>
            </div>
          )}
          {templates.map((t) => (
            <div
              key={t.id}
              onClick={() => void onSelect(t)}
              className={`cursor-pointer border-t border-border px-3 py-2.5 ${active?.id === t.id ? "bg-accent" : ""}`}
            >
              <div className="text-[12.5px] font-medium">{t.name || "(unnamed)"}</div>
              <div className="font-mono text-[11px] text-muted-foreground">{t.key || t.id}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
            <span className="text-xs font-medium">Editor</span>
            <div className="flex-1" />
            <Button size="sm" variant="outline" icon={I.Mail} onClick={onSendTest} disabled={!active || active.isNew}>Send test</Button>
            <Button size="sm" variant="primary" icon={I.Save} onClick={onSave} disabled={!active || saving}>Save</Button>
          </div>
          <div className="flex flex-col gap-2.5 p-3.5">
            <div className="flex gap-2.5">
              <div className="flex flex-1 flex-col gap-1.5"><label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Name</label><Input value={name} placeholder="Verify email" onChange={(e) => setName(e.target.value)} /></div>
              <div className="flex flex-1 flex-col gap-1.5"><label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Key</label><Input className="font-mono" value={keyDraft} placeholder="verify" disabled={!active?.isNew} spellCheck={false} autoComplete="off" onChange={(e) => setKeyDraft(e.target.value)} /></div>
            </div>
            <div className="flex flex-col gap-1.5"><label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Subject</label><Input value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
            <div className="flex flex-col gap-1.5"><label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">From</label><Input value={fromAddress} placeholder="(use the configured default)" onChange={(e) => setFromAddress(e.target.value)} /></div>
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Body (HTML)</label>
              <Textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} className="min-h-[220px] w-full resize-y rounded-xl border border-border bg-[oklch(0.18_0.01_130)] p-3 font-mono text-[12.5px] leading-[1.55] text-[oklch(0.92_0.02_130)]" />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {(active?.vars ?? []).map((v) => (
                <button key={v} onClick={() => setBody((b) => b + `{{ ${v} }}`)} className="inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-3xl border border-border bg-card px-[11px] text-[12.5px] text-foreground hover:bg-accent"><I.Code size={11} /> {`{{ ${v} }}`}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="overflow-hidden rounded-2xl border border-border bg-card text-card-foreground">
          <div className="border-b border-border px-4 py-3.5"><span className="text-xs font-medium">Preview</span></div>
          <div className="min-h-[280px] bg-[oklch(0.97_0.005_130)] p-6">
            <div className="mx-auto max-w-[480px] rounded-[12px] bg-white p-7 text-[#1a1a1a] shadow-[0_1px_4px_oklch(0_0_0/0.06)]" dangerouslySetInnerHTML={{ __html: preview.replace(/<a /g, '<a style="display:inline-block;margin-top:8px;padding:10px 16px;background:oklch(0.85 0.18 125);color:#1a1a1a;border-radius:999px;text-decoration:none;font-weight:500;font-family:Geist,sans-serif" ') }} />
          </div>
        </div>
      </div>
    </div>
  );
}
