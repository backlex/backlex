# Examples

End-to-end apps that **consume** backlex through its client SDKs — the fastest
way to see how a real frontend talks to a backlex backend.

Each example is a self-contained workspace under `examples/*`. They depend on the
in-repo SDKs by `workspace:*`, so they always track the current API. Copying one
out of the monorepo? Swap the `workspace:*` dependency for the published package.

| Example | Stack | Shows |
|---|---|---|
| [`todo-react`](./todo-react) | React 19 + Vite + `backlex` | Workspace auth, collection CRUD, realtime (SSE) |

More to come — mobile (Swift/Kotlin), other frameworks, and feature-focused
demos (storage, search, offline sync). Contributions welcome: add a folder here,
keep it minimal and runnable in a couple of commands, and list it in this table.

## Running any example

1. Start the backend from the repo root: `bun install && bun run dev`
   (API + admin on `http://localhost:5173`).
2. `cd examples/<name>` and follow its README — typically `cp .env.example .env`,
   set a value or two, then `bun run dev`.
