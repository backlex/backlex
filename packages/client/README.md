# @backlex/client

Typed TypeScript client for the [backlex](https://backlex.com) API — the same
fetch wrapper the admin SPA and the official examples use.

```bash
npm i @backlex/client
```

```ts
import { createClient } from "@backlex/client";

const backlex = createClient({
  url: "https://api.your.app",
  workspace: "acme", // app mode: auth + data scoped to one workspace
});

await backlex.auth.signUp({ email, password, name });
const { data } = await backlex.from("todos").list({ sort: ["-created_at"] });
await backlex.from("todos").create({ title: "Hello", done: false });
const off = backlex.subscribe("items:todos", (e) => console.log(e.event, e.data));
```

Covers auth (email/OAuth/magic-link/OTP), collection CRUD + a fluent typed query
builder, batch writes, full-text/vector/hybrid search, realtime (SSE), storage +
resumable uploads, jobs, feature flags, and offline-first sync. Full reference:
**https://backlex.com/docs/sdk-and-cli**.

## Runtime requirements

This package ships as **TypeScript source** (no build step) and has **zero
dependencies**. Consume it through any bundler / TS-aware runtime:

- **Bundlers** — Vite, Next.js, esbuild, Rollup, webpack, Bun, Deno: work on any
  Node version; types resolve automatically.
- **Direct `node` execution** — Node ≥ 22.6 runs the `.ts` sources via native
  type-stripping (`--experimental-strip-types`; unflagged from 23.6 / Node 22.18
  LTS).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
