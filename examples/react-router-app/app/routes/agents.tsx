import { Form, useNavigation } from "react-router";
import { adminClient, attempt, errorMessage, isConfigured } from "~/backlex.server";
import { Empty, ErrorLine, Field, inputCls, NotConfigured, Panel, primaryBtnCls } from "~/ui";
import type { Route } from "./+types/agents";

export async function loader() {
  if (!isConfigured()) return { configured: false as const };
  const res = await attempt(() => adminClient().agents.list());
  return {
    configured: true as const,
    agents: res.ok ? res.data.data : [],
    error: res.ok ? null : res.error,
  };
}

/**
 * `agents.run(id, message)` opens a thread and drives one reason→act turn to
 * completion, returning the final answer plus every tool call it made along the
 * way. Running it in an action rather than the browser matters twice over: the
 * admin key stays server-side, and a long turn doesn't hold a fetch open from
 * the client — React Router streams the response when the action resolves.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const agentId = String(form.get("agentId") ?? "");
  const message = String(form.get("message") ?? "").trim();
  if (!agentId || !message) return { error: "Pick an agent and type a message." };

  try {
    const { data, threadId } = await adminClient().agents.run(agentId, message);
    // `run` never passes `async`, so this is always the resolved turn — narrow
    // it anyway so the queued shape can't slip through the types.
    if (!("answer" in data)) return { error: "The turn was queued instead of completing." };
    return { answer: data.answer, steps: data.steps, stoppedReason: data.stoppedReason, threadId };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export default function Agents({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  if (!loaderData.configured) return <NotConfigured />;
  const { agents, error } = loaderData;

  // The action returns either a turn or an error; typegen flattens the union
  // into one object with optional members, so narrow it once here.
  const turn = actionData && "answer" in actionData ? actionData : null;
  const steps = turn?.steps ?? [];

  return (
    <div className="space-y-6">
      <Panel
        title="Agents"
        desc="agents.list() + agents.run(id, message) — one reason→act turn, tool calls included"
      >
        {error && <ErrorLine msg={error} />}

        {agents.length === 0 ? (
          <ul>
            <Empty>
              No agents yet — create one in the admin (Agents). It needs an AI provider configured.
            </Empty>
          </ul>
        ) : (
          <Form method="post" className="space-y-3">
            <Field label="Agent">
              {/* A finite value set, so it's directly selectable rather than a
                  free-text id field. */}
              <select name="agentId" className={inputCls} required>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.handle ? ` (@${a.handle})` : ""}
                    {a.active ? "" : " — inactive"}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Message">
              <textarea
                name="message"
                rows={3}
                required
                className={inputCls}
                placeholder="How many products are out of stock?"
              />
            </Field>
            <button type="submit" className={primaryBtnCls} disabled={busy}>
              {busy ? "Thinking…" : "Run"}
            </button>
          </Form>
        )}

        {actionData?.error && <ErrorLine msg={actionData.error} />}
      </Panel>

      {turn && (
        <Panel title="Answer" desc={`stopped: ${turn.stoppedReason} · thread ${turn.threadId}`}>
          <p className="whitespace-pre-wrap text-sm">{turn.answer}</p>

          {steps.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-medium text-neutral-700">
                Tool calls ({steps.length})
              </h3>
              <ol className="space-y-2">
                {steps.map((s, i) => (
                  <li
                    key={`${s.tool}-${i}`}
                    className="space-y-1 rounded-lg border border-neutral-200 p-3 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      <code className="font-medium">{s.tool}</code>
                      {s.isError && <span className="text-red-600">error</span>}
                    </div>
                    {s.thought && <p className="text-neutral-500">{s.thought}</p>}
                    {/* Args and observations can be long — let them scroll
                        inside the card instead of widening the page. */}
                    <pre className="overflow-x-auto rounded bg-neutral-50 p-2">
                      {JSON.stringify(s.args, null, 2)}
                    </pre>
                    <pre className="overflow-x-auto rounded bg-neutral-50 p-2 text-neutral-600">
                      {s.observation}
                    </pre>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}
