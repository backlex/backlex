---
title: Drizzle upgrade runbook
description: How to move off the pinned drizzle-orm/drizzle-kit 1.0 beta onto stable, in lockstep across all consuming packages.
---

# Drizzle upgrade runbook

The ORM is pinned to **`drizzle-orm@1.0.0-beta.22`** (and `drizzle-kit@1.0.0-beta.22`
for codegen). This is a deliberate, tracked production-readiness item: the whole
data layer rides a beta, so the upgrade to stable must be done in one coordinated
change, not piecemeal.

## Why it's pinned

The `1.0.0-beta` line changed APIs versus the 0.x docs, and beta-to-beta releases
have themselves shipped breaking changes. Every consuming package must move
together or the source-consumed workspace graph (`packages/*` are imported by
source, no build step) will mix incompatible runtime + types.

## Where it's pinned (move all together)

| Package | Dependency |
|---|---|
| `apps/web` | `drizzle-orm` |
| `packages/db` | `drizzle-orm` + `drizzle-kit` (codegen) |
| `packages/auth` | `drizzle-orm` |
| `packages/cli` | `drizzle-orm` |

`packages/db` is the only one with `drizzle-kit` (it owns migration generation).

## Upgrade steps

1. **Read the changelog** first — `drizzle-orm` 1.0 stable release notes +
   any beta→stable migration guide. Note query-builder, `sql` helper, and
   column-codec changes; this repo leans on raw `sql.raw(...)` in several
   services (metrics, backup) and dual-dialect schema, both sensitive to codec
   behaviour.
2. **Bump in lockstep** — set the identical stable version in all four
   `package.json` files above (orm everywhere, kit in `packages/db`), then
   `bun install`. Never bump one package alone.
3. **Regenerate snapshots, don't hand-edit** — run `bun run db:generate:pg` and
   `bun run db:generate:sqlite` from a real TTY (drizzle-kit prompts on renames).
   These only refresh the drizzle snapshot; the **hand-written SQL migrations**
   under `packages/db/drizzle/{pg,sqlite}/` stay authoritative — review any diff
   the new kit produces but keep both dialects in lockstep.
4. **Typecheck** — `bun run typecheck`. Beta→stable type changes surface here
   first; expect to touch the `as any` casts in `routes/items.ts` (the
   dual-dialect union is why they exist).
5. **Test both dialects** — `bun run test` (SQLite in-process + `pg-smoke` via
   pglite). The migration applier (`packages/db/src/auto-migrate.ts`) and
   `schema-applier.ts` are the highest-risk surfaces.
6. **Build the runtime targets** — `bun run build:targets` (CF Workers / Vercel /
   Netlify / Node, plus the shared SPA). Driver behaviour (postgres-js vs
   neon-http) can shift across ORM versions.
7. **Smoke the live deploy** after merge per the standard workflow — exercise a
   create/read/update path on each dialect you run in production.

## Rollback

Revert the four `package.json` bumps + `bun.lock` and `bun install`. Because
migrations are hand-written SQL (not generated at deploy), no schema rollback is
needed — only the dependency pin moves.
