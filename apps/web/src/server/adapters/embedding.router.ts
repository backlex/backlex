import { AppError } from "@backlex/core";
import type { EmbeddingAdapter } from "@backlex/core/adapters";
import { getEmbeddingModel, type EmbeddingModel } from "@backlex/core";

/**
 * Combines per-provider embedding adapters into a single adapter that picks
 * the right one based on the model's registered provider. Models that have
 * no configured provider fail loudly instead of silently falling through.
 */
export const embeddingRouter = (providers: {
  "workers-ai"?: EmbeddingAdapter;
  openai?: EmbeddingAdapter;
  "self-host"?: EmbeddingAdapter;
}): EmbeddingAdapter => ({
  async embed(req) {
    const def = getEmbeddingModel(req.model);
    const adapter = providers[def.provider];
    if (!adapter) {
      throw new AppError(
        "INTERNAL",
        `Embedding provider '${def.provider}' is not configured. ` +
          (def.provider === "workers-ai"
            ? "Bind [ai] in wrangler.toml."
            : def.provider === "openai"
              ? "Set OPENAI_API_KEY."
              : "Set EMBEDDING_HTTP_URL to your container endpoint."),
      );
    }
    return adapter.embed(req);
  },
});

export const noEmbeddingAdapter = (): EmbeddingAdapter => ({
  async embed(req): Promise<never> {
    const _model: EmbeddingModel = req.model;
    throw new AppError(
      "INTERNAL",
      `No embedding provider configured (requested model '${_model}'). ` +
        "Bind [ai] (Workers AI) and/or set OPENAI_API_KEY.",
    );
  },
});
