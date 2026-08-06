/**
 * What a form's answers add up to.
 *
 * A form writes ordinary rows into an ordinary collection, so the summary is
 * ordinary aggregation — this asks {@link runItemsAggregate} the same
 * questions a dashboard panel would, once per exposed block, and shapes the
 * answers the way the question was asked: a choice question comes back as its
 * own choices in their own schema order, a scale as its points with the mean,
 * an NPS row as promoters minus detractors. Nothing here reads a row.
 *
 * Reading no rows is the point, not an omission. A results panel that returned
 * individual answers would be a second, weaker copy of the collection's own
 * list endpoint — one without its permissions, its field allow-list or its
 * audit trail. Free-text answers are therefore counted and not quoted; the
 * Submissions tab, which goes through `/api/items`, is where they are read.
 *
 * The counts are for the whole target collection, not for this form. Nothing
 * stamps a row with the form that wrote it (a form is a way in, not an owner),
 * so a collection written to by two forms — or by the admin — sums all of it.
 * The response says so in `rows` rather than implying otherwise.
 */
import { AppError } from "@backlex/core";
import type { AuthSubject } from "@backlex/core";
import { getChoices, type FieldDef } from "@backlex/db";
import type { Ctx } from "../context";
import { loadCollection } from "./items/collection-loader";
import { runItemsAggregate } from "./items/aggregate";
import { exposedBlocks, resolveScale, type FormRow } from "./forms";

/** How a block's answers are summarised. */
export type FormResultKind =
  | "choice"
  | "multi_choice"
  | "scale"
  | "boolean"
  | "number"
  | "text"
  | "timestamp"
  | "file";

export interface FormResultBucket {
  /** The stored value, as text (`"true"` / `"3"` / `"blue"`). */
  value: string;
  /** The choice's own label when it has one, else the value. */
  label: string;
  count: number;
}

/** How many questions get a summary. Each is one aggregate query, and a form
 *  may carry a hundred blocks; past this the panel costs more than it says. */
export const RESULT_BLOCK_CAP = 60;

/** Rows a grouped question may come back with. A choice question has a handful
 *  of buckets; an adopted column could hold thousands of distinct values, and
 *  a bar chart of those is not a reading of anything. */
const BUCKET_LIMIT = 60;

export interface FormResultBlock {
  name: string;
  label: string;
  /** Storage type of the underlying column. */
  type: string;
  kind: FormResultKind;
  /** Rows whose answer to this question is not null. For `multi_choice` that
   *  is people, while the bucket counts are choices — so the buckets sum to
   *  more than this whenever anyone picked two. */
  answered: number;
  /** Distribution, or null for the kinds that have none (text/file/timestamp
   *  and free numbers). Ordered by the schema's own choice order — so a bar
   *  chart keeps its bars in the same places between two reads. */
  buckets: FormResultBucket[] | null;
  /** Mean answer for scale/number questions. */
  average: number | null;
  /** Net promoter score for a `style: "nps"` scale: the share answering 9–10
   *  minus the share answering 0–6, as a whole number from -100 to 100. */
  nps: {
    promoters: number;
    passives: number;
    detractors: number;
    score: number;
  } | null;
}

export interface FormResults {
  formId: string;
  collection: string;
  /** Rows in the target collection right now — see the note above: not
   *  necessarily rows this form wrote. */
  rows: number;
  /** All-time accepted submissions through this form (the form's own counter,
   *  which survives rows being deleted). */
  submissionCount: number;
  /** Submissions this form refused (honeypot / Turnstile / rate limit). */
  blockedCount: number;
  lastSubmissionAt: unknown;
  blocks: FormResultBlock[];
  /** Exposed questions past {@link RESULT_BLOCK_CAP} that were not summarised,
   *  said out loud rather than silently dropped. */
  truncated: number;
}

/** How a field + block pair is summarised. */
const resultKind = (def: FieldDef, hasScale: boolean): FormResultKind => {
  if (hasScale) return "scale";
  if (getChoices(def).length > 0) return def.type === "json" ? "multi_choice" : "choice";
  switch (def.type) {
    case "boolean":
      return "boolean";
    case "integer":
    case "number":
      return "number";
    case "timestamp":
      return "timestamp";
    case "file":
      return "file";
    default:
      return "text";
  }
};

/**
 * Group labels come back as whatever the dialect stores, so they are folded to
 * one spelling here.
 *
 * The boolean case is the one that bites: SQLite keeps 0/1 in an INTEGER and
 * Postgres keeps `true`/`false`, so the same question answered the same way
 * produces four different bucket keys across the two. Folding depends on the
 * COLUMN and not on the value — `1` in a scale column is the answer one, and
 * turning it into `"true"` would silently move a fifth of an NPS histogram.
 */
const bucketKey = (raw: unknown, isBoolean: boolean): string | null => {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  const s = String(raw);
  if (!isBoolean) return s;
  return s === "1" || s === "true" || s === "t" ? "true" : "false";
};

const toCount = (raw: unknown): number => {
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Summarise one form's answers.
 *
 * Admin-gated at the route, so the aggregates run unrestricted (no permission
 * clamp) exactly as a dashboard panel does — the caller can already read the
 * collection outright.
 */
export const formResults = async (
  ctx: Ctx,
  auth: AuthSubject,
  tenantId: string,
  form: FormRow,
): Promise<FormResults> => {
  let collection;
  try {
    collection = await loadCollection(ctx, tenantId, form.collection);
  } catch {
    // The form outlived its collection. Say what is still true rather than
    // 404ing a form that plainly exists.
    throw new AppError(
      "NOT_FOUND",
      `Collection "${form.collection}" no longer exists, so this form has no results to read`,
    );
  }

  const agg = (config: Record<string, unknown>) =>
    runItemsAggregate(ctx, auth, tenantId, { collection: form.collection, ...config });

  const totalRows = await agg({ agg: "count" });
  const rows = toCount(totalRows[0]?.value);

  const exposed = exposedBlocks(form, collection).filter((e) => e.def);
  const blocks: FormResultBlock[] = [];
  for (const { block, def } of exposed.slice(0, RESULT_BLOCK_CAP)) {
    if (!def) continue;
    const scale = resolveScale(block, def);
    const kind = resultKind(def, Boolean(scale));
    const label = block.label || def.label || def.name;
    const base: FormResultBlock = {
      name: def.name,
      label,
      type: def.type,
      kind,
      answered: 0,
      buckets: null,
      average: null,
      nps: null,
    };

    if (kind === "choice" || kind === "boolean" || kind === "scale") {
      // One query. The buckets carry the answered count (everything but the
      // null bucket) and, for a scale, enough to compute the mean without a
      // second round-trip — the points are few and their counts are exact.
      const grouped = await agg({ agg: "count", groupBy: def.name, limit: BUCKET_LIMIT });
      const counts = new Map<string, number>();
      let answered = 0;
      for (const row of grouped) {
        const key = bucketKey(row.label, kind === "boolean");
        const n = toCount(row.value);
        if (key === null) continue;
        counts.set(key, (counts.get(key) ?? 0) + n);
        answered += n;
      }
      base.answered = answered;
      base.buckets = orderedBuckets(kind, def, scale, counts);
      if (kind === "scale") {
        let sum = 0;
        let seen = 0;
        for (const [key, n] of counts) {
          const v = Number(key);
          if (!Number.isFinite(v)) continue;
          sum += v * n;
          seen += n;
        }
        base.average = seen > 0 ? round2(sum / seen) : null;
        if (scale?.style === "nps") base.nps = npsOf(counts);
      }
    } else if (kind === "multi_choice") {
      // Two queries: the exploded per-choice counts, and how many rows
      // answered at all — which the exploded counts cannot tell you, because a
      // row that picked three choices is in three of them.
      const [grouped, answered] = await Promise.all([
        agg({ agg: "count", groupBy: def.name, limit: BUCKET_LIMIT }),
        agg({ agg: "count", filter: { [def.name]: { _null: false } } }),
      ]);
      const counts = new Map<string, number>();
      for (const row of grouped) {
        const key = bucketKey(row.label, false);
        if (key === null) continue;
        counts.set(key, (counts.get(key) ?? 0) + toCount(row.value));
      }
      base.answered = toCount(answered[0]?.value);
      base.buckets = orderedBuckets(kind, def, scale, counts);
    } else if (kind === "number") {
      const [answered, average] = await Promise.all([
        agg({ agg: "count", filter: { [def.name]: { _null: false } } }),
        agg({ agg: "avg", field: def.name }),
      ]);
      base.answered = toCount(answered[0]?.value);
      const mean = average[0]?.value;
      base.average = mean === null || mean === undefined ? null : round2(Number(mean));
    } else {
      // text / timestamp / file — how many answered, and nothing quoted.
      const answered = await agg({ agg: "count", filter: { [def.name]: { _null: false } } });
      base.answered = toCount(answered[0]?.value);
    }

    blocks.push(base);
  }

  return {
    formId: form.id,
    collection: form.collection,
    rows,
    submissionCount: form.submissionCount,
    blockedCount: form.blockedCount,
    lastSubmissionAt: form.lastSubmissionAt,
    blocks,
    truncated: Math.max(0, exposed.length - RESULT_BLOCK_CAP),
  };
};

/**
 * Put the buckets in the order the question offered them, not the order the
 * counts came back in.
 *
 * A chart whose bars reshuffle every time someone answers is unreadable, and
 * "no" sorting above "yes" because it is winning says nothing about the
 * question. Choices keep their schema order, a scale runs low to high, and a
 * value that is in the data but no longer in the schema is appended rather
 * than dropped — an answer given before the choices changed still happened.
 */
const orderedBuckets = (
  kind: FormResultKind,
  def: FieldDef,
  scale: { min: number; max: number } | null,
  counts: Map<string, number>,
): FormResultBucket[] => {
  const out: FormResultBucket[] = [];
  const taken = new Set<string>();
  const push = (value: string, label: string) => {
    taken.add(value);
    out.push({ value, label, count: counts.get(value) ?? 0 });
  };

  if (kind === "scale" && scale) {
    for (let v = scale.min; v <= scale.max; v++) push(String(v), String(v));
  } else if (kind === "boolean") {
    push("true", "true");
    push("false", "false");
  } else {
    for (const choice of getChoices(def)) push(choice.value, choice.label ?? choice.value);
  }

  for (const [value, count] of counts) {
    if (!taken.has(value)) out.push({ value, label: value, count });
  }
  return out;
};

/** Promoters (9–10) minus detractors (0–6), as whole percents of the answers
 *  actually given — the industry definition, so the number is comparable to
 *  one measured anywhere else. */
const npsOf = (counts: Map<string, number>): FormResultBlock["nps"] => {
  let promoters = 0;
  let passives = 0;
  let detractors = 0;
  for (const [key, n] of counts) {
    const v = Number(key);
    if (!Number.isFinite(v)) continue;
    if (v >= 9) promoters += n;
    else if (v >= 7) passives += n;
    else detractors += n;
  }
  const total = promoters + passives + detractors;
  const score = total > 0 ? Math.round(((promoters - detractors) / total) * 100) : 0;
  return { promoters, passives, detractors, score };
};

const round2 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
