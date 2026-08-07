// Ask-AI → Connect tab (MCP client snippets + key minting).
// Ask AI — admin page.
//
// Ports the design's four-tab AI/MCP page onto the canonical backlex UI
// primitives:
//   - Ask     — natural-language → MCP tool dispatcher (Phase 1)
//   - Tools   — searchable catalog + per-key guard editor (Phase 2)
//   - Runs    — filtered activity table with CSV export    (Phase 2)
//   - Connect — OAuth (no-key) primary + API-key snippets for headless/CI (Phase 2)
//
// The Connect tab leads with OAuth (client-agnostic MCP OAuth: discovery +
// DCR + PKCE) and demotes the API key to the headless / CI path. The visual
// treatment follows the "Backlex space theme" redesign: a primary-tinted,
// glowing OAuth hero card with an endpoint pill + numbered connect steps, and
// a quieter API-key card below. All colors resolve from theme tokens so the
// surface tracks light + dark.
import type { PushToast } from "../../types";
import { useMemo, useState } from "react";
import { Trans, useLingui } from "@lingui/react/macro";
import { I } from "../../icons";
import { Badge } from "../../ui";
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

// Mint (success) pill — matches the item-status tone helper (items.tsx) so the
// "no key needed" chip reads the same green in both themes without hardcoding.
const MINT_PILL =
  "text-accent-mint bg-[color-mix(in_oklch,var(--color-accent-mint)_12%,transparent)] border-[color-mix(in_oklch,var(--color-accent-mint)_30%,transparent)]";
// Primary gradient used on the hero action buttons.
const PRIMARY_GRADIENT =
  "bg-[linear-gradient(135deg,var(--color-primary),color-mix(in_oklch,var(--color-primary)_78%,black))] text-primary-foreground";

export function ConnectTab({
  pushToast,
  keys,
  keysLoading,
  selectedKeyId,
  setSelectedKeyId,
}: {
  pushToast: PushToast;
  keys: ApiKeyRow[];
  keysLoading: boolean;
  selectedKeyId: string | null;
  setSelectedKeyId: (id: string) => void;
}) {
  const { t } = useLingui();
  const [client, setClient] = useState<ConnectClient>("claude-desktop");
  const [urlCopied, setUrlCopied] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);

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

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1400);
      pushToast(t`MCP URL copied`);
    } catch {
      pushToast(t`Could not copy — clipboard blocked.`, "error");
    }
  };

  const copySnippet = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setSnippetCopied(true);
      setTimeout(() => setSnippetCopied(false), 1400);
      pushToast(t`Snippet copied`);
    } catch {
      pushToast(t`Could not copy snippet — clipboard blocked.`, "error");
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Primary — OAuth (no key). Standard MCP OAuth (discovery + DCR + PKCE),
          so it's client-agnostic: any OAuth-capable MCP client uses it. */}
      <Card className="relative gap-0 overflow-hidden border-primary/30 p-0 shadow-[0_24px_60px_-30px_color-mix(in_oklch,var(--color-primary)_55%,transparent)]">
        {/* aurora top strip */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-[linear-gradient(90deg,transparent,var(--color-primary),var(--color-accent-coral),transparent)] opacity-70"
        />

        {/* header */}
        <div className="flex flex-wrap items-center gap-3 border-b border-primary/15 bg-[linear-gradient(180deg,color-mix(in_oklch,var(--color-primary)_12%,transparent),transparent)] px-5 py-4">
          <span className="grid size-8 shrink-0 place-items-center rounded-control border border-primary/40 bg-primary/15 text-primary shadow-[0_0_16px_-2px_color-mix(in_oklch,var(--color-primary)_60%,transparent)]">
            <I.Sparkles size={15} />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-semibold text-foreground">
                <Trans>Connect over OAuth</Trans>
              </span>
              <Badge variant="default" mono>
                <Trans>recommended</Trans>
              </Badge>
            </div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              claude.ai · Cursor · Codex · ChatGPT connectors · VS Code · Claude Desktop
            </div>
          </div>
          <span
            className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold tracking-wider uppercase ${MINT_PILL}`}
          >
            <span className="size-1.5 rounded-full bg-accent-mint shadow-[0_0_8px_var(--color-accent-mint)]" />
            <Trans>no key needed</Trans>
          </span>
        </div>

        {/* body */}
        <div className="flex flex-col gap-5 px-5 pt-4 pb-5">
          <p className="m-0 max-w-[78ch] text-[13px] leading-relaxed text-muted-foreground text-pretty">
            <Trans>
              Any OAuth-capable client connects with no key — the browser handles
              discovery, consent, and token exchange. Tools then run with{" "}
              <span className="text-foreground">your own roles and permission rules</span>.
            </Trans>
          </p>

          {/* MCP endpoint pill */}
          <div>
            <div className="mb-2 font-mono text-[10px] tracking-[0.13em] uppercase text-muted-foreground">
              <Trans>MCP endpoint</Trans>
            </div>
            <div className="flex items-center gap-3 rounded-control border border-primary/30 bg-primary/[0.06] py-1.5 pr-1.5 pl-3.5">
              <span className="size-2 shrink-0 rounded-full bg-accent-mint shadow-[0_0_9px_var(--color-accent-mint)]" />
              <span className="min-w-0 flex-1 truncate font-mono text-[13.5px] text-foreground">
                {mcpUrl}
              </span>
              <button
                type="button"
                onClick={() => void copyUrl()}
                className={`inline-flex h-[34px] shrink-0 cursor-pointer items-center gap-1.5 rounded-control border-0 px-3.5 text-[12.5px] font-semibold shadow-[0_6px_18px_-8px_color-mix(in_oklch,var(--color-primary)_80%,transparent)] transition hover:brightness-110 ${PRIMARY_GRADIENT}`}
              >
                {urlCopied ? (
                  <>
                    <I.Check size={13} />
                    <Trans>Copied</Trans>
                  </>
                ) : (
                  <>
                    <I.Copy size={12} />
                    <Trans>Copy</Trans>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* numbered connect steps */}
          <ol className="m-0 flex list-none flex-col p-0">
            <ConnectStep
              n={1}
              title={<Trans>Add a remote MCP connector</Trans>}
              body={
                <Trans>
                  claude.ai → Settings → Connectors → Add custom connector;
                  Cursor → Settings → MCP → Add.
                </Trans>
              }
            />
            <ConnectStep
              n={2}
              title={<Trans>Paste the endpoint above</Trans>}
              body={
                <Trans>
                  Drop the MCP URL in as the server address — no token, no config
                  file.
                </Trans>
              }
            />
            <ConnectStep
              last
              title={<Trans>Sign in &amp; approve</Trans>}
              body={
                <Trans>
                  Approve the authorization screen — the connector inherits your
                  roles.
                </Trans>
              }
            />
          </ol>

          {/* Codex CLI inline block */}
          <div className="flex items-start gap-3 rounded-control border border-border bg-muted/30 px-3.5 py-3">
            <span className="mt-0.5 shrink-0 font-mono text-[9.5px] tracking-wider uppercase text-muted-foreground">
              Codex CLI
            </span>
            <div className="min-w-0 overflow-x-auto font-mono text-[12px] leading-[1.7] text-accent-mint">
              <div>codex mcp add backlex --url {mcpUrl}</div>
              <div>codex mcp login backlex</div>
            </div>
          </div>

          <div className="inline-flex items-center gap-2 text-[11.5px] text-muted-foreground">
            <I.Lock size={13} className="shrink-0" />
            <Trans>
              Tokens without the{" "}
              <span className="font-mono text-foreground">mcp:write</span> scope
              run read-only.
            </Trans>
          </div>
        </div>
      </Card>

      {/* Secondary — API key. For clients that can't do the browser OAuth flow:
          headless agents, CI, scripts, the backlex CLI/SDK, and MCP clients
          without OAuth support (Codex CLI today). */}
      <Card className="gap-0 p-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-5 pt-4 pb-3">
          <I.Plug size={13} className="text-muted-foreground" />
          <span className="text-[13px] font-semibold">
            <Trans>API key</Trans>
          </span>
          <span className="text-[11.5px] text-muted-foreground">
            <Trans>headless · CI · scripts · non-OAuth clients</Trans>
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
          <span className="mr-2 text-[11px] tracking-wider uppercase text-muted-foreground">
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
            onClick={() => void copySnippet()}
            className="absolute top-3 right-3 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-full border-0 bg-white/10 px-3 text-[11.5px] font-medium text-[oklch(0.95_0.02_130)] hover:bg-white/20"
          >
            {snippetCopied ? (
              <>
                <I.Check size={13} />
                <Trans>Copied</Trans>
              </>
            ) : (
              <>
                <I.Copy size={12} />
                <Trans>Copy</Trans>
              </>
            )}
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
                Settings → MCP → Add. Same JSON shape Claude Desktop uses. (Or
                skip the key and connect over OAuth above.)
              </Trans>
            )}
            {client === "codex" && (
              <Trans>
                Add to <span className="font-mono">~/.codex/config.toml</span>{" "}
                (native Streamable HTTP). Or skip the key and connect over OAuth
                above with <span className="font-mono">codex mcp login</span>.
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
    </div>
  );
}

/** One row in the OAuth connect stepper. Numbered circles are joined by a
 *  fading vertical rail; the final step (`last`) swaps the number for a filled
 *  gradient check and drops the rail. */
function ConnectStep({
  n,
  title,
  body,
  last = false,
}: {
  n?: number;
  title: React.ReactNode;
  body: React.ReactNode;
  last?: boolean;
}) {
  return (
    <li className="flex gap-3.5">
      <div className="flex shrink-0 flex-col items-center">
        {last ? (
          <span
            className={`grid size-6 place-items-center rounded-full ${PRIMARY_GRADIENT}`}
          >
            <I.Check size={13} />
          </span>
        ) : (
          <span className="grid size-6 place-items-center rounded-full border border-primary/40 bg-primary/15 font-mono text-[11px] font-semibold text-primary">
            {n}
          </span>
        )}
        {!last && (
          <span className="mt-1 min-h-4 w-px flex-1 bg-[linear-gradient(color-mix(in_oklch,var(--color-primary)_45%,transparent),color-mix(in_oklch,var(--color-primary)_8%,transparent))]" />
        )}
      </div>
      <div className={last ? "" : "pb-3.5"}>
        <div className="text-[13px] font-semibold text-foreground">{title}</div>
        <div className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">
          {body}
        </div>
      </div>
    </li>
  );
}
