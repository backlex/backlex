/**
 * `backlex booking` — publish a calendar and take what is on it, over
 * `/api/admin/booking`. See `docs/booking.md`.
 *
 * `create` and `url` print the public page link, and `book` prints the manage
 * link. This is the one surface that does, and it is deliberate for the same
 * reason `signatures send` prints signing links: a terminal is the operator's
 * own screen, and getting a URL you can paste into your own site is most of the
 * reason to reach for the CLI here. Every other surface withholds them, because
 * an MCP tool result is transcript and a flow op's result is readable by every
 * op after it.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface RuleRow {
  kind: string;
  weekday: number | null;
  startMinute: number;
  endMinute: number;
  startsOn: string | null;
  endsOn: string | null;
  reason: string | null;
}

interface ResourceRow {
  id: string;
  key: string;
  name: string;
  timeZone: string;
  slotMinutes: number;
  capacity: number;
  active: boolean;
  rules: RuleRow[];
}

interface BookingRow {
  id: string;
  start: string;
  end: string;
  status: string;
  customerName: string | null;
  customerEmail: string | null;
  source: string;
}

const HELP = `backlex booking <resources|create|update|url|delete|slots|list|book|confirm|cancel|move|no-show>

  resources
  create <key> --name <n> [--tz <IANA>] [--slot <min>] [--capacity <n>]
         [--step <min>] [--buffer-before <min>] [--buffer-after <min>]
         [--lead <min>] [--horizon <days>] [--hold <min>]
         [--open <rule>]                      (repeatable)
         [--block <rule>]                     (repeatable)
         [--mirror <collection>] [--map <from>=<column>]  (repeatable)
  update <key> [same flags as create]
  url <key>                                   rotate + print the page link
  delete <key> [--force]
  slots <key> [--from <iso>] [--to <iso>]
  list [--resource <key>] [--status <s>] [--from <iso>] [--to <iso>]
       [--order asc|desc] [--live]            desc is the default; --live drops
                                              cancelled, no-show and lapsed holds
  book <key> --start <iso> [--end <iso>] [--name <n>] [--email <e>]
       [--phone <p>] [--notes <n>] [--hold]
  confirm <id>
  cancel <id> [--reason <r>] [--no-notify]
  move <id> --start <iso>
  no-show <id>

  A RULE is <weekday>:<HH:MM>-<HH:MM>, e.g. --open mon:09:00-17:00. Weekdays
  are sun mon tue wed thu fri sat, or * for every day. Times are LOCAL to the
  resource's zone. A span crossing midnight is two rules:
    --open fri:22:00-24:00 --open sat:00:00-02:00

  A dated exception drops the weekday and takes a range instead:
    --block 2026-08-10..2026-08-17          (whole days)
    --block 2026-08-10..2026-08-10:12:00-13:00

  Every --open/--block on the line REPLACES the resource's whole pattern:
  opening hours are edited as one thing, not row by row.

  --tz is the zone the RULES are written in, not a display preference. It is
  what decides which instant "Mondays 09:00" actually names, so it has to be
  the resource's own zone.

  Buffers belong to every booking, so --buffer-before 15 --buffer-after 15
  leaves a 30-minute gap between two of them; they are different activities.
  Set one side for a one-sided gap.

  book is the OPERATOR's path and is NOT restricted to the published grid —
  that is what makes it usable for a booking taken over the phone. The
  capacity guarantee still applies and a taken slot fails with 409.

  create and url print the public page URL ONCE. Only its hash is stored, so
  nothing can show it again; url mints a new one and invalidates the old.
`;

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const parseClock = (raw: string): number => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`"${raw}" is not a HH:MM time`);
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  if (minutes < 0 || minutes > 1440) throw new Error(`"${raw}" is outside 00:00–24:00`);
  return minutes;
};

/**
 * `mon:09:00-17:00`, `*:09:00-17:00`, `2026-08-10..2026-08-17`, or
 * `2026-08-10..2026-08-17:12:00-13:00`.
 *
 * The dated forms exist because a one-off closure is not a weekday: a holiday
 * or a week of leave is a date range that applies to every day inside it, which
 * is exactly how the rule table says it.
 */
const parseRule = (raw: string, kind: "open" | "block"): Record<string, unknown> => {
  const dated = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})(?::(.+))?$/.exec(raw.trim());
  if (dated) {
    const [, startsOn, endsOn, clock] = dated;
    const times = clock ? clock.split("-") : null;
    return {
      kind,
      weekday: null,
      startsOn,
      endsOn,
      startMinute: times?.[0] ? parseClock(times[0]) : 0,
      endMinute: times?.[1] ? parseClock(times[1]) : 1440,
    };
  }

  const m = /^([a-z*]+):(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/i.exec(raw.trim());
  if (!m) {
    throw new Error(
      `"${raw}" is not a rule — expected <weekday>:<HH:MM>-<HH:MM> or <date>..<date>[:<HH:MM>-<HH:MM>]`,
    );
  }
  const [, day, from, to] = m;
  const weekday = day === "*" ? null : WEEKDAYS.indexOf(day!.toLowerCase());
  if (weekday === -1) throw new Error(`"${day}" is not a weekday (${WEEKDAYS.join(" ")} or *)`);
  // A `*` rule needs a date range or it applies to every day forever, which the
  // server refuses; say so here rather than round-tripping for the 422.
  if (weekday === null) {
    throw new Error("* needs a date range — use the <date>..<date>:<HH:MM>-<HH:MM> form");
  }
  return { kind, weekday, startMinute: parseClock(from!), endMinute: parseClock(to!) };
};

const collectRepeated = (args: string[], name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) out.push(args[i + 1]!);
  }
  return out;
};

const num = (args: string[], name: string): number | undefined => {
  const raw = flag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} needs a number`);
  return value;
};

/** The flags every `create`/`update` shares, collapsed into the patch body. */
const resourceInput = (rest: string[]): Record<string, unknown> => {
  const rules = [
    ...collectRepeated(rest, "--open").map((r) => parseRule(r, "open")),
    ...collectRepeated(rest, "--block").map((r) => parseRule(r, "block")),
  ];
  const map: Record<string, string> = {};
  for (const pair of collectRepeated(rest, "--map")) {
    const [from, column] = pair.split("=");
    if (from && column) map[from.trim()] = column.trim();
  }

  const patch: Record<string, unknown> = {};
  const put = (key: string, value: unknown) => {
    if (value !== undefined) patch[key] = value;
  };
  put("name", flag(rest, "--name"));
  put("description", flag(rest, "--description"));
  put("timeZone", flag(rest, "--tz"));
  put("slotMinutes", num(rest, "--slot"));
  put("stepMinutes", num(rest, "--step"));
  put("capacity", num(rest, "--capacity"));
  put("bufferBeforeMinutes", num(rest, "--buffer-before"));
  put("bufferAfterMinutes", num(rest, "--buffer-after"));
  put("leadMinutes", num(rest, "--lead"));
  put("horizonDays", num(rest, "--horizon"));
  put("holdMinutes", num(rest, "--hold"));
  put("confirmationMessage", flag(rest, "--message"));
  put("mirrorCollection", flag(rest, "--mirror"));
  if (Object.keys(map).length > 0) patch.mirrorFieldMap = map;
  if (rules.length > 0) patch.rules = rules;
  if (has(rest, "--inactive")) patch.active = false;
  if (has(rest, "--active")) patch.active = true;
  return patch;
};

const localTime = (iso: string, timeZone: string): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));

export const runBooking = async (args: string[]): Promise<void> => {
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
      case "resources": {
        const out = await client.booking.listResources();
        if (json) printJson(out.data);
        else
          printTable(
            (out.data as unknown as ResourceRow[]).map((r) => ({
              key: r.key,
              name: r.name,
              zone: r.timeZone,
              slot: `${r.slotMinutes}m`,
              seats: r.capacity,
              rules: r.rules.length,
              active: r.active ? "yes" : "paused",
            })),
          );
        return;
      }

      case "create": {
        const key = rest[0];
        if (!key) throw new Error("create needs a key");
        const name = flag(rest, "--name");
        if (!name) throw new Error("create needs --name");
        const out = await client.booking.createResource({
          key,
          name,
          ...resourceInput(rest),
        } as never);
        if (json) {
          printJson(out.data);
        } else {
          printKeyValues({
            key: out.data.resource.key,
            name: out.data.resource.name,
            zone: out.data.resource.timeZone,
            rules: String(out.data.resource.rules.length),
            // Shown once. Only the hash is stored, so nothing can print it again.
            url: out.data.url,
          });
        }
        return;
      }

      case "update": {
        const key = rest[0];
        if (!key) throw new Error("update needs a key");
        const out = await client.booking.updateResource(key, resourceInput(rest) as never);
        if (json) printJson(out.data);
        else printKeyValues({ key: out.data.key, name: out.data.name, rules: String(out.data.rules.length) });
        return;
      }

      case "url": {
        const key = rest[0];
        if (!key) throw new Error("url needs a key");
        const out = await client.booking.rotateToken(key);
        if (json) printJson(out.data);
        else {
          process.stdout.write(`${out.data.url}\n`);
          process.stderr.write("The previous link no longer works. Existing bookings are untouched.\n");
        }
        return;
      }

      case "delete": {
        const key = rest[0];
        if (!key) throw new Error("delete needs a key");
        await client.booking.deleteResource(key, { force: has(rest, "--force") });
        if (!json) process.stdout.write(`deleted ${key}\n`);
        return;
      }

      case "slots": {
        const key = rest[0];
        if (!key) throw new Error("slots needs a key");
        const window: { from?: string; to?: string } = {};
        const from = flag(rest, "--from");
        const to = flag(rest, "--to");
        if (from) window.from = from;
        if (to) window.to = to;
        const out = await client.booking.slots(key, window);
        if (json) {
          printJson(out.data);
        } else {
          const zone = String(out.data.resource.timeZone ?? "UTC");
          printTable(
            out.data.slots.map((s) => ({
              // Printed in the RESOURCE's zone: an operator reading a list of
              // instants in their own terminal's zone would misread every one
              // of them for a resource abroad.
              when: localTime(s.start, zone),
              utc: s.start,
              left: s.remaining,
            })),
          );
          if (out.data.slots.length === 0) process.stderr.write("no open slots in that window\n");
        }
        return;
      }

      case "list": {
        const opts: Record<string, string | boolean> = {};
        for (const [flagName, key] of [
          ["--resource", "resource"],
          ["--status", "status"],
          ["--from", "from"],
          ["--to", "to"],
          ["--order", "order"],
        ] as const) {
          const value = flag(rest, flagName);
          if (value) opts[key] = value;
        }
        if (has(rest, "--live")) opts.live = true;
        const out = await client.booking.listBookings(opts as never);
        if (json) printJson(out.data);
        else
          printTable(
            (out.data as unknown as BookingRow[]).map((b) => ({
              id: b.id.slice(0, 8),
              start: b.start,
              status: b.status,
              who: b.customerName ?? b.customerEmail ?? "—",
              via: b.source,
            })),
          );
        return;
      }

      case "book": {
        const key = rest[0];
        const start = flag(rest, "--start");
        if (!key || !start) throw new Error("book needs a resource key and --start");
        const input: Record<string, unknown> = { start };
        for (const [flagName, field] of [
          ["--end", "end"],
          ["--name", "name"],
          ["--email", "email"],
          ["--phone", "phone"],
          ["--notes", "notes"],
        ] as const) {
          const value = flag(rest, flagName);
          if (value) input[field] = value;
        }
        if (has(rest, "--hold")) input.hold = true;
        const out = await client.booking.book(key, input as never);
        if (json) {
          printJson(out.data);
        } else {
          printKeyValues({
            id: out.data.booking.id,
            start: out.data.booking.start,
            status: out.data.booking.status,
            emailed: out.data.emailed ? "yes" : "no",
            // Shown once, same as the page link.
            manage: out.data.manageUrl,
          });
        }
        return;
      }

      case "confirm": {
        const id = rest[0];
        if (!id) throw new Error("confirm needs a booking id");
        const out = await client.booking.confirm(id);
        if (json) printJson(out.data);
        else printKeyValues({ id: out.data.id, status: out.data.status });
        return;
      }

      case "cancel": {
        const id = rest[0];
        if (!id) throw new Error("cancel needs a booking id");
        const opts: { reason?: string; notify?: boolean } = {};
        const reason = flag(rest, "--reason");
        if (reason) opts.reason = reason;
        if (has(rest, "--no-notify")) opts.notify = false;
        const out = await client.booking.cancel(id, opts);
        if (json) printJson(out.data);
        else printKeyValues({ id: out.data.id, status: out.data.status });
        return;
      }

      case "move": {
        const id = rest[0];
        const start = flag(rest, "--start");
        if (!id || !start) throw new Error("move needs a booking id and --start");
        const out = await client.booking.reschedule(id, start);
        if (json) {
          printJson(out.data);
        } else {
          printKeyValues({
            id: out.data.booking.id,
            start: out.data.booking.start,
            // The old link is spent; this is the replacement.
            manage: out.data.manageUrl,
          });
        }
        return;
      }

      case "no-show": {
        const id = rest[0];
        if (!id) throw new Error("no-show needs a booking id");
        const out = await client.booking.noShow(id);
        if (json) printJson(out.data);
        else printKeyValues({ id: out.data.id, status: out.data.status });
        return;
      }

      default:
        process.stderr.write(`unknown booking subcommand: ${sub}\n\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `booking ${sub}`);
  }
};
