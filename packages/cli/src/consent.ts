/**
 * `backlex consent` — the cookie-consent policy a site publishes.
 *
 * Exists on the CLI for the same reason `analytics sites` does: provisioning a
 * site is scriptable, and a site provisioned without a consent policy is a site
 * that quietly asks its visitors nothing.
 *
 * `set` refuses a first save that omits `--undecided` or `--tracker`. That
 * refusal is the server's, printed verbatim: both flags encode a compliance
 * posture where neither answer is safe everywhere, so there is no default and
 * no `-y` that supplies one. A script that wants a policy has to state which
 * one it wants.
 */
import { BacklexError } from "backlex";
import {
  has,
  flag,
  makeClient,
  printJson,
  printKeyValues,
  printTable,
  resolveContext,
} from "./client";

const HELP = `backlex consent <policies|policy|versions|records|set|rm|wording>

  policies                             every site with a consent policy
  policy <siteId>                      one site's policy (null if unset)
  set <siteId> --undecided <block|allow> --tracker <none|analytics>
      [--categories functional,analytics,marketing]
      [--signals <tracker|all|off>]
      [--position <bottom|top|corner>] [--policy-url <url>]
      [--max-age-days <n>] [--enabled|--disabled]
                                       create or replace a policy
  versions <siteId> [--limit <n>]      artifacts this policy has compiled to
  records <siteId> [--subject <id>]    decisions visitors recorded
          [--limit <n>]
  rm <siteId>                          stop serving the banner
  wording                              suggested copy, as a starting point

The two decisions with no default:

  --undecided block    nothing optional fires until the visitor answers.
                       Required under GDPR/ePrivacy; costs you measurement on
                       visitors who ignore the banner.
  --undecided allow    optional tags fire until the visitor declines. The
                       CCPA/CPRA opt-out model, and NOT lawful in the EU.

  --tracker none       backlex's own tag counts as strictly necessary and
                       measures everyone. Defensible because it stores nothing
                       on the device and its visitor id rotates daily — a legal
                       position, not a fact.
  --tracker analytics  the tag waits for consent like any other.

Both are required the first time a policy is saved and carried forward when
omitted on a later one.

The switch that DOES have a default:

  --signals tracker    GPC and Do Not Track stop backlex's own tag and nothing
                       else. What every site does today, and what you get by
                       saying nothing.
  --signals all        they also deny every optional category, so third-party
                       tags stop too — the CCPA reading, where GPC is a legal
                       opt-out. This stops pixels that fire today; that is why
                       it is a choice and not the default.
  --signals off        neither signal is read.

Common: --json prints raw JSON.
`;

const BASE = "/api/admin/consent";

const die = (e: unknown, what: string): never => {
  const msg =
    e instanceof BacklexError ? `${e.status} ${e.message}` : (e as Error).message;
  process.stderr.write(`${what}: ${msg}\n`);
  process.exit(1);
};

const need = (value: string | undefined, usage: string): string => {
  if (!value) {
    process.stderr.write(`${usage}\n`);
    process.exit(1);
  }
  return value;
};

/** One-line summary of a policy — what an operator scans a list for. */
const summarize = (p: any) => ({
  site: p.siteId,
  banner: p.enabled ? "live" : "off",
  undecided: p.undecidedBehaviour,
  tracker: p.trackerCategory,
  signals: p.signalHandling,
  asks: (p.categoriesOffered ?? []).join(",") || "—",
});

export const runConsent = async (args: string[]): Promise<void> => {
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
      case "policies": {
        const { data } = await client.request<{ data: any[] }>("GET", `${BASE}/policies`);
        if (json) {
          printJson(data);
          return;
        }
        if (!data.length) {
          process.stderr.write(
            "No consent policies. Sites without one ask nothing and block nothing.\n",
          );
          return;
        }
        printTable(data.map(summarize));
        return;
      }

      case "policy": {
        const siteId = need(rest[0], "consent policy needs a site id.");
        const { data } = await client.request<{ data: any }>(
          "GET",
          `${BASE}/policies/${encodeURIComponent(siteId)}`,
        );
        if (json) {
          printJson(data);
          return;
        }
        if (!data) {
          process.stderr.write("No policy for that site.\n");
          return;
        }
        printKeyValues({
          ...summarize(data),
          position: data.position,
          policyUrl: data.policyUrl ?? "—",
          decisionStandsForDays: data.cookieMaxAgeDays,
        });
        return;
      }

      case "versions": {
        const siteId = need(rest[0], "consent versions needs a site id.");
        const limit = flag(rest, "--limit");
        const qs = limit ? `?limit=${Number(limit)}` : "";
        const { data } = await client.request<{ data: any[] }>(
          "GET",
          `${BASE}/policies/${encodeURIComponent(siteId)}/versions${qs}`,
        );
        if (json) {
          printJson(data);
          return;
        }
        if (!data.length) {
          process.stderr.write(
            "No artifacts yet — this site's policy has never been saved.\n",
          );
          return;
        }
        printTable(
          data.map((v) => ({
            hash: String(v.hash).slice(0, 12),
            created: new Date(Number(v.createdAt)).toISOString(),
          })),
        );
        return;
      }

      case "records": {
        const siteId = need(rest[0], "consent records needs a site id.");
        const q = new URLSearchParams();
        const subject = flag(rest, "--subject");
        if (subject) q.set("subjectId", subject);
        const limit = flag(rest, "--limit");
        if (limit) q.set("limit", String(Number(limit)));
        const qs = q.toString();
        const { data } = await client.request<{ data: any[] }>(
          "GET",
          `${BASE}/policies/${encodeURIComponent(siteId)}/records${qs ? `?${qs}` : ""}`,
        );
        if (json) {
          printJson(data);
          return;
        }
        if (!data.length) {
          process.stderr.write("No decisions recorded for that site yet.\n");
          return;
        }
        printTable(
          data.map((r) => ({
            when: new Date(Number(r.createdAt)).toISOString(),
            decision: r.decision,
            source: r.source,
            // Truncated on purpose: the full id is the visitor's handle and a
            // terminal is a place things get pasted from.
            subject: String(r.subjectId).slice(0, 12),
            policy: r.hashGrade,
          })),
        );
        return;
      }

      case "set": {
        const siteId = need(rest[0], "consent set needs a site id.");
        const body: Record<string, unknown> = {};
        const undecided = flag(rest, "--undecided");
        const tracker = flag(rest, "--tracker");
        // Not validated here beyond presence: the server owns the vocabulary
        // and its rejection explains what each value means. A second copy of
        // that explanation in the CLI is a second thing to drift.
        if (undecided) body.undecidedBehaviour = undecided;
        if (tracker) body.trackerCategory = tracker;
        // Unlike the two above this one DOES have a server-side default, so
        // omitting it on a first save is fine and means "what every site does".
        const signals = flag(rest, "--signals");
        if (signals) body.signalHandling = signals;

        const cats = flag(rest, "--categories");
        if (cats !== undefined) {
          body.categoriesOffered = cats
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
        }
        const position = flag(rest, "--position");
        if (position) body.position = position;
        const policyUrl = flag(rest, "--policy-url");
        if (policyUrl !== undefined) body.policyUrl = policyUrl || null;
        const maxAge = flag(rest, "--max-age-days");
        if (maxAge) body.cookieMaxAgeDays = Number(maxAge);
        if (has(rest, "--enabled")) body.enabled = true;
        if (has(rest, "--disabled")) body.enabled = false;

        const { data } = await client.request<{ data: any }>(
          "PUT",
          `${BASE}/policies/${encodeURIComponent(siteId)}`,
          body,
        );
        if (json) {
          printJson(data);
          return;
        }
        printKeyValues(summarize(data));
        return;
      }

      case "rm": {
        const siteId = need(rest[0], "consent rm needs a site id.");
        await client.request("DELETE", `${BASE}/policies/${encodeURIComponent(siteId)}`);
        process.stderr.write(
          "Banner removed. Consent already recorded is evidence and was left alone.\n",
        );
        return;
      }

      case "wording": {
        const { data } = await client.request<{ data: Record<string, unknown> }>(
          "GET",
          `${BASE}/wording/suggested`,
        );
        printJson(data);
        if (!json) {
          process.stderr.write(
            "\nA starting point, not a default: nothing is applied until you save it.\n",
          );
        }
        return;
      }

      default:
        process.stderr.write(`Unknown consent subcommand: ${sub}\n\n${HELP}`);
        process.exit(1);
    }
  } catch (e) {
    die(e, `consent ${sub}`);
  }
};
