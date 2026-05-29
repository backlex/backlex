import { AppError } from "@backlex/core";

/**
 * Auto-translate a batch of source strings into a target locale using the
 * Anthropic Messages API. We hit the HTTP endpoint directly so the Workers
 * runtime doesn't need an SDK dependency.
 *
 * Returns the translations in the same order as the input. If the model
 * returns an object that doesn't parse or doesn't cover every key, the
 * missing slots are filled with the source value as a fallback (caller
 * decides whether to upsert that — typically you'd skip identical rows).
 */
export const autoTranslateBatch = async (params: {
  apiKey: string;
  sourceLocale: string;
  targetLocale: string;
  items: { key: string; value: string }[];
  /** Override the default Claude model. Haiku is fine for translation; opus
   *  is overkill but available for tricky tonal work. */
  model?: string;
}): Promise<{ key: string; value: string }[]> => {
  const { apiKey, sourceLocale, targetLocale, items } = params;
  if (items.length === 0) return [];

  const model = params.model ?? "claude-haiku-4-5-20251001";

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

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: Math.min(4096, 256 + items.length * 128),
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AppError(
      "INTERNAL",
      `Anthropic API error (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const body = (await res.json()) as {
    content?: { type: string; text?: string }[];
  };
  const text =
    body.content?.find((b) => b.type === "text")?.text?.trim() ?? "";

  // The model is asked for raw JSON, but tolerate fenced code just in case.
  const json = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError(
      "INTERNAL",
      `Translator returned malformed JSON: ${text.slice(0, 200)}`,
    );
  }

  return items.map((it, i) => {
    const v = parsed[String(i + 1)];
    return {
      key: it.key,
      value: typeof v === "string" && v.length > 0 ? v : it.value,
    };
  });
};
