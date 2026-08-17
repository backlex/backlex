import type { Condition, Operation, ScheduleSpec } from "@backlex/core";
import {
  FOREACH_MAX_ROWS,
  formatScheduleTrigger,
  parseScheduleTrigger,
  validateScheduleSpec,
} from "@backlex/core";
import { parseFilter, FilterParseError } from "./filter-dsl";

/**
 * Builder ↔ runtime translation layer.
 *
 * The flow builder works in graph form (positioned `nodes` + branching
 * `edges`). The runtime needs a flat `operations` array plus a `trigger`
 * string. `compileGraph` reduces graph → runtime, and `decompileGraph`
 * rehydrates a saved flow back into the graph form so editing is round-
 * trippable. The original graph is also persisted to `flows.layout` so
 * positions survive even when no clean inverse exists for an op.
 */

export interface GraphNode {
  id: string;
  kind: "trigger" | "action" | "control";
  type: string;
  x: number;
  y: number;
  config: Record<string, any>;
}
export interface GraphEdge {
  from: string;
  to: string;
  /** `"true"`/`"false"` are an If's two arms; `"loop"` is a For-each's body.
   *  `null` is the ordinary "next step" edge. */
  branch: "true" | "false" | "loop" | null;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Action types the backend can execute today. Anything outside this set
 *  is preserved in the saved layout but emitted as a warning + skipped at
 *  runtime so the flow still saves. */
const SUPPORTED_ACTIONS = new Set([
  "email",
  "webhook",
  "request",
  "log",
  "notification",
  "push",
  "sms",
  "ai.generate",
  "ai.classify",
  "payment.checkout",
  "payment.refund",
  "document.render",
  "document.sign",
  "approval.request",
  "report.deliver",
  "transform",
  "run-script",
  // Wired in later phases — listed so the compiler emits a clearer warning
  // ("requires phase 2") instead of "unknown step".
  "fn",
  "item.create",
  "item.update",
  "integration",
  "integration.task",
  "delay",
]);

const PHASE_PENDING: Record<string, string> = {};

/**
 * Parse a duration string like "30s", "5m", "1h", "2d" into milliseconds.
 * Bare numbers are treated as ms. Throws on unparseable input.
 */
export const parseDurationMs = (raw: string): number => {
  const s = raw.trim();
  if (!s) throw new FlowCompileError("Delay duration is empty");
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(s);
  if (!m) throw new FlowCompileError(`Cannot parse duration "${raw}"`);
  const n = Number(m[1]);
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return Math.round(n * mult[unit]!);
};

export const formatDurationMs = (ms: number): string => {
  if (ms < 1000) return `${ms}ms`;
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
};

export interface CompileResult {
  trigger: string;
  operations: Operation[];
  layout: Graph;
  warnings: string[];
}

export class FlowCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowCompileError";
  }
}

/* ─────────────────────────── compile ─────────────────────────── */

export const compileGraph = (graph: Graph): CompileResult => {
  const trigger = graph.nodes.find((n) => n.kind === "trigger");
  if (!trigger) throw new FlowCompileError("Flow needs a trigger node");

  const triggerStr = compileTrigger(trigger);

  const warnings: string[] = [];
  // BFS from trigger along edges with `branch == null` (the trigger only has
  // one outgoing path). Branching only kicks in on control "if" nodes.
  const next = nextLinear(graph, trigger.id, null);
  let operations = walk(graph, next, warnings);

  if (operations.length === 0) {
    throw new FlowCompileError(
      "Flow needs at least one action after the trigger",
    );
  }

  // Wrap operations in a top-level `condition` when the trigger has a
  // "When (filter DSL)" expression. The runtime evaluates conditions
  // against the event payload's `data`, so this gates the whole flow on
  // the predicate without requiring the admin to drop in an explicit if
  // step. Empty / whitespace-only when expressions pass through.
  const whenRaw = String((trigger.config.when ?? "")).trim();
  if (whenRaw) {
    let filter;
    try {
      filter = parseFilter(whenRaw);
    } catch (e) {
      throw new FlowCompileError(
        e instanceof FilterParseError
          ? `Trigger filter is invalid: ${e.message}`
          : (e as Error).message,
      );
    }
    operations = [
      { type: "condition", filter, then: operations, else: [] },
    ];
  }

  return {
    trigger: triggerStr,
    operations,
    layout: { nodes: graph.nodes, edges: graph.edges },
    warnings,
  };
};

/**
 * `"09:00"` → minutes past midnight, or null for "keep the row's own time".
 *
 * Empty is a real answer here, not a missing one: without a time of day the
 * schedule counts in plain milliseconds from whatever hour the field carries,
 * which is what an "N hours before" reminder wants.
 */
const toMinuteOfDay = (raw: unknown): number | null => {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new FlowCompileError(`Cannot read "${s}" as a time of day (use 09:00)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new FlowCompileError(`"${s}" is not a valid time of day`);
  return h * 60 + min;
};

/** Minutes past midnight → the `HH:MM` the inspector shows. Inverse of
 *  {@link toMinuteOfDay}, so a saved schedule round-trips through the editor
 *  unchanged. */
const minuteOfDayToTime = (minute: number): string =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** An optional inspector filter box → a condition, or null when left empty. */
const parseOptionalFilter = (raw: unknown, where: string): Condition | null => {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  try {
    return parseFilter(s) as Condition;
  } catch (e) {
    throw new FlowCompileError(
      e instanceof FilterParseError
        ? `Filter on the ${where} is invalid: ${e.message}`
        : (e as Error).message,
    );
  }
};

const compileTrigger = (node: GraphNode): string => {
  switch (node.type) {
    case "item.created":
    case "item.updated":
    case "item.deleted": {
      const evt = node.type.split(".")[1]!; // created/updated/deleted
      const collection = node.config.collection || "*";
      return `event:items:${collection}:${evt}`;
    }
    case "cron": {
      const pattern = String(node.config.cron || "").trim();
      if (!pattern)
        throw new FlowCompileError(
          "Cron trigger needs a pattern (e.g. 0 9 * * *)",
        );
      return `cron:${pattern}`;
    }
    case "schedule": {
      const c = node.config;
      const collection = String(c.collection ?? "").trim();
      const field = String(c.field ?? "").trim();
      if (!collection || !field) {
        throw new FlowCompileError(
          "A date schedule needs a collection and a date field to count from",
        );
      }
      const unit = String(c.offsetUnit ?? "days") as ScheduleSpec["offset"]["unit"];
      // A time of day only means something against whole days, so the two
      // controls move together rather than letting the pair contradict.
      const at = unit === "days" || unit === "weeks" ? toMinuteOfDay(c.at) : null;
      const spec: ScheduleSpec = {
        collection,
        field,
        offset: {
          value: Math.max(0, Math.trunc(Number(c.offsetValue ?? 0)) || 0),
          unit,
          direction: c.offsetDirection === "after" ? "after" : "before",
        },
        at,
        timeZone: at === null ? null : String(c.timeZone ?? "").trim() || null,
        where: parseOptionalFilter(c.where, "schedule"),
      };
      const problem = validateScheduleSpec(spec);
      if (problem) throw new FlowCompileError(problem);
      return formatScheduleTrigger(spec);
    }
    case "auth.signup":
      return "event:auth:signup";
    case "webhook": {
      // Incoming webhook trigger — the actual /api/webhook/:flowId endpoint
      // arrives in phase 4, but the trigger string is stable so saved flows
      // start firing as soon as the route lands.
      return "webhook";
    }
    default:
      throw new FlowCompileError(`Unknown trigger type "${node.type}"`);
  }
};

const walk = (
  graph: Graph,
  startId: string | null,
  warnings: string[],
): Operation[] => {
  const out: Operation[] = [];
  let cursor = startId;
  const guard = new Set<string>();
  while (cursor) {
    if (guard.has(cursor)) {
      warnings.push(`Cycle detected at node "${cursor}" — truncating`);
      break;
    }
    guard.add(cursor);
    const node = graph.nodes.find((n) => n.id === cursor);
    if (!node) break;
    const op = compileNode(graph, node, warnings);
    if (op) out.push(op);
    cursor = nextLinear(graph, cursor, null);
  }
  return out;
};

const nextLinear = (
  graph: Graph,
  fromId: string,
  branch: GraphEdge["branch"],
): string | null => {
  const edge = graph.edges.find((e) => e.from === fromId && e.branch === branch);
  return edge?.to ?? null;
};

const compileNode = (
  graph: Graph,
  node: GraphNode,
  warnings: string[],
): Operation | null => {
  if (node.kind === "control" && node.type === "if") {
    let filter;
    try {
      filter = parseFilter(String(node.config.test ?? ""));
    } catch (e) {
      throw new FlowCompileError(
        e instanceof FilterParseError
          ? `Filter on "if" step is invalid: ${e.message}`
          : (e as Error).message,
      );
    }
    const thenStart = nextLinear(graph, node.id, "true");
    const elseStart = nextLinear(graph, node.id, "false");
    return {
      type: "condition",
      filter,
      then: walk(graph, thenStart, warnings),
      else: walk(graph, elseStart, warnings),
    };
  }

  if (node.kind === "control" && node.type === "foreach") {
    const collection = String(node.config.collection ?? "").trim();
    if (!collection) {
      throw new FlowCompileError("A For-each step needs a collection to loop over");
    }
    const body = walk(graph, nextLinear(graph, node.id, "loop"), warnings);
    if (body.length === 0) {
      // An empty loop is not a no-op the author meant — it is a body they
      // attached to the wrong port, and it would run silently forever.
      throw new FlowCompileError(
        "A For-each step has no body — attach at least one step to its loop port",
      );
    }
    const filter = parseOptionalFilter(node.config.filter, "For-each step");
    const sort = String(node.config.sort ?? "").trim();
    const limitRaw = Number(node.config.limit);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0
        ? Math.min(Math.trunc(limitRaw), FOREACH_MAX_ROWS)
        : undefined;
    return {
      type: "foreach",
      collection,
      ...(filter ? { filter } : {}),
      ...(sort ? { sort } : {}),
      ...(limit ? { limit } : {}),
      do: body,
    };
  }

  if (node.kind === "action") {
    if (!SUPPORTED_ACTIONS.has(node.type)) {
      warnings.push(`Skipped unknown action "${node.type}"`);
      return null;
    }
    if (PHASE_PENDING[node.type]) {
      warnings.push(
        `"${node.type}" step skipped at runtime — ${PHASE_PENDING[node.type]}`,
      );
      return null;
    }
    return compileAction(node);
  }

  // Trigger reached via walk — should never happen because we start AFTER it.
  return null;
};

/**
 * The inspector's calendar-invite fields → the op's nested `ics` block.
 *
 * Flat in the inspector because a node's config is a flat record, nested in the
 * op because that is where a reader looks for it. `icsStart` is what turns the
 * block on: an invite with no start is not an invite, and the two fields the
 * builder can't default are exactly summary and start.
 */
type EmailOp = Extract<Operation, { type: "email" }>;

const compileIcs = (c: Record<string, any>): { ics?: NonNullable<EmailOp["ics"]> } => {
  const start = String(c.icsStart ?? "").trim();
  if (!start) return {};
  const summary = String(c.icsSummary ?? "").trim();
  if (!summary) throw new FlowCompileError("Calendar invite needs a title");
  const opt = (v: unknown) => {
    const s = String(v ?? "").trim();
    return s || undefined;
  };
  return {
    ics: {
      summary,
      start,
      ...(opt(c.icsEnd) ? { end: opt(c.icsEnd) } : {}),
      ...(opt(c.icsLocation) ? { location: opt(c.icsLocation) } : {}),
      ...(opt(c.icsDescription) ? { description: opt(c.icsDescription) } : {}),
      ...(opt(c.icsOrganizerEmail) ? { organizerEmail: opt(c.icsOrganizerEmail) } : {}),
      ...(opt(c.icsAttendees) ? { attendees: opt(c.icsAttendees) } : {}),
    },
  };
};

const compileAction = (node: GraphNode): Operation => {
  const c = node.config;
  switch (node.type) {
    case "email": {
      // The email op accepts either a templateKey OR literal subject+text.
      // Validate at compile time so a half-filled inspector fails fast
      // instead of surfacing a 422 from the runtime.
      const hasTemplate = !!c.templateKey;
      if (!hasTemplate && !c.subject)
        throw new FlowCompileError(
          "Email step needs either a template or a Subject",
        );
      if (!hasTemplate && !c.text && !c.html)
        throw new FlowCompileError(
          "Email step needs either a template or a Body (text/html)",
        );
      return {
        type: "email",
        to: String(c.to ?? ""),
        ...(c.templateKey ? { templateKey: String(c.templateKey) } : {}),
        ...(c.vars ? { vars: c.vars } : {}),
        ...(c.subject ? { subject: String(c.subject) } : {}),
        ...(c.html ? { html: String(c.html) } : {}),
        ...(c.text ? { text: String(c.text) } : {}),
        ...compileIcs(c),
      };
    }
    case "webhook":
    case "request": {
      if (!c.url) throw new FlowCompileError(`${node.type} step needs a URL`);
      return {
        type: node.type as "webhook" | "request",
        url: String(c.url),
        ...(c.method ? { method: c.method } : {}),
        ...(c.headers ? { headers: c.headers } : {}),
        ...(c.body !== undefined ? { body: tryParseJson(c.body) } : {}),
      } as Operation;
    }
    case "log": {
      return { type: "log", message: String(c.message ?? "") };
    }
    case "notification": {
      if (!c.title)
        throw new FlowCompileError("Notification step needs a Title");
      return {
        type: "notification",
        title: String(c.title),
        ...(c.body ? { body: String(c.body) } : {}),
        ...(c.url ? { url: String(c.url) } : {}),
        ...(c.userId !== undefined ? { userId: c.userId ?? null } : {}),
      };
    }
    case "push": {
      const templateKey = String(c.templateKey ?? "").trim();
      const title = String(c.title ?? "").trim();
      const body = String(c.body ?? "").trim();
      const userId = String(c.userId ?? "").trim();
      // A key stands in for both, exactly as the email step's does. Without
      // one they are still required — the same message the builder gave before
      // push templates had a send path.
      if (!templateKey && !title) throw new FlowCompileError("Push step needs a Title");
      if (!templateKey && !body) throw new FlowCompileError("Push step needs a message");
      if (!userId) throw new FlowCompileError("Push step needs a recipient user");
      return {
        type: "push",
        ...(templateKey ? { templateKey } : {}),
        ...(title ? { title } : {}),
        ...(body ? { body } : {}),
        userId,
        ...(c.url ? { url: String(c.url).trim() } : {}),
      };
    }
    case "sms": {
      const body = String(c.body ?? "").trim();
      if (!body) throw new FlowCompileError("SMS step needs a message");
      const from = c.from ? { from: String(c.from).trim() } : {};
      // The editor's recipient toggle. `to` addresses a number carried on the
      // row (a customer), `user` a platform user's registered numbers — the op
      // accepts exactly one, so the mode decides which field is emitted.
      if (c.mode === "user") {
        const userId = String(c.userId ?? "").trim();
        if (!userId) throw new FlowCompileError("SMS step needs a recipient user");
        return { type: "sms", body, userId, ...from };
      }
      const to = String(c.to ?? "").trim();
      if (!to) throw new FlowCompileError("SMS step needs a recipient number");
      return { type: "sms", body, to, ...from };
    }
    case "ai.generate": {
      const prompt = String(c.prompt ?? "").trim();
      if (!prompt) throw new FlowCompileError("AI step needs a prompt");
      const system = String(c.system ?? "").trim();
      const model = String(c.model ?? "").trim();
      const maxTokens = Number(c.maxTokens);
      return {
        type: "ai.generate",
        prompt,
        ...(system ? { system } : {}),
        // An empty model means "the workspace default", which is what the op
        // means by omitting the field — emitting `model: ""` would instead ask
        // the provider for a model with no name.
        ...(model ? { model } : {}),
        ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens: Math.floor(maxTokens) } : {}),
        ...(c.effort === "low" || c.effort === "medium" || c.effort === "high"
          ? { effort: c.effort }
          : {}),
      };
    }
    case "ai.classify": {
      const input = String(c.input ?? "").trim();
      if (!input) throw new FlowCompileError("Classify step needs some text to classify");
      // The inspector edits the label set as one newline-separated field,
      // because a repeating row editor for a list of short strings is more
      // chrome than the thing it edits. The split happens here so the op always
      // stores the array its schema declares.
      const labels = String(c.labels ?? "")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (labels.length < 2) throw new FlowCompileError("Classify step needs at least two labels");
      if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) {
        throw new FlowCompileError("Classify step labels must be distinct");
      }
      const fallback = String(c.fallback ?? "").trim();
      if (fallback && !labels.some((l) => l.toLowerCase() === fallback.toLowerCase())) {
        throw new FlowCompileError("Classify step fallback must be one of the labels");
      }
      const instructions = String(c.instructions ?? "").trim();
      const model = String(c.model ?? "").trim();
      return {
        type: "ai.classify",
        input,
        labels,
        ...(instructions ? { instructions } : {}),
        ...(model ? { model } : {}),
        ...(fallback ? { fallback } : {}),
      };
    }
    case "payment.checkout": {
      const amount = String(c.amount ?? "").trim();
      const currency = String(c.currency ?? "").trim().toUpperCase();
      if (!amount) throw new FlowCompileError("Payment link step needs an amount");
      if (currency.length !== 3) {
        throw new FlowCompileError("Payment link step needs a 3-letter currency code");
      }
      const opt = (key: string): Record<string, string> => {
        const v = String(c[key] ?? "").trim();
        return v ? { [key]: v } : {};
      };
      // The write-back fields travel together: a target row with no field to
      // put the link in records nothing, so the compiler asks for all three
      // rather than emitting a half-specified target the server will reject.
      const wbCollection = String(c.writeBackCollection ?? "").trim();
      const wbItemId = String(c.writeBackItemId ?? "").trim();
      const wbUrlField = String(c.writeBackUrlField ?? "").trim();
      const wbRefField = String(c.writeBackReferenceField ?? "").trim();
      let writeBack:
        | { collection: string; itemId: string; urlField: string; referenceField?: string }
        | undefined;
      if (wbCollection || wbUrlField) {
        if (!wbCollection || !wbUrlField || !wbItemId) {
          throw new FlowCompileError(
            "Payment link write-back needs a collection, a row id and a URL field",
          );
        }
        writeBack = {
          collection: wbCollection,
          itemId: wbItemId,
          urlField: wbUrlField,
          ...(wbRefField ? { referenceField: wbRefField } : {}),
        };
      }
      return {
        type: "payment.checkout",
        amount,
        currency,
        ...opt("provider"),
        ...opt("description"),
        ...opt("email"),
        ...opt("customerName"),
        ...opt("successUrl"),
        ...opt("cancelUrl"),
        ...(writeBack ? { writeBack } : {}),
      };
    }
    case "payment.refund": {
      const opt = (key: string): Record<string, string> => {
        const v = String(c[key] ?? "").trim();
        return v ? { [key]: v } : {};
      };
      const target = {
        ...opt("paymentRowId"),
        ...opt("externalId"),
        ...opt("reference"),
      };
      if (Object.keys(target).length === 0) {
        throw new FlowCompileError(
          "Refund step needs a payment row id, a provider payment id, or the checkout reference",
        );
      }
      const amount = String(c.amount ?? "").trim();
      return {
        type: "payment.refund",
        ...target,
        // Blank means the whole remaining balance, which is the common case —
        // so unlike the checkout's amount this is not required.
        ...(amount ? { amount } : {}),
        ...opt("provider"),
        ...opt("description"),
        ...(c.reason ? { reason: String(c.reason) as "other" } : {}),
      };
    }
    case "document.render":
    case "document.sign": {
      const templateKey = String(c.templateKey ?? "").trim();
      if (!templateKey) throw new FlowCompileError(`${node.type} step needs a document template`);
      // The three write-back fields travel together: a target row with no
      // field to put the key in records nothing, so the compiler asks for all
      // three rather than emitting a half-specified target the server rejects.
      const wbCollection = String(c.writeBackCollection ?? "").trim();
      const wbItemId = String(c.writeBackItemId ?? "").trim();
      const wbField = String(c.writeBackField ?? "").trim();
      let writeBack: { collection: string; id: string; field: string } | undefined;
      if (wbCollection || wbField) {
        if (!wbCollection || !wbField || !wbItemId) {
          throw new FlowCompileError(
            `${node.type} write-back needs a collection, a row id and a field`,
          );
        }
        writeBack = { collection: wbCollection, id: wbItemId, field: wbField };
      }
      if (node.type === "document.render") {
        const filename = String(c.filename ?? "").trim();
        return {
          type: "document.render",
          templateKey,
          ...(filename ? { filename } : {}),
          ...(writeBack ? { writeBack } : {}),
        };
      }
      // One `email:name:role` per line, which is what the admin page and the
      // CLI take too. A lone placeholder is passed through untouched — it
      // resolves to a whole list at run time, off a row that carries its own
      // counterparties.
      const raw = String(c.signers ?? "").trim();
      if (!raw) throw new FlowCompileError("Signature step needs at least one signer");
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      const lone = lines.length === 1 && /^\{\{\s*[\w$.]+\s*\}\}$/.test(lines[0]!);
      const signers = lone
        ? lines[0]!
        : lines.map((line) => {
            const [email, name, ...role] = line.split(":");
            return {
              email: (email ?? "").trim(),
              ...(name?.trim() ? { name: name.trim() } : {}),
              ...(role.join(":").trim() ? { role: role.join(":").trim() } : {}),
            };
          });
      const days = Number(String(c.expiresInDays ?? "").trim());
      return {
        type: "document.sign",
        templateKey,
        signers,
        ...(String(c.title ?? "").trim() ? { title: String(c.title).trim() } : {}),
        ...(String(c.message ?? "").trim() ? { message: String(c.message).trim() } : {}),
        ...(c.ordered ? { ordered: true } : {}),
        ...(Number.isFinite(days) && days > 0 ? { expiresInDays: days } : {}),
        ...(writeBack ? { writeBack } : {}),
      };
    }
    case "approval.request": {
      const title = String(c.title ?? "").trim();
      if (!title) throw new FlowCompileError("Approval step needs a title");
      // One `email:name:role` per line, the same shape the signature step and
      // the CLI take. A lone placeholder passes through untouched — it
      // resolves to a whole list at run time, off a row carrying its own
      // approvers.
      const raw = String(c.approvers ?? "").trim();
      if (!raw) throw new FlowCompileError("Approval step needs at least one approver");
      const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
      const lone = lines.length === 1 && /^\{\{\s*[\w$.]+\s*\}\}$/.test(lines[0]!);
      const approvers = lone
        ? lines[0]!
        : lines.map((line) => {
            const [email, name, ...role] = line.split(":");
            return {
              email: (email ?? "").trim(),
              ...(name?.trim() ? { name: name.trim() } : {}),
              ...(role.join(":").trim() ? { role: role.join(":").trim() } : {}),
            };
          });
      const policy = String(c.policy ?? "").trim() || "all";
      const quorum = Number(String(c.quorum ?? "").trim());
      // Refused here rather than server-side so the author is told while they
      // are still looking at the step: a quorum with no number silently means
      // 1, which is `any` under a different name.
      if (policy === "quorum" && !(Number.isFinite(quorum) && quorum > 0)) {
        throw new FlowCompileError("A quorum policy needs a number of approvals");
      }
      const hours = Number(String(c.expiresInHours ?? "").trim());
      const wbField = String(c.writeBackField ?? "").trim();
      const writeBack = wbField
        ? {
            field: wbField,
            ...(String(c.writeBackCollection ?? "").trim()
              ? { collection: String(c.writeBackCollection).trim() }
              : {}),
            ...(String(c.writeBackItemId ?? "").trim()
              ? { id: String(c.writeBackItemId).trim() }
              : {}),
            ...(String(c.approvedValue ?? "").trim()
              ? { approvedValue: String(c.approvedValue).trim() }
              : {}),
            ...(String(c.rejectedValue ?? "").trim()
              ? { rejectedValue: String(c.rejectedValue).trim() }
              : {}),
          }
        : undefined;
      return {
        type: "approval.request",
        title,
        approvers,
        ...(String(c.message ?? "").trim() ? { message: String(c.message).trim() } : {}),
        ...(policy !== "all" ? { policy: policy as "any" } : {}),
        ...(policy === "quorum" ? { quorum } : {}),
        ...(c.ordered ? { ordered: true } : {}),
        ...(Number.isFinite(hours) && hours > 0 ? { expiresInHours: hours } : {}),
        ...(writeBack ? { writeBack } : {}),
      };
    }
    case "report.deliver": {
      const dashboardId = String(c.dashboardId ?? "").trim();
      if (!dashboardId) throw new FlowCompileError("Report step needs a dashboard");
      const to = String(c.to ?? "").trim();
      const format = String(c.format ?? "").trim();
      const landscape = Boolean(c.landscape);
      // `pageOptions` is only emitted when it says something. An op carrying
      // `{ landscape: false }` reads, in a saved flow, as a deliberate choice
      // rather than the default nobody touched.
      const pageOptions =
        format || landscape
          ? { ...(format ? { format: format as "A4" } : {}), ...(landscape ? { landscape: true } : {}) }
          : undefined;
      return {
        type: "report.deliver",
        dashboardId,
        ...(String(c.filename ?? "").trim() ? { filename: String(c.filename).trim() } : {}),
        ...(to ? { to } : {}),
        ...(String(c.subject ?? "").trim() ? { subject: String(c.subject).trim() } : {}),
        ...(String(c.templateKey ?? "").trim() ? { templateKey: String(c.templateKey).trim() } : {}),
        ...(pageOptions ? { pageOptions } : {}),
      };
    }
    case "transform": {
      return {
        type: "transform",
        value: c.value !== undefined ? tryParseJson(c.value) : null,
      };
    }
    case "run-script": {
      if (!c.code) throw new FlowCompileError("Script step needs code");
      return {
        type: "run-script",
        code: String(c.code),
        ...(c.timeoutMs ? { timeoutMs: Number(c.timeoutMs) } : {}),
      };
    }
    case "fn": {
      // The builder's "fn" select stores the function name (matches the
      // unique `(tenantId, name)` index in the functions table).
      const name = String(c.fn ?? c.name ?? "").trim();
      if (!name) throw new FlowCompileError("Function step needs a name");
      return {
        type: "function",
        name,
        ...(c.input !== undefined ? { input: tryParseJson(c.input) } : {}),
      };
    }
    case "integration": {
      // The builder stores the provider kind ("slack", "jira", …); the row is
      // resolved per-workspace at run time, so nothing workspace-specific is
      // baked into the flow definition.
      const kind = String(c.kind ?? "").trim();
      const text = String(c.text ?? "").trim();
      if (!kind) throw new FlowCompileError("Integration step needs a provider");
      if (!text) throw new FlowCompileError("Integration step needs a message");
      return {
        type: "integration",
        kind,
        text,
        ...(c.event ? { event: String(c.event).trim() } : {}),
        ...(c.payload !== undefined && c.payload !== ""
          ? {
              payload:
                typeof c.payload === "string"
                  ? c.payload
                  : (tryParseJson(c.payload) as Record<string, unknown>),
            }
          : {}),
      };
    }
    case "integration.task": {
      const kind = String(c.kind ?? "").trim();
      const task = String(c.task ?? "").trim();
      const collection = String(c.collection ?? "").trim();
      const itemId = String(c.itemId ?? "").trim();
      if (!kind) throw new FlowCompileError("Task step needs a provider");
      if (!task) throw new FlowCompileError("Task step needs a task");
      if (!collection) throw new FlowCompileError("Task step needs a collection");
      if (!itemId) throw new FlowCompileError("Task step needs the row to act on");
      // A half-filled picker leaves blanks behind. Dropping them is not the
      // same as sending them: the server refuses a setting it cannot read and
      // an empty mapping target, so a blank left in would fail the save with a
      // message about a field the author never filled in on purpose.
      const kept = (bag: unknown): Record<string, string> => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries((bag ?? {}) as Record<string, unknown>)) {
          const s = String(v ?? "").trim();
          if (s) out[k] = s;
        }
        return out;
      };
      const settings = kept(c.settings);
      const outputMapping = kept(c.outputMapping);
      return {
        type: "integration.task",
        kind,
        task,
        collection,
        itemId,
        ...(Object.keys(settings).length ? { settings } : {}),
        ...(Object.keys(outputMapping).length ? { outputMapping } : {}),
        ...(c.force ? { force: true } : {}),
      };
    }
    case "item.create": {
      const collection = String(c.collection ?? "").trim();
      if (!collection)
        throw new FlowCompileError("Item create step needs a collection");
      return {
        type: "item.create",
        collection,
        // Keep strings as strings so the runtime can interpolate templates
        // before parsing. Objects pass through untouched.
        data:
          typeof c.data === "string"
            ? c.data
            : (tryParseJson(c.data) as Record<string, unknown>),
      };
    }
    case "item.update": {
      const collection = String(c.collection ?? "").trim();
      const id = String(c.id ?? "").trim();
      if (!collection)
        throw new FlowCompileError("Item update step needs a collection");
      if (!id) throw new FlowCompileError("Item update step needs an id");
      return {
        type: "item.update",
        collection,
        id,
        data:
          typeof c.data === "string"
            ? c.data
            : (tryParseJson(c.data) as Record<string, unknown>),
      };
    }
    case "delay": {
      const raw = String(c.duration ?? "").trim();
      const durationMs = parseDurationMs(raw);
      return { type: "delay", durationMs };
    }
    default:
      throw new FlowCompileError(`No compiler for action "${node.type}"`);
  }
};

/** Body fields are typed as textareas; try to JSON-parse so users can pass
 *  objects without manual quoting, but fall back to the raw string when
 *  parsing fails (intentional template strings like "{{ data.title }}"). */
const tryParseJson = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }
  return v;
};

/* ─────────────────────────── decompile ─────────────────────────── */

const DEFAULT_TRIGGER: GraphNode = {
  id: "n-trigger",
  kind: "trigger",
  type: "item.updated",
  x: 60,
  y: 160,
  config: { collection: "posts", when: "" },
};

/**
 * Rehydrate a builder graph from a saved flow.
 *
 * Preferred path: when `layout` was persisted, it's the source of truth —
 * the operations are the executable projection, but layout keeps the
 * canvas exactly as the admin left it.
 *
 * Fallback path: derive a fresh linear graph from `operations`. Used for
 * flows created before A1 landed, or anything written via the API
 * directly. Branches are reconstructed from `condition` ops; positions
 * are auto-assigned left-to-right.
 */
export const decompileGraph = (input: {
  trigger: string;
  operations: Operation[];
  layout?: Graph | null;
}): Graph => {
  if (input.layout && Array.isArray(input.layout.nodes)) {
    return input.layout;
  }
  return synthesize(input.trigger, input.operations);
};

const synthesize = (trigger: string, operations: Operation[]): Graph => {
  const triggerNode = parseTrigger(trigger);

  // Inverse of compileGraph's "trigger.when" wrap: if the first op is a
  // condition with an empty `else` branch, lift its filter back onto the
  // trigger and unwrap the `then` so the canvas matches what the admin
  // originally drew (rather than showing a synthetic If/else node).
  let ops = operations;
  if (
    ops.length === 1 &&
    ops[0]?.type === "condition" &&
    (!ops[0].else || ops[0].else.length === 0)
  ) {
    triggerNode.config.when = JSON.stringify(ops[0].filter, null, 2);
    ops = ops[0].then ?? [];
  }

  const nodes: GraphNode[] = [triggerNode];
  const edges: GraphEdge[] = [];

  let counter = 1;
  const newId = () => `n${counter++}`;
  const place = (depth: number, lane: number): { x: number; y: number } => ({
    x: 60 + depth * 260,
    y: 160 + lane * 100,
  });

  const isControl = (op: Operation) => op.type === "condition" || op.type === "foreach";
  const controlType = (op: Operation) => (op.type === "condition" ? "if" : "foreach");

  const layout = (
    ops: Operation[],
    parentId: string,
    parentBranch: GraphEdge["branch"],
    depth: number,
    lane: number,
  ): void => {
    let prevId = parentId;
    let prevBranch = parentBranch;
    ops.forEach((op, i) => {
      const id = newId();
      const pos = place(depth + i, lane);
      const node: GraphNode = {
        id,
        kind: isControl(op) ? "control" : "action",
        type: isControl(op) ? controlType(op) : op.type,
        ...pos,
        config: opToConfig(op),
      };
      nodes.push(node);
      edges.push({ from: prevId, to: id, branch: prevBranch });
      prevId = id;
      prevBranch = null;

      if (op.type === "condition") {
        if (op.then?.length) layout(op.then, id, "true", depth + i + 1, lane - 1);
        if (op.else?.length) layout(op.else, id, "false", depth + i + 1, lane + 1);
      }
      if (op.type === "foreach" && op.do?.length) {
        layout(op.do, id, "loop", depth + i + 1, lane - 1);
      }
    });
  };

  layout(ops, nodes[0]!.id, null, 1, 0);
  return { nodes, edges };
};

const parseTrigger = (s: string): GraphNode => {
  const t = s.startsWith("event:") ? s.slice("event:".length) : s;
  if (t.startsWith("items:")) {
    const parts = t.split(":"); // items:<slug>:<event>
    const collection = parts[1] || "*";
    const event = parts[2] || "updated";
    return {
      ...DEFAULT_TRIGGER,
      type: `item.${event}`,
      config: { collection, when: "" },
    };
  }
  if (t.startsWith("cron:") || s.startsWith("cron:")) {
    const pattern = (s.startsWith("cron:") ? s : t).slice("cron:".length);
    return {
      ...DEFAULT_TRIGGER,
      type: "cron",
      config: { cron: pattern },
    };
  }
  if (s.startsWith("schedule:")) {
    const spec = parseScheduleTrigger(s);
    // A spec that no longer parses still opens, as the schedule node with its
    // defaults, rather than silently reverting to "item updated" — which would
    // look like the flow was always an event flow and quietly change it on the
    // next save.
    return {
      ...DEFAULT_TRIGGER,
      type: "schedule",
      config: spec
        ? {
            collection: spec.collection,
            field: spec.field,
            offsetValue: spec.offset.value,
            offsetUnit: spec.offset.unit,
            offsetDirection: spec.offset.direction,
            at: spec.at === null ? "" : minuteOfDayToTime(spec.at),
            timeZone: spec.timeZone ?? "",
            where: spec.where ? JSON.stringify(spec.where, null, 2) : "",
          }
        : { collection: "", field: "", offsetValue: 3, offsetUnit: "days", offsetDirection: "before", at: "09:00", timeZone: "", where: "" },
    };
  }
  if (t === "auth:signup")
    return { ...DEFAULT_TRIGGER, type: "auth.signup", config: {} };
  if (s === "webhook" || s.startsWith("webhook:"))
    return { ...DEFAULT_TRIGGER, type: "webhook", config: {} };
  return DEFAULT_TRIGGER;
};

const opToConfig = (op: Operation): Record<string, any> => {
  switch (op.type) {
    case "email":
      return {
        to: op.to,
        templateKey: op.templateKey ?? "",
        vars: op.vars,
        subject: op.subject ?? "",
        html: op.html ?? "",
        text: op.text ?? "",
        // Flattened back out, so a flow written through the API round-trips
        // into the inspector instead of losing its invite on the first save.
        icsSummary: op.ics?.summary ?? "",
        icsStart: op.ics?.start ?? "",
        icsEnd: op.ics?.end ?? "",
        icsLocation: op.ics?.location ?? "",
        icsDescription: op.ics?.description ?? "",
        icsOrganizerEmail: op.ics?.organizerEmail ?? "",
        icsAttendees: op.ics?.attendees ?? "",
      };
    case "webhook":
    case "request":
      return {
        url: op.url,
        method: op.method,
        headers: op.headers,
        body:
          op.body === undefined
            ? ""
            : typeof op.body === "string"
              ? op.body
              : JSON.stringify(op.body, null, 2),
      };
    case "condition": {
      // Filter is shown as JSON in the textarea — round-trip lossless.
      return { test: JSON.stringify(op.filter, null, 2) };
    }
    case "foreach":
      return {
        collection: op.collection,
        filter: op.filter ? JSON.stringify(op.filter, null, 2) : "",
        sort: op.sort ?? "",
        limit: op.limit ?? "",
      };
    case "log":
      return { message: op.message };
    case "notification":
      return {
        title: op.title,
        body: op.body ?? "",
        url: op.url ?? "",
        userId: op.userId ?? null,
      };
    case "push":
      return {
        templateKey: op.templateKey ?? "",
        vars: op.vars,
        title: op.title ?? "",
        body: op.body ?? "",
        url: op.url ?? "",
        userId: op.userId,
      };
    case "sms":
      // `mode` is derived, not stored on the op — the presence of `userId` is
      // what distinguishes the two addressing modes.
      return {
        mode: op.userId != null ? "user" : "to",
        to: op.to ?? "",
        userId: op.userId ?? "",
        body: op.body,
        from: op.from ?? "",
      };
    case "ai.generate":
      return {
        prompt: op.prompt,
        system: op.system ?? "",
        model: op.model ?? "",
        maxTokens: op.maxTokens ?? "",
        effort: op.effort ?? "",
      };
    case "ai.classify":
      // The inverse of the compile step's split: the op stores an array, the
      // inspector edits one newline-separated field.
      return {
        input: op.input,
        labels: op.labels.join("\n"),
        instructions: op.instructions ?? "",
        model: op.model ?? "",
        fallback: op.fallback ?? "",
      };
    case "payment.checkout":
      // Flattened for the inspector: the nested `writeBack` object becomes
      // four sibling fields, which is what the editor binds inputs to.
      return {
        provider: op.provider ?? "",
        amount: String(op.amount ?? ""),
        currency: op.currency,
        description: op.description ?? "",
        email: op.email ?? "",
        customerName: op.customerName ?? "",
        successUrl: op.successUrl ?? "",
        cancelUrl: op.cancelUrl ?? "",
        writeBackCollection: op.writeBack?.collection ?? "",
        writeBackItemId: op.writeBack?.itemId ?? "",
        writeBackUrlField: op.writeBack?.urlField ?? "",
        writeBackReferenceField: op.writeBack?.referenceField ?? "",
      };
    case "payment.refund":
      return {
        provider: op.provider ?? "",
        paymentRowId: op.paymentRowId ?? "",
        externalId: op.externalId ?? "",
        reference: op.reference ?? "",
        amount: String(op.amount ?? ""),
        reason: op.reason ?? "",
        description: op.description ?? "",
      };
    case "document.render":
      // Flattened for the inspector: the nested `writeBack` becomes three
      // sibling fields, which is what the editor binds inputs to.
      return {
        templateKey: op.templateKey ?? "",
        filename: op.filename ?? "",
        writeBackCollection: op.writeBack?.collection ?? "",
        writeBackItemId: op.writeBack?.id ?? "",
        writeBackField: op.writeBack?.field ?? "",
      };
    case "document.sign":
      return {
        templateKey: op.templateKey ?? "",
        title: op.title ?? "",
        message: op.message ?? "",
        // Back to one line per signer — the same shape the compiler parses.
        signers:
          typeof op.signers === "string"
            ? op.signers
            : (op.signers ?? [])
                .map((s: any) => [s.email, s.name, s.role].filter(Boolean).join(":"))
                .join("\n"),
        ordered: Boolean(op.ordered),
        expiresInDays: op.expiresInDays ? String(op.expiresInDays) : "",
        writeBackCollection: op.writeBack?.collection ?? "",
        writeBackItemId: op.writeBack?.id ?? "",
        writeBackField: op.writeBack?.field ?? "",
      };
    case "approval.request":
      // Flattened for the inspector, same as the signature step: the nested
      // `writeBack` becomes sibling fields the editor binds inputs to.
      return {
        title: op.title ?? "",
        message: op.message ?? "",
        approvers:
          typeof op.approvers === "string"
            ? op.approvers
            : (op.approvers ?? [])
                .map((a: any) => [a.email, a.name, a.role].filter(Boolean).join(":"))
                .join("\n"),
        policy: op.policy ?? "all",
        quorum: op.quorum ? String(op.quorum) : "",
        ordered: Boolean(op.ordered),
        expiresInHours: op.expiresInHours ? String(op.expiresInHours) : "",
        writeBackCollection: op.writeBack?.collection ?? "",
        writeBackItemId: op.writeBack?.id ?? "",
        writeBackField: op.writeBack?.field ?? "",
        approvedValue: op.writeBack?.approvedValue ?? "",
        rejectedValue: op.writeBack?.rejectedValue ?? "",
      };
    case "report.deliver":
      return {
        dashboardId: op.dashboardId ?? "",
        filename: op.filename ?? "",
        to: op.to ?? "",
        subject: op.subject ?? "",
        templateKey: op.templateKey ?? "",
        format: op.pageOptions?.format ?? "",
        landscape: Boolean(op.pageOptions?.landscape),
      };
    case "transform":
      return {
        value:
          op.value === undefined
            ? ""
            : typeof op.value === "string"
              ? op.value
              : JSON.stringify(op.value, null, 2),
      };
    case "run-script":
      return { code: op.code, timeoutMs: op.timeoutMs };
    case "function":
      return {
        fn: op.name,
        input:
          op.input === undefined
            ? ""
            : typeof op.input === "string"
              ? op.input
              : JSON.stringify(op.input, null, 2),
      };
    case "integration":
      return {
        kind: op.kind,
        text: op.text,
        event: op.event ?? "",
        payload:
          op.payload === undefined
            ? ""
            : typeof op.payload === "string"
              ? op.payload
              : JSON.stringify(op.payload, null, 2),
      };
    case "integration.task":
      return {
        kind: op.kind,
        task: op.task,
        collection: op.collection,
        itemId: op.itemId,
        // Objects, not JSON text: the inspector renders one control per
        // declared setting and output, so it binds to the bag directly.
        settings: op.settings ?? {},
        outputMapping: op.outputMapping ?? {},
        force: Boolean(op.force),
      };
    case "item.create":
      return {
        collection: op.collection,
        data:
          typeof op.data === "string"
            ? op.data
            : JSON.stringify(op.data, null, 2),
      };
    case "item.update":
      return {
        collection: op.collection,
        id: op.id,
        data:
          typeof op.data === "string"
            ? op.data
            : JSON.stringify(op.data, null, 2),
      };
    case "delay":
      return { duration: formatDurationMs(op.durationMs) };
    default:
      return {};
  }
};
