import { Form, useNavigation } from "react-router";
import { adminClient, attempt, errorMessage, isConfigured } from "~/backlex.server";
import { btnCls, Empty, ErrorLine, Field, inputCls, NotConfigured, Panel, primaryBtnCls } from "~/ui";
import type { Route } from "./+types/jobs";

// Mirrors the SDK's `JobStatus` union — `dead_letter` is where a job lands once
// it has burned through `maxAttempts`.
const STATUSES = [
  "pending",
  "active",
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
] as const;

export async function loader({ request }: Route.LoaderArgs) {
  if (!isConfigured()) return { configured: false as const };

  // Filters live in the URL, so the list is shareable and the back button works
  // — the framework-mode alternative to holding filter state in React.
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "";
  const res = await attempt(() =>
    adminClient().jobs.list({
      limit: 50,
      ...(status ? { status: status as (typeof STATUSES)[number] } : {}),
    }),
  );

  return {
    configured: true as const,
    status,
    jobs: res.ok ? res.data.jobs : [],
    error: res.ok ? null : res.error,
  };
}

/**
 * One action per route handles every mutation, discriminated by an `intent`
 * field on the submitted form. Returning `{ error }` instead of throwing keeps
 * the failure inline; React Router revalidates the loader on success, so the
 * list refreshes without any client-side cache to invalidate.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const backlex = adminClient();

  try {
    switch (intent) {
      case "enqueue": {
        const name = String(form.get("name") ?? "").trim();
        if (!name) return { error: "Function name is required." };
        const delaySeconds = Number(form.get("delaySeconds") ?? 0);
        await backlex.jobs.enqueue({
          type: "function",
          payload: { name, input: {} },
          maxAttempts: 3,
          // `runAt` in the future is what makes it a *scheduled* job.
          ...(delaySeconds > 0
            ? { runAt: new Date(Date.now() + delaySeconds * 1000).toISOString() }
            : {}),
        });
        return { ok: true };
      }
      case "retry":
        await backlex.jobs.retry(String(form.get("id")));
        return { ok: true };
      case "cancel":
        await backlex.jobs.cancel(String(form.get("id")));
        return { ok: true };
      case "remove":
        await backlex.jobs.remove(String(form.get("id")));
        return { ok: true };
      default:
        return { error: `Unknown intent: ${intent}` };
    }
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export default function Jobs({ loaderData, actionData }: Route.ComponentProps) {
  const nav = useNavigation();
  const busy = nav.state === "submitting";
  if (!loaderData.configured) return <NotConfigured />;
  const { jobs, status, error } = loaderData;

  return (
    <div className="space-y-6">
      <Panel
        title="Enqueue a job"
        desc="jobs.enqueue({ type: 'function', payload, maxAttempts, runAt }) — durable, retried with backoff, dead-lettered after maxAttempts"
      >
        <Form method="post" className="space-y-3">
          <input type="hidden" name="intent" value="enqueue" />
          <Field label="Function name">
            <input
              className={inputCls}
              name="name"
              placeholder="send-welcome-email"
              required
              // Functions are authored in the admin → Functions; the job runner
              // resolves this name at execution time.
            />
          </Field>
          <Field label="Delay (seconds)">
            <input
              className={inputCls}
              name="delaySeconds"
              type="number"
              min={0}
              defaultValue={0}
            />
          </Field>
          <button type="submit" className={primaryBtnCls} disabled={busy}>
            {busy ? "Enqueueing…" : "Enqueue"}
          </button>
        </Form>
        {actionData?.error && <ErrorLine msg={actionData.error} />}
      </Panel>

      <Panel title="Queue" desc="jobs.list({ status, limit }) — filter lives in the URL">
        {/* A GET form writes the filter straight into the querystring. */}
        <Form method="get" className="flex flex-wrap gap-2">
          <select name="status" defaultValue={status} className={inputCls}>
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <button type="submit" className={btnCls}>
            Filter
          </button>
        </Form>

        {error && <ErrorLine msg={error} />}

        <ul className="space-y-2">
          {jobs.length === 0 && <Empty>No jobs{status ? ` with status "${status}"` : ""}.</Empty>}
          {jobs.map((j) => (
            <li key={j.id} className="space-y-2 rounded-lg border border-neutral-200 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs">{j.status}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{j.type}</span>
                <span className="text-xs text-neutral-500">
                  attempt {j.attempts}/{j.maxAttempts}
                </span>
              </div>
              {j.lastError && (
                <p className="break-words text-xs text-red-600">{j.lastError}</p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                {/* Each button is its own form so a single row action doesn't
                    submit the sibling rows' hidden fields. */}
                <Form method="post">
                  <input type="hidden" name="intent" value="retry" />
                  <input type="hidden" name="id" value={j.id} />
                  <button type="submit" className={btnCls} disabled={busy}>
                    Retry
                  </button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="cancel" />
                  <input type="hidden" name="id" value={j.id} />
                  <button type="submit" className={btnCls} disabled={busy}>
                    Cancel
                  </button>
                </Form>
                <Form method="post">
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="id" value={j.id} />
                  <button type="submit" className={btnCls} disabled={busy}>
                    Delete
                  </button>
                </Form>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
