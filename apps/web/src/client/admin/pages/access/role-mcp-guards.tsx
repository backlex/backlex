// MCP guard section of the role editor: which tools members of a role may call
// over MCP, and whether they may call any write tool at all.
//
// Granularity here is deliberately the *namespace* (`collections.*`,
// `schema.*`), not the individual tool. A role answers "what job does this
// person do", and jobs map onto namespaces; per-tool pinning is a property of a
// specific credential and lives on the API key (Ask AI → Tools). The custom
// field below is the escape hatch for the cases that don't fit — exact ids and
// any pattern the API accepts round-trip through it untouched.
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Input } from "@backlex/ui/components/input";
import { Switch } from "@backlex/ui/components/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@backlex/ui/components/select";
import { Badge } from "@backlex/ui/components/badge";
import { api } from "@/lib/api";

/** `collections.*` → `collections`. Anything that isn't a namespace glob (an
 *  exact id, or the bare `*`) returns null and is carried in the custom list. */
const namespaceOf = (pattern: string): string | null =>
  pattern.endsWith(".*") ? pattern.slice(0, -2) : null;

export interface RoleMcpGuardsProps {
  /** Current allowlist; `null` = unrestricted. */
  mcpTools: string[] | null;
  mcpReadOnly: boolean;
  onChange: (next: { mcpTools: string[] | null; mcpReadOnly: boolean }) => void;
}

export function RoleMcpGuards({
  mcpTools,
  mcpReadOnly,
  onChange,
}: RoleMcpGuardsProps) {
  const { t } = useLingui();
  const [namespaces, setNamespaces] = useState<string[] | null>(null);

  // The namespace list is derived from the live tool catalog rather than
  // hard-coded, so a newly-added tool namespace shows up here without a UI edit.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const body = await api<{ result?: { tools: { name: string }[] } }>(
          "/api/admin/mcp",
          {
            method: "POST",
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          },
        );
        if (cancelled) return;
        const ns = new Set<string>();
        for (const tool of body.result?.tools ?? []) {
          const dot = tool.name.indexOf(".");
          if (dot > 0) ns.add(tool.name.slice(0, dot));
        }
        setNamespaces([...ns].sort((a, b) => a.localeCompare(b)));
      } catch {
        // Catalog unreachable — the custom field below still works, so the
        // section degrades to text entry rather than blocking the save.
        if (!cancelled) setNamespaces([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const restricted = mcpTools !== null;
  const selectedNamespaces = useMemo(
    () =>
      new Set(
        (mcpTools ?? [])
          .map(namespaceOf)
          .filter((n): n is string => n !== null),
      ),
    [mcpTools],
  );
  /** Entries that aren't namespace globs — exact ids, `*`, anything hand-typed. */
  const customEntries = useMemo(
    () => (mcpTools ?? []).filter((p) => namespaceOf(p) === null),
    [mcpTools],
  );
  const [customDraft, setCustomDraft] = useState("");
  useEffect(() => {
    setCustomDraft(customEntries.join(", "));
  }, [customEntries]);

  const setMode = (mode: string) => {
    onChange({
      mcpReadOnly,
      // Switching to "restricted" starts from an empty list — deny-by-default is
      // the only safe starting point for an allowlist, and the namespace
      // checkboxes right below make opening it back up a one-click job.
      mcpTools: mode === "restricted" ? (mcpTools ?? []) : null,
    });
  };

  const toggleNamespace = (ns: string, next: boolean) => {
    const glob = `${ns}.*`;
    const current = mcpTools ?? [];
    onChange({
      mcpReadOnly,
      mcpTools: next
        ? [...current, glob]
        : current.filter((p) => p !== glob),
    });
  };

  const commitCustom = () => {
    const parsed = customDraft
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onChange({
      mcpReadOnly,
      mcpTools: [
        ...(mcpTools ?? []).filter((p) => namespaceOf(p) !== null),
        ...parsed,
      ],
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-control border border-border p-3.5">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-foreground">
          <Trans>MCP access</Trans>
        </span>
        <Badge variant="outline">
          {restricted ? (
            <Trans>{(mcpTools ?? []).length} patterns</Trans>
          ) : (
            <Trans>unrestricted</Trans>
          )}
        </Badge>
      </div>
      <span className="text-[11.5px] text-muted-foreground">
        <Trans>
          Limits which MCP tools an AI agent may call on behalf of members of
          this role. Narrowing only — it never grants anything the permission
          rules above already deny.
        </Trans>
      </span>

      <div className="flex items-center justify-between gap-3">
        <label className="text-[12.5px] text-foreground">
          <Trans>Read-only over MCP</Trans>
        </label>
        <Switch
          checked={mcpReadOnly}
          onCheckedChange={(next) => onChange({ mcpTools, mcpReadOnly: next })}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label className="text-[12.5px] text-foreground">
          <Trans>Tool access</Trans>
        </label>
        <Select value={restricted ? "restricted" : "open"} onValueChange={setMode}>
          <SelectTrigger className="min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">{t`Every tool`}</SelectItem>
            <SelectItem value="restricted">{t`Only what I select`}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {restricted && (
        <>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="text-[12.5px] text-foreground">
              <Trans>Namespaces</Trans>
            </label>
            <div className="flex flex-wrap gap-1">
              {(namespaces ?? []).map((ns) => {
                const on = selectedNamespaces.has(ns);
                return (
                  <button
                    key={ns}
                    type="button"
                    onClick={() => toggleNamespace(ns, !on)}
                    className={`inline-flex h-7 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-control border px-[11px] font-mono text-[11.5px] text-foreground hover:bg-accent ${on ? "border-chip-border bg-accent" : "border-border bg-card"}`}
                  >
                    {ns}.*
                  </button>
                );
              })}
              {namespaces?.length === 0 && (
                <span className="text-[11.5px] text-muted-foreground">
                  <Trans>Tool catalog unavailable — use the field below.</Trans>
                </span>
              )}
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <label className="text-[12.5px] text-foreground">
              <Trans>Custom patterns</Trans>
            </label>
            <Input
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              onBlur={commitCustom}
              placeholder={t`collections.read, schema.describe_collection`}
            />
            <span className="text-[11.5px] text-muted-foreground">
              <Trans>
                Comma-separated exact tool ids. Use these when a whole namespace
                is too broad.
              </Trans>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
