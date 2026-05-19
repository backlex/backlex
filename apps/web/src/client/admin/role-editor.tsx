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

        <div className="min-w-0" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="field">
            <label className="field-label">Name</label>
            <Input value={name} disabled={isSystem} onChange={(e) => setName(e.target.value.replace(/[^a-z0-9_-]/g, "_"))} placeholder="editor" />
            <span className="field-hint font-mono">lowercase, snake_case</span>
          </div>

          <div className="field">
            <label className="field-label">Description</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this role can do…" />
          </div>

          <div className="field">
            <label className="field-label">Permissions (per action)</label>
            <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius-xl)", overflow: "hidden" }}>
              {ACTIONS.map((a, i) => (
                <div
                  key={a}
                  className="role-action-row"
                  style={{ borderTop: i === 0 ? 0 : "1px solid var(--border)" }}
                >
                  <span className="font-mono" style={{ fontSize: 12.5, fontWeight: 500 }}>{a}</span>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
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
                        className={`chip ${rule[a] === opt.v ? "active" : ""}`}
                        style={{ fontSize: 11.5 }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field-label">Compiled rule</label>
            <pre className="alter-preview" style={{ fontSize: 11.5, margin: 0, whiteSpace: "pre", overflowX: "auto", maxWidth: "100%" }}>{compiled}</pre>
            <span className="field-hint">Generated DSL — saved to <span className="font-mono">role_permissions</span> on save.</span>
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
