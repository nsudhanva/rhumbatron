import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Tier to Anthropic Claude model mapping (ADR 0021). Every tier on every environment calls
 * Anthropic through the AI Gateway. Opus is off unless the `ALLOW_OPUS` binding is "true": the opus
 * tier then runs on Sonnet, and the downgrade is recorded in the Decision Receipt.
 */
export const TIER_MODELS: Record<ModelTier, string> = {
  haiku: "claude-haiku-5-5",
  sonnet: "claude-sonnet-5-5",
  opus: "claude-opus-5-5",
};

/** Adaptive thinking effort per tier. Thinking tokens bill as output and count toward max_tokens. */
export const TIER_REASONING_EFFORT: Record<ModelTier, "low" | "medium" | "high"> = {
  haiku: "low",
  sonnet: "medium",
  opus: "high",
};

/** `ALLOW_OPUS` binding: only the exact string "true" enables Opus. */
export const opusAllowed = (flag?: string): boolean => flag === "true";

export type TierResolution = {
  /** The tier that runs. */
  tier: ModelTier;
  model: string;
  /** Set when the requested tier was lowered; the receipt records it. */
  downgradedFrom?: ModelTier;
  downgradeReason?: "opus_disabled";
};

/** The tier and model that run for a requested tier. Opus becomes Sonnet while Opus is off. */
export function resolveTier(requested: ModelTier, allowOpus: boolean): TierResolution {
  if (requested === "opus" && !allowOpus) {
    return {
      tier: "sonnet",
      model: TIER_MODELS.sonnet,
      downgradedFrom: "opus",
      downgradeReason: "opus_disabled",
    };
  }
  return { tier: requested, model: TIER_MODELS[requested] };
}

/**
 * USD per million tokens (Anthropic pricing 2026-10). Cache writes: 1.25x
 * input for the 5-minute TTL, 2x for the 1-hour TTL. Haiku 5.5 bills a higher rate on every token
 * of a request whose prompt (input + cache read + cache write) is above 100K tokens.
 */
export type AnthropicPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  longPrompt?: {
    aboveTokens: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite5m: number;
    cacheWrite1h: number;
  };
};

export const ANTHROPIC_PRICES: Record<string, AnthropicPrice> = {
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    longPrompt: {
      aboveTokens: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite5m: 0.625,
      cacheWrite1h: 1,
    },
  },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
  },
  "claude-opus-5-5": {
    input: 4,
    output: 20,
    cacheRead: 0.4,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
  },
};
