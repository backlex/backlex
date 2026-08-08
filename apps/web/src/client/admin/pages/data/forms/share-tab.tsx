import type { PushToast } from "../../../types";
import { useEffect, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../../icons";
import {
  Button,
  IconButton,
  Switch,
} from "../../../ui";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@backlex/ui/components/popover";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@backlex/ui/components/command";
import { Skeleton } from "@backlex/ui/components/skeleton";
import {
  formsApi,
  type ApiForm,
  type ApiFormInvite,
  type ApiFormSettings,
  type ApiMintedFormInvite,
} from "../../../api";
import { PanelCard } from "./panels";
import { LivePill, relTime } from "./shared";

/** Epoch ms → the `datetime-local` spelling, in the operator's OWN zone.
 *  An opening time is set by a person looking at a clock on a wall; storing it
 *  as an instant is right, showing it in UTC is not. */
const toLocalInput = (ms: number | undefined): string => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

/** …and back. An empty input clears the setting rather than storing epoch 0,
 *  which would close every form ever opened. */
const fromLocalInput = (value: string): number | undefined => {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
};

/** Common form locales offered by the add-language picker (code + native name). */
const LANGUAGE_OPTIONS: Array<{ code: string; name: string }> = [
  { code: "en", name: "English" },
  { code: "tr", name: "Türkçe" },
  { code: "de", name: "Deutsch" },
  { code: "fr", name: "Français" },
  { code: "es", name: "Español" },
  { code: "it", name: "Italiano" },
  { code: "pt", name: "Português" },
  { code: "nl", name: "Nederlands" },
  { code: "pl", name: "Polski" },
  { code: "sv", name: "Svenska" },
  { code: "da", name: "Dansk" },
  { code: "nb", name: "Norsk" },
  { code: "fi", name: "Suomi" },
  { code: "cs", name: "Čeština" },
  { code: "ro", name: "Română" },
  { code: "hu", name: "Magyar" },
  { code: "el", name: "Ελληνικά" },
  { code: "ru", name: "Русский" },
  { code: "uk", name: "Українська" },
  { code: "ar", name: "العربية" },
  { code: "fa", name: "فارسی" },
  { code: "hi", name: "हिन्दी" },
  { code: "id", name: "Bahasa Indonesia" },
  { code: "vi", name: "Tiếng Việt" },
  { code: "th", name: "ไทย" },
  { code: "ja", name: "日本語" },
  { code: "ko", name: "한국어" },
  { code: "zh", name: "中文" },
  { code: "az", name: "Azərbaycanca" },
];

/** shadcn combobox (Popover + Command) for adding a form locale. */
export function AddLanguagePopover({
  languages,
  onAdd,
  compact,
}: {
  languages: string[];
  onAdd: (code: string) => void;
  compact?: boolean;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const available = LANGUAGE_OPTIONS.filter((l) => !languages.includes(l.code));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t`Add language`}
          className={
            compact
              ? "rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground hover:border-primary hover:text-primary"
              : "flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground hover:border-primary hover:text-primary"
          }
        >
          {compact ? "+" : <><I.Plus size={9} /> {t`add`}</>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="end">
        <Command>
          <CommandInput placeholder={t`Search languages…`} />
          <CommandList>
            <CommandEmpty><Trans>No language found.</Trans></CommandEmpty>
            {available.map((l) => (
              <CommandItem
                key={l.code}
                value={`${l.code} ${l.name}`}
                onSelect={() => {
                  onAdd(l.code);
                  setOpen(false);
                }}
              >
                <span className="font-mono text-[10.5px] uppercase text-muted-foreground">{l.code}</span>
                <span>{l.name}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Invite-only mode, and the links that make it mean something.
 *
 * The links are shown ONCE — in the mint response — so they stay on screen
 * until the operator navigates away, with a copy button each. The list below
 * is the durable half: who was invited and who has answered. It never carries
 * a token, and the panel says so rather than letting someone hunt for one.
 */
function InvitesCard({
  form,
  formToken,
  onPatchSettings,
  pushToast,
}: {
  form: ApiForm;
  /** The form's own plaintext token, when this session still holds it — it is
   *  what turns a minted invite into a ready-made link. */
  formToken: string | null;
  onPatchSettings: (p: Partial<ApiFormSettings>) => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const [invites, setInvites] = useState<ApiFormInvite[] | null>(null);
  const [minted, setMinted] = useState<ApiMintedFormInvite[] | null>(null);
  const [emails, setEmails] = useState("");
  const [busy, setBusy] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    let cancelled = false;
    formsApi
      .invites(form.id)
      .then((r) => !cancelled && setInvites(r.data))
      .catch(() => !cancelled && setInvites([]));
    return () => {
      cancelled = true;
    };
  }, [form.id]);

  const parsed = emails
    .split(/[,\n;]/)
    .map((e) => e.trim())
    .filter(Boolean);

  const mint = async (send: boolean) => {
    if (parsed.length === 0) return;
    setBusy(true);
    try {
      const res = await formsApi.invite(form.id, {
        recipients: parsed.map((email) => ({ email })),
        ...(formToken ? { formToken } : {}),
        ...(send ? { send: true } : {}),
      });
      setMinted(res.data.invites);
      setEmails("");
      setInvites((prev) => [...(prev ?? []), ...res.data.invites]);
      pushToast(
        send
          ? t`${res.data.invites.length} invited, ${res.data.sent} emailed.`
          : t`${res.data.invites.length} link(s) minted — copy them now.`,
      );
    } catch (e) {
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (invite: ApiFormInvite) => {
    const snapshot = invites;
    setInvites((prev) => (prev ?? []).filter((i) => i.id !== invite.id));
    setMinted((prev) => prev?.filter((i) => i.id !== invite.id) ?? null);
    try {
      await formsApi.revokeInvite(form.id, invite.id);
    } catch (e) {
      setInvites(snapshot);
      pushToast((e as Error).message);
    }
  };

  const answered = (invites ?? []).filter((i) => i.usedAt).length;
  const waiting = (invites ?? []).filter((i) => !i.usedAt);

  /**
   * Nudge everyone still outstanding.
   *
   * Optimistic like every other mutation here: the rows say "reminded" before
   * the request lands and roll back if it doesn't. The fresh links join the
   * shown-once box, because they are shown once — and the earlier ones keep
   * working, so nothing the operator already handed out has to be chased.
   */
  const remind = async (send: boolean) => {
    if (waiting.length === 0) return;
    const snapshot = invites;
    const stamp = Date.now();
    setBusy(true);
    setInvites((prev) =>
      (prev ?? []).map((i) =>
        i.usedAt ? i : { ...i, remindedAt: stamp, reminderCount: (i.reminderCount ?? 0) + 1 },
      ),
    );
    try {
      const res = await formsApi.remindInvites(form.id, {
        ...(formToken ? { formToken } : {}),
        ...(send ? { send: true } : {}),
        force: true,
      });
      if (res.data.invites.length > 0) setMinted(res.data.invites);
      // Reconcile: the server decides who was actually due.
      const fresh = await formsApi.invites(form.id);
      setInvites(fresh.data);
      pushToast(
        send
          ? t`${res.data.invites.length} reminded, ${res.data.sent} emailed.`
          : t`${res.data.invites.length} fresh link(s) — copy them now.`,
      );
    } catch (e) {
      setInvites(snapshot);
      pushToast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelCard icon={I.Mail} title={<Trans>Invites</Trans>}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[12.5px] font-medium"><Trans>Invite only</Trans></div>
          <div className="text-[11px] text-muted-foreground">
            <Trans>only a visitor holding an unspent link may answer</Trans>
          </div>
        </div>
        <Switch
          checked={Boolean(form.settings?.inviteOnly)}
          onChange={(v) => onPatchSettings({ inviteOnly: v || undefined })}
        />
      </div>

      <label className="flex flex-col gap-1 text-[12px] font-medium">
        <Trans>Email addresses</Trans>
        <Textarea
          rows={2}
          placeholder="ada@example.com, grace@example.com"
          value={emails}
          onChange={(e) => setEmails(e.target.value)}
        />
        <span className="text-[11px] font-normal text-muted-foreground">
          <Trans>Comma or newline separated. Each gets its own single-use link.</Trans>
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => mint(false)} disabled={busy || parsed.length === 0}>
          {busy ? <Trans>Working…</Trans> : <Trans>Create links</Trans>}
        </Button>
        <Button variant="primary" icon={I.Mail} onClick={() => mint(true)} disabled={busy || parsed.length === 0}>
          <Trans>Create and email</Trans>
        </Button>
      </div>

      {waiting.length > 0 && (
        <div className="flex flex-col gap-1.5 border-t border-border pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              icon={I.Refresh}
              onClick={() => remind(false)}
              disabled={busy}
            >
              <Trans>New links for {waiting.length} waiting</Trans>
            </Button>
            <Button variant="primary" icon={I.Mail} onClick={() => remind(true)} disabled={busy}>
              <Trans>Remind by email</Trans>
            </Button>
          </div>
          <span className="text-[11px] text-muted-foreground">
            <Trans>
              Each gets a fresh link. The ones already sent keep working — every link
              into an invite opens the same turn, and answering spends it.
            </Trans>
          </span>
        </div>
      )}

      {minted && minted.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-control border border-primary/30 bg-primary/10 p-2.5">
          <span className="text-[11px] text-primary">
            <Trans>Shown once — these links cannot be listed again.</Trans>
          </span>
          {minted.map((i) => (
            <div key={i.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {i.url ? `${origin}${i.url}` : i.token}
              </span>
              <IconButton
                icon={I.Copy}
                title={t`Copy link`}
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(i.url ? `${origin}${i.url}` : i.token);
                    pushToast(t`Copied.`);
                  } catch {
                    pushToast(t`Copy failed — select and copy manually.`);
                  }
                }}
              />
            </div>
          ))}
        </div>
      )}
      {minted && minted.length > 0 && !formToken && (
        <span className="text-[11px] text-muted-foreground">
          <Trans>
            Only the invite tokens are shown: generate a new form link above and the
            next batch comes back as full URLs.
          </Trans>
        </span>
      )}

      {invites === null ? (
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : invites.length === 0 ? (
        <span className="text-[11.5px] text-muted-foreground">
          <Trans>Nobody invited yet.</Trans>
        </span>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex justify-between font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground">
            <span><Trans>Invited</Trans> {invites.length}</span>
            <span><Trans>Answered</Trans> {answered}</span>
          </div>
          <ScrollArea viewportClassName="max-h-[220px]" className="w-full">
            <div className="flex flex-col">
              {invites.map((i) => (
                <div
                  key={i.id}
                  className="flex items-center gap-2 border-b border-border py-1.5 text-[12px] last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate">{i.email ?? t`no address`}</span>
                  {!i.usedAt && (i.reminderCount ?? 0) > 0 && (
                    <span
                      className="shrink-0 font-mono text-[10px] uppercase text-muted-foreground"
                      title={t`reminded ${relTime(i.remindedAt)}`}
                    >
                      <Trans>+{i.reminderCount}</Trans>
                    </span>
                  )}
                  <span
                    className={`shrink-0 font-mono text-[10px] uppercase ${i.usedAt ? "text-emerald-400" : "text-muted-foreground"}`}
                  >
                    {i.usedAt ? <Trans>answered</Trans> : i.sentAt ? <Trans>sent</Trans> : <Trans>not sent</Trans>}
                  </span>
                  <IconButton icon={I.Trash} title={t`Revoke`} onClick={() => revoke(i)} />
                </div>
              ))}
            </div>
          </ScrollArea>
        </div>
      )}
    </PanelCard>
  );
}

export function ShareTab({
  form,
  urls,
  languages,
  onRotate,
  onHideLink,
  onToggleActive,
  onToggleTurnstile,
  onPatchSettings,
  pushToast,
}: {
  form: ApiForm;
  urls: { url: string; embedUrl: string } | null;
  languages: string[];
  onRotate: () => void;
  onHideLink: () => void;
  onToggleActive: (v: boolean) => void;
  onToggleTurnstile: (v: boolean) => void;
  onPatchSettings: (p: Partial<ApiFormSettings>) => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  // Share-time language pin: null = auto (visitor's browser language);
  // a code appends ?lang=xx to both the link and the embed src.
  const [shareLang, setShareLang] = useState<string | null>(null);
  const [embedMode, setEmbedMode] = useState<"script" | "iframe">("script");
  const langQs = shareLang ? `?lang=${encodeURIComponent(shareLang)}` : "";
  const absolute = urls ? `${origin}${urls.url}${langQs}` : null;
  const token = urls?.url.split("/f/")[1] ?? null;
  const iframe = urls
    ? embedMode === "script"
      ? `<div data-backlex-form="${token}"${shareLang ? ` data-lang="${shareLang}"` : ""}></div>\n<script src="${origin}/embed/form.js" async></script>`
      : `<iframe src="${origin}${urls.embedUrl}${langQs}" width="100%" height="620" frameborder="0"></iframe>`
    : null;
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      pushToast(t`Copied.`);
    } catch {
      pushToast(t`Copy failed — select and copy manually.`);
    }
  };
  return (
    <div className="grid grid-cols-[1.25fr_1fr] gap-4 max-[900px]:grid-cols-1">
      <div className="flex flex-col gap-4">
        <PanelCard
          icon={I.Link}
          title={
            <span className="flex w-full items-center gap-2">
              <Trans>Public link</Trans>
              <span className="ml-auto"><LivePill active={form.active} /></span>
            </span>
          }
        >
          <p className="text-[11.5px] text-muted-foreground">
            <Trans>No auth on the visitor's side — the token in the URL is the
            credential. It's stored hashed, so it can only be shown{" "}
            <span className="text-amber-400">once</span>.</Trans>
          </p>
          {absolute && languages.length > 1 && (
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">
                <Trans>language</Trans>
              </span>
              <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5">
                <button
                  type="button"
                  onClick={() => setShareLang(null)}
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${
                    shareLang === null
                      ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Trans>auto</Trans>
                </button>
                {languages.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setShareLang(l)}
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${
                      shareLang === l
                        ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <span className="text-[10.5px] text-muted-foreground">
                {shareLang === null ? <Trans>visitor's browser language</Trans> : <Trans>link pins this language</Trans>}
              </span>
            </div>
          )}
          {absolute ? (
            <>
              <div className="flex items-center gap-2 rounded-control border border-amber-400/30 bg-amber-400/5 px-3 py-2 font-mono text-[10.5px] text-amber-400">
                <I.Lock size={11} />
                <Trans>shown once — copy it now, it won't appear again</Trans>
              </div>
              <div className="flex items-center gap-1.5">
                <Input readOnly value={absolute} className="border-amber-400/35 font-mono text-[12px]" />
                <IconButton icon={I.Copy} title={t`Copy link`} onClick={() => void copy(absolute)} />
                <IconButton icon={I.ExternalLink} title={t`Open form`} onClick={() => window.open(absolute, "_blank")} />
              </div>
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={onHideLink}
                  className="text-[11.5px] font-medium text-muted-foreground underline underline-offset-2 hover:text-primary"
                >
                  <Trans>I copied it — hide the link</Trans>
                </button>
                <button
                  type="button"
                  title={t`Mints a new token; the current link stops working`}
                  onClick={onRotate}
                  className="flex items-center gap-1.5 rounded-control border border-orange-300/40 bg-orange-300/5 px-3 py-1.5 text-[12px] font-medium text-orange-300 hover:bg-orange-300/10"
                >
                  <I.Refresh size={12} />
                  <Trans>Rotate token</Trans>
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <div className="flex min-w-0 flex-1 items-center gap-2 truncate rounded-control border border-border bg-background/40 px-3 py-2 font-mono text-[12px] text-muted-foreground">
                  <I.Lock size={12} />
                  {origin}/f/frm_{"•".repeat(12)}
                </div>
                <Button variant="primary" icon={I.Refresh} onClick={onRotate}>
                  <Trans>Generate new link</Trans>
                </Button>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                <Trans>The token can't be shown again — generating a new link is the
                only way to get one. The old link stops working instantly; update any
                embeds.</Trans>
              </p>
            </>
          )}
        </PanelCard>
        <PanelCard
          icon={I.Code}
          title={
            <span className="flex w-full items-center gap-2">
              <Trans>Embed</Trans>
              {iframe && (
                <span className="ml-auto">
                  <Button variant="ghost" icon={I.Copy} onClick={() => void copy(iframe)}>
                    <Trans>Copy</Trans>
                  </Button>
                </span>
              )}
            </span>
          }
        >
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5">
              {(
                [
                  { value: "script", label: t`Script` },
                  { value: "iframe", label: "iframe" },
                ] as const
              ).map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => setEmbedMode(o.value)}
                  className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] uppercase ${
                    embedMode === o.value
                      ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span className="text-[10.5px] text-muted-foreground">
              {embedMode === "script" ? (
                <Trans>auto-sizes to the form's height — recommended</Trans>
              ) : (
                <Trans>fixed height, zero JavaScript</Trans>
              )}
            </span>
          </div>
          <p className="text-[11.5px] text-muted-foreground">
            <Trans>Drop it into any site — the form keeps its own theme.</Trans>
          </p>
          {iframe ? (
            <ScrollArea className="w-full rounded-control border border-border bg-background/60">
              <pre className="whitespace-pre px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-muted-foreground">{iframe.replace(/" /g, '"\n  ')}</pre>
            </ScrollArea>
          ) : (
            <p className="rounded-control border border-dashed border-border px-3 py-2.5 text-[12px] text-muted-foreground">
              <Trans>Use "Generate new link" above — the embed snippet is minted
              together with it.</Trans>
            </p>
          )}
        </PanelCard>
      </div>
      <div className="flex flex-col gap-4">
        <PanelCard icon={I.Shield} title={<Trans>Delivery</Trans>}>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[12.5px] font-medium"><Trans>Accepting submissions</Trans></div>
              <div className="text-[11px] text-muted-foreground"><Trans>pausing returns 410 on the public link</Trans></div>
            </div>
            <Switch checked={form.active} onChange={onToggleActive} />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[12.5px] font-medium"><Trans>Turnstile</Trans></div>
              <div className="text-[11px] text-muted-foreground"><Trans>needs TURNSTILE_SITE_KEY on the server</Trans></div>
            </div>
            <Switch
              checked={Boolean(form.settings?.turnstile)}
              onChange={onToggleTurnstile}
            />
          </div>
          <div className="flex flex-col gap-1.5 border-t border-border pt-2.5 font-mono text-[11.5px]">
            <div className="flex justify-between"><span className="text-muted-foreground"><Trans>Honeypot</Trans></span><span className="text-emerald-400"><Trans>always on</Trans></span></div>
            <div className="flex justify-between"><span className="text-muted-foreground"><Trans>Rate limit</Trans></span><span>10 / min / IP</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground"><Trans>Writes to</Trans></span><span>{form.collection}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground"><Trans>Blocked so far</Trans></span><span className="tabular-nums">{form.blockedCount}</span></div>
          </div>
        </PanelCard>
        <PanelCard icon={I.Clock} title={<Trans>Who can answer, and until when</Trans>}>
          <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
              <Trans>Opens</Trans>
              <Input
                type="datetime-local"
                value={toLocalInput(form.settings?.opensAt)}
                onChange={(e) => onPatchSettings({ opensAt: fromLocalInput(e.target.value) })}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-[12px] font-medium">
              <Trans>Closes</Trans>
              <Input
                type="datetime-local"
                value={toLocalInput(form.settings?.closesAt)}
                onChange={(e) => onPatchSettings({ closesAt: fromLocalInput(e.target.value) })}
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[12px] font-medium">
            <Trans>Response limit</Trans>
            <Input
              type="number"
              min={1}
              placeholder={t`No limit`}
              value={form.settings?.maxResponses ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                onPatchSettings({
                  maxResponses: e.target.value === "" || !Number.isFinite(n) || n < 1 ? undefined : Math.floor(n),
                });
              }}
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              <Trans>
                Accepted so far: {form.submissionCount}. Checked before the row is
                written, so a simultaneous burst can land a couple over.
              </Trans>
            </span>
          </label>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium"><Trans>One answer per browser</Trans></div>
              <div className="text-[11px] text-muted-foreground">
                <Trans>a cookie, not an identity — another browser answers again</Trans>
              </div>
            </div>
            <Switch
              checked={Boolean(form.settings?.onePerBrowser)}
              onChange={(v) => onPatchSettings({ onePerBrowser: v || undefined })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium"><Trans>Save progress</Trans></div>
              <div className="text-[11px] text-muted-foreground">
                <Trans>
                  half-filled answers are kept so people can come back — invited
                  people resume on any device, everyone else in the same browser
                </Trans>
              </div>
            </div>
            <Switch
              checked={Boolean(form.settings?.saveProgress)}
              onChange={(v) => onPatchSettings({ saveProgress: v || undefined })}
            />
          </div>
          <label className="flex flex-col gap-1 text-[12px] font-medium">
            <Trans>Closed message</Trans>
            <Input
              placeholder={t`This form is closed.`}
              value={form.settings?.closedMessage ?? ""}
              onChange={(e) => onPatchSettings({ closedMessage: e.target.value || undefined })}
            />
            <span className="text-[11px] font-normal text-muted-foreground">
              <Trans>Shown in place of the questions. The form keeps its title, so the
              link still says what it was.</Trans>
            </span>
          </label>
        </PanelCard>
        <InvitesCard form={form} formToken={token} onPatchSettings={onPatchSettings} pushToast={pushToast} />
        <PanelCard icon={I.Zap} title={<Trans>On submit</Trans>}>
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            <Trans>Submissions go through the standard items write path — validation,
            flows, webhooks, realtime, audit. Anything listening on this collection
            fires as if an authenticated user created the row.</Trans>
          </p>
        </PanelCard>
      </div>
    </div>
  );
}

/* ── submission detail drawer ──────────────────────────────────────── */
