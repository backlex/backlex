import { AppError } from "@workeros/core";
import type { EmbeddingAdapter } from "@workeros/core/adapters";
import { getEmbeddingModel } from "@workeros/core";

interface OpenAiCompatResponse {
  data: { embedding: number[]; index: number }[];
}

/**
 * Embeddings against a self-hosted server (HuggingFace TEI, Ollama, vLLM,
 * LiteLLM — anything that speaks OpenAI's `/v1/embeddings`). Text never
 * leaves the user's infrastructure.
 *
 * `baseUrl` is the container's root (no trailing slash) — the adapter
 * appends `/v1/embeddings`. `token` is sent as `Authorization: Bearer ...`
 * when present; leave empty for un-authed containers on a private network.
 *
 * For a TEI container running `--model-id BAAI/bge-m3` on port 8080:
 *   EMBEDDING_HTTP_URL = "https://embed.internal.example.com"
 */
export const selfHostEmbeddingAdapter = (cfg: {
  baseUrl: string;
  token?: string;
}): EmbeddingAdapter => ({
  async embed({ model, texts }) {
    if (texts.length === 0) return { values: [], model };
    const def = getEmbeddingModel(model);
    if (def.provider !== "self-host") {
      throw new AppError(
        "VALIDATION",
        `Model '${model}' is not a self-host model`,
      );
    }
    const url = `${cfg.baseUrl.replace(/\/$/, "")}/v1/embeddings`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: def.providerModel, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new AppError(
        "INTERNAL",
        `Self-host embeddings ${res.status} at ${url}: ${body.slice(0, 500)}`,
      );
    }
    const json = (await res.json()) as OpenAiCompatResponse;
    if (!json.data || json.data.length !== texts.length) {
      throw new AppError(
        "INTERNAL",
        `Self-host endpoint returned ${json.data?.length ?? 0} embeddings for ${texts.length} inputs`,
      );
    }
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    const values = sorted.map((d) => d.embedding);
    for (const v of values) {
      if (v.length !== def.dimensions) {
        throw new AppError(
          "INTERNAL",
          `Self-host '${def.providerModel}' returned dim ${v.length}, expected ${def.dimensions}. ` +
            "The container is serving a different model than the registry expects.",
        );
      }
    }
    return { values, model };
  },
});
