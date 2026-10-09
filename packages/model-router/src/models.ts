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

/**
 * Paid backup on Vertex AI (GCP credits), used only when every free model in the tier fails with a
 * rate limit, outage, or timeout. The gateway caps Vertex spend at $9 per 30 days (Terraform).
 */
export const TIER_VERTEX_MODEL: Record<ModelTier, string> = {
  haiku: "google/gemini-3.5-flash-lite",
  sonnet: "google/gemini-3.8-flash",
  opus: "google/gemini-3.8-flash",
};

/** USD per million tokens. Output includes reasoning tokens. Matches the gateway's cost estimate. */
export const VERTEX_PRICES: Record<string, { input: number; output: number }> = {
  "google/gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "google/gemini-3.5-flash-lite": { input: 0.3, output: 2.5 },
};
