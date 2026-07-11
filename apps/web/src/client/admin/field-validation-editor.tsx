// @ts-nocheck
// Shared per-field validation editor — rendered in the "Settings" step of both
// the Add-field and Edit-field dialogs. Surfaces the type-appropriate subset of
// `FieldValidation` (length / bounds / format / date bounds / cardinality),
// a custom error message, and an "Advanced" cross-field rule built with the
// same RuleBuilder the conditions panel uses (values reference siblings via
// `$field.<name>`). The parent owns a `ValDraft`; `compileValidation` turns it
// into the `validation` object sent to POST/PATCH.
import { type ReactNode, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { I } from "./icons";
import { Select } from "./select";
import {
  type GroupNode,
  newGroup,
  objToTree,
  RuleBuilder,
  ruleTreeToObj,
  treeHasRule,
} from "./rule-builder";

export interface ValDraft {
  minLength: string;
  maxLength: string;
  min: string;
  max: string;
  integer: boolean;
  format: string; // "" | "email" | "url"
  regex: string;
  minDate: string;
  maxDate: string;
  minSelect: string;
  maxSelect: string;
  message: string;
  severity: string; // "error" | "warning" | "info"
  ruleTree: GroupNode;
}

export const emptyValDraft = (): ValDraft => ({
  minLength: "",
  maxLength: "",
  min: "",
  max: "",
  integer: false,
  format: "",
  regex: "",
  minDate: "",
  maxDate: "",
  minSelect: "",
  maxSelect: "",
  message: "",
  severity: "error",
  ruleTree: newGroup("and"),
});

/** Hydrate a draft from a stored `validation` object (Edit dialog). */
export const validationToDraft = (v: unknown): ValDraft => {
  const d = emptyValDraft();
  if (!v || typeof v !== "object") return d;
  const o = v as Record<string, unknown>;
  const s = (x: unknown) => (x === undefined || x === null ? "" : String(x));
  d.minLength = s(o.minLength);
  d.maxLength = s(o.maxLength);
  d.min = s(o.min);
  d.max = s(o.max);
  d.integer = !!o.integer;
  d.format = typeof o.format === "string" ? o.format : "";
  d.regex = s(o.regex);
  d.minDate = s(o.minDate);
  d.maxDate = s(o.maxDate);
  d.minSelect = s(o.minSelect);
  d.maxSelect = s(o.maxSelect);
  d.message = s(o.message);
  d.severity = typeof o.severity === "string" ? o.severity : "error";
  d.ruleTree = o.rule ? objToTree(o.rule) : newGroup("and");
  return d;
};

const numOrUndef = (x: string): number | undefined => {
  const t = x.trim();
  if (t === "") return undefined;
  const n = Number(t);
  return Number.isNaN(n) ? undefined : n;
};

/** Compile a draft into the `validation` object (or undefined when empty). */
export const compileValidation = (
  d: ValDraft,
  type: string,
): Record<string, unknown> | undefined => {
  const out: Record<string, unknown> = {};
  const textish = type === "text" || type === "longtext" || type === "hash";
  const numeric = type === "integer" || type === "number";
  if (textish) {
    const a = numOrUndef(d.minLength);
    const b = numOrUndef(d.maxLength);
    if (a !== undefined) out.minLength = a;
    if (b !== undefined) out.maxLength = b;
    if (d.format === "email" || d.format === "url") out.format = d.format;
    if (d.regex.trim()) out.regex = d.regex.trim();
  }
  if (numeric) {
    const a = numOrUndef(d.min);
    const b = numOrUndef(d.max);
    if (a !== undefined) out.min = a;
    if (b !== undefined) out.max = b;
    if (d.integer) out.integer = true;
  }
  if (type === "timestamp") {
    // A bound is an ISO string, "$now", or an epoch-ms number — keep the epoch
    // numeric, otherwise pass the string through (the server parses it).
    const bound = (x: string): string | number | undefined => {
      const t = x.trim();
      if (t === "") return undefined;
      if (/^\d+$/.test(t)) return Number(t);
      return t;
    };
    const a = bound(d.minDate);
    const b = bound(d.maxDate);
    if (a !== undefined) out.minDate = a;
    if (b !== undefined) out.maxDate = b;
  }
  if (type === "relation_many") {
    const a = numOrUndef(d.minSelect);
    const b = numOrUndef(d.maxSelect);
    if (a !== undefined) out.minSelect = a;
    if (b !== undefined) out.maxSelect = b;
  }
  if (treeHasRule(d.ruleTree)) out.rule = ruleTreeToObj(d.ruleTree);
  if (d.message.trim()) out.message = d.message.trim();
  // Severity only matters alongside at least one actual check.
  if (d.severity && d.severity !== "error" && Object.keys(out).length) out.severity = d.severity;
  return Object.keys(out).length ? out : undefined;
};

/** True when a draft carries any per-value constraint (used to auto-open the
 *  Advanced panel and to show a summary badge). */
export const draftHasRule = (d: ValDraft): boolean => treeHasRule(d.ruleTree);

const FieldLabel = ({ children }: { children: ReactNode }) => (
  <label className="text-[11.5px] font-medium text-muted-foreground">{children}</label>
);

export function FieldValidationEditor({
  type,
  fields,
  value,
  onChange,
}: {
  type: string;
  /** Sibling field names — offered as `$field.<name>` in the cross-field rule. */
  fields: string[];
  value: ValDraft;
  onChange: (next: ValDraft) => void;
}) {
  const { t } = useLingui();
  const [advanced, setAdvanced] = useState(draftHasRule(value));
  const set = (patch: Partial<ValDraft>) => onChange({ ...value, ...patch });
  const textish = type === "text" || type === "longtext" || type === "hash";
  const numeric = type === "integer" || type === "number";
  const fieldVars = fields.map((f) => ({ v: `$field.${f}`, desc: t`value of ${f}` }));

  return (
    <div className="flex flex-col gap-2.5 rounded-control bg-muted p-3">
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">
          <I.Shield size={13} /> <Trans>Validation</Trans>
        </span>
        <span className="text-[11.5px] text-muted-foreground">
          {value.severity === "error"
            ? <Trans>enforced on save (422)</Trans>
            : <Trans>advisory — returned as a warning, not blocking</Trans>}
        </span>
      </div>

      {textish && (
        <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Min length</Trans></FieldLabel>
            <Input inputMode="numeric" className="h-8" placeholder="—" value={value.minLength} onChange={(e) => set({ minLength: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Max length</Trans></FieldLabel>
            <Input inputMode="numeric" className="h-8" placeholder="—" value={value.maxLength} onChange={(e) => set({ maxLength: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Format</Trans></FieldLabel>
            <Select
              value={value.format}
              onChange={(v) => set({ format: v })}
              options={[
                { value: "", label: t`None` },
                { value: "email", label: t`Email` },
                { value: "url", label: t`URL` },
              ]}
              size="sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Pattern (regex)</Trans></FieldLabel>
            <Input className="h-8 font-mono" placeholder="^[A-Z].*" value={value.regex} onChange={(e) => set({ regex: e.target.value })} />
          </div>
        </div>
      )}

      {numeric && (
        <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Min</Trans></FieldLabel>
            <Input inputMode="decimal" className="h-8" placeholder="—" value={value.min} onChange={(e) => set({ min: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Max</Trans></FieldLabel>
            <Input inputMode="decimal" className="h-8" placeholder="—" value={value.max} onChange={(e) => set({ max: e.target.value })} />
          </div>
          {type === "number" && (
            <label className="col-span-2 flex cursor-pointer items-center gap-2 text-[12px] text-foreground max-[520px]:col-span-1">
              <input type="checkbox" checked={value.integer} onChange={(e) => set({ integer: e.target.checked })} />
              <Trans>Whole numbers only (no decimals)</Trans>
            </label>
          )}
        </div>
      )}

      {type === "timestamp" && (
        <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Earliest</Trans></FieldLabel>
            <Input className="h-8" placeholder={t`ISO or $now`} value={value.minDate} onChange={(e) => set({ minDate: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Latest</Trans></FieldLabel>
            <Input className="h-8" placeholder={t`ISO or $now`} value={value.maxDate} onChange={(e) => set({ maxDate: e.target.value })} />
          </div>
          <span className="col-span-2 text-[11px] text-muted-foreground max-[520px]:col-span-1">
            <Trans>Accepts an ISO date, epoch-ms, or <span className="font-mono">$now</span>.</Trans>
          </span>
        </div>
      )}

      {type === "relation_many" && (
        <div className="grid grid-cols-2 gap-2 max-[520px]:grid-cols-1">
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Min selected</Trans></FieldLabel>
            <Input inputMode="numeric" className="h-8" placeholder="—" value={value.minSelect} onChange={(e) => set({ minSelect: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <FieldLabel><Trans>Max selected</Trans></FieldLabel>
            <Input inputMode="numeric" className="h-8" placeholder="—" value={value.maxSelect} onChange={(e) => set({ maxSelect: e.target.value })} />
          </div>
        </div>
      )}

      <div className="grid grid-cols-[1fr_9rem] gap-2 max-[520px]:grid-cols-1">
        <div className="flex flex-col gap-1">
          <FieldLabel><Trans>Custom message (optional)</Trans></FieldLabel>
          <Input className="h-8" placeholder={t`Shown instead of the default message`} value={value.message} onChange={(e) => set({ message: e.target.value })} />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel><Trans>Severity</Trans></FieldLabel>
          <Select
            value={value.severity}
            onChange={(v) => set({ severity: v })}
            options={[
              { value: "error", label: t`Error (blocks)` },
              { value: "warning", label: t`Warning` },
              { value: "info", label: t`Info` },
            ]}
            size="sm"
          />
        </div>
      </div>

      <div className="border-t border-border pt-2">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setAdvanced((a) => !a)}
        >
          {advanced ? <I.ChevronDown size={13} /> : <I.ChevronRight size={13} />}
          <Trans>Advanced — cross-field rule</Trans>
          {draftHasRule(value) && <span className="ml-1 rounded-sm bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary"><Trans>active</Trans></span>}
        </button>
        {advanced && (
          <div className="mt-2 flex flex-col gap-1.5">
            <span className="text-[11px] text-muted-foreground">
              <Trans>The row is rejected unless this matches. Reference another field's value with <span className="font-mono">$field.name</span> (e.g. <span className="font-mono">end_date ≥ $field.start_date</span>).</Trans>
            </span>
            <RuleBuilder
              tree={value.ruleTree}
              onChange={(tree) => set({ ruleTree: tree })}
              fields={fields}
              extraVars={fieldVars}
            />
          </div>
        )}
      </div>
    </div>
  );
}
