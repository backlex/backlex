/**
 * `backlex signatures` — send a rendered document out to be signed, over
 * `/api/admin/signatures`. See `docs/e-signature.md`.
 *
 * `send` prints the signing links. This is the one surface that does, and it
 * is deliberate: a terminal is the operator's own screen, and the whole reason
 * to reach for the CLI here is to get a link you can paste somewhere yourself
 * — `--no-send` exists for exactly that. Every other surface withholds them,
 * because an MCP tool result is transcript and a flow op's result is readable
 * by every op after it.
 */
import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { BacklexError } from "backlex";
import { has, flag, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

interface SignerRow {
  id: string;
  email: string;
  name: string | null;
  role: string | null;
  status: string;
  signedAt?: unknown;
}

interface RequestRow {
  id: string;
  title: string;
  status: string;
  ordered: boolean;
  documentHash: string;
  signedDocumentKey: string | null;
  expiresAt?: unknown;
  signers: SignerRow[];
  bodyHtml?: string;
}

const HELP = `backlex signatures <list|get|send|void|resend|finalize|download>

  list [--status pending|completed|declined|voided|expired]
  get <id>
  send [--template <key> | --html-file <path>]
       --signer <email>[:<name>[:<role>]]   (repeatable)
       [--title <t>] [--message <m>] [--vars <json>]
       [--ordered] [--expires <days>] [--no-send]
       [--write-back <collection>:<rowId>:<field>]
       [--notify <email>]                   (repeatable)
  void <id> [--reason <r>]
  resend <id> <signerId>
  finalize <id>
  download <id> [--which signed|original] [--out <path>]

  The document is FROZEN when it is sent: editing the template afterwards
  never changes what a signer already read.

  --vars takes the whole render context, so the usual shape is:
    --vars '{"data":{"tenant":"Ayşe Yılmaz","no":"2026-9"}}'

  --ordered means each link only opens once the one before it has signed;
  only the first signer is emailed, and the next when their turn arrives.

  send prints the signing links ONCE — only their hashes are stored, so
  nothing can show them again. void and resend both mint a NEW token, which
  is what makes a link that went astray stop working.

  finalize is the recovery for a renderer that was unreachable when the last
  signature landed: the signatures are in, the signed copy is not, and every
  link is spent.

  There is no renderer bundled with the server. Set PDF_CF_ACCOUNT_ID +
  PDF_CF_API_TOKEN, or PDF_GOTENBERG_URL, or send fails with a message
  saying so.
`;

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

/** Every `--signer a@b.com:Ayşe:Tenant` on the line, in the order given —
 *  which is the signing order when `--ordered` is set. */
const collectSigners = (args: string[]): Array<{ email: string; name?: string; role?: string }> => {
  const out: Array<{ email: string; name?: string; role?: string }> = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--signer") continue;
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

export const runSignatures = async (args: string[]): Promise<void> => {
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
        const out = await client.signatures.list(status ? { status: status as never } : undefined);
        if (json) printJson(out.data);
        else
          printTable(
            (out.data as unknown as RequestRow[]).map((r) => ({
              id: r.id,
              title: r.title,
              status: r.status,
              signed: `${r.signers.filter((s) => s.status === "signed").length}/${r.signers.length}`,
              order: r.ordered ? "sequential" : "any",
            })),
          );
        return;
      }
      case "get": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("signatures get <id>\n");
          process.exit(1);
        }
        const { data } = await client.signatures.get(id);
        const row = data as unknown as RequestRow;
        if (json) printJson(row);
        else {
          printKeyValues({
            id: row.id,
            title: row.title,
            status: row.status,
            order: row.ordered ? "sequential" : "any",
            documentHash: row.documentHash,
            signedDocument: row.signedDocumentKey ?? "—",
          });
          printTable(
            row.signers.map((s) => ({
              signerId: s.id,
              email: s.email,
              role: s.role ?? "",
              status: s.status,
            })),
          );
        }
        return;
      }
      case "send": {
        const templateKey = flag(rest, "--template");
        const htmlPath = flag(rest, "--html-file");
        if ((templateKey == null) === (htmlPath == null)) {
          process.stderr.write(
            "signatures send needs exactly one of --template <key> or --html-file <path>\n",
          );
          process.exit(1);
        }
        let html: string | undefined;
        if (htmlPath) {
          try {
            html = readFileSync(htmlPath, "utf8");
          } catch (e) {
            process.stderr.write(`signatures send: cannot read ${htmlPath} — ${(e as Error).message}\n`);
            process.exit(1);
          }
        }
        const signers = collectSigners(rest);
        if (signers.length === 0) {
          process.stderr.write("signatures send needs at least one --signer <email>[:<name>[:<role>]]\n");
          process.exit(1);
        }
        let vars: Record<string, unknown> | undefined;
        const rawVars = flag(rest, "--vars");
        if (rawVars) {
          try {
            vars = JSON.parse(rawVars) as Record<string, unknown>;
          } catch {
            process.stderr.write("signatures send --vars must be JSON\n");
            process.exit(1);
          }
        }
        let writeBack: { collection: string; id: string; field: string } | undefined;
        const rawWb = flag(rest, "--write-back");
        if (rawWb) {
          const [collection, rowId, field] = rawWb.split(":");
          if (!collection || !rowId || !field) {
            process.stderr.write("--write-back takes <collection>:<rowId>:<field>\n");
            process.exit(1);
          }
          writeBack = { collection, id: rowId, field };
        }
        const notify = collectRepeated(rest, "--notify");
        const expires = flag(rest, "--expires");

        const { data } = await client.signatures.create({
          ...(templateKey ? { templateKey } : {}),
          ...(html ? { html } : {}),
          ...(vars ? { vars } : {}),
          ...(flag(rest, "--title") ? { title: flag(rest, "--title")! } : {}),
          ...(flag(rest, "--message") ? { message: flag(rest, "--message")! } : {}),
          ...(flag(rest, "--filename") ? { filename: flag(rest, "--filename")! } : {}),
          signers,
          ...(has(rest, "--ordered") ? { ordered: true } : {}),
          ...(expires ? { expiresInDays: Number(expires) } : {}),
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
            emailed: data.sent ? "yes" : "no",
          });
          // Shown once. Nothing stored can reproduce them.
          printTable(data.links.map((l) => ({ email: l.email, link: l.url })));
        }
        return;
      }
      case "void": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("signatures void <id> [--reason <r>]\n");
          process.exit(1);
        }
        const { data } = await client.signatures.void(id, flag(rest, "--reason") ?? null);
        if (json) printJson(data);
        else process.stdout.write(`cancelled ${id} — every outstanding link is now dead\n`);
        return;
      }
      case "resend": {
        const [id, signerId] = rest;
        if (!id || !signerId) {
          process.stderr.write("signatures resend <id> <signerId>\n");
          process.exit(1);
        }
        const { data } = await client.signatures.resend(id, signerId);
        if (json) printJson(data);
        else
          process.stdout.write(
            `${data.sent ? "sent" : "not sent"} to ${data.email} — the previous link is now dead\n`,
          );
        return;
      }
      case "finalize": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("signatures finalize <id>\n");
          process.exit(1);
        }
        const { data } = await client.signatures.finalize(id);
        if (json) printJson(data);
        else printKeyValues({ id: data.id, status: data.status, document: data.signedDocumentKey ?? "—" });
        return;
      }
      case "download": {
        const id = rest[0];
        if (!id) {
          process.stderr.write("signatures download <id> [--which signed|original]\n");
          process.exit(1);
        }
        const which = (flag(rest, "--which") ?? "signed") as "signed" | "original";
        const bytes = await client.signatures.document(id, which);
        const out = flag(rest, "--out") ?? `${which}-${id}.pdf`;
        writeFileSync(out, bytes);
        if (json) printJson({ ok: true, path: out, bytes: bytes.byteLength });
        else process.stdout.write(`wrote ${out} (${bytes.byteLength} bytes)\n`);
        return;
      }
      default:
        process.stdout.write(HELP);
        process.exitCode = 1;
    }
  } catch (e) {
    die(e, `signatures ${sub}`);
  }
};
