import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import {
  ANTHROPIC_PRICES,
  anthropicPrice,
  gatewayAnthropicUrl,
  TIER_MODELS,
  TIER_REASONING_EFFORT,
} from "@rhumbatron/model-router";
import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Pi model access (ADR 0009, ADR 0021). One pi-ai provider, `rhumbatron`, with one model per tier
 * on Pi's Anthropic Messages API, through our AI Gateway's Anthropic endpoint. Every request sends
 * `anthropic-workspace-id` (the key is organization-level). Pi puts `cache_control` on the system
 * prompt, the tool definitions, and the latest message, and prices each response from its usage
 * fields with the costs below, cache reads and writes included.
 * The AgentDO resolves the tier before the run (Opus off unless ALLOW_OPUS). `beforeCall` runs
 * before every model request and may throw to stop a run (budgets, caps); `onFailure` sees every
 * failed response.
 */

export const PROVIDER_ID = "rhumbatron";

/**
 * Bounded context per call keeps the per-call reservation and spend small. One `write_file` call
 * holds a whole file: at 4,000 output tokens Haiku's call stopped inside the file of a page, and
 * the run ended with no outcome. 8,000 fits the app's page and route files on every tier.
 */
const TIER_LIMITS: Record<ModelTier, { contextWindow: number; maxTokens: number }> = {
  haiku: { contextWindow: 200_000, maxTokens: 8000 },
  sonnet: { contextWindow: 200_000, maxTokens: 8000 },
  opus: { contextWindow: 200_000, maxTokens: 8000 },
};

/** Largest prompt one Pi call can send: the reservation estimate before each call. */
export const tierLimits = (tier: ModelTier) => TIER_LIMITS[tier];

export type ModelAccess = {
  accountId: string;
  gatewayId: string;
  apiKey: string;
  workspaceId: string;
  beforeCall: (tier: ModelTier) => Promise<void>;
  onFailure: (status: number | null, body: string) => Promise<void>;
};

export const modelIdFor = (tier: ModelTier) => `tier-${tier}`;

export function parseModelId(id: string): { tier: ModelTier } {
  const match = /^tier-(haiku|sonnet|opus)$/.exec(id);
  if (!match) throw new Error(`unknown model ${id}`);
  return { tier: match[1] as ModelTier };
}

/** A tier's Anthropic prices in Pi's cost shape (USD per million tokens). */
export function tierModelCost(tier: ModelTier) {
  const known = ANTHROPIC_PRICES[TIER_MODELS[tier]];
  const price = known ?? anthropicPrice(TIER_MODELS[tier]);
  const long = known?.longPrompt;
  return {
    input: price.input,
    output: price.output,
    cacheRead: price.cacheRead,
    cacheWrite: price.cacheWrite5m,
    ...(long
      ? {
          tiers: [
            {
              inputTokensAbove: long.aboveTokens,
              input: long.input,
              output: long.output,
              cacheRead: long.cacheRead,
              cacheWrite: long.cacheWrite5m,
            },
          ],
        }
      : {}),
  };
}

/**
 * Rewrites a Pi payload for a tier: the real model id, adaptive thinking with the text omitted
 * (no reasoning is stored), and the tier's effort. Exported for tests.
 */
export function tierPayload(payload: Record<string, unknown>, tier: ModelTier) {
  return {
    ...payload,
    model: TIER_MODELS[tier],
    thinking: { type: "adaptive", display: "omitted" },
    output_config: {
      ...((payload.output_config as Record<string, unknown> | undefined) ?? {}),
      effort: TIER_REASONING_EFFORT[tier],
    },
  };
}

export function createTierModels(access: ModelAccess): MutableModels {
  const baseUrl = gatewayAnthropicUrl(access.accountId, access.gatewayId);
  const tiers = Object.keys(TIER_MODELS) as ModelTier[];
  const models: Model<"anthropic-messages">[] = tiers.map((tier) => ({
    api: "anthropic-messages" as const,
    provider: PROVIDER_ID,
    id: modelIdFor(tier),
    name: `Rhumbatron ${tier} (${TIER_MODELS[tier]})`,
    baseUrl,
    headers: { "anthropic-workspace-id": access.workspaceId },
    reasoning: true,
    input: ["text" as const],
    contextWindow: TIER_LIMITS[tier].contextWindow,
    maxTokens: TIER_LIMITS[tier].maxTokens,
    cost: tierModelCost(tier),
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      // 5-minute cache only: a 1-hour write costs 2x input and runs rarely repeat after 5 minutes.
      supportsLongCacheRetention: false,
    },
  }));

  /** Reports every failed response or network failure, then hands the response to pi-ai. */
  const observedFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let response: Response;
    try {
      response = await fetch(input, init);
    } catch (error) {
      if (!init?.signal?.aborted) await access.onFailure(null, "");
      throw error;
    }
    if (!response.ok) {
      const body = await response
        .clone()
        .text()
        .catch(() => "");
      await access.onFailure(response.status, body.slice(0, 2000));
    }
    return response;
  };

  const api = anthropicMessagesApi();
  const withTier = <T extends object>(model: Model<Api>, options: T | undefined) => {
    const { tier } = parseModelId(model.id);
    return {
      ...options,
      fetch: observedFetch,
      onPayload: (payload: unknown) => tierPayload(payload as Record<string, unknown>, tier),
    };
  };

  const provider = createProvider<"anthropic-messages">({
    id: PROVIDER_ID,
    name: "Rhumbatron tiers",
    baseUrl,
    headers: { "anthropic-workspace-id": access.workspaceId },
    auth: {
      apiKey: {
        name: "Anthropic API key",
        resolve: async () => ({ auth: { apiKey: access.apiKey }, source: "ANTHROPIC_API_KEY" }),
      },
    },
    models,
    api: {
      stream(model, context, options) {
        return api.stream(model, context, withTier(model, options));
      },
      streamSimple(model, context, options) {
        // A rejected budget check must fail this request before it reaches the network.
        const { tier } = parseModelId(model.id);
        const gate = access.beforeCall(tier);
        const routed = withTier(model, options);
        const stream = api.streamSimple(model, context, {
          ...routed,
          onPayload: async (payload: unknown) => {
            await gate;
            return routed.onPayload(payload);
          },
        });
        gate.catch(() => undefined);
        return stream;
      },
    },
  });

  const registry = createModels();
  registry.setProvider(provider);
  return registry;
}
