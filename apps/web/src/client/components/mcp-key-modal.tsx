/**
 * Per-API-key MCP configuration modal:
 *   - Tabbed install-snippet generator (Claude Desktop / Cursor / Codex / curl)
 *   - Per-tool allowlist editor (checkbox grid sourced from /api/admin/mcp tools/list)
 *   - Read-only toggle
 *
 * Lives next to the API Keys page rather than its own route because the
 * concept is tightly bound to a single key — every change happens through
 * `PATCH /api/api-keys/:id/mcp-guards`. A future "MCP Settings" page can
 * reuse this component for the per-key view.
 *
 * The guard editor itself (read-only toggle + allowlist grid) is the shared
 * `McpGuardsFields`, so it stays in lockstep with the create-form version.
 */
import { useEffect, useMemo, useState } from "react";
import { CopyIcon, CheckIcon, TerminalSquareIcon, MonitorSmartphoneIcon } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@backlex/ui/components/button";
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
import { McpGuardsFields, useMcpTools } from "@/components/mcp-guards-fields";
import { notifyError } from "@/lib/error";
import { api } from "@/lib/api";
import {
  claudeDesktopSnippet,
  cursorSnippet,
  codexSnippet,
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
  const { tools, loading: loadingTools } = useMcpTools(open);
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

  const secretForSnippet = useMemo(() => {
    if (initialSecret) return initialSecret;
    return `${keyPrefix}_<paste-secret-here>`;
  }, [initialSecret, keyPrefix]);

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
                className="w-full rounded-control border border-border bg-background px-3 py-2 font-mono text-xs"
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
                <TabsTrigger value="codex">
                  <TerminalSquareIcon className="size-3.5" />
                  <Trans>Codex</Trans>
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
              <TabsContent value="codex">
                <SnippetBlock
                  snippet={codexSnippet(mcpUrl, secretForSnippet)}
                  copied={copied === "codex"}
                  onCopy={() => copySnippet("codex", codexSnippet(mcpUrl, secretForSnippet))}
                />
                <p className="mt-2 text-xs text-muted-foreground">
                  <Trans>Add to <code>~/.codex/config.toml</code> and restart Codex.</Trans>
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

            <McpGuardsFields
              idPrefix="modal"
              readOnly={readOnly}
              onReadOnlyChange={setReadOnly}
              allowlist={allowlist}
              onAllowlistChange={setAllowlist}
              tools={tools}
              loading={loadingTools}
            />
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
    {/* Wrap long unbroken tokens (the full `pak_…` secret) instead of
        scrolling horizontally — a nested horizontal scroll inside the
        dialog's vertical ScrollArea bled the whole modal past the viewport
        on narrow screens. `break-all` + `whitespace-pre-wrap` keeps it
        contained. Right padding clears the copy button. */}
    <pre className="m-0 max-w-full overflow-hidden whitespace-pre-wrap break-all rounded-control border border-border bg-muted/50 p-3 pr-20 font-mono text-xs">
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
