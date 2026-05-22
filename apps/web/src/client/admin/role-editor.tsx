// @ts-nocheck
// Role editor dialog
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "./ui";
import { Input } from "@workeros/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workeros/ui/components/dialog";

const ACTIONS = ["read", "create", "update", "delete"] as const;

export type RuleState = "all" | "none" | "auth" | "owner" | "published";
export type RoleMatrix = Record<typeof ACTIONS[number], RuleState>;

export interface RoleData {
  name: string;
  system?: boolean;
  description?: string;
  badges?: string[];
  matrix?: RoleMatrix;
  rule?: string;
}

export function defaultRoleRule(): RoleMatrix {
  return { read: "all", create: "auth", update: "owner", delete: "owner" };
}

export function ruleSummary(rule: RoleMatrix) {
  return ACTIONS.map((a) => `${a}: ${rule[a]}`).join(" · ");
}

export function compileRule(rule: RoleMatrix) {
  const parts: string[] = [];
  for (const a of ACTIONS) {
    const v = rule[a];
    if (v === "none") parts.push(`${a}: { _deny: true }`);
    else if (v === "all") parts.push(`${a}: {}`);
    else if (v === "auth") parts.push(`${a}: { _userIsAuthenticated: true }`);
    else if (v === "owner") parts.push(`${a}: { owner_id: { _eq: "$user.id" } }`);
    else if (v === "published") parts.push(`${a}: { status: { _eq: "published" } }`);
  }
  return "{\n  " + parts.join(",\n  ") + "\n}";
}

export interface RoleEditorProps {
  open: boolean;
  role: RoleData | null;
  isNew: boolean;
  onClose: () => void;
  onSave: (data: RoleData) => void;
}

export function RoleEditor({ open, role, isNew, onClose, onSave }: RoleEditorProps) {
  const { t } = useLingui();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [rule, setRule] = useState<RoleMatrix>(defaultRoleRule());

  useEffect(() => {
    if (!open) return;
    setName(role?.name || "");
    setDescription(role?.description || "");
    setRule(role?.matrix || defaultRoleRule());
  }, [open, role]);

  const compiled = useMemo(() => compileRule(rule), [rule]);
  const isSystem = role?.system;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto overflow-x-hidden [grid-template-columns:minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>{isNew ? <Trans>New role</Trans> : <Trans>Edit {role?.name || "role"}</Trans>}</DialogTitle>
          <DialogDescription>
            {isSystem
              ? <Trans>System role — name is read-only; permissions still editable.</Trans>
              : <Trans>Custom roles layer additively on top of authenticated.</Trans>}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Name</Trans></label>
            <Input value={name} disabled={isSystem} onChange={(e) => setName(e.target.value.replace(/[^a-z0-9_-]/g, "_"))} placeholder={t`editor`} />
            <span className="font-mono text-[11.5px] text-muted-foreground"><Trans>lowercase, snake_case</Trans></span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Description</Trans></label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t`What this role can do…`} />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Permissions (per action)</Trans></label>
            <div className="overflow-hidden rounded-xl border border-border">
              {ACTIONS.map((a, i) => (
                <div
                  key={a}
                  className={`grid grid-cols-[110px_1fr] items-center gap-2.5 px-3 py-2.5 max-[640px]:grid-cols-[1fr] max-[640px]:gap-y-2 ${i === 0 ? "" : "border-t border-border"}`}
                >
                  <span className="font-mono text-[12.5px] font-medium">{a}</span>
                  <div className="flex flex-wrap gap-1">
                    {[
                      { v: "none", label: t`no access` },
                      { v: "owner", label: t`owner only` },
                      { v: "auth", label: t`any signed-in` },
                      { v: "published", label: t`published only` },
                      { v: "all", label: t`everyone` },
                    ].map((opt) => (
                      <button
                        key={opt.v}
                        type="button"
                        onClick={() => setRule((r) => ({ ...r, [a]: opt.v as RuleState }))}
                        className={`inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-3xl border px-[11px] text-[11.5px] text-foreground hover:bg-accent ${rule[a] === opt.v ? "border-[color-mix(in_oklch,var(--foreground)_22%,var(--border))] bg-accent" : "border-border bg-card"}`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground"><Trans>Compiled rule</Trans></label>
            <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-xl bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-[11.5px] leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)]">{compiled}</pre>
            <span className="text-[11.5px] text-muted-foreground"><Trans>Generated DSL — saved to <span className="font-mono">role_permissions</span> on save.</Trans></span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}><Trans>Cancel</Trans></Button>
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={() => onSave({
              name: name.trim(),
              description,
              matrix: rule,
              system: isSystem || false,
              rule: ruleSummary(rule),
            })}
          >
            {isNew ? <Trans>Create role</Trans> : <Trans>Save changes</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
