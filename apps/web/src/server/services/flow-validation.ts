import {
  AppError,
  OPERATION_BRANCH_KEYS,
  type Operation,
  findForeachViolation,
  findNestedApproval,
  parseScheduleTrigger,
  validateScheduleSpec,
} from "@backlex/core";
import { taskFor, taskOutputsProblem, taskSettingsProblem } from "@backlex/integrations";
import type { Ctx } from "../context";
import { loadCollection } from "./items/collection-loader";

/**
 * Everything a flow has to satisfy before it is stored, in one place.
 *
 * One place because there is more than one way into the `flows` table — the
 * REST route, the GraphQL mutations, and whatever comes next — and a guard
 * re-typed per surface is a guard that only holds on the surface somebody
 * remembered. That is not hypothetical here: the nested-approval check shipped
 * on the REST route alone, so the same flow the API refused could be created
 * through GraphQL and then park a continuation nothing would ever resume.
 *
 * Every check refuses at SAVE time on purpose. The failures these prevent all
 * present at RUN time as silence — a loop that ran once, a reminder that never
 * arrived, a request nobody resumes — with nothing in the flow to point at.
 */
export const assertFlowShape = async (
  ctx: Ctx,
  tenantId: string,
  input: { trigger?: unknown; operations?: unknown },
): Promise<void> => {
  if (input.operations !== undefined) {
    const nested = findNestedApproval(input.operations);
    if (nested) {
      throw new AppError(
        "VALIDATION",
        `An approval step cannot sit inside another step's branch (${nested}). Put it at the top level — every step after it runs once it is approved.`,
      );
    }
    const foreachIssue = findForeachViolation(input.operations);
    if (foreachIssue) {
      throw new AppError("VALIDATION", foreachIssue);
    }
    await assertForeachCollections(ctx, tenantId, input.operations);
    assertTaskSteps(input.operations);
  }

  if (typeof input.trigger === "string" && input.trigger.startsWith("schedule:")) {
    const spec = parseScheduleTrigger(input.trigger);
    if (!spec) {
      throw new AppError(
        "VALIDATION",
        "This schedule trigger could not be read. Pick the collection, date field and offset again.",
      );
    }
    const problem = validateScheduleSpec(spec);
    if (problem) throw new AppError("VALIDATION", problem);
    if (spec.where) assertConditionOps(spec.where, "in the schedule's filter");

    // The field check needs the collection, so it cannot live in core with the
    // rest. Worth the round trip: a schedule naming a field that is not a date
    // is not a flow that misfires, it is a flow that never fires at all, and
    // nothing about it looks wrong from the outside.
    const collection = await loadCollection(ctx, tenantId, spec.collection);
    const field = collection.fields.find((f) => f.name === spec.field);
    if (!field) {
      throw new AppError(
        "VALIDATION",
        `"${spec.collection}" has no field called "${spec.field}".`,
      );
    }
    if (field.type !== "timestamp") {
      throw new AppError(
        "VALIDATION",
        `A schedule has to count from a date. "${spec.field}" is a ${field.type} field.`,
      );
    }
  }
};

/**
 * Every comparison operator the condition DSL understands.
 *
 * Needed because the compiler ignores what it does not recognise, and a leaf
 * that contributes no SQL leaves the surrounding `AND` empty — which compiles
 * to TRUE. So `{ status: { $ne: "paid" } }`, with the wrong sigil, does not
 * narrow anything: it MATCHES EVERY ROW. On a permission that fails open; on a
 * schedule it reminds every customer at once, and on a `foreach` it loops over
 * the whole collection.
 *
 * Refusing an unknown operator here is deliberately narrow — it only covers the
 * filters a flow carries, and leaves the shared DSL's behaviour alone.
 */
const CONDITION_OPS = new Set([
  "_eq",
  "_neq",
  "_in",
  "_nin",
  "_gt",
  "_gte",
  "_lt",
  "_lte",
  "_between",
  "_null",
  "_contains",
  "_starts_with",
  "_ends_with",
  "_icontains",
  "_istarts_with",
  "_iends_with",
  "_empty",
  "_nempty",
]);

/**
 * The first leaf in a condition tree that would compile to no SQL, described,
 * or null if every leaf narrows something.
 *
 * Both shapes it catches collapse the same way. `compileComparison` collects a
 * fragment per operator it recognises and ends with `if (parts.length === 0)
 * return TRUE`, so a leaf it cannot read does not narrow the query — it MATCHES
 * EVERY ROW. On a schedule that is a reminder to every customer at once; in a
 * `foreach` it is a loop over the whole collection.
 *
 * The bare-value case is the likelier of the two by far, because
 * `{ "status": "paid" }` is what the shape looks like in every other JSON API
 * an author has used. This DSL has no such shorthand.
 */
const conditionProblem = (cond: unknown): string | null => {
  if (!cond || typeof cond !== "object") return null;
  for (const [key, value] of Object.entries(cond as Record<string, unknown>)) {
    if (key === "$and" || key === "$or") {
      for (const child of Array.isArray(value) ? value : []) {
        const found = conditionProblem(child);
        if (found) return found;
      }
      continue;
    }
    if (key === "$not") {
      const found = conditionProblem(value);
      if (found) return found;
      continue;
    }
    // Anything else is a field name whose value must be a comparison object.
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return `the filter on "${key}" is a bare value. Name the comparison — ${JSON.stringify(
        { [key]: { _eq: value } },
      )} — because a filter with no operator matches every row rather than none`;
    }
    const ops = Object.keys(value as Record<string, unknown>);
    if (ops.length === 0) {
      return `the filter on "${key}" is empty, which matches every row rather than none`;
    }
    for (const op of ops) {
      if (!CONDITION_OPS.has(op)) {
        return `"${op}" is not a filter operator — did you mean "_${op.replace(
          /^[$_]/,
          "",
        )}"? A filter the engine cannot read matches every row rather than none`;
      }
    }
  }
  return null;
};

const assertConditionOps = (where: unknown, where_: string): void => {
  const problem = conditionProblem(where);
  if (problem) {
    throw new AppError("VALIDATION", `${problem} (${where_}).`);
  }
};

/**
 * Every operation in the tree, branches included.
 *
 * One walker rather than one per check: a branch key a later check forgets to
 * descend into is a step nothing validates, and the whole point of these guards
 * is that they hold wherever the author put the step.
 */
const walkOps = (operations: unknown, visit: (op: Operation) => void): void => {
  if (!Array.isArray(operations)) return;
  for (const op of operations as Operation[]) {
    if (!op || typeof op !== "object") continue;
    visit(op);
    for (const branch of OPERATION_BRANCH_KEYS) {
      walkOps((op as unknown as Record<string, unknown>)[branch], visit);
    }
  }
};

/**
 * Every `integration.task` step names a task that exists, with settings and
 * outputs that task declares.
 *
 * Registry-only, and deliberately so — it is the half that cannot be checked
 * any other way before the step runs. A mistyped task id or output key reads as
 * a perfectly ordinary step in the builder, and the first sign of it is a run
 * that failed on the order it was supposed to ship. Whether the TARGET column
 * can be written to is checked at run time against the collection, and the
 * builder only ever offers writable ones.
 *
 * A kind or task built from a template is left alone: there is nothing to look
 * up until the run renders it.
 *
 * Both fields are type-checked rather than assumed, like the `foreach` slug
 * below. Only the REST route parses operations through zod first; GraphQL hands
 * this the payload as it arrived, so a `kind` that is a number would otherwise
 * take the request down with a TypeError instead of naming the bad step.
 */
const assertTaskSteps = (operations: unknown): void => {
  walkOps(operations, (op) => {
    if (op.type !== "integration.task") return;
    const kind = typeof op.kind === "string" ? op.kind : "";
    const taskId = typeof op.task === "string" ? op.task : "";
    if (!kind || !taskId) {
      throw new AppError(
        "VALIDATION",
        "An integration task step needs a provider and a task, both named as text.",
      );
    }
    if (kind.includes("{{") || taskId.includes("{{")) return;
    const task = taskFor(kind, taskId);
    if (!task) {
      throw new AppError(
        "VALIDATION",
        `"${kind}" has no task called "${taskId}", so this step could never run.`,
      );
    }
    const problem =
      taskSettingsProblem(kind, task, asBag(op.settings)) ??
      taskOutputsProblem(kind, task, Object.keys(asBag(op.outputMapping)));
    if (problem) throw new AppError("VALIDATION", `${problem}.`);
  });
};

/** A step's settings/mapping as an object, whatever the caller actually sent. */
const asBag = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Walk the tree and confirm every `foreach` names a collection that exists.
 *  A literal slug is checkable; one built from a template is not, and is left
 *  to the run. */
const assertForeachCollections = async (
  ctx: Ctx,
  tenantId: string,
  operations: unknown,
): Promise<void> => {
  const slugs = new Set<string>();
  walkOps(operations, (op) => {
    if (op.type === "foreach") {
      if (typeof op.collection === "string" && !op.collection.includes("{{")) {
        slugs.add(op.collection);
      }
      if (op.filter) assertConditionOps(op.filter, "in a foreach step");
    }
    if (op.type === "condition" && op.filter) {
      assertConditionOps(op.filter, "in a condition step");
    }
  });
  for (const slug of slugs) {
    // `loadCollection` throws NOT_FOUND, which would surface as a 404 on a
    // request that is really a bad payload — re-shape it so the caller sees a
    // validation error naming the step they got wrong.
    try {
      await loadCollection(ctx, tenantId, slug);
    } catch {
      throw new AppError(
        "VALIDATION",
        `A foreach step points at "${slug}", which is not a collection in this workspace.`,
      );
    }
  }
};
