// Ask-AI → Connect tab (MCP client snippets + key minting).
// Ask AI — admin page.
//
// Ports the design's four-tab AI/MCP page (/tmp/design-bundle/backlex/project/ai-mcp.jsx)
// onto the canonical backlex UI primitives:
//   - Ask     — natural-language → MCP tool dispatcher (Phase 1)
//   - Tools   — searchable catalog + per-key guard editor (Phase 2)
//   - Runs    — filtered activity table with CSV export    (Phase 2)
//   - Connect — Claude Desktop / Cursor / Codex / curl snippets    (Phase 2)
//
// Backend hops the Ask tab still drives:
//   POST /api/admin/ai/plan  →  {rationale, tool, args, model, usage}
//   POST /api/admin/ai/run   →  executes one MCP tool + writes to `activity`
//
// Recent runs fetch /api/activity?action=mcp.&limit=10 — same wire we log
// into from the /run handler.
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge, } from "../../ui";
import { Card } from "@backlex/ui/components/card";
import {
  Tabs,
  TabsList,
  TabsTrigger,
} from "@backlex/ui/components/tabs";
import { ScrollArea } from "@backlex/ui/components/scroll-area";
import {
  claudeDesktopSnippet,
  cursorSnippet,
  codexSnippet,
  curlSnippet,
} from "@/lib/mcp-snippets";

import {
  ApiKeyRow,
  KeyPicker,
} from "./shared";

type ConnectClient = "claude-desktop" | "cursor" | "codex" | "curl";

export function ConnectTab({
  pushToast,
  keys,
  keysLoading,
  selectedKeyId,
  setSelectedKeyId,
}: {
  pushToast: (m: string, type?: "success" | "error") => void;
  keys: ApiKeyRow[];
  keysLoading: boolean;
  selectedKeyId: string | null;
  setSelectedKeyId: (id: string) => void;
}) {
  const { t } = useLingui();
  const [client, setClient] = useState<ConnectClient>("claude-desktop");

  const mcpUrl = useMemo(() => {
    if (typeof window === "undefined") return "https://your-backlex.example.com/mcp";
    return `${window.location.origin}/mcp`;
  }, []);

  const selectedKey = keys.find((k) => k.id === selectedKeyId) ?? null;

  // The plaintext secret is unrecoverable after key creation; the snippet
  // bakes in `<prefix>_••••••••` so an admin pasting the config still has
  // a clear "replace this" placeholder. `prefix` already starts with `pak_`.
  const secretForSnippet = selectedKey
    ? `${selectedKey.prefix}_••••••••`
    : "pak_<prefix>_<paste-secret-here>";

  const snippet = useMemo(() => {
    if (client === "claude-desktop") return claudeDesktopSnippet(mcpUrl, secretForSnippet);
    if (client === "cursor") return cursorSnippet(mcpUrl, secretForSnippet);
    if (client === "codex") return codexSnippet(mcpUrl, secretForSnippet);
    return curlSnippet(mcpUrl, secretForSnippet);
  }, [client, mcpUrl, secretForSnippet]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      pushToast(t`Snippet copied`);
    } catch {
      pushToast(t`Could not copy snippet — clipboard blocked.`, "error");
    }
  };

  return (
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_340px]">
      <Card className="py-0 gap-0">
        <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-3">
          <I.Plug size={13} />
          <span className="text-[13px] font-semibold">
            <Trans>Connect an MCP client</Trans>
          </span>
          <div className="ml-auto">
            <Tabs
              value={client}
              onValueChange={(v) => setClient(v as ConnectClient)}
            >
              <TabsList>
                <TabsTrigger value="claude-desktop">
                  <Trans>Claude Desktop</Trans>
                </TabsTrigger>
                <TabsTrigger value="cursor">
                  <Trans>Cursor</Trans>
                </TabsTrigger>
                <TabsTrigger value="codex">
                  <Trans>Codex</Trans>
                </TabsTrigger>
                <TabsTrigger value="curl">
                  <Trans>curl</Trans>
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </div>
        <div className="border-t border-border bg-muted/30 px-5 py-3">
          <span className="mr-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Trans>API key</Trans>
          </span>
          <div className="mt-1 max-w-md">
            <KeyPicker
              keys={keys}
              keysLoading={keysLoading}
              selectedKeyId={selectedKeyId}
              setSelectedKeyId={setSelectedKeyId}
            />
          </div>
        </div>
        <div className="relative border-t border-border bg-[oklch(0.18_0.01_130)] text-[oklch(0.95_0.02_130)]">
          <button
            type="button"
            onClick={() => {
              void copy();
            }}
            className="absolute top-3 right-3 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-white/10 px-3 text-[11.5px] font-medium text-[oklch(0.95_0.02_130)] hover:bg-white/20"
          >
            <I.Copy size={12} />
            <Trans>Copy</Trans>
          </button>
          <ScrollArea viewportClassName="max-h-[420px]">
            <pre className="m-0 px-5 py-5 font-mono text-[12px] leading-[1.6] whitespace-pre">
              {snippet}
            </pre>
          </ScrollArea>
        </div>
        <div className="flex items-center gap-2 border-t border-border px-5 py-3">
          <span className="text-[11.5px] text-muted-foreground">
            {client === "claude-desktop" && (
              <Trans>
                Add to{" "}
                <span className="font-mono">
                  ~/Library/Application Support/Claude/claude_desktop_config.json
                </span>{" "}
                (macOS), restart Claude Desktop, then look under the plug icon.
              </Trans>
            )}
            {client === "cursor" && (
              <Trans>
                Settings → MCP → Add. Same JSON shape Claude Desktop uses.
              </Trans>
            )}
            {client === "codex" && (
              <Trans>
                Add to <span className="font-mono">~/.codex/config.toml</span>,
                then restart Codex. Runs the backlex CLI as a stdio bridge to{" "}
                <span className="font-mono">/mcp</span>.
              </Trans>
            )}
            {client === "curl" && (
              <Trans>
                Direct Streamable HTTP — useful for CI agents and smoke tests.
              </Trans>
            )}
          </span>
        </div>
      </Card>

      <Card className="py-0 gap-0">
        <div className="flex items-center gap-2 px-5 pt-4 pb-3">
          <I.Sparkles size={13} className="text-primary" />
          <span className="text-[13px] font-semibold">
            <Trans>Hosted Claude</Trans>
          </span>
          <Badge
            variant="outline"
            mono
            className="ml-1 border-sky-500/40 text-sky-700 dark:text-sky-300"
          >
            oauth
          </Badge>
        </div>
        <div className="flex flex-col gap-3 px-5 pb-4 text-[12.5px] text-muted-foreground">
          <Trans>
            claude.ai connects over OAuth — no key to paste. Add the MCP URL as
            a custom connector and approve the consent screen; tools run with
            your roles and permission rules.
          </Trans>
          <ol className="m-0 list-decimal space-y-1 pl-4 text-[12px]">
            <li>
              <Trans>
                claude.ai → Settings → Connectors →{" "}
                <span className="text-foreground">Add custom connector</span>
              </Trans>
            </li>
            <li>
              <Trans>
                Paste{" "}
                <span className="font-mono text-foreground">{mcpUrl}</span>
              </Trans>
            </li>
            <li>
              <Trans>Sign in and approve the authorization screen</Trans>
            </li>
          </ol>
          <button
            type="button"
            className="flex w-fit cursor-pointer items-center gap-1.5 rounded-control border border-border bg-muted/40 px-2.5 py-1.5 font-mono text-[11.5px] text-foreground hover:bg-accent"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(mcpUrl);
                pushToast(t`MCP URL copied`);
              } catch {
                pushToast(t`Could not copy — clipboard blocked.`, "error");
              }
            }}
          >
            <I.Copy size={12} />
            {mcpUrl}
          </button>
          <span className="text-[11.5px]">
            <Trans>
              Tokens without the{" "}
              <span className="font-mono text-foreground">mcp:write</span> scope
              run read-only.
            </Trans>
          </span>
        </div>
      </Card>
    </div>
  );
}
