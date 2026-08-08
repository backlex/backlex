
import { Trans, useLingui } from "@lingui/react/macro";
import { Card } from "@backlex/ui/components/card";
import { Input } from "@backlex/ui/components/input";
import { Label } from "@backlex/ui/components/label";
import { Switch } from "@backlex/ui/components/switch";
import { I } from "../../../icons";
import { Select } from "../../../select";
import { Button, } from "../../../ui";
import {
  type ApiBookingQuestion,
} from "../../../api";
import { asOneOf } from "../../../types";
import { MAX_QUESTIONS, QUESTION_TYPES, blankQuestion, questionName, } from "./questions";

export function QuestionsTab({
  questions,
  storedNames,
  editQuestions,
}: {
  questions: ApiBookingQuestion[];
  storedNames: Set<string>;
  editQuestions: (fn: (arr: ApiBookingQuestion[]) => ApiBookingQuestion[]) => void;
}) {
  const { t } = useLingui();
  return (
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0">
            <div className="text-sm font-medium">
              <Trans>Intake questions</Trans>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              <Trans>
                What the booker is asked beyond name, email and phone. The answers ride along with
                the booking and can be mapped into the mirrored collection.
              </Trans>
            </p>
          </div>
          <Button
            variant="outline"
            className="ml-auto"
            disabled={questions.length >= MAX_QUESTIONS}
            onClick={() => editQuestions((arr) => [...arr, blankQuestion()])}
          >
            <I.Plus className="size-4" />
            <span className="max-sm:sr-only">
              <Trans>Add question</Trans>
            </span>
          </Button>
        </div>

        {questions.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
            <Trans>No questions — the page asks only for name, email and phone.</Trans>
          </p>
        ) : (
          questions.map((q, i) => {
            const locked = storedNames.has(q.name);
            const patch = (next: Partial<ApiBookingQuestion>) =>
              editQuestions((arr) => arr.map((x, j) => (j === i ? { ...x, ...next } : x)));
            return (
              <div key={i} className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_170px_auto]">
                <div className="grid min-w-0 gap-1">
                  <Input
                    value={q.label ?? ""}
                    onChange={(e) =>
                      patch({
                        label: e.target.value,
                        // A question nobody has answered yet still has its
                        // name follow the label; once answers exist the name
                        // is frozen.
                        ...(locked ? {} : { name: questionName(e.target.value) }),
                      })
                    }
                    placeholder={t`Reason for visit`}
                  />
                  {q.name && (
                    <p className="truncate font-mono text-[11px] text-muted-foreground">{q.name}</p>
                  )}
                </div>
                <Select
                  value={q.type ?? "text"}
                  onChange={(v) => patch({ type: asOneOf(QUESTION_TYPES, v, "text") })}
                  className="min-w-0"
                  options={[
                    { value: "text", label: t`Short text` },
                    { value: "textarea", label: t`Long text` },
                    { value: "select", label: t`Choice` },
                    { value: "boolean", label: t`Yes / no` },
                  ]}
                />
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <Switch
                      id={`bk-q-req-${i}`}
                      checked={q.required === true}
                      onCheckedChange={(v) => patch({ required: v })}
                    />
                    <Label htmlFor={`bk-q-req-${i}`} className="text-xs">
                      <Trans>Required</Trans>
                    </Label>
                  </div>
                  <Button
                    variant="outline"
                    className="ml-auto"
                    onClick={() => editQuestions((arr) => arr.filter((_, j) => j !== i))}
                  >
                    <I.Trash className="size-4" />
                    <span className="sr-only">
                      <Trans>Remove question</Trans>
                    </span>
                  </Button>
                </div>
                {q.type === "select" && (
                  <div className="grid gap-1 sm:col-span-3">
                    <Input
                      value={(q.options ?? []).join(", ")}
                      onChange={(e) =>
                        // Empty entries survive the keystroke on purpose —
                        // dropping them here would eat the comma the operator
                        // just typed. `bodyOf` filters them on the way out.
                        patch({ options: e.target.value.split(",").map((o) => o.trim()) })
                      }
                      placeholder={t`Check-up, Follow-up, Emergency`}
                    />
                    <p className="text-xs text-muted-foreground">
                      <Trans>Comma-separated. The page offers exactly these.</Trans>
                    </p>
                  </div>
                )}
              </div>
            );
          })
        )}
      </Card>
  );
}
