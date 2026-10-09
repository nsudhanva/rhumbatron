import { OPENROUTER_DAILY_CALL_CAP } from "./budget.ts";
import { VERTEX_PRICES } from "./models.ts";

/**
 * Provider choice for agent runs (ADR 0016). OpenRouter free models first; Gemini on Vertex AI is
 * the paid overflow once OpenRouter is used up for the UTC day. The AI Gateway spend limit
 * (per environment on `google-vertex-ai`, Terraform `modules/ai`, ADR 0017) is the hard money ceiling.
 * Pure logic only: callers read and write the `usage_counters` rows.
 */

export type ModelProvider = "openrouter" | "google-vertex-ai";

/** `usage_counters.counter` keys, one row per UTC day. */
export const USAGE_COUNTER = {
  /** Agent model calls on every provider; capped by AGENT_DAILY_CALL_CAP. */
  agentCalls: "agent-model-calls",
  /** Agent model calls sent to OpenRouter; capped by OPENROUTER_DAILY_CALL_CAP. */
  openrouterCalls: "openrouter-calls",
  /** Present when OpenRouter returned a rate limit or quota error today. */
  openrouterExhausted: "openrouter-exhausted",
  /** Present when the gateway rejected a Vertex call for its spend limit today. */
  vertexSpendLimited: "vertex-spend-limited",
} as const;

export type ProviderState = {
  openrouterCallsToday: number;
  openrouterExhaustedToday: boolean;
  vertexSpendLimitedToday: boolean;
  /** The Worker has a Vertex credential. */
  vertexConfigured: boolean;
  /** Operator setting `MODEL_PROVIDER=vertex`: use Gemini from the first call. */
  preferVertex?: boolean;
};

export type ProviderChoice =
  | { provider: ModelProvider; reason: string }
  /** Nothing can run: OpenRouter is used up and the Vertex spend cap was reached. */
  | { provider: null; reason: "vertex_spend_limit" };

export function selectProvider(state: ProviderState): ProviderChoice {
  if (state.preferVertex && state.vertexConfigured) {
    if (state.vertexSpendLimitedToday) return { provider: null, reason: "vertex_spend_limit" };
    return { provider: "google-vertex-ai", reason: "vertex_preferred" };
  }
  const exhausted =
    state.openrouterExhaustedToday || state.openrouterCallsToday >= OPENROUTER_DAILY_CALL_CAP;
  if (!exhausted) return { provider: "openrouter", reason: "openrouter_free" };
  if (!state.vertexConfigured) return { provider: "openrouter", reason: "vertex_not_configured" };
  if (state.vertexSpendLimitedToday) return { provider: null, reason: "vertex_spend_limit" };
  return {
    provider: "google-vertex-ai",
    reason: state.openrouterExhaustedToday
      ? "openrouter_rate_limited_today"
      : "openrouter_daily_cap",
  };
}

/** USD per million tokens. An unpriced model gets the highest known rate, never $0. */
export function vertexPrice(model: string): { input: number; output: number } {
  const id = model.replace(/^google-vertex-ai\//, "");
  const known = VERTEX_PRICES[id];
  if (known) return known;
  const fallback = { input: 0, output: 0 };
  for (const p of Object.values(VERTEX_PRICES)) {
    fallback.input = Math.max(fallback.input, p.input);
    fallback.output = Math.max(fallback.output, p.output);
  }
  return fallback;
}

/** Vertex reports no cost. Output tokens include reasoning tokens. */
export function vertexCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = vertexPrice(model);
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

export type ProviderFailureKind =
  | "spend_limited"
  | "rate_limited"
  | "timeout"
  | "transient"
  | "auth"
  | "invalid_request";

/**
 * Classifies a failed provider response. `status` is null for a network failure.
 * A Vertex 429 that is not Google's own RESOURCE_EXHAUSTED and not the gateway request rate limit
 * is the gateway spend limit: the gateway documents only the 429 status, not the body. Stopping
 * on an unknown 429 is the safe side; a spend stop never retries.
 */
export function classifyProviderFailure(
  provider: ModelProvider,
  status: number | null,
  body: string,
): { kind: ProviderFailureKind; openrouterExhausted: boolean } {
  const text = body.toLowerCase();
  if (provider === "google-vertex-ai" && (status === 429 || status === 402)) {
    const spend = /spend|budget|cost limit/.test(text);
    const upstream = /resource.?exhausted|rate.?limit/.test(text);
    if (spend || !upstream) return { kind: "spend_limited", openrouterExhausted: false };
    return { kind: "rate_limited", openrouterExhausted: false };
  }
  const openrouterQuota =
    provider === "openrouter" &&
    (status === 429 || /rate.?limit|quota|free-models-per-day|too many requests/.test(text));
  if (openrouterQuota) return { kind: "rate_limited", openrouterExhausted: true };
  if (status === 429) return { kind: "rate_limited", openrouterExhausted: false };
  if (status === null || status >= 500) return { kind: "transient", openrouterExhausted: false };
  if (status === 408) return { kind: "timeout", openrouterExhausted: false };
  if (status === 401 || status === 403) return { kind: "auth", openrouterExhausted: false };
  return { kind: "invalid_request", openrouterExhausted: false };
}
