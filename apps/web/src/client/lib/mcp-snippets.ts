/**
 * MCP install-snippet generators.
 *
 * Pure string builders for the clients we document in-product
 * (Claude Desktop, Cursor, Codex CLI, curl). Lives in `client/lib/` so both the
 * per-key modal (`components/mcp-key-modal.tsx`) and the Ask-AI Connect
 * tab (`admin/pages/ask-ai.tsx`) can render the same shapes without
 * pulling React into either consumer.
 *
 * The shape stays in sync with `docs/mcp.md` — bump the docs when you
 * change the JSON keys or the curl example.
 */

/** Claude Desktop's `mcpServers` entry. Cursor uses the same JSON shape
 *  through its `Settings → MCP → Add` flow, so `cursorSnippet` is an
 *  alias of this generator. */
export const claudeDesktopSnippet = (url: string, secret: string): string =>
  JSON.stringify(
    {
      mcpServers: {
        backlex: {
          command: "bun",
          args: [
            "/abs/path/to/backlex/packages/cli/bin/backlex.ts",
            "mcp",
            "--url",
            url,
            "--key",
            secret,
          ],
        },
      },
    },
    null,
    2,
  );

export const cursorSnippet = claudeDesktopSnippet;

/** OpenAI Codex CLI's `~/.codex/config.toml` MCP-server block. Codex configures
 *  MCP servers as a local command (stdio), same as Claude Desktop — so it reuses
 *  the `backlex mcp` CLI bridge that tunnels stdio to the remote `/mcp` HTTP
 *  endpoint with the pak_ key. TOML, not JSON, because that's Codex's config
 *  format. */
export const codexSnippet = (url: string, secret: string): string =>
  [
    "[mcp_servers.backlex]",
    'command = "bun"',
    `args = ["/abs/path/to/backlex/packages/cli/bin/backlex.ts", "mcp", "--url", "${url}", "--key", "${secret}"]`,
  ].join("\n");

/** Direct Streamable HTTP sanity check — usable from CI agents and shell
 *  scripts. Issues a `tools/list` so the snippet doesn't tempt the reader
 *  into a destructive op. */
export const curlSnippet = (url: string, secret: string): string =>
  `curl -X POST ${url} \\
  -H 'Authorization: Bearer ${secret}' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
