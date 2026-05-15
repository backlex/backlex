// @ts-nocheck
import { useEffect, useState } from "react";
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
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <PageHeader title="Email templates" description={<>Variables use Liquid-style <span className="font-mono">{"{{ user.email }}"}</span>. Template renders run through the Functions sandbox.</>} actions={<Button size="sm" variant="outline" icon={I.Plus} onClick={onNew}>New template</Button>} />
      <div className="master-detail-3" style={{ "--md-a": "240px", "--md-b": "minmax(0, 1fr)" }}>
        <div className="card">
          {templates.length === 0 && !active?.isNew && (
            <div className="muted" style={{ padding: "12px 14px", fontSize: 12 }}>No templates yet — use “New template” to add one.</div>
          )}
          {active?.isNew && !templates.some((t) => t.id === active.id) && (
            <div style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", background: "var(--accent)" }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{name.trim() || "(new template)"}</div>
              <div className="font-mono muted" style={{ fontSize: 11 }}>{keyDraft.trim() || "unsaved"}</div>
            </div>
          )}
          {templates.map((t) => (
            <div key={t.id} onClick={() => void onSelect(t)} style={{ padding: "10px 12px", borderTop: "1px solid var(--border)", cursor: "pointer", background: active?.id === t.id ? "var(--accent)" : "transparent" }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{t.name || "(unnamed)"}</div>
              <div className="font-mono muted" style={{ fontSize: 11 }}>{t.key || t.id}</div>
            </div>
          ))}
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div className="card-section" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, fontWeight: 500 }}>Editor</span>
            <div className="spacer" />
            <Button size="sm" variant="outline" icon={I.Mail} onClick={onSendTest} disabled={!active || active.isNew}>Send test</Button>
            <Button size="sm" variant="primary" icon={I.Save} onClick={onSave} disabled={!active || saving}>Save</Button>
          </div>
          <div style={{ padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", gap: 10 }}>
              <div className="field" style={{ flex: 1 }}><label className="field-label">Name</label><input className="input" value={name} placeholder="Verify email" onChange={(e) => setName(e.target.value)} /></div>
              <div className="field" style={{ flex: 1 }}><label className="field-label">Key</label><input className="input font-mono" value={keyDraft} placeholder="verify" disabled={!active?.isNew} spellCheck={false} autoComplete="off" onChange={(e) => setKeyDraft(e.target.value)} /></div>
            </div>
            <div className="field"><label className="field-label">Subject</label><input className="input" value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
            <div className="field"><label className="field-label">From</label><input className="input" value={fromAddress} placeholder="(use the configured default)" onChange={(e) => setFromAddress(e.target.value)} /></div>
            <div className="field">
              <label className="field-label">Body (HTML)</label>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} style={{ width: "100%", minHeight: 220, padding: 12, border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", background: "oklch(0.18 0.01 130)", color: "oklch(0.92 0.02 130)", fontFamily: "Geist Mono, monospace", fontSize: 12.5, lineHeight: 1.55, resize: "vertical" }} />
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(active?.vars ?? []).map((v) => (
                <button key={v} onClick={() => setBody((b) => b + `{{ ${v} }}`)} className="chip"><I.Code size={11} /> {`{{ ${v} }}`}</button>
              ))}
            </div>
          </div>
        </div>
        <div className="card" style={{ padding: 0, overflow: "hidden" }}>
          <div className="card-section"><span style={{ fontSize: 12, fontWeight: 500 }}>Preview</span></div>
          <div style={{ padding: 24, background: "oklch(0.97 0.005 130)", minHeight: 280 }}>
            <div style={{ background: "white", borderRadius: 12, padding: 28, maxWidth: 480, margin: "0 auto", boxShadow: "0 1px 4px oklch(0 0 0 / 0.06)", color: "#1a1a1a" }} dangerouslySetInnerHTML={{ __html: preview.replace(/<a /g, '<a style="display:inline-block;margin-top:8px;padding:10px 16px;background:oklch(0.85 0.18 125);color:#1a1a1a;border-radius:999px;text-decoration:none;font-weight:500;font-family:Geist,sans-serif" ') }} />
          </div>
        </div>
      </div>
    </div>
  );
}
