/**
 * `backlex channels` — the rules that authorize application-owned realtime
 * channels, plus publish / history / explain. See `docs/realtime.md`.
 *
 * `explain` is the command to reach for first. A failing subscribe says only
 * that it was refused; `explain` says WHICH rule matched (or that none did),
 * what the pattern captured, and whether this identity may subscribe or
 * publish — the three things the error cannot carry without leaking the rule
 * set to whoever asked.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface AccessView {
  access: "none" | "public" | "authenticated" | "roles";
  roles?: string[];
  condition?: unknown;
}

interface RuleRow {
  id: string;
  name: string;
  pattern: string;
  subscribe: AccessView;
  publish: AccessView;
  presence: boolean;
  replay: boolean;
  retentionHours: number;
  enabled: boolean;
}

const HELP = `backlex channels <list|create|update|delete|explain|publish|history>

  list
  create --name <n> --pattern <p>
         --subscribe <none|public|authenticated|roles[:r1,r2]>
         --publish   <none|public|authenticated|roles[:r1,r2]>
         [--subscribe-condition <json>] [--publish-condition <json>]
         [--presence] [--replay] [--retention <hours>]
  update <id> [--name …] [--pattern …] [--subscribe …] [--publish …]
              [--subscribe-condition <json>] [--publish-condition <json>]
              [--presence|--no-presence] [--replay|--no-replay]
              [--retention <hours>] [--enable|--disable]
  delete <id>
  explain <channel>             which rule governs it, and your verdict
  publish <channel> --data <json> [--event <name>]
  history <channel> [--since <cursor>] [--limit <n>]

  A pattern is colon-separated segments:
    literal   matches itself
    *         one segment, any value
    **        the rest (last segment only)
    {name}    one segment, captured — readable by a condition as \`name\`

  So \`org:{org}:feed\` with
    --subscribe roles:member --subscribe-condition '{"org":{"_eq":"$org.id"}}'
  authorizes every org's feed with one rule, without enumerating orgs.

  A channel with NO matching rule is refused in both directions. The first
  segment must be a literal and may not be one the managed channels own
  (items, signal, presence, collab, agent, collections).
`;

const ADMIN = "/api/admin/realtime-channels";

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

/** `roles:editor,admin` → `{ access: "roles", roles: ["editor","admin"] }`. */
const parseAccess = (raw: string | undefined, label: string): AccessView | undefined => {
  if (!raw) return undefined;
  const [kind, list] = raw.split(":");
  if (kind === "none" || kind === "public" || kind === "authenticated") {
    return { access: kind };
  }
  if (kind === "roles") {
    const roles = (list ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    if (!roles.length) {
      process.stderr.write(`--${label} roles:<r1,r2> needs at least one role.\n`);
      process.exit(1);
    }
    return { access: "roles", roles };
  }
  process.stderr.write(`--${label} must be none | public | authenticated | roles:<r1,r2>\n`);
  return process.exit(1) as never;
};

const parseJsonFlag = (raw: string | undefined, label: string): unknown => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write(`--${label} must be valid JSON.\n`);
    return process.exit(1) as never;
  }
};

const describeAccess = (a: AccessView): string => {
  const base = a.access === "roles" ? `roles:${(a.roles ?? []).join(",")}` : a.access;
  return a.condition ? `${base} +cond` : base;
};

export const runChannels = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  try {
    switch (sub) {
      case "list": {
        const { data } = await client.request<{ data: RuleRow[] }>("GET", ADMIN);
        if (json) printJson(data);
        else
          printTable(
            data.map((r) => ({
              id: r.id,
              name: r.name,
              pattern: r.pattern,
              subscribe: describeAccess(r.subscribe),
              publish: describeAccess(r.publish),
              presence: r.presence ? "yes" : "",
              replay: r.replay ? `${r.retentionHours}h` : "",
              status: r.enabled ? "on" : "off",
            })),
          );
        return;
      }
      case "create": {
        const name = flag(rest, "--name");
        const pattern = flag(rest, "--pattern");
        if (!name || !pattern) {
          process.stderr.write("channels create --name <n> --pattern <p>\n");
          process.exit(1);
        }
        const subscribe = parseAccess(flag(rest, "--subscribe"), "subscribe");
        const publish = parseAccess(flag(rest, "--publish"), "publish");
        if (!subscribe || !publish) {
          process.stderr.write(
            "channels create needs --subscribe and --publish — a rule that says nothing " +
              "authorizes nothing, and silence is not a safe default.\n",
          );
          process.exit(1);
        }
        const sc = parseJsonFlag(flag(rest, "--subscribe-condition"), "subscribe-condition");
        if (sc !== undefined) subscribe!.condition = sc;
        const pc = parseJsonFlag(flag(rest, "--publish-condition"), "publish-condition");
        if (pc !== undefined) publish!.condition = pc;
        const body: Record<string, unknown> = { name, pattern, subscribe, publish };
        if (has(rest, "--presence")) body.presence = true;
        if (has(rest, "--replay")) body.replay = true;
        const retention = flag(rest, "--retention");
        if (retention) body.retentionHours = Number(retention);
        const res = await client.request<{ data: RuleRow }>("POST", ADMIN, body);
        if (json) printJson(res.data);
        else
          printKeyValues({
            id: res.data.id,
            pattern: res.data.pattern,
            subscribe: describeAccess(res.data.subscribe),
            publish: describeAccess(res.data.publish),
          });
        return;
      }
      case "update": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("channels update <id> …\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = {};
        const name = flag(rest, "--name");
        if (name) body.name = name;
        const pattern = flag(rest, "--pattern");
        if (pattern) body.pattern = pattern;
        const subscribe = parseAccess(flag(rest, "--subscribe"), "subscribe");
        const publish = parseAccess(flag(rest, "--publish"), "publish");
        const sc = parseJsonFlag(flag(rest, "--subscribe-condition"), "subscribe-condition");
        const pc = parseJsonFlag(flag(rest, "--publish-condition"), "publish-condition");
        if (subscribe) {
          if (sc !== undefined) subscribe.condition = sc;
          body.subscribe = subscribe;
        } else if (sc !== undefined) {
          process.stderr.write(
            "--subscribe-condition needs --subscribe too: a condition narrows an access " +
              "level, and sending it alone would leave the stored level unstated.\n",
          );
          process.exit(1);
        }
        if (publish) {
          if (pc !== undefined) publish.condition = pc;
          body.publish = publish;
        } else if (pc !== undefined) {
          process.stderr.write("--publish-condition needs --publish too.\n");
          process.exit(1);
        }
        if (has(rest, "--presence")) body.presence = true;
        if (has(rest, "--no-presence")) body.presence = false;
        if (has(rest, "--replay")) body.replay = true;
        if (has(rest, "--no-replay")) body.replay = false;
        const retention = flag(rest, "--retention");
        if (retention) body.retentionHours = Number(retention);
        if (has(rest, "--enable")) body.enabled = true;
        if (has(rest, "--disable")) body.enabled = false;
        const res = await client.request<{ data: RuleRow }>(
          "PATCH",
          `${ADMIN}/${encodeURIComponent(id)}`,
          body,
        );
        if (json) printJson(res.data);
        else process.stdout.write(`updated ${res.data.pattern}\n`);
        return;
      }
      case "delete": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("channels delete <id>\n");
          process.exit(1);
        }
        await client.request("DELETE", `${ADMIN}/${encodeURIComponent(id)}`);
        process.stdout.write("deleted\n");
        return;
      }
      case "explain": {
        const channel = rest[0];
        if (!channel) {
          process.stderr.write("channels explain <channel>\n");
          process.exit(1);
        }
        const res = await client.request<{
          channel: string;
          managed: boolean;
          matched: { name: string; pattern: string } | null;
          params: Record<string, string>;
          canSubscribe: boolean;
          canPublish: boolean;
          reason: string;
        }>("GET", `/api/realtime/${encodeURIComponent(channel)}/explain`);
        if (json) printJson(res);
        else
          printKeyValues({
            channel: res.channel,
            rule: res.matched ? `${res.matched.name} (${res.matched.pattern})` : "—",
            captured: Object.entries(res.params)
              .map(([k, v]) => `${k}=${v}`)
              .join(" ") || "—",
            subscribe: res.canSubscribe ? "allowed" : "refused",
            publish: res.canPublish ? "allowed" : "refused",
            why: res.reason,
          });
        return;
      }
      case "publish": {
        const channel = rest[0];
        const raw = flag(rest, "--data");
        if (!channel || raw === undefined) {
          process.stderr.write("channels publish <channel> --data <json>\n");
          process.exit(1);
        }
        const body: Record<string, unknown> = { data: parseJsonFlag(raw, "data") };
        const event = flag(rest, "--event");
        if (event) body.event = event;
        await client.request("POST", `/api/realtime/${encodeURIComponent(channel!)}/publish`, body);
        process.stdout.write("published\n");
        return;
      }
      case "history": {
        const channel = rest[0];
        if (!channel) {
          process.stderr.write("channels history <channel>\n");
          process.exit(1);
        }
        const q = new URLSearchParams();
        const since = flag(rest, "--since");
        if (since) q.set("since", since);
        const limit = flag(rest, "--limit");
        if (limit) q.set("limit", limit);
        const qs = q.toString();
        const res = await client.request<{
          data: Array<{
            id: string;
            event: string;
            data: unknown;
            from: { id: string; name: string | null } | null;
            at: number;
            cursor: string;
          }>;
          cursor: string | null;
        }>("GET", `/api/realtime/${encodeURIComponent(channel)}/replay${qs ? `?${qs}` : ""}`);
        if (json) printJson(res);
        else {
          printTable(
            res.data.map((m) => ({
              at: new Date(m.at).toISOString(),
              event: m.event,
              from: m.from?.name ?? m.from?.id ?? "—",
              data: JSON.stringify(m.data).slice(0, 60),
            })),
          );
          if (res.cursor) process.stdout.write(`\nnext: --since ${res.cursor}\n`);
        }
        return;
      }
      default:
        process.stdout.write(HELP);
    }
  } catch (e) {
    die(e, `channels ${sub}`);
  }
};
