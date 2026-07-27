/**
 * `backlex orgs` — app-plane organizations ("teams") over `/api/app-orgs`.
 *
 * An org is the B2B grouping level *inside* a workspace: its members are
 * `app_users` (the end-users of the app built on the workspace), not
 * control-plane users. Two role layers show up in the output and both matter:
 *
 *   - the membership role (owner/admin/member), which governs org administration;
 *   - `roles`, the workspace roles bound to a member *within that org*, which
 *     drive data access through `$org.id` / `$user.orgs` permission rules.
 *
 * Admin-scoped, like the REST routes it wraps.
 */
import { BacklexError } from "backlex";
import type { Org, OrgInvite, OrgMember } from "backlex";
import { flag, has, makeClient, printJson, printKeyValues, printTable, resolveContext } from "./client";

const ORGS_HELP = `backlex orgs <list|get|create|update|delete|members|add-member|update-member|remove-member|invites|invite|revoke-invite>

  list                              organizations in the active workspace
    --q <text>                      filter by name/slug substring
  get <idOrSlug>                    one organization
  create <name>                     create an organization
    --slug <slug>                   explicit handle (derived from name otherwise)
    --owner <appUserId>             seed the first owner
  update <idOrSlug>                 rename / re-slug
    --name <name>  --slug <slug>  --image <url>
  delete <idOrSlug> --confirm       delete the org, its members and invitations

  members <idOrSlug>                members + their org-scoped workspace roles
  add-member <idOrSlug> <appUserId>
    --role <owner|admin|member>     membership role (default member)
    --roles <id,id>                 org-scoped workspace role ids
  update-member <idOrSlug> <appUserId>
    --role <owner|admin|member>     change the membership role
    --roles <id,id>                 REPLACE the org-scoped workspace roles
  remove-member <idOrSlug> <appUserId>

  invites <idOrSlug>                invitations, newest first
    --pending                       only ones still actionable
  invite <idOrSlug> <email>         mint a 7-day invitation (prints the token once)
    --role <owner|admin|member>
    --roles <id,id>
  revoke-invite <idOrSlug> <inviteId>

  --json                            machine-readable output
`;

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

const csv = (v: string | undefined): string[] | undefined =>
  v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

const asRole = (v: string | undefined): "owner" | "admin" | "member" | undefined => {
  if (v === undefined) return undefined;
  if (v === "owner" || v === "admin" || v === "member") return v;
  process.stderr.write(`--role must be one of: owner, admin, member\n`);
  process.exit(1);
};

const orgRow = (o: Org) => ({
  id: o.id,
  slug: o.slug,
  name: o.name,
  members: o.memberCount ?? 0,
});

const memberRow = (m: OrgMember) => ({
  appUserId: m.appUserId,
  email: m.email,
  role: m.role,
  status: m.status,
  workspaceRoles: m.roles.map((r) => r.name).join(", ") || "—",
});

const inviteRow = (i: OrgInvite) => ({
  id: i.id,
  email: i.email,
  role: i.role,
  state: i.acceptedAt ? "accepted" : i.pending ? "pending" : "expired",
  expires: new Date(i.expiresAt).toISOString(),
});

export const runOrgs = async (args: string[]): Promise<void> => {
  const sub = args[0];
  const rest = args.slice(1);
  const json = has(args, "--json");

  if (!sub || sub === "help" || sub === "--help") {
    process.stdout.write(ORGS_HELP);
    return;
  }

  const client = makeClient(resolveContext(args));
  const orgs = client.orgs;
  const out = <T,>(value: T, render: () => void): void => {
    if (json) printJson(value);
    else render();
  };

  try {
    switch (sub) {
      case "list": {
        const q = flag(rest, "--q");
        const { data } = await orgs.list(q ? { q } : undefined);
        out(data, () => printTable(data.map(orgRow)));
        return;
      }
      case "get": {
        const id = need(rest[0], "backlex orgs get <idOrSlug>");
        const { data } = await orgs.get(id);
        out(data, () =>
          printKeyValues({
            id: data.id,
            slug: data.slug,
            name: data.name,
            members: String(data.memberCount ?? 0),
            created: data.createdAt ? new Date(data.createdAt).toISOString() : "—",
          }),
        );
        return;
      }
      case "create": {
        const name = need(rest[0], "backlex orgs create <name> [--slug <slug>] [--owner <appUserId>]");
        const slug = flag(rest, "--slug");
        const owner = flag(rest, "--owner");
        const { data } = await orgs.create({
          name,
          ...(slug ? { slug } : {}),
          ...(owner ? { ownerAppUserId: owner } : {}),
        });
        out(data, () => process.stdout.write(`created ${data.slug} (${data.id})\n`));
        return;
      }
      case "update": {
        const id = need(rest[0], "backlex orgs update <idOrSlug> [--name <name>] [--slug <slug>]");
        const name = flag(rest, "--name");
        const slug = flag(rest, "--slug");
        const image = flag(rest, "--image");
        const { data } = await orgs.update(id, {
          ...(name ? { name } : {}),
          ...(slug ? { slug } : {}),
          ...(image ? { image } : {}),
        });
        out(data, () => process.stdout.write(`updated ${data.slug}\n`));
        return;
      }
      case "delete": {
        const id = need(rest[0], "backlex orgs delete <idOrSlug> --confirm");
        if (!has(rest, "--confirm")) {
          process.stderr.write(
            "refusing to delete without --confirm (this drops the org, its members and invitations)\n",
          );
          process.exit(1);
        }
        await orgs.delete(id);
        out({ ok: true }, () => process.stdout.write(`deleted ${id}\n`));
        return;
      }

      case "members": {
        const id = need(rest[0], "backlex orgs members <idOrSlug>");
        const { data } = await orgs.members(id);
        out(data, () => printTable(data.map(memberRow)));
        return;
      }
      case "add-member": {
        const id = need(rest[0], "backlex orgs add-member <idOrSlug> <appUserId>");
        const appUserId = need(rest[1], "backlex orgs add-member <idOrSlug> <appUserId>");
        const role = asRole(flag(rest, "--role"));
        const roleIds = csv(flag(rest, "--roles"));
        const { data } = await orgs.addMember(id, {
          appUserId,
          ...(role ? { role } : {}),
          ...(roleIds ? { roleIds } : {}),
        });
        out(data, () => process.stdout.write(`added ${data.email} as ${data.role}\n`));
        return;
      }
      case "update-member": {
        const id = need(rest[0], "backlex orgs update-member <idOrSlug> <appUserId>");
        const appUserId = need(rest[1], "backlex orgs update-member <idOrSlug> <appUserId>");
        const role = asRole(flag(rest, "--role"));
        const roleIds = csv(flag(rest, "--roles"));
        if (!role && !roleIds) {
          process.stderr.write("nothing to change — pass --role and/or --roles\n");
          process.exit(1);
        }
        const { data } = await orgs.updateMember(id, appUserId, {
          ...(role ? { role } : {}),
          ...(roleIds ? { roleIds } : {}),
        });
        out(data, () => printKeyValues(memberRow(data)));
        return;
      }
      case "remove-member": {
        const id = need(rest[0], "backlex orgs remove-member <idOrSlug> <appUserId>");
        const appUserId = need(rest[1], "backlex orgs remove-member <idOrSlug> <appUserId>");
        await orgs.removeMember(id, appUserId);
        out({ ok: true }, () => process.stdout.write(`removed ${appUserId}\n`));
        return;
      }

      case "invites": {
        const id = need(rest[0], "backlex orgs invites <idOrSlug>");
        const { data } = await orgs.invites(id, has(rest, "--pending") ? { pending: true } : undefined);
        out(data, () => printTable(data.map(inviteRow)));
        return;
      }
      case "invite": {
        const id = need(rest[0], "backlex orgs invite <idOrSlug> <email>");
        const email = need(rest[1], "backlex orgs invite <idOrSlug> <email>");
        const role = asRole(flag(rest, "--role"));
        const roleIds = csv(flag(rest, "--roles"));
        const { data } = await orgs.invite(id, {
          email,
          ...(role ? { role } : {}),
          ...(roleIds ? { roleIds } : {}),
        });
        out(data, () =>
          printKeyValues({
            email: data.email,
            role: data.role,
            // The only time the raw token is ever readable — it's mailed to the
            // invitee and never returned by `orgs invites`.
            token: data.token,
            expires: new Date(data.expiresAt).toISOString(),
          }),
        );
        return;
      }
      case "revoke-invite": {
        const id = need(rest[0], "backlex orgs revoke-invite <idOrSlug> <inviteId>");
        const inviteId = need(rest[1], "backlex orgs revoke-invite <idOrSlug> <inviteId>");
        await orgs.revokeInvite(id, inviteId);
        out({ ok: true }, () => process.stdout.write(`revoked ${inviteId}\n`));
        return;
      }

      default:
        process.stderr.write(`unknown subcommand: ${sub}\n${ORGS_HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `orgs ${sub}`);
  }
};
