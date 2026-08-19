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
}: {
  site: ApiAnalyticsSite | null;
  policy: ApiConsentPolicy | null;
  onClose: () => void;
  onSave: (patch: ApiConsentPolicyInput) => void;
}) {
  const { t } = useLingui();
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
  }

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
