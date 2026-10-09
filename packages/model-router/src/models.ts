import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Tier to OpenRouter model mapping (ADR 0007). Only `:free` variants, so model spend is $0.
 * OpenRouter tries each list in order when a model is rate-limited or down (at most 3 entries).
 * Re-check https://openrouter.ai/collections/free-models before changing; the free roster moves.
 */
export const TIER_MODELS: Record<ModelTier, readonly string[]> = {
  haiku: [
    "poolside/laguna-xs-2.1:free",
    "nvidia/nemotron-3.5-lightning:free",
    "cohere/north-mini-code:free",
  ],
  sonnet: [
    "poolside/laguna-s-2.1:free",
    "cohere/north-mini-code:free",
    "nvidia/nemotron-3-super-120b-a12b:free",
  ],
  opus: ["nvidia/nemotron-3-ultra-550b-a55b:free", "poolside/laguna-s-2.1:free"],
};

/** Reasoning tokens count toward max_tokens on these models, so effort scales with tier. */
export const TIER_REASONING_EFFORT: Record<ModelTier, "low" | "medium" | "high"> = {
  haiku: "low",
  sonnet: "medium",
  opus: "high",
};
