# backlex

Typed TypeScript client for the [backlex](https://backlex.com) API — what the
official examples, and your own application, are built on.

(The admin console deliberately keeps its own client: it carries a Cloudflare
D1 Sessions bookmark this SDK has no equivalent for. See
[Architecture](https://backlex.com/docs/architecture#why-the-admin-keeps-its-own-client).)

```bash
npm i backlex                  # npm — compiled ESM + types
# or
npx jsr add @backlex/backlex   # JSR — TypeScript source
```

```ts
import { createClient } from "backlex";

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

## Agent skill

An [Agent Skill](https://code.claude.com/docs/en/skills) ships in the package at
`skills/backlex/`. Drop it into your project so any agent tool that reads the
format — Claude Code, Codex CLI, Cursor, Copilot, Gemini CLI — drives this API
correctly instead of guessing:

```bash
mkdir -p .claude/skills && cp -r node_modules/backlex/skills/backlex .claude/skills/
```

## Distribution

Published to two registries, both **zero-dependency**:

- **npm** (`npm i backlex`) — compiled ESM JavaScript + `.d.ts`. Works in every
  bundler (Vite, Next.js, webpack, esbuild, Rollup), in Node (any version), in
  Deno/Bun, and for plain `tsc` consumers.
- **JSR** (`npx jsr add @backlex/backlex`) — the TypeScript source; JSR transpiles
  + generates types on install for Node consumers and serves source to Deno/Bun.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
