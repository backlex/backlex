import { Form, useNavigation } from "react-router";
import { adminClient, errorMessage, isConfigured } from "~/backlex.server";
import { ErrorLine, Field, inputCls, NotConfigured, Panel, primaryBtnCls, Stat } from "~/ui";
import type { Route } from "./+types/permissions";

const ACTIONS = ["read", "create", "update", "delete", "publish"] as const;

export async function loader() {
  return { configured: isConfigured() };
}

/**
 * `permissions.simulate()` dry-runs the permission resolver for any subject and
 * returns the full allow/deny trace: which roles matched, which rules fired, how
 * the DSL variables resolved, and the exact SQL predicate the compiled condition
 * would add to a query. Read-only — nothing is written and no rows are read.
 *
 * This is the single best answer to "why can't this user see that row?", and it
 * is admin-only, so it can only be driven from a server like this one.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const collection = String(form.get("collection") ?? "").trim();
  if (!collection) return { error: "Collection is required." };

  const rolesRaw = String(form.get("roles") ?? "").trim();
  const sampleRaw = String(form.get("sampleRow") ?? "").trim();

  let sampleRow: Record<string, unknown> | null = null;
  if (sampleRaw) {
    try {
      sampleRow = JSON.parse(sampleRaw);
    } catch {
      return { error: "Sample row must be valid JSON." };
    }
  }

  try {
    const { data } = await adminClient().permissions.simulate({
      collection,
      action: String(form.get("action") ?? "read") as (typeof ACTIONS)[number],
      plane: String(form.get("plane") ?? "app") as "platform" | "app",
      // `userId` wins when set — roles are then read live from the DB and the
      // ad-hoc `roles` list is ignored.
      userId: String(form.get("userId") ?? "").trim() || null,
      email: String(form.get("email") ?? "").trim() || null,
      roles: rolesRaw ? rolesRaw.split(",").map((r) => r.trim()).filter(Boolean) : null,
      sampleRow,
    });
    return { sim: data };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export default function Permissions({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  if (!loaderData.configured) return <NotConfigured />;
  const sim = actionData && "sim" in actionData ? actionData.sim : null;

  return (
    <div className="space-y-6">
      <Panel
        title="Permission simulator"
        desc="permissions.simulate({ collection, action, userId | roles, plane, sampleRow }) — read-only allow/deny trace"
      >
        <Form method="post" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Collection">
              <input className={inputCls} name="collection" placeholder="posts" required />
            </Field>
            <Field label="Action">
              <select name="action" className={inputCls} defaultValue="read">
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Plane">
              <select name="plane" className={inputCls} defaultValue="app">
                <option value="app">app (workspace end-users)</option>
                <option value="platform">platform (admin users)</option>
              </select>
            </Field>
            <Field label="User id (optional)">
              <input className={inputCls} name="userId" placeholder="usr_…" />
            </Field>
            <Field label="Email (optional)">
              <input className={inputCls} name="email" placeholder="ada@example.com" />
            </Field>
            <Field label="Roles (comma-separated)">
              <input className={inputCls} name="roles" placeholder="authenticated, editor" />
            </Field>
          </div>
          <Field label="Sample row (optional JSON)">
            <textarea
              name="sampleRow"
              rows={3}
              className="w-full rounded-control border border-line-strong px-3 py-2 font-mono text-xs outline-none focus:border-brand"
              placeholder='{"owner_id": "usr_123", "status": "published"}'
            />
          </Field>
          <p className="text-xs text-ink-muted">
            A user id takes precedence over the roles list — roles are then read live from the
            database. A sample row additionally evaluates the compiled condition against concrete
            values, so you get a real row-level verdict.
          </p>
          <button type="submit" className={primaryBtnCls} disabled={busy}>
            {busy ? "Simulating…" : "Simulate"}
          </button>
        </Form>
        {actionData?.error && <ErrorLine msg={actionData.error} />}
      </Panel>

      {sim && (
        <Panel title="Verdict" desc={`${sim.collection} · ${sim.action}`}>
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Allowed" value={sim.allowed ? "yes" : "no"} />
            <Stat label="Admin" value={sim.isAdmin ? "yes" : "no"} />
            <Stat
              label="Row match"
              value={sim.rowMatch === undefined ? "—" : sim.rowMatch ? "yes" : "no"}
            />
          </div>

          <p className="text-sm text-ink-muted">{sim.reason}</p>

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-ink-muted">
              Matched rules ({sim.matchedRules.length})
            </h3>
            {sim.matchedRules.length === 0 ? (
              <p className="text-sm text-ink-dim">
                None — nothing grants this subject the action.
              </p>
            ) : (
              <pre className="overflow-x-auto rounded-control border border-line bg-raised p-3 text-xs">
                {JSON.stringify(sim.matchedRules, null, 2)}
              </pre>
            )}
          </div>

          {sim.whereSql && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink-muted">Compiled predicate</h3>
              <pre className="overflow-x-auto rounded-control border border-line bg-raised p-3 text-xs">
                {sim.whereSql.sql}
                {"\n\n"}
                {JSON.stringify(sim.whereSql.params)}
              </pre>
            </div>
          )}

          {sim.fields && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-ink-muted">Field allow-list</h3>
              <p className="text-sm text-ink-muted">{sim.fields.join(", ") || "(empty)"}</p>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-medium text-ink-muted">Resolved DSL variables</h3>
            <pre className="overflow-x-auto rounded-control border border-line bg-raised p-3 text-xs">
              {JSON.stringify(sim.resolvedVars, null, 2)}
            </pre>
          </div>
        </Panel>
      )}
    </div>
  );
}
