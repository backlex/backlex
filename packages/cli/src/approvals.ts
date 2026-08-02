/**
 * `backlex approvals` — park something on a human decision, over
 * `/api/admin/approvals`. See `docs/approvals.md`.
 *
 * `request` prints the decision links. This is the one surface that does, and
 * it is deliberate, for the same reason `signatures send` prints signing links:
 * a terminal is the operator's own screen, and the reason to reach for the CLI
 * is often to get a link you paste somewhere yourself — `--no-send` exists for
 * exactly that. Every other surface withholds them, because an MCP tool result
 * is transcript and a flow op's result is readable by every op after it.
 */
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface ApproverRow {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  status: string;
  reason: string | null;
  decidedAt?: unknown;
}

interface RequestRow {
  id: string;
  title: string;
  status: string;
  policy: string;
  quorum: number;
  ordered: boolean;
  outcomeReason: string | null;
  expiresAt?: unknown;
  approvers: ApproverRow[];
}

const HELP = `backlex approvals <list|get|request|cancel>

  list [--status pending|approved|rejected|expired|cancelled]
  get <id>
  request --title <t>
          --approver <email>[:<name>[:<role>]]   (repeatable)
          [--message <m>] [--policy all|any|quorum] [--quorum <n>]
          [--ordered] [--expires <hours>] [--no-send]
          [--subject <collection>:<rowId>]
          [--summary <label>=<value>]            (repeatable)
          [--write-back <field>:<approved>:<rejected>]
          [--notify <email>]                     (repeatable)
  cancel <id> [--reason <r>]

  --policy decides what settles it:
    all     everyone must approve; ONE rejection ends it (default)
    any     the first approval wins; rejected only if everybody rejects
    quorum  --quorum <n> approvals; rejected once n can no longer be reached

  --ordered means each link only opens once the one before it has decided;
  only the first approver is emailed, and the next when their turn arrives.

  --expires defaults to 72 hours. On expiry the request REJECTS — to
  everything downstream, nobody answering is not the same as approval.

  --write-back patches the subject row once the outcome is known, e.g.
    --write-back status:approved:rejected
  writes {"status":"approved"} on approval and {"status":"rejected"} on a
  rejection OR an expiry.

  request prints the decision links ONCE — only their hashes are stored, so
  nothing can show them again.

  There is no decide command. Deciding is the approver's act, authenticated
  by their own link; an admin key deciding on their behalf would also fire
  whatever the waiting flow does next.
`;

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

/** Every `--approver a@b.com:Ayşe:Finance` on the line, in the order given —
 *  which is the deciding order when `--ordered` is set. */
const collectApprovers = (args: string[]): Array<{ email: string; name?: string; role?: string }> => {
  const out: Array<{ email: string; name?: string; role?: string }> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--approver") continue;
    const raw = args[i + 1];
    if (!raw) continue;
    // Split on the first two colons only: a role could plausibly contain one,
    // an email address cannot.
    const [email, name, ...roleParts] = raw.split(":");
    out.push({
      email: (email ?? "").trim(),
      ...(name?.trim() ? { name: name.trim() } : {}),
      ...(roleParts.length && roleParts.join(":").trim() ? { role: roleParts.join(":").trim() } : {}),
    });
  }
  return out;
};

const collectRepeated = (args: string[], name: string): string[] => {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) out.push(args[i + 1]!);
  }
  return out;
};

/** `--summary Amount=1.240,00 TRY`. Splits on the FIRST `=` only, so a value
 *  may contain one. */
const collectSummary = (args: string[]): Array<{ label: string; value: string }> =>
  collectRepeated(args, "--summary").map((raw) => {
    const at = raw.indexOf("=");
    return at < 0
      ? { label: raw.trim(), value: "" }
      : { label: raw.slice(0, at).trim(), value: raw.slice(at + 1).trim() };
  });

export const runApprovals = async (args: string[]): Promise<void> => {
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
        const status = flag(rest, "--status");
        const out = await client.approvals.list(status ? { status: status as never } : undefined);
        if (json) printJson(out.data);
        else
          printTable(
            (out.data as unknown as RequestRow[]).map((r) => ({
              id: r.id,
              title: r.title,
              status: r.status,
              policy: r.policy === "quorum" ? `quorum ${r.quorum}` : r.policy,
              answered: `${r.approvers.filter((a) => a.status === "approved" || a.status === "rejected").length}/${r.approvers.length}`,
              order: r.ordered ? "sequential" : "any",
            })),
          );
        return;
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("approvals get <id>\n");
          process.exit(1);
        }
        const { data } = await client.approvals.get(id);
        const row = data as unknown as RequestRow;
        if (json) printJson(row);
        else {
          printKeyValues({
            id: row.id,
            title: row.title,
            status: row.status,
            policy: row.policy === "quorum" ? `quorum ${row.quorum}` : row.policy,
            order: row.ordered ? "sequential" : "any",
            outcomeReason: row.outcomeReason ?? "—",
          });
          printTable(
            row.approvers.map((a) => ({
              approverId: a.id,
              email: a.email,
              role: a.role ?? "",
              status: a.status,
              reason: a.reason ?? "",
            })),
          );
        }
        return;
      }
      case "request": {
        const title = flag(rest, "--title");
        if (!title) {
          process.stderr.write("approvals request needs --title <t>\n");
          process.exit(1);
        }
        const approvers = collectApprovers(rest);
        if (approvers.length === 0) {
          process.stderr.write(
            "approvals request needs at least one --approver <email>[:<name>[:<role>]]\n",
          );
          process.exit(1);
        }
        const policy = flag(rest, "--policy");
        const quorum = flag(rest, "--quorum");
        if (policy === "quorum" && !quorum) {
          // Refused here rather than server-side so the message names the flag
          // the operator actually has to type.
          process.stderr.write("--policy quorum needs --quorum <n>\n");
          process.exit(1);
        }

        let subject: { collection: string; id: string } | undefined;
        const rawSubject = flag(rest, "--subject");
        if (rawSubject) {
          const [collection, rowId] = rawSubject.split(":");
          if (!collection || !rowId) {
            process.stderr.write("--subject takes <collection>:<rowId>\n");
            process.exit(1);
          }
          subject = { collection, id: rowId };
        }

        let writeBack:
          | { field: string; approvedValue?: unknown; rejectedValue?: unknown }
          | undefined;
        const rawWb = flag(rest, "--write-back");
        if (rawWb) {
          const [field, approved, rejected] = rawWb.split(":");
          if (!field) {
            process.stderr.write("--write-back takes <field>:<approvedValue>:<rejectedValue>\n");
            process.exit(1);
          }
          writeBack = {
            field,
            ...(approved !== undefined ? { approvedValue: approved } : {}),
            ...(rejected !== undefined ? { rejectedValue: rejected } : {}),
          };
        }

        const summary = collectSummary(rest);
        const notify = collectRepeated(rest, "--notify");
        const expires = flag(rest, "--expires");

        const { data } = await client.approvals.create({
          title,
          approvers,
          ...(flag(rest, "--message") ? { message: flag(rest, "--message")! } : {}),
          ...(policy ? { policy: policy as never } : {}),
          ...(quorum ? { quorum: Number(quorum) } : {}),
          ...(has(rest, "--ordered") ? { ordered: true } : {}),
          ...(expires ? { expiresInHours: Number(expires) } : {}),
          ...(subject ? { subject } : {}),
          ...(summary.length ? { summary } : {}),
          ...(writeBack ? { writeBack } : {}),
          ...(notify.length ? { notifyEmails: notify } : {}),
          ...(has(rest, "--no-send") ? { send: false } : {}),
        });
        if (json) printJson(data);
        else {
          printKeyValues({
            id: data.request.id,
            title: data.request.title,
            status: data.request.status,
            policy:
              data.request.policy === "quorum"
                ? `quorum ${data.request.quorum}`
                : data.request.policy,
            emailed: data.sent ? "yes" : "no",
          });
          // Shown once. Nothing stored can reproduce them.
          printTable(data.links.map((l) => ({ email: l.email, link: l.url })));
        }
        return;
      }
      case "cancel": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("approvals cancel <id> [--reason <r>]\n");
          process.exit(1);
        }
        const { data } = await client.approvals.cancel(id, flag(rest, "--reason") ?? null);
        if (json) printJson(data);
        else
          process.stdout.write(
            `cancelled ${id} — every outstanding link is dead, and neither flow branch ran\n`,
          );
        return;
      }
      default:
        process.stdout.write(HELP);
        process.exitCode = 1;
    }
  } catch (e) {
    die(e, `approvals ${sub}`);
  }
};
