// Cookie consent — the policy a website publishes, and its own page.
//
// Extracted from `analytics.tsx` rather than living in it: consent is not
// measurement, the page was already past 2,400 lines, and the two components
// below are the ones a render test needs to reach. A tab that renders a legal
// posture is exactly the kind of thing that should be directly testable.
import { useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import type { PushToast } from "../../types";
import { I } from "../../icons";
import { ConsentSkeleton } from "../../page-skeletons";
import { Badge, Button, EmptyState, PageHeader, Switch } from "../../ui";
import { ConfirmDialog } from "../../sheet";
import { Select } from "../../select";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Textarea } from "@backlex/ui/components/textarea";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "../../queries";
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
  useSuggestedPostures,
  useDeleteConsentPolicy,
  useSaveConsentPolicy,
} from "../../queries";
import { consentApi } from "../../api/observability";
import { BUILTIN_STRINGS } from "../../../consent-banner/strings";

/**
 * The three categories, named the way the banner names them.
 *
 * They used to render as the raw column values — lowercase `functional`,
 * `analytics`, `marketing` — as chips on the card AND as the labels of the
 * operator's primary compliance choice, in a row that otherwise read "Banner
 * live" / "Blocks before consent". One concept, two vocabularies, and a chip
 * reading `analytics` three nav rows from the Analytics page it has nothing to
 * do with.
 */
const CATEGORIES = ["functional", "analytics", "marketing"] as const;

function useCategoryLabels(): Record<string, string> {
  const { t } = useLingui();
  return {
    functional: t`Functional`,
    analytics: t`Analytics`,
    marketing: t`Marketing`,
  };
}

/** The two locales the banner ships built-in text for. Named once so the
 *  language Select and the wording tabs stop disagreeing about whether they
 *  are called "English"/"Turkish" or `en`/`tr`. */
const BUILTIN_LOCALES = ["en", "tr"] as const;

/** What `parseTheme` (server/services/consent.ts:312) will keep: the same
 *  character set, the same `url(` refusal and the same 60-character cap. Kept
 *  in step with it deliberately — the server is still the check; this only lets
 *  the field say so before the save, because a rejected value is dropped there
 *  SILENTLY and the response is still a 200. */
const SAFE_THEME_VALUE = /^[#a-zA-Z0-9 ,.%()/-]+$/;



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
export function ConsentPage({
  pushToast,
  setActiveNav,
}: {
  pushToast: PushToast;
  /** Prop-drilled rather than `useNavigate`, because `app.tsx`'s `vNav` saves
   *  pane scroll, warms the target's lazy chunk and commits inside a view
   *  transition. A raw navigate skips all three and flashes a Suspense
   *  skeleton where nothing else in this admin does. */
  setActiveNav?: (id: string) => void;
}) {
  const { t } = useLingui();
  const qc = useQueryClient();
  const sitesQ = useAnalyticsSites();
  const policiesQ = useConsentPolicies();
  const savePolicy = useSaveConsentPolicy();
  const removePolicy = useDeleteConsentPolicy();
  const catLabels = useCategoryLabels();
  const [editing, setEditing] = useState<ApiAnalyticsSite | null>(null);
  const [removing, setRemoving] = useState<ApiAnalyticsSite | null>(null);

  const sites = sitesQ.data?.data ?? [];
  const policies = policiesQ.data?.data ?? [];
  const policyFor = (siteId: string) => policies.find((p) => p.siteId === siteId) ?? null;

  const header = (
    <PageHeader
      title={t`Cookie consent`}
      description={t`What each website asks its visitors, and what runs before they answer. One policy per website.`}
      descriptionClassName="hidden sm:block"
      actions={
        // This page reads the same `analyticsSites` query as Websites, which
        // has a Refresh; this one had none, so the page whose staleness has
        // legal consequence was the one that could not re-read itself.
        <Button
          icon={I.Refresh}
          disabled={sitesQ.isFetching || policiesQ.isFetching}
          onClick={() => {
            void qc.invalidateQueries({ queryKey: queryKeys.analyticsSites() });
            void qc.invalidateQueries({ queryKey: queryKeys.consentPolicies() });
          }}
        >
          <Trans>Refresh</Trans>
        </Button>
      }
    />
  );

  if (sitesQ.isLoading || policiesQ.isLoading) return <ConsentSkeleton />;

  // Neither failure used to be handled, and both fell through to copy that
  // asserts a fact. A failed sites read rendered "No websites registered"; a
  // failed POLICIES read rendered every site as "No policy yet. Nothing is
  // asked and nothing is blocked" — a false statement about a live legal
  // posture, produced by a dropped fetch.
  if (sitesQ.isError || policiesQ.isError) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <EmptyState
          icon={I.AlertTriangle}
          title={t`Couldn't load consent policies`}
          description={
            (sitesQ.error as Error)?.message ||
            (policiesQ.error as Error)?.message ||
            t`The request failed, so nothing here can be trusted to describe your sites. Try again.`
          }
          action={
            <Button
              variant="primary"
              icon={I.Refresh}
              onClick={() => {
                void sitesQ.refetch();
                void policiesQ.refetch();
              }}
            >
              <Trans>Try again</Trans>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {header}
      {sites.length === 0 ? (
        <EmptyState
          icon={I.Cookie}
          title={t`No websites registered`}
          description={t`A consent banner is served for a registered website. Register one first, then decide here what its visitors are asked.`}
          action={
            setActiveNav && (
              <Button onClick={() => setActiveNav("websites")}>
                <Trans>Go to Websites</Trans>
              </Button>
            )
          }
        />
      ) : (
        sites.map((s: ApiAnalyticsSite) => {
          const p = policyFor(s.id);
          return (
            <Card key={s.id} className="gap-3 px-4 py-3.5">
              {/* Stacks on a phone. As one `justify-between` row the two
                  full-label buttons held their width against a `min-w-0` name,
                  squeezing the site down to about twelve characters — and a
                  wrap put the actions on the LEFT, against the house rule. */}
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium">{s.name}</div>
                  <div className="truncate text-[12.5px] text-muted-foreground">
                    {s.domain}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <Button
                    variant={p ? "outline" : "primary"}
                    icon={I.Settings}
                    onClick={() => setEditing(s)}
                  >
                    {p ? <Trans>Edit policy</Trans> : <Trans>Set up consent</Trans>}
                  </Button>
                  {/* Confirmed, like every other destructive action here.
                      Removing a policy is not a display change: the banner stops
                      being served, the site's legal posture reverts to "nothing
                      is asked", and the wording an operator may have had
                      reviewed goes with it. */}
                  {p ? (
                    <Button
                      variant="outline"
                      icon={I.Trash}
                      onClick={() => setRemoving(s)}
                    >
                      <Trans>Remove</Trans>
                    </Button>
                  ) : null}
                </div>
              </div>

              {p && p.enabled ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="default">
                    <Trans>Banner live</Trans>
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
                      {catLabels[c] ?? c}
                    </Badge>
                  ))}
                </div>
              ) : p ? (
                // A disabled policy is wholly inert server-side — no banner AND
                // no blocking. Showing "Blocks before consent" beside "Not
                // shown" described a state that cannot exist, and on this page
                // that mislabel is what an operator quotes in a privacy review.
                <div className="flex flex-col gap-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">
                      <Trans>Not shown</Trans>
                    </Badge>
                  </div>
                  <p className="m-0 text-[12.5px] text-muted-foreground">
                    <Trans>
                      Saved but not in effect — nothing is asked and nothing is blocked
                      until you set it live.
                    </Trans>
                  </p>
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

      {/* Keyed on the site so the form re-seeds from what is STORED every time
          it opens. Without it `loadedFor` matched on reopen, so Cancel was not
          a discard — and after Remove, "Set up consent" opened with the deleted
          policy's compliance answers already selected, which is exactly what
          the dialog's own doc comment says must never happen. */}
      <ConfirmDialog
        open={!!removing}
        destructive
        title={t`Remove this site's consent policy?`}
        description={t`The banner stops being served, nothing is asked and nothing is blocked, and the wording and appearance saved for it are deleted. The site itself and its traffic stay.`}
        actionLabel={t`Remove policy`}
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const target = removing;
          if (!target) return;
          setRemoving(null);
          removePolicy.mutate(target.id, {
            // The confirmation waits for the answer. Fired alongside the
            // mutation it produced both "Consent policy removed." and the
            // failure toast at once.
            onSuccess: () => pushToast(t`Consent policy removed.`),
            onError: () => pushToast(t`Couldn't remove the policy.`, "error"),
          });
        }}
      />

      <ConsentPolicyDialog
        key={editing?.id ?? "none"}
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
              onSuccess: () => pushToast(t`Consent policy saved.`),
              onError: (e) =>
                // The server's refusal explains WHY there is no default, so it
                // is surfaced verbatim rather than replaced with "Save failed".
                pushToast((e as Error)?.message || t`Couldn't save the policy.`, "error"),
            },
          );
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
  const catLabels = useCategoryLabels();

  /**
   * The eighteen strings the banner renders, in the order it renders them.
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
  // `multiline` is what the string IS, not a styling choice: a category
  // description is a sentence or two and was being edited through a single-line
  // input whose overflow scrolls sideways one character at a time.
  const WORDING_FIELDS = [
    { key: "title", label: t`Title` },
    { key: "body", label: t`Body`, multiline: true },
    { key: "acceptAll", label: t`Accept button` },
    { key: "rejectAll", label: t`Reject button` },
    { key: "manage", label: t`Manage button` },
    { key: "save", label: t`Save button` },
    { key: "policyLink", label: t`Policy link text` },
    { key: "functionalLabel", label: t`Functional — name` },
    { key: "functionalBody", label: t`Functional — description`, multiline: true },
    { key: "analyticsLabel", label: t`Analytics — name` },
    { key: "analyticsBody", label: t`Analytics — description`, multiline: true },
    { key: "marketingLabel", label: t`Marketing — name` },
    { key: "marketingBody", label: t`Marketing — description`, multiline: true },
    {
      key: "necessaryLabel",
      label: t`Strictly necessary — name`,
    },
    { key: "necessaryBody", label: t`Strictly necessary — description`, multiline: true },
    { key: "close", label: t`Close button` },
    { key: "withdraw", label: t`Withdraw link` },
    { key: "idLabel", label: t`Consent id — label` },
  ];

  /**
   * `THEME_KEYS` from the same module, with the banner's own defaults shown as
   * placeholders so a blank field reads as "the default" rather than "unset".
   *
   * `swatches` is what the shared `ColorSwatchPicker` offers for that key: the
   * banner's default first (an empty value, i.e. "leave it alone"), then a few
   * that suit the role, then the rainbow custom circle. Every other colour in
   * this admin — workspace appearance, form design, collection settings — is
   * picked this way; a bare hex box here was a second way to do one job.
   */
  const THEME_FIELDS = [
    {
      key: "background",
      label: t`Background`,
      placeholder: "#ffffff",
      swatches: ["", "#ffffff", "#f8fafc", "#18181b", "#0b0b0f"],
    },
    {
      key: "foreground",
      label: t`Text`,
      placeholder: "#18181b",
      swatches: ["", "#18181b", "#334155", "#ffffff", "#e4e4e7"],
    },
    {
      key: "accent",
      label: t`Accent`,
      placeholder: "#4f46e5",
      swatches: ["", "#4f46e5", "#0ea5e9", "#16a34a", "#dc2626", "#18181b"],
    },
    {
      key: "accentForeground",
      label: t`Accent text`,
      placeholder: "#ffffff",
      swatches: ["", "#ffffff", "#18181b"],
    },
    {
      key: "border",
      label: t`Border`,
      placeholder: "#e4e4e7",
      // No `transparent` preset: it paints an invisible circle, which reads as
      // a gap in the row rather than as a choice. Type it in the box if you
      // want it.
      swatches: ["", "#e4e4e7", "#cbd5e1", "#27272a"],
    },
  ];

  /** Not a colour, so not a swatch row — but it stays in the same list, because
   *  `consent-surfaces.test.ts` reads this file to prove every `THEME_KEYS`
   *  entry has a field an operator can reach. A key that moved out of the list
   *  into its own control is exactly the drift that check exists to catch. */
  const RADIUS_FIELD = {
    key: "radius",
    label: t`Corner radius`,
    placeholder: "10px",
    options: [
      { value: "", label: t`Default (10px)` },
      { value: "0px", label: t`Square` },
      { value: "6px", label: t`6px` },
      { value: "10px", label: t`10px` },
      { value: "16px", label: t`16px` },
      { value: "999px", label: t`Fully rounded` },
    ],
  };

  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  // `undefined`, never "". The admin Select maps an empty string to a sentinel
  // meaning "this option IS selected", so `value=""` renders a trigger that is
  // blank AND suppresses the placeholder — two unlabelled dropdowns on the one
  // form where the operator most needs to be told they must choose.
  const [undecided, setUndecided] = useState<string | undefined>(undefined);
  const [tracker, setTracker] = useState<string | undefined>(undefined);
  // Unlike the two above this one has a real default, so it is a plain string
  // rather than `string | undefined` — there is no "unset" to represent.
  const [signals, setSignals] = useState<string>("tracker");
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
  // The presets the server offers, and which one was last applied. `applied` is
  // presentational ONLY — it drives the caveat below and is never saved, because
  // a stored preset would be an applied preset and the operator's Save would
  // stop being the thing that decides.
  const presets = useSuggestedPostures().data?.data ?? [];
  const [applied, setApplied] = useState<string | undefined>(undefined);

  // Seeded in render rather than an effect, matching SiteSettingsDialog: it
  // keeps the dialog a pure function of props and avoids the StrictMode
  // double-effect this codebase has been bitten by.
  if (site && loadedFor !== site.id) {
    setLoadedFor(site.id);
    setUndecided(policy?.undecidedBehaviour ?? undefined);
    setTracker(policy?.trackerCategory ?? undefined);
    setSignals(policy?.signalHandling ?? "tracker");
    setCats(policy?.categoriesOffered ?? []);
    setPosition(policy?.position ?? "bottom");
    setPolicyUrl(policy?.policyUrl ?? "");
    setMaxAge(String(policy?.cookieMaxAgeDays ?? 180));
    setEnabled(policy?.enabled ?? false);
    setDefaultLocale(policy?.defaultLocale ?? "en");
    setWording(policy?.wording ?? {});
    setTheme(policy?.theme ?? {});
    setEditLocale(policy?.defaultLocale ?? "en");
    // Reopening on another site must not carry a chip that describes the
    // previous one's fields.
    setApplied(undefined);
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
  /**
   * Apply a preset to the FORM, and to nothing else.
   *
   * Unlike `useSuggested` below this deliberately DOES overwrite the posture
   * Selects — the operator picked a control named after a regime, so leaving
   * their old answer in place would be the surprising outcome. What it must not
   * touch is `wording`: that map is per locale, so moving `defaultLocale` to
   * `tr` has to leave an authored `en` block exactly where it was.
   *
   * It never calls `savePolicy`. The operator watches four controls move and
   * presses Save themselves, which is the whole reason there is no endpoint
   * that applies one — see `suggestedPostures()` in `services/consent.ts`.
   */
  const applyPreset = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    setUndecided(preset.policy.undecidedBehaviour);
    setTracker(preset.policy.trackerCategory);
    setSignals(preset.policy.signalHandling);
    setCats([...preset.policy.categoriesOffered]);
    setDefaultLocale(preset.policy.defaultLocale);
    setEditLocale(preset.policy.defaultLocale);
    setApplied(id);
  };

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

  /**
   * Wrap a setter so touching a preset-owned control drops the preset label.
   *
   * `applied` drives the trigger text and the caveat underneath it. Editing one
   * of the five controls a preset writes used to leave both in place, so the
   * form claimed to be "GDPR / ePrivacy" while no longer matching it — and
   * because Radix only fires `onValueChange` on a CHANGE, re-picking the same
   * preset to get back was a no-op.
   */
  const manual =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      setApplied(undefined);
      set(v);
    };

  const toggleCat = (c: string) => {
    setApplied(undefined);
    setCats((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));
  };

  /** The server accepts any http(s) URL and refuses everything else — after the
   *  dialog has already closed optimistically, which is the worst moment to
   *  learn it. Checked here so the field can say so while it is on screen. */
  const urlOk = !policyUrl.trim() || /^https?:\/\//i.test(policyUrl.trim());
  const ready = Boolean(undecided && tracker) && urlOk;

  /** Every locale this policy actually has text for, plus the two the banner
   *  ships built in. A policy written through the SDK with `defaultLocale: "de"`
   *  used to highlight no tab at all, and one click on `en` made the German
   *  block uneditable while it was still being served. */
  const locales = Array.from(
    new Set<string>([...BUILTIN_LOCALES, defaultLocale, ...Object.keys(wording)]),
  ).filter(Boolean);

  const localeOptions = locales.map((l) => ({
    value: l,
    label: l === "en" ? t`English` : l === "tr" ? t`Turkish` : l,
  }));

  /** The four presets, plus whatever is stored if it is not one of them — a
   *  policy set to 30 days through the API rendered as an unset Select. */
  const MAX_AGE_OPTIONS = [
    { value: "90", label: t`90 days` },
    { value: "180", label: t`180 days`, hint: t`Matches the CNIL's six-month guidance.` },
    { value: "365", label: t`365 days` },
    { value: "730", label: t`730 days` },
  ];
  const maxAgeOptions = MAX_AGE_OPTIONS.some((o) => o.value === maxAge)
    ? MAX_AGE_OPTIONS
    : [...MAX_AGE_OPTIONS, { value: maxAge, label: t`${maxAge} days` }];

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
            {presets.length > 0 && (
              <label className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[12.5px] text-muted-foreground">
                  <Trans>Start from a preset</Trans>
                </span>
                {/* Label only. `appliesTo` is two sentences, and as a Select
                    `hint` it is rendered inline in the row — which made the
                    menu grow to the width of its longest sentence: a list
                    1800px wide on a desktop. A hint is a qualifier; a paragraph
                    goes under the field, where it can wrap. */}
                <Select
                  className="min-w-0"
                  value={applied}
                  onChange={(v) => v && applyPreset(v)}
                  placeholder={t`Optional — fills the fields below`}
                  options={presets.map((p) => ({ value: p.id, label: p.label }))}
                />
                <span className="text-[11.5px] text-muted-foreground">
                  {applied ? (
                    <>
                      {presets.find((p) => p.id === applied)?.appliesTo}{" "}
                      {presets.find((p) => p.id === applied)?.caveat}
                    </>
                  ) : (
                    <Trans>
                      Fills the fields below so you can check them. Nothing is saved until
                      you press Save, and a preset is never matched against a visitor —
                      one site has one policy.
                    </Trans>
                  )}
                </span>
              </label>
            )}

            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Before a visitor decides</Trans>
              </span>
              <Select
                className="min-w-0"
                value={undecided}
                onChange={manual(setUndecided)}
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
                onChange={manual(setTracker)}
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

            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Global Privacy Control &amp; Do Not Track</Trans>
              </span>
              <Select
                className="min-w-0"
                value={signals}
                onChange={manual((v: string) => setSignals(v || "tracker"))}
                options={[
                  {
                    value: "tracker",
                    label: t`Stop backlex's tag only`,
                    hint: t`What your site does today. Your other tags are governed by consent alone.`,
                  },
                  {
                    value: "all",
                    label: t`Stop every optional tag`,
                    hint: t`Treats the signals as a refusal for every category, so third-party tags stop too. This is the CCPA reading — and it will stop pixels that fire today.`,
                  },
                  {
                    value: "off",
                    label: t`Ignore both signals`,
                    hint: t`Neither is read. Do Not Track is a standard the W3C retired; Global Privacy Control is not, and in California it carries legal weight.`,
                  },
                ]}
              />
            </label>

            <div className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>Categories the banner offers</Trans>
              </span>
              {/* `aria-pressed` because the only other signal that a category
                  is offered is the fill colour, so a screen reader heard three
                  identically-named buttons and no state. */}
              <div className="flex flex-wrap items-center gap-1.5">
                {CATEGORIES.map((c) => (
                  <Button
                    key={c}
                    variant={cats.includes(c) ? "primary" : "outline"}
                    aria-pressed={cats.includes(c)}
                    onClick={() => toggleCat(c)}
                  >
                    {catLabels[c] ?? c}
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
              {urlOk ? (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>Linked from the banner. Leave it blank for no link.</Trans>
                </span>
              ) : (
                // Caught here rather than by the server: `setEditing(null)` has
                // already closed this dialog by the time a refusal comes back,
                // so the message lands over a page the operator has left.
                <span className="text-[11.5px] text-destructive">
                  <Trans>Start it with http:// or https:// — the banner needs a full URL.</Trans>
                </span>
              )}
            </label>

            <label className="flex min-w-0 flex-col gap-1.5">
              <span className="text-[12.5px] text-muted-foreground">
                <Trans>How long a decision stands</Trans>
              </span>
              {/* One unit for all four. It used to read 90 days / 180 days /
                  1 year / 2 years, so two of the options could not be compared
                  against the other two without arithmetic. */}
              <Select
                className="min-w-0"
                value={maxAge}
                onChange={setMaxAge}
                options={maxAgeOptions}
              />
              <span className="text-[11.5px] text-muted-foreground">
                <Trans>
                  How long before the banner asks again. A visitor can change their
                  answer at any time from the withdraw link.
                </Trans>
              </span>
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
                options={localeOptions}
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
                  aria-pressed={openSection === "wording"}
                  icon={I.Type}
                  onClick={() => setOpenSection(openSection === "wording" ? "none" : "wording")}
                >
                  <Trans>Wording</Trans>
                </Button>
                <Button
                  variant={openSection === "theme" ? "primary" : "outline"}
                  aria-pressed={openSection === "theme"}
                  icon={I.Palette}
                  onClick={() => setOpenSection(openSection === "theme" ? "none" : "theme")}
                >
                  <Trans>Appearance</Trans>
                </Button>
              </div>

              {openSection === "wording" && (
                <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {localeOptions.map((l) => (
                      <Button
                        key={l.value}
                        variant={editLocale === l.value ? "primary" : "outline"}
                        aria-pressed={editLocale === l.value}
                        onClick={() => setEditLocale(l.value)}
                      >
                        {l.label}
                      </Button>
                    ))}
                    <Button variant="outline" onClick={useSuggested}>
                      <Trans>Fill the blanks</Trans>
                    </Button>
                  </div>
                  {WORDING_FIELDS.map((f) => (
                    <label key={f.key} className="flex min-w-0 flex-col gap-1">
                      <span className="text-[12.5px] text-muted-foreground">{f.label}</span>
                      {f.multiline ? (
                        <Textarea
                          rows={2}
                          className="min-h-0"
                          value={wording[editLocale]?.[f.key] ?? ""}
                          placeholder={BUILTIN_STRINGS[editLocale]?.[f.key] ?? ""}
                          onChange={(e) => setWord(f.key, e.target.value)}
                        />
                      ) : (
                        <Input
                          value={wording[editLocale]?.[f.key] ?? ""}
                          placeholder={BUILTIN_STRINGS[editLocale]?.[f.key] ?? ""}
                          onChange={(e) => setWord(f.key, e.target.value)}
                        />
                      )}
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

              {/* One column, not two. `sm:` is a VIEWPORT breakpoint, so a
                  two-column grid applies inside this 560px dialog on any
                  desktop — and each column is then ~180px, too narrow for a
                  swatch row, which wrapped onto a second line under every
                  field. Full width fits the row and the hex box side by side. */}
              {openSection === "theme" && (
                <div className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
                  {THEME_FIELDS.map((f) => {
                    const value = theme[f.key] ?? "";
                    const trimmed = value.trim();
                    // `parseTheme` drops a value it does not like SILENTLY and
                    // still answers 200, so a rejected accent colour looked
                    // saved until a full reload. Mirrored here so the field can
                    // say so before the save.
                    const ignored =
                      trimmed !== "" &&
                      (!SAFE_THEME_VALUE.test(trimmed) ||
                        trimmed.toLowerCase().includes("url(") ||
                        trimmed.length > 60);
                    // Label on its own line, then swatches + the exact value on
                    // one row. Laying the three out side by side made the hex
                    // box wrap under some fields and not others, depending on
                    // how many swatches that role offers.
                    return (
                      <div key={f.key} className="flex min-w-0 flex-col gap-1.5">
                        <span className="text-[12.5px] text-muted-foreground">{f.label}</span>
                        <div className="flex min-w-0 flex-wrap items-center gap-2">
                          <ColorSwatchPicker
                            options={f.swatches.map((sw) => ({
                              value: sw,
                              swatch: sw || f.placeholder,
                              label: sw === "" ? t`The banner's default` : sw,
                            }))}
                            value={value}
                            onChange={(v) => setTheme((prev) => ({ ...prev, [f.key]: v }))}
                          />
                          <Input
                            className="min-w-[120px] flex-1 font-mono text-[12px]"
                            value={value}
                            placeholder={f.placeholder}
                            aria-invalid={ignored ? true : undefined}
                            onChange={(e) =>
                              setTheme((prev) => ({ ...prev, [f.key]: e.target.value }))
                            }
                          />
                        </div>
                        {ignored && (
                          <span className="text-[11.5px] text-destructive">
                            <Trans>Not a CSS colour or length — this value is ignored.</Trans>
                          </span>
                        )}
                      </div>
                    );
                  })}
                  <label className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="text-[12.5px] text-muted-foreground">
                      {RADIUS_FIELD.label}
                    </span>
                    {/* A stored value outside the list keeps its own option, so
                        a radius set through the API reads as set rather than as
                        the placeholder. */}
                    <Select
                      className="w-[180px] shrink-0"
                      value={theme[RADIUS_FIELD.key] ?? ""}
                      onChange={(v) =>
                        setTheme((prev) => ({ ...prev, [RADIUS_FIELD.key]: v }))
                      }
                      options={
                        RADIUS_FIELD.options.some(
                          (o) => o.value === (theme[RADIUS_FIELD.key] ?? ""),
                        )
                          ? RADIUS_FIELD.options
                          : [
                              ...RADIUS_FIELD.options,
                              {
                                value: theme[RADIUS_FIELD.key] ?? "",
                                label: theme[RADIUS_FIELD.key] ?? "",
                              },
                            ]
                      }
                    />
                  </label>
                  <span className="text-[11.5px] text-muted-foreground">
                    <Trans>
                      Anything left blank uses the banner's default. Values are CSS
                      colours and lengths; the banner refuses anything that is not.
                    </Trans>
                  </span>
                </div>
              )}
            </div>

            {/* One boolean, one control — and the same two words the card uses
                for it. Two buttons reading "Live"/"Off" set a state the card
                then read back as "Banner live"/"Not shown". */}
            {/* `pr-3` is load-bearing, not spacing. The Switch paints an
                invisible hit target 12px wider than itself on each side
                (`after:-inset-x-3` in the design system, there so a 20px-tall
                control still has a thumb-sized target). Flush against the right
                edge of the dialog's scroll container that overflow becomes a
                horizontal scrollbar across the whole form — 10px of sideways
                scroll that clips every label on the left. */}
            <label className="flex min-w-0 items-start justify-between gap-3 border-t pr-3 pt-4">
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium">
                  <Trans>Show the banner</Trans>
                </span>
                <span className="block text-[11.5px] text-muted-foreground">
                  {enabled ? (
                    <Trans>Live — visitors are asked, and your choices above apply.</Trans>
                  ) : (
                    <Trans>
                      Not shown — nothing is asked and nothing is blocked, whatever is
                      set above.
                    </Trans>
                  )}
                </span>
              </span>
              <Switch checked={enabled} onChange={setEnabled} />
            </label>
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
                signalHandling: signals as "tracker" | "all" | "off",
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
