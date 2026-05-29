/**
 * Per-API-key MCP configuration modal:
 *   - Tabbed install-snippet generator (Claude Desktop / Cursor / curl)
 *   - Per-tool allowlist editor (checkbox grid sourced from /api/admin/mcp tools/list)
 *   - Read-only toggle
 *
 * Lives next to the API Keys page rather than its own route because the
 * concept is tightly bound to a single key — every change happens through
 * `PATCH /api/api-keys/:id/mcp-guards`. A future "MCP Settings" page can
 * reuse this component for the per-key view.
 */
import { useEffect, useMemo, useState } from "react";
import { CopyIcon, CheckIcon, TerminalSquareIcon, MonitorSmartphoneIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
import { Checkbox } from "@backlex/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@backlex/ui/components/dialog";
import { Label } from "@backlex/ui/components/label";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@backlex/ui/components/tabs";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";
import {
  claudeDesktopSnippet,
  cursorSnippet,
  curlSnippet,
} from "@/lib/mcp-snippets";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  keyId: string;
  keyPrefix: string;
  keyName: string;
  /** Plaintext `pak_<prefix>_<secret>` if the key was just minted. Null on
   *  every subsequent open — the secret is unrecoverable, so the snippet
   *  falls back to a `pak_<prefix>_<paste-secret-here>` placeholder. */
  initialSecret: string | null;
  initialAllowlist: string[] | null;
  initialReadOnly: boolean;
  onSaved: () => void;
}

interface ToolDescriptor {
  name: string;
  description: string;
}

interface ToolsListResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { tools: ToolDescriptor[] };
}

const MCP_URL_PLACEHOLDER = "https://your-backlex.example.com/mcp";

export const McpKeyModal = ({
  open,
  onOpenChange,
  keyId,
  keyPrefix,
  keyName,
  initialSecret,
  initialAllowlist,
  initialReadOnly,
  onSaved,
}: Props) => {
  const { t } = useLingui();
  const [tools, setTools] = useState<ToolDescriptor[] | null>(null);
  const [loadingTools, setLoadingTools] = useState(false);
  const [allowlist, setAllowlist] = useState<Set<string> | null>(
    initialAllowlist ? new Set(initialAllowlist) : null,
  );
  const [readOnly, setReadOnly] = useState(initialReadOnly);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [mcpUrl, setMcpUrl] = useState<string>(() => {
    if (typeof window === "undefined") return MCP_URL_PLACEHOLDER;
    return `${window.location.origin}/mcp`;
  });

  // Reset modal state every time it opens against a different key.
  useEffect(() => {
    if (!open) return;
    setAllowlist(initialAllowlist ? new Set(initialAllowlist) : null);
    setReadOnly(initialReadOnly);
    if (typeof window !== "undefined") {
      setMcpUrl(`${window.location.origin}/mcp`);
    }
  }, [open, initialAllowlist, initialReadOnly]);

  // Lazy-load the tool catalog from /api/admin/mcp the first time the modal
  // opens — `tools/list` over JSON-RPC. Admin session cookie is forwarded
  // automatically by `api()`.
  useEffect(() => {
    if (!open || tools) return;
    setLoadingTools(true);
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
        setLoadingTools(false);
      }
    })();
  }, [open, tools, t]);

  const secretForSnippet = useMemo(() => {
    if (initialSecret) return initialSecret;
    return `${keyPrefix}_<paste-secret-here>`;
  }, [initialSecret, keyPrefix]);

  const toggleAllowlistItem = (toolName: string) => {
    setAllowlist((prev) => {
      // Activating the allowlist for the first time — start with the
      // selected tool only (a "narrow this key" gesture). Subsequent clicks
      // toggle in/out of the set.
      const next = new Set(prev ?? []);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return next;
    });
  };

  const groupedTools = useMemo(() => {
    if (!tools) return [] as Array<{ namespace: string; tools: ToolDescriptor[] }>;
    const groups = new Map<string, ToolDescriptor[]>();
    for (const t of tools) {
      const dot = t.name.indexOf(".");
      const namespace = dot < 0 ? "other" : t.name.slice(0, dot);
      const bucket = groups.get(namespace) ?? [];
      bucket.push(t);
      groups.set(namespace, bucket);
    }
    return [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([namespace, tools]) => ({ namespace, tools }));
  }, [tools]);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        mcpReadOnly: readOnly,
      };
      patch.mcpTools = allowlist ? Array.from(allowlist) : null;
      await api(`/api/api-keys/${keyId}/mcp-guards`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      onSaved();
      onOpenChange(false);
    } catch (e) {
      notifyError(e, t`Saving MCP guards`);
    } finally {
      setSaving(false);
    }
  };

  const copySnippet = async (label: string, snippet: string) => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(label);
      setTimeout(() => setCopied((cur) => (cur === label ? null : cur)), 1500);
    } catch (e) {
      notifyError(e, t`Copying snippet`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-w-3xl flex-col overflow-hidden p-0">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>
            <Trans>Connect MCP — {keyName}</Trans>
          </DialogTitle>
          <DialogDescription>
            <Trans>
              Wire this API key into a Model Context Protocol client (Claude Desktop, Cursor, or any MCP-aware tool). The snippet below is pre-filled with this workspace's MCP URL.
            </Trans>
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-6 py-5">
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="mcp-url" className="text-xs">
                <Trans>MCP endpoint URL</Trans>
              </Label>
              <input
                id="mcp-url"
                value={mcpUrl}
                onChange={(e) => setMcpUrl(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-xs"
              />
            </div>

            <Tabs defaultValue="claude">
              <TabsList>
                <TabsTrigger value="claude">
                  <MonitorSmartphoneIcon className="size-3.5" />
                  <Trans>Claude Desktop</Trans>
                </TabsTrigger>
                <TabsTrigger value="cursor">
                  <MonitorSmartphoneIcon className="size-3.5" />
                  <Trans>Cursor</Trans>
                </TabsTrigger>
                <TabsTrigger value="curl">
                  <TerminalSquareIcon className="size-3.5" />
                  <Trans>curl</Trans>
                </TabsTrigger>
              </TabsList>
              <TabsContent value="claude">
                <SnippetBlock
                  snippet={claudeDesktopSnippet(mcpUrl, secretForSnippet)}
                  copied={copied === "claude"}
                  onCopy={() => copySnippet("claude", claudeDesktopSnippet(mcpUrl, secretForSnippet))}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  <Trans>Add to <code>~/Library/Application Support/Claude/claude_desktop_config.json</code> (macOS) and restart Claude Desktop.</Trans>
                </p>
              </TabsContent>
              <TabsContent value="cursor">
                <SnippetBlock
                  snippet={cursorSnippet(mcpUrl, secretForSnippet)}
                  copied={copied === "cursor"}
                  onCopy={() => copySnippet("cursor", cursorSnippet(mcpUrl, secretForSnippet))}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  <Trans>Settings → MCP → Add new MCP server → paste the JSON.</Trans>
                </p>
              </TabsContent>
              <TabsContent value="curl">
                <SnippetBlock
                  snippet={curlSnippet(mcpUrl, secretForSnippet)}
                  copied={copied === "curl"}
                  onCopy={() => copySnippet("curl", curlSnippet(mcpUrl, secretForSnippet))}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  <Trans>Sanity-check the endpoint before wiring it into an agent.</Trans>
                </p>
              </TabsContent>
            </Tabs>

            <section className="space-y-3">
              <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
                <Checkbox
                  id="modal-readonly"
                  checked={readOnly}
                  onCheckedChange={(v) => setReadOnly(v === true)}
                  className="mt-0.5"
                />
                <div className="flex-1 space-y-1">
                  <Label htmlFor="modal-readonly" className="font-medium">
                    <Trans>Read-only mode</Trans>
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    <Trans>Refuses every write tool through MCP for this key — agent can read everything its permissions allow but cannot mutate.</Trans>
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="font-medium">
                    <Trans>Tool allowlist</Trans>
                  </Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setAllowlist(null)}
                    >
                      <Trans>Allow all</Trans>
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setAllowlist(new Set())}
                    >
                      <Trans>Block all</Trans>
                    </Button>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  {allowlist === null ? (
                    <Trans>Every MCP tool is callable, subject to permissions. Toggle a tool below to switch to allowlist mode.</Trans>
                  ) : (
                    <Trans>{allowlist.size} of {tools?.length ?? 0} tools allowed. Uncheck all to remove the allowlist.</Trans>
                  )}
                </p>
                {loadingTools && (
                  <div className="rounded-md border border-border/50 bg-muted/20 p-3 text-xs text-muted-foreground">
                    <Trans>Loading tool catalog…</Trans>
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
                            const checked =
                              allowlist === null ? true : allowlist.has(tool.name);
                            return (
                              <label
                                key={tool.name}
                                className="flex cursor-pointer items-start gap-2 rounded-md p-2 hover:bg-muted/40"
                                onClick={(e) => {
                                  // Bare label click — let the input handle it
                                  if ((e.target as HTMLElement).tagName === "INPUT") return;
                                }}
                              >
                                <Checkbox
                                  checked={checked}
                                  onCheckedChange={() => {
                                    if (allowlist === null) {
                                      // Transition: leaving unrestricted mode
                                      // → start with this tool toggled OFF.
                                      const next = new Set(tools.map((t) => t.name));
                                      next.delete(tool.name);
                                      setAllowlist(next);
                                    } else {
                                      toggleAllowlistItem(tool.name);
                                    }
                                  }}
                                  className="mt-0.5"
                                />
                                <div className="flex-1">
                                  <code className="font-mono text-xs">{tool.name}</code>
                                </div>
                              </label>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </ScrollArea>
        <DialogFooter className="border-t px-6 py-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            <Trans>Close</Trans>
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving ? <Trans>Saving…</Trans> : <Trans>Save guards</Trans>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const SnippetBlock = ({
  snippet,
  copied,
  onCopy,
}: {
  snippet: string;
  copied: boolean;
  onCopy: () => void;
}) => (
  <div className="relative min-w-0">
    <pre className="min-w-0 overflow-x-auto rounded-md border border-border bg-muted/50 p-3 font-mono text-xs">
      {snippet}
    </pre>
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="absolute right-2 top-2"
      onClick={onCopy}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
      {copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
    </Button>
  </div>
);
