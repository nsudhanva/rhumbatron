import { ANTHROPIC_PRICES, type AnthropicPrice } from "./models.ts";

/**
 * The model provider (ADR 0021): Anthropic Claude through the AI Gateway on every environment.
 * OpenRouter and Gemini on Vertex AI (ADR 0007, ADR 0016) are removed; old Decision Receipts can
 * still name them. Pure logic only: callers read and write the `usage_counters` rows.
 */

export type ModelProvider = "anthropic";

/** `usage_counters.counter` keys. */
export const USAGE_COUNTER = {
  /** Agent model calls per UTC day (`day` = YYYY-MM-DD); capped by AGENT_DAILY_CALL_CAP. */
  agentCalls: "agent-model-calls",
  /**
   * Anthropic spend per calendar month in micro-USD (`day` = YYYY-MM); capped by the
   * `ANTHROPIC_MONTHLY_BUDGET_USD` binding (spend-meter.ts).
   */
  anthropicSpend: "anthropic-usd-micro",
} as const;

/** Token counts of one Messages API response (`usage`). */
export type AnthropicUsage = {
  /** Uncached input tokens (`input_tokens`). */
  inputTokens: number;
  /** Output tokens, thinking included (`output_tokens`). */
  outputTokens: number;
  /** `cache_read_input_tokens`. */
  cacheReadTokens: number;
  /** `cache_creation_input_tokens`: all cache writes, both TTLs. */
  cacheWriteTokens: number;
  /** The 1-hour TTL part of `cacheWriteTokens` (`cache_creation.ephemeral_1h_input_tokens`). */
  cacheWrite1hTokens?: number;
};

/** The highest known rate of each field: an unpriced model never costs $0. */
function highestPrice(): AnthropicPrice {
  const all = Object.values(ANTHROPIC_PRICES).flatMap((p) => [
    p,
    ...(p.longPrompt ? [p.longPrompt] : []),
  ]);
  return {
    input: Math.max(...all.map((p) => p.input)),
    output: Math.max(...all.map((p) => p.output)),
    cacheRead: Math.max(...all.map((p) => p.cacheRead)),
    cacheWrite5m: Math.max(...all.map((p) => p.cacheWrite5m)),
    cacheWrite1h: Math.max(...all.map((p) => p.cacheWrite1h)),
  };
}

/** USD per million tokens for a model and prompt size. An unknown model gets the highest rates. */
export function anthropicPrice(
  model: string,
  promptTokens = 0,
): Omit<AnthropicPrice, "longPrompt"> {
  const known = ANTHROPIC_PRICES[model.replace(/^anthropic\//, "")];
  if (!known) return highestPrice();
  if (known.longPrompt && promptTokens > known.longPrompt.aboveTokens) return known.longPrompt;
  return known;
}

/** Exact cost of one call from its usage fields, cache reads and writes included. */
export function anthropicCostUsd(model: string, usage: AnthropicUsage): number {
  const write1h = Math.min(usage.cacheWrite1hTokens ?? 0, usage.cacheWriteTokens);
  const write5m = usage.cacheWriteTokens - write1h;
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const price = anthropicPrice(model, prompt);
  return (
    (usage.inputTokens * price.input +
      usage.outputTokens * price.output +
      usage.cacheReadTokens * price.cacheRead +
      write5m * price.cacheWrite5m +
      write1h * price.cacheWrite1h) /
    1_000_000
  );
}

export type ProviderFailureKind =
  | "spend_limited"
  | "rate_limited"
  | "timeout"
  | "transient"
  | "auth"
  | "invalid_request";

/**
 * Classifies a failed Anthropic or AI Gateway response. `status` is null for a network failure.
 * - Anthropic's own 429 (`rate_limit_error`) and the gateway request rate limit retry.
 * - Any other 429 is the gateway spend limit, which documents only the status: stop, never retry.
 * - A 400 for a too-low credit balance is a billing stop too, never a retry.
 * - 529 (`overloaded_error`) and 5xx are transient.
 */
export function classifyProviderFailure(status: number | null, body: string): ProviderFailureKind {
  const text = body.toLowerCase();
  if (status === null) return "transient";
  if (status === 429 || status === 402) {
    if (/spend|budget|cost limit/.test(text)) return "spend_limited";
    if (/rate_limit_error|rate.?limit/.test(text)) return "rate_limited";
    return "spend_limited";
  }
  if (status === 400 && /credit balance|billing/.test(text)) return "spend_limited";
  if (status === 408) return "timeout";
  if (status >= 500) return "transient";
  if (status === 401 || status === 403) return "auth";
  return "invalid_request";
}
