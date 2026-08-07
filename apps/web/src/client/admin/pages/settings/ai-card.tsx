// Settings card: workspace AI provider/model configuration.
//
// Both the provider list and the model list come from the server's registry +
// catalog (`GET /api/admin/ai-config` → `providers` / `models` /
// `modelsByProvider`), so adding a provider or a model on the server shows up
// here without a client change. The model field used to be free text, which
// meant a typo'd id only surfaced as a provider 404 at generation time.
import type { PushToast } from "../../types";
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Button } from "../../ui";
import { Select } from "../../select";
import { aiConfigApi, type ApiAiConfig } from "../../api";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { Skeleton } from "@backlex/ui/components/skeleton";

/** Sentinel for the "Custom…" escape hatch. The backend accepts any model id,
 *  so the picker must never be a closed set — it just stops being the DEFAULT
 *  way in. Can't collide with a real id: model ids never contain spaces. */
const MODEL_CUSTOM = "__custom__";

/** Shown when the workspace picks no provider. Not part of the server registry
 *  (it is the ABSENCE of a pick), so it lives here. */
const INHERIT_HINT =
  "On managed cloud this routes AI generation through the metered/capped platform gateway (counts against your plan's AI budget). On self-host it uses the deployment's AI provider env keys, if any. Pick a provider below to bring your own key and bill your own account instead.";

/** Card body placeholder. Mirrors the real layout — provider select, one secret
 *  field, model select, footer — so the card doesn't jump when data lands. */
function AiCardSkeleton() {
  return (
    <Card className="max-w-[920px] gap-4 p-[22px]">
      <Skeleton className="h-8 w-full" />
      {["provider", "secret", "model"].map((k) => (
        <div className="flex flex-col gap-1.5" key={k}>
          <Skeleton className="h-3.5 w-28" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      ))}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-8 w-40" />
      </div>
    </Card>
  );
}

/** Bring-your-own AI provider key for this workspace. Overrides the deployment
 *  default for AI generation — and on managed cloud lets a workspace opt out of
 *  the metered platform gateway and bill its own provider. Mirrors the
 *  SMS/Push/Email config cards. */
export function AiSettingsCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [cfg, setCfg] = useState<ApiAiConfig | null>(null);
  const [provider, setProvider] = useState("inherit");
  const [model, setModel] = useState("");
  const [modelChoice, setModelChoice] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  /** Push a server payload into the form fields. Also used to reconcile after
   *  an optimistic save, and to roll back after a failed one. */
  const hydrate = (d: ApiAiConfig) => {
    setCfg(d);
    setProvider(d.provider || "inherit");
    const m = typeof d.config?.model === "string" ? (d.config.model as string) : "";
    setModel(m);
    // A stored id the catalog doesn't list is legitimate (the backend takes
    // any id) — surface it in the Custom… input rather than silently dropping
    // it to "Default", which would rewrite the operator's choice on next save.
    const known = d.models.some((x) => x.id === m);
    setModelChoice(m === "" ? "" : known ? m : MODEL_CUSTOM);
    setSecrets({});
    setDirty(false);
  };

  const load = async () => {
    try {
      hydrate((await aiConfigApi.get()).data);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const providerDef = useMemo(
    () => cfg?.providers.find((p) => p.id === provider),
    [cfg, provider],
  );

  const providerOptions = useMemo(
    () => [
      { value: "inherit", label: t`Inherit — deployment default` },
      ...(cfg?.providers ?? []).map((p) => ({
        value: p.id,
        label: p.label,
        hint: p.transport === "gateway" ? t`multi-provider` : t`single vendor`,
      })),
    ],
    [cfg, t],
  );

  /** Models this provider can actually run, plus "Default" and "Custom…".
   *  Filtering here is what stops an admin picking a Gemini id while the
   *  workspace is on a direct Anthropic key. */
  const modelOptions = useMemo(() => {
    const allowed = new Set(cfg?.modelsByProvider?.[provider] ?? []);
    const listed = (cfg?.models ?? []).filter((m) => allowed.has(m.id));
    return [
      {
        value: "",
        label: t`Default`,
        hint: providerDef?.defaultModel ?? t`provider default`,
      },
      ...listed.map((m) => ({ value: m.id, label: m.label, hint: m.hint })),
      { value: MODEL_CUSTOM, label: t`Custom…`, hint: t`any provider model id` },
    ];
  }, [cfg, provider, providerDef, t]);

  const mark = () => setDirty(true);

  const pickModel = (v: string) => {
    setModelChoice(v);
    // "Custom…" keeps whatever was typed so switching to it and back doesn't
    // wipe the id; "Default" clears it.
    if (v !== MODEL_CUSTOM) setModel(v);
    mark();
  };

  const pickProvider = (v: string) => {
    setProvider(v);
    // A model from another vendor can't run on the new provider, so drop it
    // back to Default rather than saving an id that resolves to a 404.
    const allowed = new Set(cfg?.modelsByProvider?.[v] ?? []);
    if (modelChoice !== MODEL_CUSTOM && model && !allowed.has(model)) {
      setModel("");
      setModelChoice("");
    }
    mark();
  };

  const save = async () => {
    if (!cfg) return;
    const config = model.trim() ? { model: model.trim() } : {};
    // Optimistic: the card shows the saved state immediately (including the
    // "a key is stored" flags), then reconciles with the server. Rollback
    // restores the FORM, not just the server payload — a failed save that
    // silently discarded the key the operator just pasted would be worse than
    // no optimism at all.
    const snapshot = { cfg, secrets };
    const nextSecretsSet = { ...cfg.secretsSet };
    for (const [k, v] of Object.entries(secrets)) {
      if (k in nextSecretsSet) nextSecretsSet[k] = v.trim().length > 0;
    }
    setCfg({ ...cfg, provider, config, secretsSet: nextSecretsSet });
    setSecrets({});
    setDirty(false);
    setSaving(true);
    try {
      await aiConfigApi.put({ provider, config, secrets });
      pushToast(t`AI settings saved.`);
      // Background reconcile — the row's updatedAt and the server's own view of
      // which secrets survived are authoritative.
      void aiConfigApi
        .get()
        .then((r) => hydrate(r.data))
        .catch(() => {
          /* the optimistic state is already correct enough to keep */
        });
    } catch (e) {
      setCfg(snapshot.cfg);
      setSecrets(snapshot.secrets);
      setDirty(true); // still unsaved — Save must stay clickable
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const r = await aiConfigApi.test();
      pushToast(t`AI key works — model replied: ${r.reply}`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setTesting(false);
    }
  };

  if (!cfg) return <AiCardSkeleton />;

  const envHint = cfg.env?.cloud
    ? " · this is a managed cloud project"
    : cfg.env?.hasGatewayKey || cfg.env?.hasAnthropicKey
      ? " · deployment env has an AI key"
      : "";

  return (
    <Card className="max-w-[920px] gap-4 p-[22px]">
      <div className="flex items-start gap-2.5">
        <I.Info size={14} className="mt-0.5" />
        <span className="text-xs text-muted-foreground">
          <Trans>AI provider key for <b>this workspace</b>. When set, it overrides the
          deployment default for AI generation (Ask AI, agents, the
          <span className="font-mono"> ai.*</span> tools, auto-translate) — including on
          managed cloud, where it lets you opt out of the metered platform AI gateway and
          bill your own provider. Keys are encrypted at rest and never shown again.</Trans>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Provider</Trans></label>
        <Select value={provider} onChange={pickProvider} options={providerOptions} />
        <span className="text-[11.5px] text-muted-foreground">
          {providerDef?.hint ?? INHERIT_HINT}{envHint}
          {providerDef && (
            <> <a href={providerDef.docsUrl} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{providerDef.label} →</a></>
          )}
        </span>
      </div>
      {providerDef && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{providerDef.secretLabel}</label>
          <Textarea
            rows={2}
            autoComplete="off"
            className="font-mono text-[11px]"
            placeholder={cfg.secretsSet?.[providerDef.secretKey] ? t`•••••••• (stored — leave blank to keep)` : ""}
            value={secrets[providerDef.secretKey] ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setSecrets((s) => ({ ...s, [providerDef.secretKey]: v }));
              mark();
            }}
          />
          {cfg.secretsSet?.[providerDef.secretKey] && <span className="text-[11.5px] text-muted-foreground"><Trans>A value is stored. Type a new one to replace it, or leave blank to keep it.</Trans></span>}
        </div>
      )}
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Default model</Trans></label>
        <Select value={modelChoice} onChange={pickModel} options={modelOptions} />
        {modelChoice === MODEL_CUSTOM && (
          <Input
            type="text"
            autoComplete="off"
            className="font-mono text-[11px]"
            placeholder="anthropic/claude-haiku-4-5"
            value={model}
            onChange={(e) => { setModel(e.target.value); mark(); }}
          />
        )}
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>Used by Ask AI, agents left on “Default”, auto-translate and the
          ai.* tools. Callers may still override per request. Ids are written
          provider-prefixed; a direct provider gets the prefix stripped for you.</Trans>
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border pt-2.5">
        <Button variant="outline" size="sm" disabled={testing || provider === "inherit"} onClick={() => void runTest()}>{testing ? <Trans>Testing…</Trans> : <Trans>Test key</Trans>}</Button>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={!dirty || saving} onClick={() => void load()}><Trans>Discard</Trans></Button>
          <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => void save()}>{saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}</Button>
        </div>
      </div>
    </Card>
  );
}
