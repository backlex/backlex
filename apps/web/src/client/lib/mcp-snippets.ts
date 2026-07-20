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

/** OpenAI Codex CLI's `~/.codex/config.toml` MCP-server block. Codex speaks
 *  Streamable HTTP natively, so it connects straight to the remote `/mcp`
 *  endpoint with a `bearer_token` — no stdio bridge / absolute CLI path. TOML,
 *  not JSON, because that's Codex's config format. (For the keyless path, Codex
 *  also does `auth = "oauth"` + `codex mcp login` — see the OAuth card.) */
export const codexSnippet = (url: string, secret: string): string =>
  [
    "[mcp_servers.backlex]",
    `url = "${url}"`,
    `bearer_token = "${secret}"`,
  ].join("\n");

/** Direct Streamable HTTP sanity check — usable from CI agents and shell
 *  scripts. Issues a `tools/list` so the snippet doesn't tempt the reader
 *  into a destructive op. */
export const curlSnippet = (url: string, secret: string): string =>
  `curl -X POST ${url} \\
  -H 'Authorization: Bearer ${secret}' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
