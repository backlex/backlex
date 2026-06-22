# `@backlex/cli`

The command-line interface for [backlex](https://backlex.com) — manage any
backlex instance from your terminal or CI. It talks to the same REST API as the
[`backlex`](https://www.npmjs.com/package/backlex) SDK, authenticating with a
personal API key (`pak_…`).

## Install

```bash
# one-off (no install)
npx @backlex/cli login --url https://api.your.app --key pak_xxx

# or with Bun
bunx @backlex/cli login --url https://api.your.app --key pak_xxx

# or globally — the binary is `backlex`
npm i -g @backlex/cli
backlex whoami
```

> The npm package is `@backlex/cli`; the installed command is `backlex`. (The
> bare `backlex` npm package is the SDK, not the CLI.)

## Quick start

```bash
backlex login --url https://api.your.app --key pak_xxx   # saves a profile
backlex whoami                                           # who the key is
backlex collections list                                 # what you can reach
backlex items list posts --filter '{"published":{"_eq":true}}' --limit 10
```

`login` saves the connection to `~/.backlex/config.json` (mode `0600`), so later
commands need no flags. Precedence per field: flag > env (`BACKLEX_URL` /
`BACKLEX_API_KEY` / `BACKLEX_TENANT`) > saved profile.

## Commands

`backlex help` lists everything; run any group bare (e.g. `backlex items`) for
its flags. Groups: `login` / `logout` / `whoami` / `profile`, `collections`,
`items`, `backup`, `users` / `roles`, `flags`, `settings`, `functions`, `flows`,
`webhooks`, `jobs`, `advisor`, `init`, `sdk`, `gen-types`, `gen-openapi`,
`migrate`, `mcp`. Add `--json` to any read for machine-readable output.

`migrate` is Bun-only (it uses `bun:sqlite`) and for self-hosting; every other
command runs under Node.

Full guide: <https://backlex.com/docs/sdk-and-cli>.

## License

Apache-2.0
