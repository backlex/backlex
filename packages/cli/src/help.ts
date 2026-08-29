/**
 * The CLI's user-facing command list, in one place.
 *
 * Kept out of `bin/backlex.ts` so it can be read without running the CLI —
 * `apps/web/tests/cli-release-drift.test.ts` parses it to compare the commands
 * this build offers against the ones the published `@backlex/cli` actually has.
 * Importing the bin would print this text and dispatch a command.
 */
export const HELP = `backlex — self-hostable backend platform CLI

Connection (most commands; precedence: flag > env > saved profile):
  --url <url>        API base (default http://localhost:8787, env BACKLEX_URL)
  --key <pak_…>      API key (env BACKLEX_API_KEY); '-' reads from stdin
  --tenant <id>      scope to a tenant (slug or id), env BACKLEX_TENANT
  --profile <name>   use a named saved profile instead of the active one
  --json             machine-readable JSON output

Usage:
  backlex login [--url <url>] [--key <pak_…>|-] [--tenant <id>] [--profile <name>]
      Verify the key against /api/me and save it as a profile (default: "default").
      With no --key on a TTY, prompts without echoing.

  backlex logout [--profile <name>] [--all]
      Clear the saved credentials for a profile (--all removes the profile).

  backlex whoami [--profile <name>] [--json]
      Show the identity (user, roles, tenant) behind the resolved key.

  backlex profile <list|use|add|remove>
      list                              show all profiles (* = active)
      use <name>                        set the active profile
      add <name> --url <url> [--key …] [--tenant …]   add/replace a profile
      remove <name>                     delete a profile

  backlex collections <list|get|export-schema|drop-field|fts-reindex|vectorize>
      Inspect the schema of the connected instance. \`list\` shows everything
      the key can reach; \`fts-reindex\` / \`vectorize\` rebuild a collection's
      search indexes. Run \`backlex collections\` for details.

  backlex items <list|get|create|update|delete|export|import|search> <slug>
      Data-plane CRUD + bulk export/import + search. Run \`backlex items\`
      for the per-command flags.

  backlex backup <list|now|download|restore|config>
      Logical backups + restore + schedule. \`restore\` requires --confirm.

  backlex users <list|grant|revoke>
      Workspace users + role assignment. \`grant <userId> admin\` replaces the
      manual user_roles SQL.

  backlex roles list
      Roles in the active workspace (ids to use with \`users grant\`).

  backlex permissions simulate --collection <slug> --action <action>
      Dry-run the permission resolver and explain the allow/deny decision.
      Test a real user (\`--user <id>\`) or ad-hoc roles (\`--roles a,b\`).

  backlex tenants <list|switch|members|invite|set-role|transfer|remove|...>
      Workspaces and the OPERATORS in them — invite, change a role, hand
      ownership over, evict. You must outrank whoever you act on, and the last
      owner can only be replaced by \`transfer\`, never removed.

  backlex orgs <list|get|create|update|delete|members|invite|...>
      App-plane organizations ("teams") — the B2B grouping inside a workspace.
      Members are end-users; \`--roles\` binds workspace roles per-org.

  backlex flags <list|set|delete>
      Feature flags / remote config. \`--global\` targets the global scope.

  backlex settings <get|set>
      Workspace settings (whitelisted keys).

  backlex functions <list|deploy|invoke|delete>
      Sandboxed JS functions. \`deploy <name> --file <path>\` is create-or-update.

  backlex flows <list|get|run|create|delete>
      Visual workflow builder (definitions as JSON).

  backlex extensions <list|install|push|enable|disable|uninstall|invoke>
      Extension packages. \`install <pkg>\` pulls from npm; \`push <dir>\` uploads
      a local extension for development.

  backlex dashboards <list|get|run|create|delete|share|revoke>
      Embedded BI dashboards. \`share <id>\` mints a public embed token.

  backlex kpis <list|get|run|create|update|delete>
      Named KPI definitions — the shared formula behind a figure. \`run\`
      evaluates one over a period and the period before it.

  backlex analytics <overview|funnel|retention|errors|track|ingest-key|...>
      Product analytics + crash reporting. \`ingest-key mint\` prints the
      publishable client key.

  backlex consent <policies|policy|versions|records|set|rm|wording>
      Cookie consent. \`set\` requires --undecided and --tracker the first
      time: both are compliance postures with no safe default.

  backlex forms <list|get|fields|create|update|rotate-token|delete>
      Public form builder. \`create\`/\`rotate-token\` print the one-time link.

  backlex usage <overview|series|limits|set-limits>
      Workspace usage metering: per-key request counts, gauges, plan limits.

  backlex schema <snapshots|capture|import|branches|create-branch|diff|apply|…>
      Migration diffing / schema branching. \`diff\`/\`apply\` take refs:
      live, snapshot:<id>, branch:<id>. \`apply --confirm-destructive\` for drops.

  backlex agents <list|get|create|update|delete|threads|run>
      AI agents. \`run <id> --message "…"\` runs a turn and prints the answer.

  backlex templates <list|apply|extract|clear-samples>
      Schema-template catalog. \`apply <id>\` seeds collections + sample data;
      \`apply --file <path>\` applies a custom template; \`extract\` exports the
      workspace schema as a template; \`clear-samples\` removes seeded demo rows.

  backlex webhooks <list|create|test|deliveries|retry|resume|delete>
      Outbound webhooks + delivery ops. \`resume\` re-enables an auto-disabled hook.

  backlex sync-hooks <list|create|update|test|delete>
      Services that run BEFORE a write and decide whether it happens.
      \`--on-error\` is required on create and has no safe default.

  backlex auth-hooks <list|create|update|test|delete>
      Your own code at four moments in END-USER auth: sign-up admission,
      access-token claims, password verification, auth-mail delivery.

  backlex channels <list|create|update|delete|explain|publish|history>
      Application-owned realtime channels: who may subscribe, who may publish,
      presence, and retained history. \`explain\` says why one was refused.

  backlex rls <status|plan|apply|disable>
      Compile this workspace's permission rules into Postgres row-level
      security, so psql and BI tools are filtered the way the API is.

  backlex s3 <list|create|update|delete>
      Credentials for the S3-compatible endpoint, so rclone, aws-cli, mc and
      any backup tool can read and write this workspace's objects.

  backlex support <captcha|impersonate|impersonations|end>
      The captcha in front of your public auth endpoints, and audited
      impersonation of an end-user (read-only by default, always recorded).

  backlex signing-keys <list|generate|import|promote|revoke|restore|delete>
      JWT signing keys with a life cycle — rotate by promoting a standby key
      instead of editing a secret and redeploying twice.

  backlex oauth <clients|register|enable|disable|delete|grants|revoke>
      The client registry for the authorization server this instance runs, and
      the consents people have given those clients.

  backlex cdc <list|create|update|run|delete>
      Deliver a collection's changefeed — deletes included — to a webhook or
      to this workspace's own bucket, at-least-once with a saved watermark.

  backlex documents <list|save|delete|render>
      HTML templates rendered to PDF — contracts, quotes, invoices.

  backlex signatures <list|get|send|void|resend|finalize|download>
      Send one of those documents out to be signed. \`send\` prints the
      signing links once; \`void\` and \`resend\` both invalidate the old one.

  backlex approvals <list|get|request|cancel>
      Park something on a human decision. \`request\` prints the decision
      links once; \`--policy\` picks all / any / quorum.

  backlex booking <resources|create|url|slots|list|book|cancel|move|no-show>
      Publish a calendar and take what is on it. \`create\` and \`url\` print the
      public page link once; \`slots\` shows the times still open.

  backlex integrations <catalog|list|connect|deliveries|resume|disconnect>
      Slack / Jira / Algolia / … — connect providers, read the delivery log, and
      re-enable one the circuit breaker paused.

  backlex payments <catalog|list|connect|sync|events|rotate-token|provision|disconnect>
      Stripe / Polar / Lemon Squeezy. \`connect\` also provisions the four sync
      collections; \`sync\` pulls history back from the provider API.

  backlex jobs <list|get|retry|cancel|remove|enqueue>
      Durable background job queue.

  backlex messaging <send-push|send-sms|devices|phones>
      Direct push/SMS dispatch + the caller's device/phone registrations.

  backlex advisor [--kind …] [--fail-on error|warn] [--apply <id>]
      Run security/performance checks. \`--fail-on\` makes it a CI gate;
      \`--apply\` carries out a finding's fix (e.g. create a missing index).

  backlex advisor insights [--days N]
      Slowest endpoints + per-collection list traffic, from recorded spans.

  backlex traces <list|get>
      Inspect distributed-tracing spans (request traces + waterfalls).

  backlex init [dir] [--force]
      Scaffold a TypeScript consumer starter (backlex.ts + .env.example).

  backlex sdk [lang]
      Discover the official native client SDKs (install + quickstart).

  backlex migrate [db-path]
      Apply SQLite migrations to db-path (default: ./.data/backlex.sqlite,
      or $DATABASE_PATH if set).

  backlex import-db <inspect|plan|run>
      Migrate an external database INTO backlex: introspect the source
      (Postgres), emit an editable migration plan, then copy the rows —
      PK-preserving, resumable, verified. Run \`backlex import-db\` for
      the per-command flags.

  backlex gen-types <api-url> [--out <file>] [--key <pak_…>] [--sdk]
      Fetch /api/collections and emit a TypeScript module describing every
      collection. With --out, writes to disk; otherwise prints to stdout. Use
      --key to authenticate via API key. Add --sdk to also emit a typed client
      factory (createTypedClient), so db.collections.<slug>.list() is typed.

  backlex gen-openapi [--out <file>]
      Fetch the live OpenAPI spec (/api/openapi.json) for codegen / Postman.

  backlex mcp --url <mcp-url> --key <pak_…> [--tenant <id>]
      Run an MCP (Model Context Protocol) server over stdio that proxies to a
      remote backlex /mcp HTTP endpoint. Wire into Claude Desktop / Cursor as a
      stdio command. URL defaults to http://localhost:8787/mcp; key falls back
      to BACKLEX_API_KEY.

  backlex help
      Show this message.
`;
