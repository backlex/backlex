import { AppError } from "@workeros/core";
import type { EmbeddingAdapter } from "@workeros/core/adapters";
import { getEmbeddingModel } from "@workeros/core";

/** Cloudflare Workers AI binding shape — `env.AI.run(model, input)`. */
interface WorkersAi {
  run(
    model: string,
    input: { text: string | string[] },
  ): Promise<{ data?: number[][]; shape?: number[] }>;
}

export const workersAiEmbeddingAdapter = (ai: WorkersAi): EmbeddingAdapter => ({
  async embed({ model, texts }) {
    if (texts.length === 0) return { values: [], model };
    const def = getEmbeddingModel(model);
    if (def.provider !== "workers-ai") {
      throw new AppError(
        "VALIDATION",
        `Model '${model}' is not a workers-ai model`,
      );
    }
    const res = await ai.run(def.providerModel, { text: texts });
    const values = res.data;
    if (!values || values.length !== texts.length) {
      throw new AppError(
        "INTERNAL",
        `Workers AI returned ${values?.length ?? 0} vectors for ${texts.length} inputs`,
      );
    }
    for (const v of values) {
      if (v.length !== def.dimensions) {
        throw new AppError(
          "INTERNAL",
          `Workers AI '${def.providerModel}' returned dim ${v.length}, expected ${def.dimensions}`,
        );
      }
    }
    return { values, model };
  },
});
