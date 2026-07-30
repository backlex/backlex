import { defineProvider } from "../provider";

/**
 * ClickHouse — mirror a collection into an analytics table.
 *
 * The HTTP interface is the whole API surface: a query in the URL and the rows
 * as the body. That makes it the simplest destination to get right, which is
 * why it is the first one.
 *
 * Writes go through `INSERT … FORMAT JSONEachRow`, and the target is expected
 * to be a `ReplacingMergeTree` ordered by `id` — see `ensureSql` below. That
 * choice is what makes a re-sent batch harmless: ClickHouse has no upsert, so
 * idempotency comes from the table engine collapsing duplicate keys rather than
 * from the insert.
 */

/** backlex field type → ClickHouse column type, for the DDL hint. */
const CH_TYPES: Record<string, string> = {
  text: "String",
  longtext: "String",
  uuid: "String",
  relation: "String",
  integer: "Nullable(Int64)",
  number: "Nullable(Float64)",
  boolean: "Nullable(UInt8)",
  timestamp: "Nullable(DateTime64(3))",
  json: "String",
  relation_many: "String",
};

/**
 * The DDL an operator runs once, printed by the docs and the CLI rather than
 * executed here.
 *
 * Creating tables needs privileges an insert-only user should not have, and a
 * warehouse table is a schema decision — partitioning, TTL, ordering — that
 * belongs to whoever owns the cluster. Guessing it silently is how a mirror
 * ends up unqueryable at scale.
 */
export const clickhouseEnsureSql = (table: string, columns: Record<string, string>): string => {
  const cols = Object.entries(columns)
    .map(([name, type]) => `  \`${name}\` ${CH_TYPES[type] ?? "String"}`)
    .join(",\n");
  return (
    `CREATE TABLE IF NOT EXISTS \`${table}\` (\n${cols}\n)\n` +
    // ReplacingMergeTree is load-bearing: a re-sent batch collapses on merge
    // instead of double-counting, which is what makes retries safe.
    `ENGINE = ReplacingMergeTree\nORDER BY \`id\`;`
  );
};

export const clickhouse = defineProvider({
  id: "clickhouse",
  label: "ClickHouse",
  category: "warehouse",
  capabilities: ["destination"],
  configFields: [
    {
      key: "url",
      label: "HTTP endpoint",
      placeholder: "https://abc.eu-central-1.aws.clickhouse.cloud:8443",
    },
    { key: "username", label: "Username", placeholder: "default" },
    { key: "password", label: "Password", secret: true },
    { key: "database", label: "Database", placeholder: "default" },
  ],
  destination: {
    settingFields: [{ key: "table", label: "Target table", placeholder: "leads" }],
    async push(ctx) {
      const url = ctx.str("url");
      const table = ctx.setting("table");
      if (!url || !table) throw new Error("ClickHouse destination is missing its endpoint or table");
      // Checked here rather than trusted: it is interpolated into the query,
      // and the settings form is not the only way a value can arrive.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
        throw new Error(`ClickHouse table name "${table}" is not a plain identifier`);
      }
      const database = ctx.str("database") ?? "default";
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
        throw new Error(`ClickHouse database name "${database}" is not a plain identifier`);
      }

      const endpoint = new URL(url);
      endpoint.searchParams.set("database", database);
      endpoint.searchParams.set("query", `INSERT INTO \`${table}\` FORMAT JSONEachRow`);

      const headers: Record<string, string> = { "Content-Type": "application/x-ndjson" };
      const username = ctx.str("username");
      const password = ctx.str("password");
      if (username) {
        // ClickHouse accepts credentials as query parameters too; a header
        // keeps them out of the server's own query log.
        headers["X-ClickHouse-User"] = username;
        if (password) headers["X-ClickHouse-Key"] = password;
      }

      const res = await ctx.fetch(endpoint.toString(), {
        method: "POST",
        headers,
        body: ctx.rows.map((r) => JSON.stringify(r)).join("\n"),
      });
      if (!res.ok) {
        // ClickHouse puts the reason in the body and it is genuinely useful
        // (a missing column names itself), so it is worth carrying through.
        throw new Error(`ClickHouse responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }
    },
  },
});
