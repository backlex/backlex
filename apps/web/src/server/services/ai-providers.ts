/**
 * AI provider registry + model catalog.
 *
 * This is the single source of truth for "which AI providers can a workspace
 * pick, what credential does each need, and which models can it run". It
 * replaced a hard-coded `"gateway" | "anthropic"` union that was duplicated
 * across the config service, the route, and the admin settings card — adding a
 * provider used to mean editing four files and remembering a fifth.
 *
 * Two axes matter and they are deliberately separate:
 *
 *  - **transport** — `gateway` means one Vercel AI Gateway key reaches every
 *    upstream vendor (Anthropic / OpenAI / Google / Mistral / Groq / …) using
 *    provider-prefixed model ids. `direct` means the vendor's own API with the
 *    vendor's own key, one namespace only.
 *  - **namespace** — the vendor prefix in a model id (`anthropic/…`). Models are
 *    ALWAYS stored gateway-style (prefixed); `mcp/ai-client.ts::resolveModelId`
 *    strips the prefix when the call goes out over a direct provider. Storing
 *    one canonical id shape is what lets a workspace flip gateway ↔ direct
 *    without its saved model becoming garbage.
 */

/** Env vars that can hold a generation credential. */
export type AiEnvKey =
  | "AI_GATEWAY_API_KEY"
  | "ANTHROPIC_API_KEY"
  | "OPENAI_API_KEY"
  | "GOOGLE_GENERATIVE_AI_API_KEY";

/** Providers a workspace can bring its own key for. `inherit` is NOT here — it
 *  is the absence of a pick, handled separately by the config service. */
export type AiProviderId = "gateway" | "anthropic" | "openai" | "google";

export interface AiProviderDef {
  id: AiProviderId;
  label: string;
  /** Key inside `ai_config.secrets` holding this provider's encrypted BYO key. */
  secretKey: string;
  /** Field label the admin picker puts above that secret's input. */
  secretLabel: string;
  /** Deployment env var holding the same credential. */
  envKey: AiEnvKey;
  transport: "gateway" | "direct";
  /** Vendor namespace this provider talks to. The gateway reaches every
   *  namespace, so its value is only the fallback for a bare (unprefixed) id —
   *  which is `anthropic` for back-compat with settings saved before the
   *  catalog existed. */
  namespace: string;
  /** Canonical (prefixed) model used when neither the caller nor the stored
   *  config names one. */
  defaultModel: string;
  /** Bare id to send when calling this vendor's API directly and nothing is
   *  configured. Defaults to `defaultModel` minus the namespace; Anthropic
   *  overrides it with the dated id its direct API has always been given, so
   *  introducing the registry can't change which model an existing
   *  `ANTHROPIC_API_KEY` deployment actually calls. */
  directDefaultModel?: string;
  /** One-line explanation shown under the provider picker. */
  hint: string;
  docsUrl: string;
}

/**
 * Order matters: it is the order the admin picker renders, and `gateway` leads
 * because one key reaching every vendor is the recommendation.
 */
export const AI_PROVIDERS: readonly AiProviderDef[] = [
  {
    id: "gateway",
    label: "Vercel AI Gateway (multi-provider)",
    secretKey: "gatewayKey",
    secretLabel: "AI Gateway API key",
    envKey: "AI_GATEWAY_API_KEY",
    transport: "gateway",
    namespace: "anthropic",
    defaultModel: "anthropic/claude-haiku-4-5",
    hint: "One key reaches Anthropic / OpenAI / Google / Mistral / Groq. Recommended — you can switch models without reissuing credentials.",
    docsUrl: "https://vercel.com/docs/ai-gateway",
  },
  {
    id: "anthropic",
    label: "Anthropic (direct)",
    secretKey: "anthropicKey",
    secretLabel: "Anthropic API key",
    envKey: "ANTHROPIC_API_KEY",
    transport: "direct",
    namespace: "anthropic",
    defaultModel: "anthropic/claude-haiku-4-5",
    directDefaultModel: "claude-haiku-4-5-20251001",
    hint: "A direct Anthropic API key. Claude models only.",
    docsUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    label: "OpenAI (direct)",
    secretKey: "openaiKey",
    secretLabel: "OpenAI API key",
    envKey: "OPENAI_API_KEY",
    transport: "direct",
    namespace: "openai",
    defaultModel: "openai/gpt-5.6-terra",
    hint: "A direct OpenAI API key. GPT models only.",
    docsUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google",
    label: "Google Gemini (direct)",
    secretKey: "googleKey",
    secretLabel: "Google AI Studio API key",
    envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
    transport: "direct",
    namespace: "google",
    defaultModel: "google/gemini-3.7-flash",
    hint: "A direct Google AI Studio key. Gemini models only.",
    docsUrl: "https://aistudio.google.com/apikey",
  },
] as const;

/** Secret keys recognised across every provider, in registry order. */
export const AI_SECRET_KEYS = AI_PROVIDERS.map((p) => p.secretKey) as readonly string[];

/** Every value the stored `provider` column may legitimately hold. */
export const AI_PROVIDER_IDS: readonly string[] = [
  "inherit",
  ...AI_PROVIDERS.map((p) => p.id),
];

const BY_ID = new Map<string, AiProviderDef>(AI_PROVIDERS.map((p) => [p.id, p]));

/** Look a provider up by its stored id. Returns `undefined` for `inherit`, for
 *  an empty column, and for a provider id written by a NEWER build than the one
 *  reading it — every caller must treat that as "fall back", never as a throw. */
export const getAiProvider = (id: string | null | undefined): AiProviderDef | undefined =>
  id ? BY_ID.get(id) : undefined;

/** Is `key` one of the registry's secret keys? Guards the PUT merge loop so a
 *  client can't write arbitrary keys into the secrets blob. */
export const isAiSecretKey = (key: string): boolean =>
  AI_PROVIDERS.some((p) => p.secretKey === key);

// ---------------------------------------------------------------------------
// Model catalog
// ---------------------------------------------------------------------------

/** Cost/speed tier. Used to sort the picker and to colour the hint. */
export type AiModelTier = "flagship" | "balanced" | "fast";

export interface AiModelDef {
  /** Canonical, gateway-style (provider-prefixed) id — what gets stored. */
  id: string;
  label: string;
  /** Vendor namespace (the part before the `/`). */
  namespace: string;
  /** One line on where this model sits on the cost/speed curve. */
  hint: string;
  tier: AiModelTier;
}

/**
 * Selectable models, grouped by vendor namespace. Not exhaustive and not meant
 * to be: it is the curated shortlist an operator actually picks between. Every
 * surface keeps a free-text escape hatch, so an id missing here is a UI
 * inconvenience, never a hard block — `callClaude` passes whatever it is given
 * straight through to the provider.
 *
 * Every id here must be a real Vercel AI Gateway slug (`GET
 * https://ai-gateway.vercel.sh/v1/models`, no auth needed) AND, for the three
 * namespaces a `direct` provider covers, still resolve after the prefix is
 * stripped — `anthropic/claude-opus-5` has to be a valid bare id on
 * api.anthropic.com too, or a workspace flipping gateway → direct breaks. That
 * double constraint is why the Anthropic ids are written with hyphens
 * (`claude-haiku-4-5`) even though the gateway's canonical spelling uses dots:
 * the hyphen form is an accepted gateway alias, and it is the ONLY form the
 * direct API takes. The `mistral` / `meta` entries are gateway-only — no direct
 * provider claims those namespaces, so nothing strips their prefix.
 */
export const AI_MODELS: readonly AiModelDef[] = [
  {
    id: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    namespace: "anthropic",
    hint: "Most capable · slowest and priciest",
    tier: "flagship",
  },
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    namespace: "anthropic",
    hint: "Balanced · the default for multi-step agents",
    tier: "balanced",
  },
  {
    id: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    namespace: "anthropic",
    hint: "Fast and cheap · short, scoped tasks",
    tier: "fast",
  },
  {
    id: "openai/gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    namespace: "openai",
    hint: "Most capable OpenAI model · priciest",
    tier: "flagship",
  },
  {
    id: "openai/gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    namespace: "openai",
    hint: "Balanced · good default for OpenAI",
    tier: "balanced",
  },
  {
    id: "openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    namespace: "openai",
    hint: "Cheapest and fastest · classification, extraction",
    tier: "fast",
  },
  {
    // The Pro line currently ships only under a `-preview` id: Google retired
    // `gemini-3-pro-preview` in favour of this one rather than promoting it to
    // an unsuffixed slug, so the suffix is the model's real name here, not a
    // pre-release we forgot to update.
    id: "google/gemini-3.1-pro-preview",
    label: "Gemini 3.1 Pro",
    namespace: "google",
    hint: "Most capable Gemini · long context",
    tier: "flagship",
  },
  {
    id: "google/gemini-3.7-flash",
    label: "Gemini 3.7 Flash",
    namespace: "google",
    hint: "Balanced · very large context per lira",
    tier: "balanced",
  },
  {
    id: "google/gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash Lite",
    namespace: "google",
    hint: "Cheapest and fastest Gemini",
    tier: "fast",
  },
  {
    id: "mistral/mistral-large-3",
    label: "Mistral Large 3",
    namespace: "mistral",
    hint: "EU-hosted flagship · gateway only",
    tier: "flagship",
  },
  {
    // Was `groq/llama-3.3-70b-versatile`, which never resolved: the gateway
    // namespaces by model CREATOR, not by the inference provider serving it, so
    // there is no `groq/*` slug at all. Llama lives under `meta/`.
    id: "meta/llama-4-maverick",
    label: "Llama 4 Maverick",
    namespace: "meta",
    hint: "Open weights · cheap · gateway only",
    tier: "fast",
  },
] as const;

/**
 * Models a given provider can actually run.
 *
 *  - a `gateway` provider reaches every namespace → the whole catalog
 *  - a `direct` provider is limited to its own namespace
 *  - `inherit` (or an unknown id) shows the whole catalog, because the
 *    deployment default could be any of them and hiding options there would be
 *    a lie
 */
export const modelsForProvider = (providerId: string | null | undefined): AiModelDef[] => {
  const def = getAiProvider(providerId);
  if (!def || def.transport === "gateway") return [...AI_MODELS];
  return AI_MODELS.filter((m) => m.namespace === def.namespace);
};

/** The default model for a provider id, falling back to the gateway default so
 *  an unknown/absent provider still resolves to something runnable. */
export const defaultModelFor = (providerId: string | null | undefined): string =>
  getAiProvider(providerId)?.defaultModel ?? "anthropic/claude-haiku-4-5";
