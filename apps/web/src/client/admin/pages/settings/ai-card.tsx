// Settings card: workspace AI provider/model configuration.
// Settings page — general/appearance/email/bindings/env/about tabs
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I, } from "../../icons";
import { Button, } from "../../ui";
import { Select } from "../../select";
import {
  aiConfigApi,
} from "../../api";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";


const AI_PROVIDER_OPTIONS = [
  { value: "inherit", label: "Inherit — deployment default" },
  { value: "gateway", label: "Vercel AI Gateway (multi-provider)" },
  { value: "anthropic", label: "Anthropic (direct)" },
];

const AI_PROVIDER_FIELDS: Record<
  string,
  {
    hint: string;
    secrets: [string, string][];
    link?: { href: string; label: string };
  }
> = {
  inherit: {
    hint: "On managed cloud this routes AI generation through the metered/capped platform gateway (counts against your plan's AI budget). On self-host it uses the deployment's AI_GATEWAY_API_KEY / ANTHROPIC_API_KEY env, if any. Pick a provider below to bring your own key and bill your own account instead.",
    secrets: [],
  },
  gateway: {
    hint: "One key reaches Anthropic / OpenAI / Google / … through Vercel AI Gateway. Powers Ask AI and the ai.* MCP tools. (Auto-translate uses a direct Anthropic key — pick Anthropic below for that.)",
    secrets: [["gatewayKey", "AI Gateway API key"]],
    link: { href: "https://vercel.com/docs/ai-gateway", label: "Vercel AI Gateway →" },
  },
  anthropic: {
    hint: "A direct Anthropic API key. Powers Ask AI, the ai.* MCP tools, and the Translations “Auto-translate missing” action.",
    secrets: [["anthropicKey", "Anthropic API key"]],
    link: { href: "https://console.anthropic.com/settings/keys", label: "Anthropic Console →" },
  },
};

/** Bring-your-own AI provider key for this workspace. Overrides the deployment
 *  default for AI generation — and on managed cloud lets a workspace opt out of
 *  the metered platform gateway and bill its own provider. Mirrors the
 *  SMS/Push/Email config cards. */
export function AiSettingsCard({ pushToast }: { pushToast: (m: string) => void }) {
  const { t } = useLingui();
  const [cfg, setCfg] = useState<any>(null);
  const [provider, setProvider] = useState("inherit");
  const [model, setModel] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const load = async () => {
    try {
      const r = await aiConfigApi.get();
      const d = r.data as any;
      setCfg(d);
      setProvider(d.provider || "inherit");
      setModel(typeof d.config?.model === "string" ? d.config.model : "");
      setSecrets({});
      setDirty(false);
    } catch (e) {
      pushToast((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const fields = AI_PROVIDER_FIELDS[provider] ?? AI_PROVIDER_FIELDS.inherit!;
  const mark = () => setDirty(true);

  const save = async () => {
    setSaving(true);
    try {
      const config = model.trim() ? { model: model.trim() } : {};
      await aiConfigApi.put({ provider, config, secrets });
      pushToast(t`AI settings saved.`);
      await load();
    } catch (e) {
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

  const envHint = cfg?.env?.cloud
    ? " · this is a managed cloud project"
    : cfg?.env?.hasGatewayKey || cfg?.env?.hasAnthropicKey
      ? " · deployment env has an AI key"
      : "";

  return (
    <Card className="max-w-[920px] gap-4 p-[22px]">
      <div className="flex items-start gap-2.5">
        <I.Info size={14} className="mt-0.5" />
        <span className="text-xs text-muted-foreground">
          <Trans>AI provider key for <b>this workspace</b>. When set, it overrides the
          deployment default for AI generation (Ask AI, the
          <span className="font-mono"> ai.*</span> tools, auto-translate) — including on
          managed cloud, where it lets you opt out of the metered platform AI gateway and
          bill your own provider. Keys are encrypted at rest and never shown again.</Trans>
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Provider</Trans></label>
        <Select value={provider} onChange={(v: string) => { setProvider(v); mark(); }} options={AI_PROVIDER_OPTIONS} />
        <span className="text-[11.5px] text-muted-foreground">
          {fields.hint}{envHint}
          {fields.link && (
            <> <a href={fields.link.href} target="_blank" rel="noreferrer" className="text-primary underline underline-offset-2">{fields.link.label}</a></>
          )}
        </span>
      </div>
      {fields.secrets.map(([key, label]) => (
        <div className="flex flex-col gap-1.5" key={key}>
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">{label}</label>
          <Textarea
            rows={2}
            autoComplete="off"
            className="font-mono text-[11px]"
            placeholder={cfg?.secretsSet?.[key] ? t`•••••••• (stored — leave blank to keep)` : ""}
            value={secrets[key] ?? ""}
            onChange={(e) => { setSecrets((s) => ({ ...s, [key]: e.target.value })); mark(); }}
          />
          {cfg?.secretsSet?.[key] && <span className="text-[11.5px] text-muted-foreground"><Trans>A value is stored. Type a new one to replace it, or leave blank to keep it.</Trans></span>}
        </div>
      ))}
      {provider !== "inherit" && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Default model (optional)</Trans></label>
          <Input
            type="text"
            placeholder={provider === "gateway" ? "anthropic/claude-haiku-4-5" : "claude-haiku-4-5-20251001"}
            value={model}
            onChange={(e) => { setModel(e.target.value); mark(); }}
          />
          <span className="text-[11.5px] text-muted-foreground"><Trans>Leave blank to use the built-in default. Callers may still override per request.</Trans></span>
        </div>
      )}
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
