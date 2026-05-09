// Worker-only shim for `bun:sqlite`. The Worker entry never actually calls
// `createBunSqliteClient()` (D1 is selected when env.D1 is bound), so this
// file's exports exist only to satisfy esbuild's static import resolution.
export class Database {
  constructor() {
    throw new Error("bun:sqlite is not available on Cloudflare Workers");
  }
}
