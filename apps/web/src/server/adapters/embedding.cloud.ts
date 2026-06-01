import {
  AppError,
  getEmbeddingModel,
  type EmbeddingAdapter,
  type EmbedRequest,
  type EmbedResult,
} from "@backlex/core";
import type { Env } from "../env";
import { cloudPost } from "../lib/cloud-report";

/**
 * Managed-cloud embedding adapter. On a provisioned cloud project the customer
 * doesn't bring their own AI key, so Workers-AI embeddings must run on the
 * platform's account — metered and hard-capped per plan. Instead of calling the
 * tenant's own `env.AI` (which would be unmetered/uncapped), this posts to the
 * control-plane gateway (`/api/internal/ai/embed`, HMAC-signed via
 * `cloud-report`), which runs the model and bills neurons against the org's
 * budget. A 402 surfaces as a quota AppError.
 */
export function cloudEmbeddingAdapter(env: Env): EmbeddingAdapter {
  return {
    async embed({ model, texts, intent }: EmbedRequest): Promise<EmbedResult> {
      const def = getEmbeddingModel(model);
      let res: Response;
      try {
        res = await cloudPost(env, "/api/internal/ai/embed", { model: def.providerModel, texts, intent });
      } catch (e) {
        throw new AppError("INTERNAL", `Cloud embedding gateway unreachable: ${e instanceof Error ? e.message : "error"}`);
      }
      if (!res.ok) {
        let message = `Cloud embedding gateway returned ${res.status}`;
        try {
          const j = (await res.json()) as { error?: { message?: string } };
          if (j?.error?.message) message = j.error.message;
        } catch {
          // keep the status-based message
        }
        // 402 = monthly AI budget exhausted; map to a quota error either way.
        throw new AppError(res.status === 402 ? "VALIDATION" : "INTERNAL", message);
      }
      const json = (await res.json()) as { data?: number[][] };
      const values = json.data ?? [];
      if (values.length !== texts.length) {
        throw new AppError("INTERNAL", `Cloud embedding returned ${values.length} vectors for ${texts.length} inputs`);
      }
      for (const v of values) {
        if (v.length !== def.dimensions) {
          throw new AppError(
            "INTERNAL",
            `Cloud embedding for '${model}' returned ${v.length} dimensions, expected ${def.dimensions}`,
          );
        }
      }
      return { values, model };
    },
  };
}
