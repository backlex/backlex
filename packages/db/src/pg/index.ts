import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type PgDb = PostgresJsDatabase<typeof schema>;

export const createPgClient = (url: string): PgDb => {
  const client = postgres(url, { prepare: false });
  return drizzle(client, { schema });
};

export { schema };
