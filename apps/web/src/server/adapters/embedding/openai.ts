import { AppError } from "@backlex/core";
import type { EmbeddingAdapter } from "@backlex/core/adapters";
import { getEmbeddingModel } from "@backlex/core";

interface OpenAiEmbedResponse {
  data: { embedding: number[]; index: number }[];
}

export const openaiEmbeddingAdapter = (apiKey: string): EmbeddingAdapter => ({
  async embed({ model, texts }) {
    if (texts.length === 0) return { values: [], model };
    const def = getEmbeddingModel(model);
    if (def.provider !== "openai") {
      throw new AppError(
        "VALIDATION",
        `Model '${model}' is not an OpenAI model`,
      );
    }
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: def.providerModel,
        input: texts,
        dimensions: def.dimensions,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AppError(
        "INTERNAL",
        `OpenAI embeddings ${res.status}: ${body.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as OpenAiEmbedResponse;
    if (!json.data || json.data.length !== texts.length) {
      throw new AppError(
        "INTERNAL",
        `OpenAI returned ${json.data?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }
    // OpenAI guarantees `index` matches the input order, but sort defensively.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const values = sorted.map((d) => d.embedding);
    return { values, model };
  },
});
