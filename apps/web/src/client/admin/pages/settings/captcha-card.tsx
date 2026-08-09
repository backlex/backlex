// Captcha — the gate in front of the auth endpoints a stranger can reach.
//
// Two things drive the form. `onError` has no safe default, so it starts
// unchosen and the card refuses to save until it is picked — the same posture
// the sync-hook editor takes, and for the same reason: the wrong answer here is
// silently wrong. And what is protected is a set of checkboxes rather than one
// switch, because the endpoints cost different things and an operator turning
// on sign-up protection should not be forced to break their own sign-in flow.
import type { PushToast } from "../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, Button, Switch } from "../../ui";
import { Select } from "../../select";
import { Input } from "@backlex/ui/components/input";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { captchaApi, type ApiCaptchaConfig, type CaptchaTarget } from "../../api";
import { fetchSafely } from "../_shared";

const TARGETS: CaptchaTarget[] = ["sign-up", "sign-in", "password-reset", "forms"];

export function CaptchaCard({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const [loaded, setLoaded] = useState(false);
  const [config, setConfig] = useState<ApiCaptchaConfig | null>(null);
  const [provider, setProvider] = useState("");
  const [siteKey, setSiteKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [protect, setProtect] = useState<CaptchaTarget[]>([]);
  const [onError, setOnError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const res = await fetchSafely<{ data: ApiCaptchaConfig }>("/api/admin/captcha");
      if (!live) return;
      const data = res?.data ?? null;
      setConfig(data);
      if (data?.provider) {
        setProvider(data.provider);
        setSiteKey(data.siteKey);
        setProtect(data.protect);
        setOnError(data.onError);
      }
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  const ready = provider && siteKey.trim() && onError && (secretKey.trim() || config?.hasSecret);

  const save = async () => {
    setSaving(true);
    try {
      const res = await captchaApi.set({
        provider,
        siteKey: siteKey.trim(),
        // Omitted rather than sent empty: a blank field must not blank the
        // stored credential, and the API reads "absent" as "keep".
        ...(secretKey.trim() ? { secretKey: secretKey.trim() } : {}),
        protect,
        onError: onError as "allow" | "deny",
      });
      setConfig(res.data);
      setSecretKey("");
      pushToast(t`Captcha saved.`);
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const snapshot = config;
    setConfig(null);
    setProvider("");
    setSiteKey("");
    setProtect([]);
    setOnError("");
    try {
      await captchaApi.remove();
      pushToast(t`Captcha removed — gated endpoints stop asking now.`);
    } catch (e) {
      setConfig(snapshot);
      pushToast((e as Error).message);
    }
  };

  const toggleTarget = (target: CaptchaTarget, on: boolean) =>
    setProtect((prev) => (on ? [...new Set([...prev, target])] : prev.filter((p) => p !== target)));

  const targetLabel: Record<CaptchaTarget, string> = {
    "sign-up": t`Sign-up (password, magic link and OTP)`,
    "sign-in": t`Sign-in`,
    "password-reset": t`Password reset`,
    forms: t`Public form submissions`,
  };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3.5">
        <I.ShieldCheck size={13} />
        <span className="text-[13px] font-medium">
          <Trans>Captcha</Trans>
        </span>
        {config?.provider && <Badge variant="default">{config.provider}</Badge>}
        <div className="flex-1" />
        {config?.provider && (
          <Button size="sm" variant="ghost" onClick={() => void remove()}>
            <Trans>Remove</Trans>
          </Button>
        )}
      </div>

      <div className="border-b border-border px-4 py-3 text-[12.5px] text-muted-foreground">
        <Trans>
          Rate limiting bounds how fast an attacker goes. A captcha asks whether there is a person
          there at all — which is what a public sign-up, a password reset that mails a real person,
          and a public form submission each need.
        </Trans>
      </div>

      {!loaded ? (
        <div className="flex flex-col gap-2 px-4 py-3.5">
          <Skeleton className="h-3 w-2/3" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      ) : (
        <div className="flex flex-col gap-3.5 px-4 py-4">
          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium">{t`Provider`}</span>
            <Select
              className="min-w-0"
              value={provider}
              onChange={setProvider}
              options={[
                { value: "", label: t`Choose…` },
                { value: "turnstile", label: "Cloudflare Turnstile" },
                { value: "hcaptcha", label: "hCaptcha" },
                { value: "recaptcha", label: "reCAPTCHA" },
              ]}
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium">{t`Site key`}</span>
            <Input
              className="font-mono"
              value={siteKey}
              onChange={(e) => setSiteKey(e.target.value)}
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              <Trans>
                The public half. Published on your workspace's auth surface so a sign-in screen can
                render the widget.
              </Trans>
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium">{t`Secret key`}</span>
            <Input
              type="password"
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder={config?.hasSecret ? "••••••••" : ""}
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              {config?.hasSecret ? (
                <Trans>Leave blank to keep the stored one. It is never shown again.</Trans>
              ) : (
                <Trans>Stored encrypted. It has no read-back path.</Trans>
              )}
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-[11.5px] font-medium">{t`Protect`}</span>
            {TARGETS.map((target) => (
              <label key={target} className="flex items-start gap-2.5">
                <Switch
                  checked={protect.includes(target)}
                  onChange={(v) => toggleTarget(target, v)}
                />
                <span className="text-[12.5px]">{targetLabel[target]}</span>
              </label>
            ))}
          </div>

          <label className="block">
            <span className="mb-1 block text-[11.5px] font-medium">
              {t`When the provider cannot answer`}
            </span>
            <Select
              className="min-w-0"
              value={onError}
              onChange={setOnError}
              options={[
                { value: "", label: t`Choose…` },
                { value: "deny", label: t`Refuse the request (deny)` },
                { value: "allow", label: t`Let it through unverified (allow)` },
              ]}
            />
            <span className="mt-1 block text-[11px] text-muted-foreground">
              <Trans>
                No default on purpose: "allow" means the gate stops working exactly when the
                provider is having a bad day, which an attacker can arrange. "deny" turns their
                outage into yours.
              </Trans>
            </span>
          </label>

          <div className="flex justify-end">
            <Button disabled={!ready || saving} onClick={() => void save()}>
              {saving ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
