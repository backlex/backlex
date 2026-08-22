// Cookie consent — the admin tab for the policy a site publishes.
//
// Extracted from `analytics.tsx` rather than living in it: consent is not
// measurement, the page was already past 2,400 lines, and the two components
// below are the ones a render test needs to reach. A tab that renders a legal
// posture is exactly the kind of thing that should be directly testable.
import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { PushToast } from "../../types";
import { I } from "../../icons";
import { Badge, Button, EmptyState } from "../../ui";
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
import type {
  ApiAnalyticsSite,
  ApiConsentPolicy,
  ApiConsentPolicyInput,
} from "../../api";
import {
  useAnalyticsSites,
  useConsentPolicies,
  useDeleteConsentPolicy,
  useSaveConsentPolicy,
} from "../../queries";
import { consentApi } from "../../api/observability";
import { BUILTIN_STRINGS } from "../../../consent-banner/strings";



/**
 * Cookie consent — one policy per registered site.
 *
 * The tab exists next to Sites because a policy governs a site, and because
 * the question "does this site ask its visitors anything?" is one an operator
 * asks while looking at the site list.
 *
 * The two compliance decisions are rendered as REQUIRED dropdowns with the
 * consequence spelled out in each option's hint, and neither is preselected.
 * That is the UI half of a server rule: the column has no default, the service
 * refuses to invent one, and a form that arrived with something already chosen
 * would quietly undo both.
 */
export function ConsentTab({ pushToast }: { pushToast: PushToast }) {
  const { t } = useLingui();
  const sitesQ = useAnalyticsSites();
  const policiesQ = useConsentPolicies();
  const savePolicy = useSaveConsentPolicy();
  const removePolicy = useDeleteConsentPolicy();
  const [editing, setEditing] = useState<ApiAnalyticsSite | null>(null);

  const sites = sitesQ.data?.data ?? [];
  const policies = policiesQ.data?.data ?? [];
  const policyFor = (siteId: string) => policies.find((p) => p.siteId === siteId) ?? null;

  if (sitesQ.isLoading || policiesQ.isLoading) {
    return (
      <div className="flex flex-col gap-3">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-[132px] w-full rounded-control" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {sites.length === 0 ? (
        <EmptyState
          icon={I.Shield}
          title={t`No websites registered`}
          description={t`A consent banner is served for a registered site. Add one on the Sites tab first, then decide here what its visitors are asked.`}
        />
      ) : (
        sites.map((s: ApiAnalyticsSite) => {
          const p = policyFor(s.id);
          return (
            <Card key={s.id} className="gap-3 px-4 py-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium">{s.name}</div>
                  <div className="truncate text-[12.5px] text-muted-foreground">
                    {s.domain}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    variant="outline"
                    icon={I.Settings}
                    onClick={() => setEditing(s)}
                  >
                    {p ? <Trans>Edit policy</Trans> : <Trans>Set up consent</Trans>}
                  </Button>
                  {p ? (
                    <Button
                      variant="outline"
                      icon={I.Trash}
                      onClick={() => {
                        removePolicy.mutate(s.id, {
                          onError: () => pushToast(t`Could not remove the policy.`),
                        });
                        pushToast(t`Consent policy removed.`);
                      }}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  ) : null}
                </div>
              </div>

              {p ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant={p.enabled ? "default" : "secondary"}>
                    {p.enabled ? <Trans>Banner live</Trans> : <Trans>Not shown</Trans>}
                  </Badge>
                  <Badge variant="secondary">
                    {p.undecidedBehaviour === "block" ? (
                      <Trans>Blocks before consent</Trans>
                    ) : (
                      <Trans>Allows before consent</Trans>
                    )}
                  </Badge>
                  <Badge variant="secondary">
                    {p.trackerCategory === "none" ? (
                      <Trans>Tag: strictly necessary</Trans>
                    ) : (
                      <Trans>Tag: gated</Trans>
                    )}
                  </Badge>
                  {p.categoriesOffered.map((c) => (
                    <Badge key={c} variant="outline">
                      {c}
                    </Badge>
                  ))}
                </div>
              ) : (
                <p className="m-0 text-[12.5px] text-muted-foreground">
                  <Trans>
                    No policy yet. Nothing is asked and nothing is blocked — the site
                    behaves exactly as it does today.
                  </Trans>
                </p>
              )}
            </Card>
          );
        })
      )}

      <ConsentPolicyDialog
        site={editing}
        policy={editing ? policyFor(editing.id) : null}
        pushToast={pushToast}
        onClose={() => setEditing(null)}
        onSave={(patch) => {
          if (!editing) return;
          const siteId = editing.id;
          setEditing(null);
          savePolicy.mutate(
            { siteId, patch },
            {
              onError: (e) =>
                // The server's refusal explains WHY there is no default, so it
                // is surfaced verbatim rather than replaced with "Save failed".
                pushToast((e as Error)?.message || t`Could not save the policy.`),
            },
          );
          pushToast(t`Consent policy saved.`);
        }}
      />
    </div>
  );
}

/**
 * The policy form.
 *
 * Every field with a finite value set is a dropdown, per the house rule — and
 * the two compliance ones deliberately open EMPTY on a first setup. A
 * preselected "block" would be a legal posture the operator never chose, which
 * is the exact failure the server-side "no default" exists to prevent; letting
 * the UI supply one would route around it.
 */
export function ConsentPolicyDialog({
  site,
  policy,
  onClose,
  onSave,
  pushToast,
}: {
  site: ApiAnalyticsSite | null;
  policy: ApiConsentPolicy | null;
  onClose: () => void;
  onSave: (patch: ApiConsentPolicyInput) => void;
  pushToast: PushToast;
}) {
  const { t } = useLingui();

  /**
   * The fifteen strings the banner renders, in the order it renders them.
   *
   * Mirrors `WORDING_KEYS` in `services/consent.ts`, which is a CLOSED list
   * precisely so this form can be generated from it rather than drifting from it.
   * `consent-surfaces.test.ts` fails if the two stop agreeing — a key the policy
   * accepts but no field writes is a string an operator can never set, and a
   * field writing a key the policy drops is one they set and lose on save.
   *
   * Labels are thunks so `t` is called during render, inside the lingui provider,
   * rather than once at module load where the locale is not yet resolved.
   */
  // Placeholders are the banner's OWN built-in text, imported rather than
  // retyped: it is what actually renders when a field is left blank, it
  // follows `editLocale`, and a copy here would drift the moment either side
  // was reworded. `strings.ts` is a plain object with no imports, so this
  // costs the admin bundle nothing but the strings themselves.
  const WORDING_FIELDS = [
    { key: "title", label: t`Title` },
    { key: "body", label: t`Body` },
    { key: "acceptAll", label: t`Accept button` },
    { key: "rejectAll", label: t`Reject button` },
    { key: "manage", label: t`Manage button` },
    { key: "save", label: t`Save button` },
    { key: "policyLink", label: t`Policy link text` },
    { key: "functionalLabel", label: t`Functional — name` },
    { key: "functionalBody", label: t`Functional — description` },
    { key: "analyticsLabel", label: t`Analytics — name` },
    { key: "analyticsBody", label: t`Analytics — description` },
    { key: "marketingLabel", label: t`Marketing — name` },
    { key: "marketingBody", label: t`Marketing — description` },
    {
      key: "necessaryLabel",
      label: t`Strictly necessary — name`,
    },
    { key: "necessaryBody", label: t`Strictly necessary — description` },
    { key: "close", label: t`Close button` },
    { key: "withdraw", label: t`Withdraw link` },
    { key: "idLabel", label: t`Consent id — label` },
  ];

  /** `THEME_KEYS` from the same module, with the banner's own defaults shown as
   *  placeholders so a blank field reads as "the default" rather than "unset". */
  const THEME_FIELDS = [
    { key: "background", label: t`Background`, placeholder: "#ffffff" },
    { key: "foreground", label: t`Text`, placeholder: "#18181b" },
    { key: "accent", label: t`Accent`, placeholder: "#4f46e5" },
    { key: "accentForeground", label: t`Accent text`, placeholder: "#ffffff" },
    { key: "border", label: t`Border`, placeholder: "#e4e4e7" },
    { key: "radius", label: t`Corner radius`, placeholder: "10px" },
  ];

  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // `undefined`, never "". The admin Select maps an empty string to a sentinel
  // meaning "this option IS selected", so `value=""` renders a trigger that is
  // blank AND suppresses the placeholder — two unlabelled dropdowns on the one
  // form where the operator most needs to be told they must choose.
  const [undecided, setUndecided] = useState<string | undefined>(undefined);
  const [tracker, setTracker] = useState<string | undefined>(undefined);
  const [cats, setCats] = useState<string[]>([]);
  const [position, setPosition] = useState<string>("bottom");
  const [policyUrl, setPolicyUrl] = useState("");
  const [maxAge, setMaxAge] = useState("180");
  const [enabled, setEnabled] = useState(false);
  const [defaultLocale, setDefaultLocale] = useState("en");
  const [wording, setWording] = useState<Record<string, Record<string, string>>>({});
  const [theme, setTheme] = useState<Record<string, string>>({});
  // Which locale block the fields below are editing. Separate from
  // `defaultLocale`, because an operator writes Turkish while English stays the
  // default all the time.
  const [editLocale, setEditLocale] = useState("en");
  const [openSection, setOpenSection] = useState<"none" | "wording" | "theme">("none");

  // Seeded in render rather than an effect, matching SiteSettingsDialog: it
  // keeps the dialog a pure function of props and avoids the StrictMode
  // double-effect this codebase has been bitten by.
  if (site && loadedFor !== site.id) {
    setLoadedFor(site.id);
    setUndecided(policy?.undecidedBehaviour ?? undefined);
    setTracker(policy?.trackerCategory ?? undefined);
    setCats(policy?.categoriesOffered ?? []);
    setPosition(policy?.position ?? "bottom");
    setPolicyUrl(policy?.policyUrl ?? "");
    setMaxAge(String(policy?.cookieMaxAgeDays ?? 180));
    setEnabled(policy?.enabled ?? false);
    setDefaultLocale(policy?.defaultLocale ?? "en");
    setWording(policy?.wording ?? {});
    setTheme(policy?.theme ?? {});
    setEditLocale(policy?.defaultLocale ?? "en");
    setOpenSection("none");
  }

  const setWord = (key: string, value: string) =>
    setWording((prev) => ({
      ...prev,
      [editLocale]: { ...(prev[editLocale] ?? {}), [key]: value },
    }));

  /**
   * Fill the blanks from the server's suggestion.
   *
   * Only the blanks: `suggestedWording()` is documented as a SUGGESTION and not
   * a fallback, and overwriting a sentence an operator had reviewed with a
   * lawyer to "help" is the one thing this button must never do.
   */
  const useSuggested = async () => {
    try {
      const res = await consentApi.suggestedWording();
      const block = res.data?.[editLocale] ?? res.data?.[editLocale.split("-")[0] ?? ""] ?? {};
      setWording((prev) => {
        const mine = { ...(prev[editLocale] ?? {}) };
        for (const k of Object.keys(block)) if (!mine[k]) mine[k] = block[k] as string;
        return { ...prev, [editLocale]: mine };
      });
    } catch {
      pushToast(t`Could not load the suggested wording.`, "error");
    }
  };

  const toggleCat = (c: string) =>
    setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  const ready = Boolean(undecided && tracker);

  return (
    <Dialog open={!!site} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[560px] [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>
            <Trans>Consent policy</Trans>
          </DialogTitle>
          <DialogDescription>{site ? site.domain : ""}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="flex min-w-0 flex-col gap-3.5">
            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Before a visitor decides</Trans>
              </span>
              <Select
                className="min-w-0"
                value={undecided}
                onChange={setUndecided}
                placeholder={t`Choose — there is no default`}
                options={[
                  {
                    value: "block",
                    label: t`Block until they answer`,
                    hint: t`Nothing optional fires. Required under GDPR and ePrivacy; you lose measurement on visitors who ignore the banner.`,
                  },
                  {
                    value: "allow",
                    label: t`Allow until they decline`,
                    hint: t`Optional tags fire immediately. This is the CCPA/CPRA opt-out model and it is not lawful in the EU.`,
                  },
                ]}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  There is no default because neither answer is safe everywhere. The
                  choice is recorded against your workspace.
                </Trans>
              </span>
            </label>

            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>backlex's own analytics tag</Trans>
              </span>
              <Select
                className="min-w-0"
                value={tracker}
                onChange={setTracker}
                placeholder={t`Choose — there is no default`}
                options={[
                  {
                    value: "none",
                    label: t`Strictly necessary`,
                    hint: t`Measures every visitor. Defensible because the tag stores nothing on the device and its visitor id rotates daily — but that is a legal position, not a fact.`,
                  },
                  {
                    value: "analytics",
                    label: t`Gate it like any other tag`,
                    hint: t`The tag waits for consent. The safest reading, and it costs you the visitors who never answer.`,
                  },
                ]}
              />
            </label>

            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Categories the banner offers</Trans>
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {(["functional", "analytics", "marketing"] as const).map((c) => (
                  <Button
                    key={c}
                    variant={cats.includes(c) ? "primary" : "outline"}
                    onClick={() => toggleCat(c)}
                  >
                    {c}
                  </Button>
                ))}
              </div>
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  Only ask about what the site actually does. Strictly necessary is
                  never offered — it is not a choice a visitor has.
                </Trans>
              </span>
            </div>

            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Banner position</Trans>
              </span>
              <Select
                className="min-w-0"
                value={position}
                onChange={setPosition}
                options={[
                  { value: "bottom", label: t`Bottom bar` },
                  { value: "top", label: t`Top bar` },
                  { value: "corner", label: t`Corner card` },
                ]}
              />
            </label>

            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Link to your privacy policy</Trans>
              </span>
              <Input
                value={policyUrl}
                placeholder="https://example.com/privacy"
                onChange={(e) => setPolicyUrl(e.target.value)}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>Must be an http(s) URL. It is linked from the banner.</Trans>
              </span>
            </label>

            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>How long a decision stands</Trans>
              </span>
              <Select
                className="min-w-0"
                value={maxAge}
                onChange={setMaxAge}
                options={[
                  { value: "90", label: t`90 days` },
                  {
                    value: "180",
                    label: t`180 days`,
                    hint: t`Matches the CNIL's six-month guidance.`,
                  },
                  { value: "365", label: t`1 year` },
                  { value: "730", label: t`2 years` },
                ]}
              />
            </label>


            <div className="flex min-w-0 flex-col gap-1.5 border-t pt-4">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Banner language</Trans>
              </span>
              <Select
                className="min-w-0"
                value={defaultLocale}
                onChange={(v) => {
                  setDefaultLocale(v);
                  setEditLocale(v);
                }}
                options={[
                  { value: "en", label: t`English` },
                  { value: "tr", label: t`Turkish` },
                ]}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  The banner ships built-in text in both. Write your own below to
                  replace it — key by key, so a partial translation still renders.
                </Trans>
              </span>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant={openSection === "wording" ? "primary" : "outline"}
                  onClick={() => setOpenSection(openSection === "wording" ? "none" : "wording")}
                >
                  <Trans>Wording</Trans>
                </Button>
                <Button
                  variant={openSection === "theme" ? "primary" : "outline"}
                  onClick={() => setOpenSection(openSection === "theme" ? "none" : "theme")}
                >
                  <Trans>Appearance</Trans>
                </Button>
              </div>

              {openSection === "wording" && (
                <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {(["en", "tr"] as const).map((l) => (
                      <Button
                        key={l}
                        variant={editLocale === l ? "primary" : "outline"}
                        onClick={() => setEditLocale(l)}
                      >
                        {l}
                      </Button>
                    ))}
                    <Button variant="outline" onClick={useSuggested}>
                      <Trans>Fill the blanks</Trans>
                    </Button>
                  </div>
                  {WORDING_FIELDS.map((f) => (
                    <label key={f.key} className="flex min-w-0 flex-col gap-1">
                      <span className="text-[12.5px] text-muted-foreground">{f.label}</span>
                      <Input
                        value={wording[editLocale]?.[f.key] ?? ""}
                        placeholder={BUILTIN_STRINGS[editLocale]?.[f.key] ?? ""}
                        onChange={(e) => setWord(f.key, e.target.value)}
                      />
                    </label>
                  ))}
                  <span className="text-[11.5px] text-muted-foreground">
                    <Trans>
                      Left blank, the banner uses its own text. What you write here is
                      what a visitor is held to have agreed to, so it is stored exactly
                      as typed and never rewritten.
                    </Trans>
                  </span>
                </div>
              )}

              {openSection === "theme" && (
                <div className="grid min-w-0 gap-3 rounded-md border p-3 sm:grid-cols-2">
                  {THEME_FIELDS.map((f) => (
                    <label key={f.key} className="flex min-w-0 flex-col gap-1">
                      <span className="text-[12.5px] text-muted-foreground">{f.label}</span>
                      <Input
                        value={theme[f.key] ?? ""}
                        placeholder={f.placeholder}
                        onChange={(e) =>
                          setTheme((prev) => ({ ...prev, [f.key]: e.target.value }))
                        }
                      />
                    </label>
                  ))}
                  <span className="text-[11.5px] text-muted-foreground sm:col-span-2">
                    <Trans>
                      Anything left blank uses the banner's default. Values are CSS
                      colours and lengths; the banner refuses anything that is not.
                    </Trans>
                  </span>
                </div>
              )}
            </div>

            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Show the banner</Trans>
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Button
                  variant={enabled ? "primary" : "outline"}
                  onClick={() => setEnabled(true)}
                >
                  <Trans>Live</Trans>
                </Button>
                <Button
                  variant={!enabled ? "primary" : "outline"}
                  onClick={() => setEnabled(false)}
                >
                  <Trans>Off</Trans>
                </Button>
              </div>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            <Trans>Cancel</Trans>
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            onClick={() =>
              onSave({
                undecidedBehaviour: undecided as "block" | "allow",
                trackerCategory: tracker as "none" | "analytics",
                categoriesOffered: cats as ("functional" | "analytics" | "marketing")[],
                position: position as "bottom" | "top" | "corner",
                policyUrl: policyUrl.trim() || null,
                cookieMaxAgeDays: Number(maxAge) || 180,
                defaultLocale: defaultLocale.trim() || "en",
                wording,
                theme,
                enabled,
              })
            }
          >
            <Trans>Save</Trans>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
