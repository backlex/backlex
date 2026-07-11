// Ask-AI → Tools tab (MCP tool browser + per-key allowlists).
// Ask AI — admin page.
//
// Ports the design's four-tab AI/MCP page (/tmp/design-bundle/backlex/project/ai-mcp.jsx)
// onto the canonical backlex UI primitives:
//   - Ask     — natural-language → MCP tool dispatcher (Phase 1)
//   - Tools   — searchable catalog + per-key guard editor (Phase 2)
//   - Runs    — filtered activity table with CSV export    (Phase 2)
//   - Connect — Claude Desktop / Cursor / curl snippets    (Phase 2)
//
// Backend hops the Ask tab still drives:
//   POST /api/admin/ai/plan  →  {rationale, tool, args, model, usage}
//   POST /api/admin/ai/run   →  executes one MCP tool + writes to `activity`
//
// Recent runs fetch /api/activity?action=mcp.&limit=10 — same wire we log
// into from the /run handler.
import { useEffect, useMemo, useRef, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@/lib/api";
import { I } from "../../icons";
import { Badge, Button, Switch } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import { Skeleton } from "@backlex/ui/components/skeleton";
import { McpKeyModal } from "@/components/mcp-key-modal";

import {
  ApiKeyRow,
  KeyPicker,
  McpToolDescriptor,
} from "./shared";

function ToolKindPill({ kind }: { kind: "read" | "write" | "destruct" }) {
  if (kind === "destruct") {
    return (
      <Badge variant="destructive" mono>
        destruct
      </Badge>
    );
  }
  if (kind === "write") {
    return (
      <Badge
        variant="outline"
        mono
        className="border-amber-500/40 text-amber-700 dark:text-amber-300"
      >
        write
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      mono
      className="border-sky-500/40 text-sky-700 dark:text-sky-300"
    >
      read
    </Badge>
  );
}

export function ToolsTab({
  pushToast,
  keys,
  keysLoading,
  selectedKeyId,
  setSelectedKeyId,
  refreshKeys,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
  keys: ApiKeyRow[];
  keysLoading: boolean;
  selectedKeyId: string | null;
  setSelectedKeyId: (id: string) => void;
  refreshKeys: () => Promise<void>;
}) {
  const { t } = useLingui();
  const [tools, setTools] = useState<McpToolDescriptor[] | null>(null);
  const [toolsLoading, setToolsLoading] = useState(true);
  const [q, setQ] = useState("");
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set<string>());
  const [modalOpen, setModalOpen] = useState(false);
  // Optimistic shadow of the selected key's `mcpTools` field so per-tool
  // switches feel instant. `undefined` means "use the server-side value";
  // we only populate it once the user toggles something, and reset when
  // the selection changes or the parent refreshes the key list.
  const [pendingAllowlist, setPendingAllowlist] = useState<string[] | null | undefined>(
    undefined,
  );
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setToolsLoading(true);
    (async () => {
      try {
        const body = await api<{
          result?: { tools: McpToolDescriptor[] };
        }>("/api/admin/mcp", {
          method: "POST",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        setTools(body.result?.tools ?? []);
      } catch (e) {
        pushToast((e as Error).message, "error");
        setTools([]);
      } finally {
        setToolsLoading(false);
      }
    })();
  }, [pushToast]);

  // Group by namespace prefix (`collections.*`, `schema.*`, …). Tools
  // without a dot (none today) fall into an "other" bucket.
  const groups = useMemo(() => {
    if (!tools) return [] as Array<{ id: string; tools: McpToolDescriptor[] }>;
    const term = q.trim().toLowerCase();
    const filtered = term
      ? tools.filter(
          (t) =>
            t.name.toLowerCase().includes(term) ||
            t.description.toLowerCase().includes(term),
        )
      : tools;
    const byNs = new Map<string, McpToolDescriptor[]>();
    for (const t of filtered) {
      const dot = t.name.indexOf(".");
      const ns = dot < 0 ? "other" : t.name.slice(0, dot);
      const bucket = byNs.get(ns) ?? [];
      bucket.push(t);
      byNs.set(ns, bucket);
    }
    return [...byNs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, tools]) => ({ id, tools }));
  }, [tools, q]);

  const toggleGroup = (id: string) => {
    setOpenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedKey = keys.find((k) => k.id === selectedKeyId) ?? null;
  const totalTools = tools?.length ?? 0;
  // Pending state takes precedence so the UI never flickers back to the
  // server value between an optimistic toggle and the debounced PATCH.
  const effectiveAllowlist: string[] | null =
    pendingAllowlist !== undefined ? pendingAllowlist : selectedKey?.mcpTools ?? null;
  const allowlistSize = effectiveAllowlist === null ? null : effectiveAllowlist.length;

  // Drop optimistic state whenever the picker switches to a different key,
  // otherwise the previous key's pending changes would bleed onto the next
  // key's switches until the user toggles something.
  useEffect(() => {
    setPendingAllowlist(undefined);
  }, [selectedKeyId]);

  // Same idea after a successful refetch — the parent has the up-to-date
  // server value and our optimistic shadow is no longer needed.
  useEffect(() => {
    setPendingAllowlist(undefined);
  }, [selectedKey?.mcpTools]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const patchGuard = async (patch: {
    mcpReadOnly?: boolean;
    mcpTools?: string[] | null;
  }) => {
    if (!selectedKey) return;
    try {
      await api(`/api/api-keys/${selectedKey.id}/mcp-guards`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      pushToast(t`Guards updated`);
      void refreshKeys();
    } catch (e) {
      pushToast((e as Error).message, "error");
    }
  };

  // Per-row switch handler. Semantics:
  //   - server `null`  → every switch shows ON (permissive). Flipping a
  //     row OFF activates allowlist mode with every other tool included.
  //   - server `[]`    → every switch shows OFF. Flipping ON adds X.
  //   - server `[…]`   → membership; flip adds/removes the name.
  // Local state updates immediately; the actual PATCH is debounced 200ms
  // so a quick burst of toggles collapses into one network round-trip.
  const toggleTool = (name: string, next: boolean) => {
    if (!selectedKey) return;
    if (totalTools === 0) return;
    const allToolNames = tools?.map((t) => t.name) ?? [];
    const current = effectiveAllowlist;
    let nextAllowlist: string[];
    if (current === null) {
      if (next) return;
      nextAllowlist = allToolNames.filter((n) => n !== name);
    } else if (next) {
      if (current.includes(name)) return;
      nextAllowlist = [...current, name];
    } else {
      if (!current.includes(name)) return;
      nextAllowlist = current.filter((n) => n !== name);
    }
    setPendingAllowlist(nextAllowlist);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void (async () => {
        try {
          await api(`/api/api-keys/${selectedKey.id}/mcp-guards`, {
            method: "PATCH",
            body: JSON.stringify({ mcpTools: nextAllowlist }),
          });
          void refreshKeys();
        } catch (e) {
          // Revert the optimistic edit and surface the error — the user
          // sees the switch snap back so they know the change didn't land.
          setPendingAllowlist(undefined);
          pushToast((e as Error).message, "error");
        }
      })();
    }, 200);
  };

  return (
    <>
      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[1fr_340px]">
        <Card className="py-0 gap-0">
          <div className="flex flex-wrap items-center gap-3 px-5 pt-4 pb-3">
            <I.Layers size={14} />
            <span className="text-[13px] font-semibold">
              <Trans>MCP tool catalog</Trans>
            </span>
            <Badge variant="secondary" mono>
              {totalTools} <Trans>tools</Trans>
            </Badge>
            <div className="relative ml-auto w-72">
              <I.Search
                size={13}
                className="absolute top-1/2 left-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t`Filter tools…`}
                aria-label={t`Filter tools`}
                className="h-8 w-full rounded-full border border-border bg-card pr-3 pl-9 text-[12.5px] outline-none focus:border-ring focus:ring-2 focus:ring-ring/30"
              />
            </div>
          </div>
          <div className="border-t border-border">
            {toolsLoading ? (
              <div className="flex flex-col gap-2 px-5 py-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Skeleton className="size-4 rounded-sm" />
                    <Skeleton className="h-3.5 w-48" />
                  </div>
                ))}
              </div>
            ) : groups.length === 0 ? (
              <div className="px-5 py-8 text-center text-[12.5px] text-muted-foreground">
                <Trans>No tools match this filter.</Trans>
              </div>
            ) : (
              groups.map((g) => {
                const open = openGroups.has(g.id);
                return (
                  <div key={g.id} className="border-b border-border/60 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => toggleGroup(g.id)}
                      className="flex h-11 w-full cursor-pointer items-center gap-3 border-0 bg-transparent px-5 text-left hover:bg-accent/40"
                    >
                      <I.ChevronRight
                        size={12}
                        className={
                          open
                            ? "rotate-90 text-muted-foreground transition-transform"
                            : "text-muted-foreground transition-transform"
                        }
                      />
                      <I.Database size={13} className="text-muted-foreground" />
                      <span className="text-[13px] font-medium uppercase tracking-wider">
                        {g.id}
                      </span>
                      <Badge variant="secondary" mono>
                        {g.tools.length}
                      </Badge>
                    </button>
                    {open && (
                      <div className="border-t border-border/60 bg-muted/30">
                        {g.tools.map((tool) => {
                          // Switch state: null effective allowlist ⇒ everything
                          // ON (permissive); array ⇒ membership check.
                          const enabled =
                            effectiveAllowlist === null
                              ? true
                              : effectiveAllowlist.includes(tool.name);
                          return (
                            <div
                              key={tool.name}
                              className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-border/40 px-5 py-3 last:border-b-0"
                            >
                              <div className="flex min-w-0 flex-col gap-0.5">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-mono text-[12.5px]">
                                    {tool.name}
                                  </span>
                                  <ToolKindPill kind={tool.kind} />
                                  {tool.adminOnly && (
                                    <Badge
                                      variant="outline"
                                      mono
                                      className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                                    >
                                      admin
                                    </Badge>
                                  )}
                                  {tool.name.startsWith("ai.") && (
                                    <Badge
                                      variant="outline"
                                      mono
                                      className="border-sky-500/40 text-sky-700 dark:text-sky-300"
                                    >
                                      ai
                                    </Badge>
                                  )}
                                </div>
                                <p className="m-0 truncate text-[11.5px] text-muted-foreground">
                                  {tool.description}
                                </p>
                              </div>
                              <Switch
                                checked={enabled}
                                disabled={!selectedKey}
                                aria-label={tool.name}
                                onChange={(next) => toggleTool(tool.name, next)}
                              />
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </Card>

        <div className="flex flex-col gap-4 xl:sticky xl:top-4">
          <Card className="py-0 gap-0">
            <div className="flex items-center gap-2 px-5 pt-4 pb-3">
              <I.Key size={13} />
              <span className="text-[13px] font-semibold">
                <Trans>Active key guards</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-3 px-5 pt-2 pb-4">
              <KeyPicker
                keys={keys}
                keysLoading={keysLoading}
                selectedKeyId={selectedKeyId}
                setSelectedKeyId={setSelectedKeyId}
              />
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-[12.5px] font-medium">
                    <Trans>Read-only mode</Trans>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>Blocks every write tool at the dispatcher.</Trans>
                  </span>
                </div>
                <Switch
                  checked={selectedKey?.mcpReadOnly === true}
                  disabled={!selectedKey}
                  onChange={(next) => {
                    void patchGuard({ mcpReadOnly: next });
                  }}
                />
              </div>
              <div className="flex items-start justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-[12.5px] font-medium">
                    <Trans>Tool allowlist</Trans>
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {selectedKey === null ? (
                      <Trans>Pick a key to manage its allowlist.</Trans>
                    ) : allowlistSize === null ? (
                      <Trans>All {totalTools} tools allowed.</Trans>
                    ) : (
                      <Trans>{allowlistSize} of {totalTools} tools enabled.</Trans>
                    )}
                  </span>
                  {selectedKey !== null && (
                    <span className="mt-1 text-[11px] text-muted-foreground">
                      <Trans>Toggle tools below to edit the allowlist.</Trans>
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!selectedKey}
                  onClick={() => setModalOpen(true)}
                >
                  <Trans>Customize…</Trans>
                </Button>
              </div>
            </div>
            <div className="border-t border-border bg-muted/40 px-5 py-4">
              <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                PATCH
              </div>
              <pre className="m-0 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                {`curl -X PATCH $BACKLEX_URL/api/api-keys/<id>/mcp-guards \\
  -H "Authorization: Bearer pak_<admin>" \\
  -H "Content-Type: application/json" \\
  -d '{"mcpReadOnly": ${selectedKey?.mcpReadOnly === true ? "true" : "false"}}'`}
              </pre>
            </div>
          </Card>

          <Card className="py-0 gap-0">
            <div className="flex items-center gap-2 px-5 pt-4 pb-3">
              <I.Globe size={13} />
              <span className="text-[13px] font-semibold">
                <Trans>Endpoints</Trans>
              </span>
            </div>
            <div className="flex flex-col gap-2.5 px-5 pb-4 text-[12px]">
              <div className="flex items-start gap-3">
                <Badge variant="outline" mono>
                  POST
                </Badge>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[12px]">/mcp</span>
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>Tenant agents. DSL-filtered.</Trans>
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Badge variant="outline" mono>
                  POST
                </Badge>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-[12px]">/api/admin/mcp</span>
                  <span className="text-[11px] text-muted-foreground">
                    <Trans>Ops bots — admin role required.</Trans>
                  </span>
                </div>
              </div>
              <div className="mt-1 border-t border-border pt-2 text-[11px] text-muted-foreground">
                <Trans>
                  Stateless Streamable HTTP. No{" "}
                  <span className="font-mono">GET /mcp</span> (resumable SSE) yet.
                </Trans>
              </div>
            </div>
          </Card>
        </div>
      </div>

      {selectedKey && (
        <McpKeyModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          keyId={selectedKey.id}
          keyPrefix={selectedKey.prefix}
          keyName={selectedKey.name}
          initialSecret={null}
          initialAllowlist={selectedKey.mcpTools}
          initialReadOnly={selectedKey.mcpReadOnly}
          onSaved={() => {
            void refreshKeys();
          }}
        />
      )}
    </>
  );
}

// ─── Runs tab ─────────────────────────────────────────────────────────────
