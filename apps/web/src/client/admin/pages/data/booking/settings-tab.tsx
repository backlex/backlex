
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import { Switch } from "@backlex/ui/components/switch";
import { Textarea } from "@backlex/ui/components/textarea";
import { Select } from "../../../select";
import { ColorSwatchPicker } from "@/components/color-swatch-picker";
import {
  ACCENTS,
  type PublicAppearance,
} from "@/lib/public-theme";
import { asOneOf } from "../../../types";
import { PUBLIC_FONTS, PUBLIC_THEMES, } from "./parts";
import { DEFAULT_FORM, MIRROR_KEYS, } from "./records";
import { COMMON_ZONES, } from "./time";

export function SettingsTab({
  form,
  look,
  mirrorMap,
  recordTarget,
  customZone,
  setCustomZone,
  patchForm,
  editLook,
  editMirrorMap,
  collections,
}: {
  form: typeof DEFAULT_FORM;
  look: PublicAppearance;
  mirrorMap: Record<string, string>;
  recordTarget: string;
  customZone: boolean;
  setCustomZone: (on: boolean) => void;
  patchForm: (patch: Partial<typeof DEFAULT_FORM>) => void;
  editLook: (fn: (l: PublicAppearance) => PublicAppearance) => void;
  editMirrorMap: (fn: (m: Record<string, string>) => Record<string, string>) => void;
  collections: string[];
}) {
  const { t } = useLingui();
  return (
      <div className="flex flex-col gap-4">
        <Card className="gap-4 p-4">
          <div className="grid gap-1.5">
            <Label htmlFor="bk-name">
              <Trans>Name</Trans>
            </Label>
            <Input
              id="bk-name"
              value={form.name}
              onChange={(e) => patchForm({ name: e.target.value })}
              placeholder={t`Dr Yılmaz`}
            />
            <p className="text-xs text-muted-foreground">
              <Trans>Shown on the public page.</Trans>
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="bk-desc">
              <Trans>Description</Trans>
            </Label>
            <Textarea
              id="bk-desc"
              rows={2}
              value={form.description}
              onChange={(e) => patchForm({ description: e.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              <Trans>A line under the name, on the public page.</Trans>
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label>
              <Trans>Time zone</Trans>
            </Label>
            {customZone ? (
              <Input
                value={form.timeZone}
                onChange={(e) => patchForm({ timeZone: e.target.value })}
                placeholder="Europe/Istanbul"
              />
            ) : (
              <Select
                value={form.timeZone}
                onChange={(v) =>
                  v === "__custom" ? setCustomZone(true) : patchForm({ timeZone: v })
                }
                className="min-w-0"
                options={[
                  ...COMMON_ZONES.map((z) => ({ value: z, label: z })),
                  { value: "__custom", label: t`Custom…` },
                ]}
              />
            )}
            <p className="text-xs text-muted-foreground">
              <Trans>The zone the opening hours are written in — not a display preference.</Trans>
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["slotMinutes", t`Slot length`, t`Minutes one booking lasts.`],
                ["capacity", t`Capacity`, t`How many fit at once.`],
                ["holdMinutes", t`Hold`, t`Minutes an unconfirmed hold survives.`],
                ["bufferBeforeMinutes", t`Buffer before`, t`Protected minutes before each booking.`],
                ["bufferAfterMinutes", t`Buffer after`, t`Both sides apply, so 15+15 is a 30-minute gap.`],
                ["leadMinutes", t`Notice`, t`Minimum minutes of warning.`],
                ["horizonDays", t`Horizon`, t`How many days ahead the calendar is open.`],
              ] as const
            ).map(([field, label, hint]) => (
              <div key={field} className="grid gap-1.5">
                <Label htmlFor={`bk-${field}`}>{label}</Label>
                <Input
                  id={`bk-${field}`}
                  type="number"
                  inputMode="numeric"
                  value={form[field]}
                  onChange={(e) => patchForm({ [field]: e.target.value })}
                />
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card className="gap-4 p-4">
          <div className="grid gap-1.5">
            <Label>
              <Trans>Where bookings are recorded</Trans>
            </Label>
            <div className="flex items-center justify-between gap-3">
              <p className="min-w-0 text-sm">
                {form.mirrorEnabled ? (
                  <Trans>
                    Every booking is written as a row in{" "}
                    <span className="font-medium">{recordTarget}</span>, where permissions, flows
                    and exports apply to it as usual.
                  </Trans>
                ) : (
                  <Trans>
                    Bookings are not recorded anywhere but here. The ledger stays the only place
                    these customers exist.
                  </Trans>
                )}
              </p>
              <Switch
                checked={form.mirrorEnabled}
                onCheckedChange={(v) => patchForm({ mirrorEnabled: v })}
                aria-label={t`Record bookings into a collection`}
              />
            </div>
            {form.mirrorEnabled && !form.mirrorCollection.trim() ? (
              <p className="text-xs text-muted-foreground">
                <Trans>
                  The collection is created for you and kept in step — nothing to map. Editing a
                  row there does not move or cancel an appointment.
                </Trans>
              </p>
            ) : null}
          </div>

          {form.mirrorEnabled ? (
            <details className="group">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                <Trans>Record into a collection of my own instead</Trans>
              </summary>
              <div className="mt-3 grid gap-3">
                <Select
                  value={form.mirrorCollection}
                  onChange={(v) => patchForm({ mirrorCollection: v })}
                  className="min-w-0"
                  options={[
                    { value: "", label: t`The default collection` },
                    ...collections.map((c) => ({ value: c, label: c })),
                  ]}
                />
                {form.mirrorCollection ? (
                  <div className="grid gap-2">
                    <p className="text-xs text-muted-foreground">
                      <Trans>
                        Your collection, your column names — so each booking field needs one. A
                        target with no map records nothing, so saving without one is refused.
                      </Trans>
                    </p>
                    {MIRROR_KEYS.map((key) => (
                      <div key={key} className="grid grid-cols-[7rem_1fr] items-center gap-2">
                        <Label className="truncate text-xs text-muted-foreground">{key}</Label>
                        <Input
                          value={mirrorMap[key] ?? ""}
                          onChange={(e) =>
                            editMirrorMap((m) => {
                              const next = { ...m };
                              const column = e.target.value.trim();
                              if (column) next[key] = column;
                              else delete next[key];
                              return next;
                            })
                          }
                          placeholder={t`column name`}
                          className="min-w-0"
                        />
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            </details>
          ) : null}

          <div className="grid gap-1.5">
            <Label htmlFor="bk-confirm">
              <Trans>Confirmation message</Trans>
            </Label>
            <Textarea
              id="bk-confirm"
              rows={2}
              value={form.confirmationMessage}
              onChange={(e) => patchForm({ confirmationMessage: e.target.value })}
              placeholder={t`Please arrive ten minutes early.`}
            />
          </div>
        </Card>

        <Card className="gap-2 p-4">
          <Label>
            <Trans>Public page appearance</Trans>
          </Label>
          <p className="text-xs text-muted-foreground">
            <Trans>
              The booking page belongs on your site, so it takes your colours rather than ours.
              "Visitor's choice" follows each visitor's own light/dark setting — fine for a link
              you send, but pick a theme when you embed it, or a dark widget can land on a light
              page.
            </Trans>
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="bk-theme" className="text-xs text-muted-foreground">
                <Trans>Theme</Trans>
              </Label>
              <Select
                value={look.theme ?? ""}
                onChange={(v) =>
                  editLook(({ theme, ...rest }) => (v ? { ...rest, theme: asOneOf(PUBLIC_THEMES, v, "light") } : rest))
                }
                className="min-w-0"
                options={[
                  { value: "", label: t`Visitor's choice` },
                  { value: "dark", label: t`Dark` },
                  { value: "light", label: t`Light` },
                ]}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="bk-font" className="text-xs text-muted-foreground">
                <Trans>Font</Trans>
              </Label>
              <Select
                // No "default" entry, and unset shows as Manrope: that is
                // what the page now draws, and it is what the form's own
                // picker offers. A choice the panel does not name is a choice
                // an operator cannot see is being made.
                value={look.font ?? "sans"}
                onChange={(v) =>
                  editLook(({ font, ...rest }) => (v ? { ...rest, font: asOneOf(PUBLIC_FONTS, v, "sans") } : rest))
                }
                className="min-w-0"
                options={[
                  { value: "sans", label: "Manrope" },
                  { value: "lexend", label: "Lexend" },
                  { value: "mono", label: t`Mono` },
                  { value: "system", label: t`System` },
                ]}
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">
              <Trans>Accent</Trans>
            </Label>
            <ColorSwatchPicker
              options={[
                { value: "", swatch: "var(--muted-foreground)", label: t`Default` },
                ...ACCENTS.map((c) => ({ value: c, swatch: c })),
              ]}
              value={look.accent ?? ""}
              onChange={(accent) =>
                editLook(({ accent: _drop, ...rest }) => (accent ? { ...rest, accent } : rest))
              }
              showValue
            />
          </div>
        </Card>
      </div>
  );
}
