import { Form, useNavigation } from "react-router";
import { adminClient, attempt, errorMessage, isConfigured } from "~/backlex.server";
import { btnCls, Empty, ErrorLine, NotConfigured, Panel } from "~/ui";
import type { Route } from "./+types/flows";

export async function loader() {
  if (!isConfigured()) return { configured: false as const };
  const res = await attempt(() => adminClient().flows.list());
  return {
    configured: true as const,
    flows: res.ok ? res.data.data : [],
    error: res.ok ? null : res.error,
  };
}

/**
 * `flows.run(id, input)` executes a flow synchronously with an arbitrary
 * trigger payload — the same path a `manual` trigger takes in the admin's flow
 * builder. Event- and cron-triggered flows fire on their own; this is how you
 * drive one from code (CI, a webhook receiver, an ops console like this).
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const id = String(form.get("id") ?? "");
  const intent = String(form.get("intent") ?? "");
  const backlex = adminClient();

  try {
    if (intent === "toggle") {
      await backlex.flows.update(id, { active: form.get("active") === "true" });
      return { ok: true };
    }

    // Free-form JSON so you can shape the trigger payload the flow expects.
    const raw = String(form.get("input") ?? "").trim();
    let input: Record<string, unknown> = {};
    if (raw) {
      try {
        input = JSON.parse(raw);
      } catch {
        return { error: "Input must be valid JSON." };
      }
    }
    const res = await backlex.flows.run(id, input);
    return res.ok
      ? { ok: true, ran: id }
      : { error: res.error ?? "The flow halted on an unhandled operation error." };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export default function Flows({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  if (!loaderData.configured) return <NotConfigured />;
  const { flows, error } = loaderData;

  return (
    <Panel
      title="Flows"
      desc="flows.list() + flows.run(id, input) — admin-scoped, which is why no browser example can drive them"
    >
      {error && <ErrorLine msg={error} />}
      {actionData?.error && <ErrorLine msg={actionData.error} />}
      {actionData?.ok && "ran" in actionData && (
        <p className="text-sm text-ok">Flow ran successfully.</p>
      )}

      <ul className="space-y-2">
        {flows.length === 0 && (
          <Empty>No flows yet — build one in the admin (Flows), then run it from here.</Empty>
        )}
        {flows.map((f) => (
          <li key={f.id} className="space-y-3 rounded-control border border-line p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-medium">{f.name}</span>
              <code className="text-xs text-ink-muted">{f.trigger}</code>
              <span
                className={
                  "rounded-full px-2 py-0.5 text-xs " +
                  (f.active ? "bg-ok/15 text-ok" : "bg-raised text-ink-muted")
                }
              >
                {f.active ? "active" : "paused"}
              </span>
            </div>
            <p className="text-xs text-ink-muted">
              {f.operations.length} operation{f.operations.length === 1 ? "" : "s"}
            </p>

            <Form method="post" className="space-y-2">
              <input type="hidden" name="id" value={f.id} />
              <input type="hidden" name="intent" value="run" />
              <textarea
                name="input"
                rows={2}
                className="w-full rounded-control border border-line-strong px-3 py-2 font-mono text-xs outline-none focus:border-brand"
                placeholder='{"reason": "manual run"}'
              />
              <div className="flex flex-wrap justify-end gap-2">
                <button type="submit" className={btnCls} disabled={busy}>
                  {busy ? "Running…" : "Run"}
                </button>
              </div>
            </Form>

            <Form method="post" className="flex justify-end">
              <input type="hidden" name="id" value={f.id} />
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="active" value={String(!f.active)} />
              <button type="submit" className={btnCls} disabled={busy}>
                {f.active ? "Pause" : "Activate"}
              </button>
            </Form>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
