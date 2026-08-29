/**
 * `backlex tenants` — workspaces and the people in them, over `/api/tenants`.
 *
 * A workspace is the CONTROL-plane grouping: its members are backlex operators
 * (the `users` table), each holding a membership role — `owner` > `admin` >
 * `member` — that decides who may invite, who may change a role, and who may
 * evict whom. That is a different population from `backlex orgs`, whose members
 * are the end-users of the application built on a workspace; the two commands
 * look alike on purpose and must not be confused, so every message here says
 * "workspace".
 *
 * Three rules are enforced by the API and echoed in the help text, because they
 * are the ones that surprise people:
 *
 *   - you must OUTRANK whoever you act on (equal rank is refused — two admins
 *     removing each other is a race with no correct winner);
 *   - only an owner may grant `owner`;
 *   - the last owner can be neither demoted nor removed, which is what
 *     `transfer` exists for.
 *
 * `<memberId>` throughout is the MEMBERSHIP row id from `tenants members`, not
 * a user id. They are different values and using the wrong one is a 404, so the
 * help text names it every time.
 */
import { BacklexError } from "backlex";
import { flag, has, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

const TENANTS_HELP = `backlex tenants <list|switch|members|invite|set-role|suspend|activate|transfer|remove|resend-invite|revoke-invite>

  list                                 workspaces you belong to (* = active)
  switch <idOrSlug>                    make one active (persisted on your profile)

  members <tenantId>                   members + pending invites
  invite <tenantId> <email>            mint a 7-day invite (prints the link once)
    --role <owner|admin|member>        role on accept (default member)
  set-role <tenantId> <memberId>       change a member's role
    --role <owner|admin|member>        required; only an owner may grant owner
  suspend <tenantId> <memberId>        keep the row, revoke every right it carries
  activate <tenantId> <memberId>       undo a suspension
  transfer <tenantId> <memberId> --confirm
                                       make them owner and step yourself down to admin
  remove <tenantId> <memberId> --confirm
                                       evict: membership, workspace roles and API keys

  resend-invite <tenantId> <memberId>  new token + new 7-day expiry (old link dies)
  revoke-invite <tenantId> <memberId>  withdraw a pending invite

  <memberId> is the MEMBERSHIP id from \`tenants members\`, not a user id.
  You must outrank whoever you act on, and only an owner may grant owner.
  The last owner can never be demoted or removed — hand over with \`transfer\`.
  --json                               machine-readable output
`;

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  env: string;
  role: string;
}

interface MemberRow {
  id: string;
  userId: string | null;
  email: string;
  role: string;
  status: string;
  joinedAt?: number | string | null;
}

const die = (e: unknown, what: string): never => {
  const msg = e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const need = (v: string | undefined, usage: string): string => {
  if (!v) {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
  return v;
};

/** `editor` is deliberately absent: it is readable on rows written before it was
 *  deprecated, but the API refuses to grant it, so offering it here would only
 *  produce a 422 the user cannot act on. */
const asRole = (v: string | undefined): "owner" | "admin" | "member" | undefined => {
  if (v === undefined) return undefined;
  if (v === "owner" || v === "admin" || v === "member") return v;
  process.stderr.write("--role must be one of: owner, admin, member\n");
  process.exit(1);
};

/** Refuse an irreversible act that was not asked for twice. Handing a workspace
 *  over and evicting a colleague both take effect immediately and neither has
 *  an undo, so they follow `orgs delete` rather than the harmless verbs. */
const confirmed = (args: string[], what: string): void => {
  if (has(args, "--confirm")) return;
  process.stderr.write(`refusing to ${what} without --confirm\n`);
  process.exit(1);
};

const stamp = (v: number | string | null | undefined): string =>
  v === null || v === undefined ? "—" : new Date(v).toISOString();

export const runTenants = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(TENANTS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  const out = <T,>(value: T, render: () => void): void => {
    if (json) printJson(value);
    else render();
  };

  const members = (tenantId: string) =>
    `/api/tenants/${encodeURIComponent(tenantId)}/members`;
  const member = (tenantId: string, memberId: string) =>
    `${members(tenantId)}/${encodeURIComponent(memberId)}`;

  try {
    switch (sub) {
      case "list": {
        const res = await client.request<{ data: TenantRow[]; active: string | null }>(
          "GET",
          "/api/tenants",
        );
        out(res, () =>
          printTable(
            res.data.map((t) => ({
              active: t.id === res.active ? "*" : "",
              id: t.id,
              slug: t.slug,
              name: t.name,
              env: t.env,
              role: t.role,
            })),
          ),
        );
        return;
      }
      case "switch": {
        const tenant = need(rest[0], "backlex tenants switch <idOrSlug>");
        const { data } = await client.request<{ data: { id: string; slug: string } }>(
          "POST",
          "/api/tenants/switch",
          // The body key is `tenant` and it matches an id first, then a slug.
          { tenant },
        );
        out(data, () => process.stdout.write(`active workspace is now ${data.slug} (${data.id})\n`));
        return;
      }

      case "members": {
        const tenantId = need(rest[0], "backlex tenants members <tenantId>");
        const { data } = await client.request<{ data: MemberRow[] }>("GET", members(tenantId));
        out(data, () =>
          printTable(
            data.map((m) => ({
              id: m.id,
              email: m.email,
              role: m.role,
              status: m.status,
              joined: stamp(m.joinedAt),
            })),
          ),
        );
        return;
      }
      case "invite": {
        const usage = "backlex tenants invite <tenantId> <email> [--role owner|admin|member]";
        const tenantId = need(rest[0], usage);
        const email = need(rest[1], usage);
        const role = asRole(flag(rest, "--role"));
        const { data } = await client.request<{
          data: { id: string; url: string; sent: boolean };
        }>("POST", `${members(tenantId)}/invite`, { email, ...(role ? { role } : {}) });
        out(data, () =>
          printKeyValues({
            memberId: data.id,
            // Printed once and never again: `tenants members` deliberately
            // withholds the token, so an invite whose link was lost is reissued
            // with `resend-invite` rather than read back.
            url: data.url,
            emailed: data.sent ? "yes" : "no (no mail transport — share the url)",
          }),
        );
        return;
      }
      case "set-role": {
        const usage = "backlex tenants set-role <tenantId> <memberId> --role <owner|admin|member>";
        const tenantId = need(rest[0], usage);
        const memberId = need(rest[1], usage);
        const role = asRole(flag(rest, "--role"));
        if (!role) {
          process.stderr.write(`${usage}\n`);
          process.exit(1);
        }
        const { data } = await client.request<{ data: MemberRow }>(
          "PATCH",
          member(tenantId, memberId),
          { role },
        );
        out(data, () => process.stdout.write(`${data.email} is now ${data.role}\n`));
        return;
      }
      case "suspend":
      case "activate": {
        const usage = `backlex tenants ${sub} <tenantId> <memberId>`;
        const tenantId = need(rest[0], usage);
        const memberId = need(rest[1], usage);
        const status = sub === "suspend" ? "suspended" : "active";
        const { data } = await client.request<{ data: MemberRow }>(
          "PATCH",
          member(tenantId, memberId),
          { status },
        );
        out(data, () => process.stdout.write(`${data.email} is now ${data.status}\n`));
        return;
      }
      case "transfer": {
        const usage = "backlex tenants transfer <tenantId> <memberId> --confirm";
        const tenantId = need(rest[0], usage);
        const memberId = need(rest[1], usage);
        confirmed(rest, "hand this workspace over (you step down to admin)");
        // Addressed at the WORKSPACE, not the member: the route moves two rows
        // — the new owner's and the caller's — so the member is what it names
        // rather than what it is addressed by.
        const { data } = await client.request<{
          data: { memberId: string; userId: string; previousOwnerUserId: string | null };
        }>("POST", `/api/tenants/${encodeURIComponent(tenantId)}/transfer-ownership`, {
          memberId,
        });
        out(data, () =>
          printKeyValues({
            newOwnerUserId: data.userId,
            steppedDown: data.previousOwnerUserId ?? "— (transferred by the instance operator)",
          }),
        );
        return;
      }
      case "remove": {
        const usage = "backlex tenants remove <tenantId> <memberId> --confirm";
        const tenantId = need(rest[0], usage);
        const memberId = need(rest[1], usage);
        confirmed(rest, "evict this member (their workspace roles and API keys go too)");
        const { data } = await client.request<{
          data: { email: string; rolesRevoked: string[]; apiKeysRevoked: string[] };
        }>("DELETE", member(tenantId, memberId));
        out(data, () =>
          // What was revoked is printed rather than assumed: a removal that
          // silently revoked nothing is the failure this route already shipped
          // once, and the operator is the one who would notice.
          printKeyValues({
            removed: data.email,
            rolesRevoked: String(data.rolesRevoked.length),
            apiKeysRevoked: String(data.apiKeysRevoked.length),
          }),
        );
        return;
      }

      case "resend-invite": {
        const usage = "backlex tenants resend-invite <tenantId> <memberId>";
        const tenantId = need(rest[0], usage);
        const memberId = need(rest[1], usage);
        const { data } = await client.request<{ data: { url: string; sent: boolean } }>(
          "POST",
          `${member(tenantId, memberId)}/resend-invite`,
        );
        out(data, () =>
          printKeyValues({
            url: data.url,
            emailed: data.sent ? "yes" : "no (no mail transport — share the url)",
          }),
        );
        return;
      }
      case "revoke-invite": {
        const usage = "backlex tenants revoke-invite <tenantId> <memberId>";
        const tenantId = need(rest[0], usage);
        const memberId = need(rest[1], usage);
        await client.request("DELETE", `${member(tenantId, memberId)}/invite`);
        out({ ok: true }, () => process.stdout.write(`revoked the invite for ${memberId}\n`));
        return;
      }

      default:
        process.stderr.write(`unknown tenants subcommand: ${sub}\n\n${TENANTS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `tenants ${sub}`);
  }
};
