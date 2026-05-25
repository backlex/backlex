/**
 * stdio MCP transport for workeros — proxies JSON-RPC over stdin/stdout to
 * a remote workeros HTTP endpoint (`/mcp` by default). Lets local agents
 * (Claude Desktop, Cursor, IDE plugins) talk to a deployed workeros
 * instance through a single auth path: the PAK passed via `--key`.
 *
 * The CLI deliberately does NOT speak directly to a local SQLite — that
 * would mean a second auth & adapter setup with its own surprises. Going
 * through HTTP keeps permissions, rate-limits, activity logging, and the
 * tenant boundary identical to every other workeros caller.
 */

interface Options {
  url: string;
  key: string;
  tenant?: string;
}

/**
 * Read framed JSON-RPC messages from stdin. The MCP stdio transport per
 * spec uses newline-delimited JSON (one message per line). Bun, Node, and
 * Deno all expose stdin as an async iterable.
 */
const readMessages = async function* (): AsyncGenerator<unknown> {
  // node-style: chunks of bytes; split on newlines, keep a buffer.
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of process.stdin as unknown as AsyncIterable<Uint8Array | string>) {
    const text =
      typeof chunk === "string"
        ? chunk
        : decoder.decode(chunk, { stream: true });
    buffer += text;
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // Spec says malformed messages should be ignored. We do echo to
        // stderr so the operator notices, since this only happens when
        // the upstream MCP client is misbehaving.
        process.stderr.write(`[workeros mcp] dropping non-JSON line\n`);
      }
    }
  }
};

const write = (msg: unknown): void => {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const proxy = async (opts: Options, body: unknown): Promise<unknown | null> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${opts.key}`,
  };
  if (opts.tenant) headers["x-workeros-tenant"] = opts.tenant;
  const res = await fetch(opts.url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 202) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Surface as JSON-RPC error so the MCP client can show it.
    return {
      jsonrpc: "2.0",
      id:
        body && typeof body === "object" && "id" in body
          ? (body as { id: unknown }).id
          : null,
      error: {
        code: -32603,
        message: `upstream returned non-JSON (status ${res.status}): ${text.slice(0, 200)}`,
      },
    };
  }
};

export const runMcp = async (rawOpts: Partial<Options>): Promise<void> => {
  const url = rawOpts.url ?? "http://localhost:8787/mcp";
  const key = rawOpts.key ?? process.env.WORKEROS_API_KEY ?? "";
  if (!key) {
    process.stderr.write(
      "workeros mcp: missing API key. Pass --key pak_… or set WORKEROS_API_KEY.\n",
    );
    process.exit(1);
  }
  const opts: Options = { url, key, tenant: rawOpts.tenant };

  // Pre-flight: hit the endpoint with an initialize so the operator gets a
  // fast, clear error if the URL/key are wrong, before the MCP client even
  // starts negotiating.
  try {
    const probe = await proxy(opts, {
      jsonrpc: "2.0",
      id: "probe",
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {} },
    });
    if (probe && typeof probe === "object" && "error" in probe) {
      process.stderr.write(
        `workeros mcp: handshake failed: ${JSON.stringify((probe as { error: unknown }).error)}\n`,
      );
      process.exit(1);
    }
  } catch (e) {
    process.stderr.write(
      `workeros mcp: cannot reach ${opts.url}: ${(e as Error).message}\n`,
    );
    process.exit(1);
  }

  for await (const msg of readMessages()) {
    const response = await proxy(opts, msg).catch((e) => ({
      jsonrpc: "2.0" as const,
      id:
        msg && typeof msg === "object" && "id" in msg
          ? (msg as { id: unknown }).id
          : null,
      error: { code: -32603, message: (e as Error).message },
    }));
    if (response) write(response);
  }
};
