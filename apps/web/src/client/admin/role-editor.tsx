// @ts-nocheck
// Role editor dialog
import { useEffect, useMemo, useState } from "react";
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
          <DialogTitle>{isNew ? "New role" : `Edit ${role?.name || "role"}`}</DialogTitle>
          <DialogDescription>
            {isSystem
              ? "System role — name is read-only; permissions still editable."
              : "Custom roles layer additively on top of authenticated."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Name</label>
            <Input value={name} disabled={isSystem} onChange={(e) => setName(e.target.value.replace(/[^a-z0-9_-]/g, "_"))} placeholder="editor" />
            <span className="font-mono text-[11.5px] text-muted-foreground">lowercase, snake_case</span>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this role can do…" />
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Permissions (per action)</label>
            <div className="overflow-hidden rounded-xl border border-border">
              {ACTIONS.map((a, i) => (
                <div
                  key={a}
                  className={`grid grid-cols-[110px_1fr] items-center gap-2.5 px-3 py-2.5 max-[640px]:grid-cols-[1fr] max-[640px]:gap-y-2 ${i === 0 ? "" : "border-t border-border"}`}
                >
                  <span className="font-mono text-[12.5px] font-medium">{a}</span>
                  <div className="flex flex-wrap gap-1">
                    {[
                      { v: "none", label: "no access" },
                      { v: "owner", label: "owner only" },
                      { v: "auth", label: "any signed-in" },
                      { v: "published", label: "published only" },
                      { v: "all", label: "everyone" },
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
            <label className="flex items-center gap-2 text-[12.5px] font-medium text-foreground">Compiled rule</label>
            <pre className="m-0 max-w-full overflow-x-auto whitespace-pre rounded-xl bg-[oklch(from_var(--primary)_0.18_0.01_h)] p-3.5 font-mono text-[11.5px] leading-[1.55] text-[oklch(from_var(--primary)_0.95_0.02_h)]">{compiled}</pre>
            <span className="text-[11.5px] text-muted-foreground">Generated DSL — saved to <span className="font-mono">role_permissions</span> on save.</span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
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
            {isNew ? "Create role" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
