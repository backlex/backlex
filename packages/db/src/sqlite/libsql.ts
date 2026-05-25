/**
 * libSQL (Turso) client. Works over libSQL's HTTP/WS protocol — same SQLite
 * dialect, same schema, same migrations as Bun SQLite + D1, just a remote
 * transport. Pure fetch-based so it runs on every workeros runtime: Bun,
 * Node, CF Workers, Vercel/Netlify Edge.
 *
 * The url scheme picks the transport:
 *   - `file:` / `:memory:`   → local libsql client (bun:sqlite-like)
 *   - `http://`  / `https://`→ Hrana HTTP (one round-trip per statement)
 *   - `ws://`    / `wss://`  → Hrana WebSocket (multi-statement pipelining)
 *   - `libsql://`            → libsql-protocol URL; client negotiates ws/https
 *
 * Turso URLs look like `libsql://<db>-<org>.turso.io` and need
 * `LIBSQL_AUTH_TOKEN` for anything beyond a local file.
 */
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "./schema";
import type { SqliteDb } from "./index";

export const createLibsqlClient = (
  url: string,
  authToken?: string,
): SqliteDb => {
  const client = createClient(authToken ? { url, authToken } : { url });
  return drizzle({ client, schema }) as SqliteDb;
};

export type LibsqlDb = LibSQLDatabase<typeof schema>;
