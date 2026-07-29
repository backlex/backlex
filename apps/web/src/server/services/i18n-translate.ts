import { AppError } from "@backlex/core";
import { callClaude } from "../mcp/ai-client";
import type { Env } from "../env";

/**
 * Auto-translate a batch of source strings into a target locale.
 *
 * Generation goes through the shared `callClaude` path, which means
 * auto-translate now runs on whatever the workspace configured in Settings · AI
 * — AI Gateway, Anthropic, OpenAI or Gemini — instead of the direct-Anthropic
 * HTTP call it used to hard-code. That call predated the AI SDK being in the
 * bundle at all; keeping it meant a gateway-only or OpenAI-only workspace got a
 * "set an Anthropic key" error for a feature its key could perfectly well run.
 *
 * Returns one entry per input the model actually translated, in input order.
 * Slots the model omitted (or answered with an empty string) are DROPPED, not
 * filled with the source value — writing the source text into the target
 * locale would create a row that `onlyMissing` then treats as done, silently
 * pinning the untranslated string forever. Dropped keys stay missing and get
 * retried on the next run.
 */
export const autoTranslateBatch = async (params: {
  /** Env with the workspace's resolved AI credential already overlaid
   *  (`resolveAiRuntime().env`). */
  env: Env;
  sourceLocale: string;
  targetLocale: string;
  items: { key: string; value: string }[];
  /** Model id from the shared config path. Undefined → the provider registry's
   *  default; translation is a cheap-tier job, so that default is the right
   *  one unless an operator deliberately chose otherwise. */
  model?: string;
}): Promise<{ key: string; value: string }[]> => {
  const { env, sourceLocale, targetLocale, items, model } = params;
  if (items.length === 0) return [];

  // Encode as a numbered list so the model can return a JSON object keyed by
  // the same index. We avoid sending the original i18n key (which might leak
  // implementation details and isn't useful for translation context).
  const numbered = items
    .map((it, i) => `${i + 1}. ${JSON.stringify(it.value)}`)
    .join("\n");

  const system = [
    `You are translating UI strings for a SaaS admin app from ${sourceLocale} to ${targetLocale}.`,
    "Rules:",
    "- Preserve placeholders like {name}, {{count}}, %s, $1, <b>…</b> exactly.",
    "- Keep leading/trailing whitespace and punctuation.",
    "- Match register: terse UI strings stay terse; sentences stay sentences.",
    "- If the source is a single English technical term that's commonly left untranslated in the target language (e.g. \"OAuth\", \"API\"), keep it.",
    `Return ONLY a JSON object of the form {"1": "…translation…", "2": "…"} with one entry per numbered input. No prose, no fences.`,
  ].join("\n");

  const user = `Translate these ${items.length} strings:\n${numbered}`;

  const reply = await callClaude(env, {
    system,
    user,
    model,
    maxTokens: Math.min(4096, 256 + items.length * 128),
  });
  const text = reply.text.trim();

  // The model is asked for raw JSON, but tolerate fenced code just in case.
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError(
      "INTERNAL",
      `Translator returned malformed JSON: ${text.slice(0, 200)}`,
    );
  }
  // Valid JSON that isn't a plain object ({"1": …}) is just as malformed —
  // without this guard `null`/arrays fall through to a raw TypeError below.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError(
      "INTERNAL",
      `Translator returned malformed JSON: ${text.slice(0, 200)}`,
    );
  }
  const byIndex = parsed as Record<string, unknown>;

  const out: { key: string; value: string }[] = [];
  for (const [i, it] of items.entries()) {
    const v = byIndex[String(i + 1)];
    if (typeof v === "string" && v.length > 0) {
      out.push({ key: it.key, value: v });
    }
  }
  return out;
};
