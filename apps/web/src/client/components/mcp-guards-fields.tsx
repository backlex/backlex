/**
 * Shared MCP guard editor — the read-only toggle + per-tool allowlist grid.
 *
 * Used in two places so both stay in lockstep:
 *   - the "New API key" create form (`pages/api-keys.tsx`), inside a
 *     collapsible "MCP access" section, so guards are chosen *before* the
 *     key is minted;
 *   - the per-key "Connect MCP" modal (`components/mcp-key-modal.tsx`), for
 *     editing an existing key's guards after the fact.
 *
 * Allowlist semantics (must match `services/api-keys.ts::createApiKey` and
 * `routes/api-keys.ts`):
 *   - `null`  → permissive: every tool callable, subject to permissions.
 *   - `Set()` → deny-all: no MCP tool callable until a tool is ticked.
 *   - `Set(names)` → only the listed tools are callable.
 */
import { useEffect, useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import { Checkbox } from "@backlex/ui/components/checkbox";
import { Label } from "@backlex/ui/components/label";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";

export interface ToolDescriptor {
  name: string;
  description: string;
}

interface ToolsListResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { tools: ToolDescriptor[] };
}

/** Lazy-load the MCP tool catalog from `/api/admin/mcp` (`tools/list` over
 *  JSON-RPC) the first time `enabled` flips true. The admin session cookie is
 *  forwarded automatically by `api()`. */
export const useMcpTools = (enabled: boolean) => {
  const { t } = useLingui();
  const [tools, setTools] = useState<ToolDescriptor[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled || tools) return;
    setLoading(true);
    (async () => {
      try {
        const body = await api<ToolsListResponse>("/api/admin/mcp", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        setTools(body.result?.tools ?? []);
      } catch (e) {
        notifyError(e, t`Loading MCP tools`);
        setTools([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [enabled, tools, t]);

  return { tools, loading };
};

interface Props {
  readOnly: boolean;
  onReadOnlyChange: (v: boolean) => void;
  /** `null` = allow all; a `Set` = explicit allowlist (empty = deny all). */
  allowlist: Set<string> | null;
  onAllowlistChange: (next: Set<string> | null) => void;
  tools: ToolDescriptor[] | null;
  loading: boolean;
  /** Disambiguate `htmlFor`/`id` when more than one editor is on a page. */
  idPrefix?: string;
}

export const McpGuardsFields = ({
  readOnly,
  onReadOnlyChange,
  allowlist,
  onAllowlistChange,
  tools,
  loading,
  idPrefix = "mcp",
}: Props) => {
  const readonlyId = `${idPrefix}-readonly`;

  const groupedTools = useMemo(() => {
    if (!tools) return [] as Array<{ namespace: string; tools: ToolDescriptor[] }>;
    const groups = new Map<string, ToolDescriptor[]>();
    for (const tool of tools) {
      const dot = tool.name.indexOf(".");
      const namespace = dot < 0 ? "other" : tool.name.slice(0, dot);
      const bucket = groups.get(namespace) ?? [];
      bucket.push(tool);
      groups.set(namespace, bucket);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([namespace, tools]) => ({ namespace, tools }));
  }, [tools]);

  const toggleItem = (toolName: string) => {
    const next = new Set(allowlist ?? []);
    if (next.has(toolName)) next.delete(toolName);
    else next.add(toolName);
    onAllowlistChange(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
        <Checkbox
          id={readonlyId}
          checked={readOnly}
          onCheckedChange={(v) => onReadOnlyChange(v === true)}
          className="mt-0.5"
        />
        <div className="flex-1 space-y-1">
          <Label htmlFor={readonlyId} className="font-medium">
            <Trans>Read-only mode</Trans>
          </Label>
          <p className="text-xs text-muted-foreground">
            <Trans>
              Refuses every write tool through MCP for this key — the agent can
              read everything its permissions allow but cannot mutate.
            </Trans>
          </p>
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label className="font-medium">
            <Trans>Tool allowlist</Trans>
          </Label>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onAllowlistChange(null)}
            >
              <Trans>Allow all</Trans>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onAllowlistChange(new Set())}
            >
              <Trans>Block all</Trans>
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {allowlist === null ? (
            <Trans>
              Every MCP tool is callable, subject to permissions. Tick a tool
              below to narrow this key to an allowlist.
            </Trans>
          ) : (
            <Trans>
              {allowlist.size} of {tools?.length ?? 0} tools allowed. Choose
              Allow all to remove the allowlist.
            </Trans>
          )}
        </p>
        {loading && (
          <div className="flex flex-col gap-2 rounded-md border border-border/50 bg-muted/20 p-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="flex items-center gap-2">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-3.5 w-44" />
              </div>
            ))}
          </div>
        )}
        {tools && tools.length > 0 && (
          <div className="space-y-4">
            {groupedTools.map((group) => (
              <div key={group.namespace} className="space-y-1.5">
                <div className="text-xs font-medium uppercase text-muted-foreground">
                  {group.namespace}
                </div>
                <div className="grid grid-cols-1 gap-1 md:grid-cols-2">
                  {group.tools.map((tool) => {
                    const checked = allowlist === null ? true : allowlist.has(tool.name);
                    return (
                      <label
                        key={tool.name}
                        className="flex min-w-0 cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted/40"
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => {
                            if (allowlist === null) {
                              // Leaving "allow all" → seed the allowlist with
                              // every tool except the one being unticked.
                              const next = new Set(tools.map((x) => x.name));
                              next.delete(tool.name);
                              onAllowlistChange(next);
                            } else {
                              toggleItem(tool.name);
                            }
                          }}
                          className="mt-0.5"
                        />
                        <code className="min-w-0 break-all font-mono text-xs">
                          {tool.name}
                        </code>
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
