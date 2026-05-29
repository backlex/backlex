/**
 * MCP install-snippet generators.
 *
 * Pure string builders for the three clients we document in-product
 * (Claude Desktop, Cursor, curl). Lives in `client/lib/` so both the
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

/** Direct Streamable HTTP sanity check — usable from CI agents and shell
 *  scripts. Issues a `tools/list` so the snippet doesn't tempt the reader
 *  into a destructive op. */
export const curlSnippet = (url: string, secret: string): string =>
  `curl -X POST ${url} \\
  -H 'Authorization: Bearer ${secret}' \\
  -H 'Content-Type: application/json' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
