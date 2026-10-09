import type { Api, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import { TIER_MODELS } from "@rhumbatron/model-router";
import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Pi model access (ADR 0007, ADR 0009). One pi-ai provider, `rhumbatron`, with one model per tier.
 * Requests go to OpenRouter through our AI Gateway, with the tier's free-model fallback list.
 * `beforeCall` runs before every model request and may throw to stop a run (budget, daily cap).
 */

export const PROVIDER_ID = "rhumbatron";

const TIER_LIMITS: Record<ModelTier, { contextWindow: number; maxTokens: number }> = {
  haiku: { contextWindow: 200_000, maxTokens: 4000 },
  sonnet: { contextWindow: 200_000, maxTokens: 8000 },
  opus: { contextWindow: 200_000, maxTokens: 8000 },
};

export type ModelAccess = {
  accountId: string;
  gatewayId: string;
  apiKey: string;
  beforeCall: (tier: ModelTier) => Promise<void>;
};

export const modelIdFor = (tier: ModelTier) => `tier-${tier}`;

function tierOf(model: Model<Api>): ModelTier {
  const tier = model.id.replace(/^tier-/, "");
  if (tier === "haiku" || tier === "sonnet" || tier === "opus") return tier;
  throw new Error(`unknown model ${model.id}`);
}

export function createTierModels(access: ModelAccess): MutableModels {
  const baseUrl = `https://gateway.ai.cloudflare.com/v1/${access.accountId}/${access.gatewayId}/openrouter/v1`;
  const models: Model<"openai-completions">[] = (Object.keys(TIER_MODELS) as ModelTier[]).map(
    (tier) => ({
      id: modelIdFor(tier),
      name: `Rhumbatron ${tier}`,
      api: "openai-completions",
      provider: PROVIDER_ID,
      baseUrl,
      reasoning: true,
      input: ["text"],
      // OpenRouter :free models cost nothing (ADR 0007).
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: TIER_LIMITS[tier].contextWindow,
      maxTokens: TIER_LIMITS[tier].maxTokens,
      compat: { thinkingFormat: "openrouter" },
    }),
  );

  const api = openAICompletionsApi();
  const withTier = <T extends { onPayload?: unknown }>(
    model: Model<Api>,
    options: T | undefined,
  ) => ({
    ...options,
    // OpenRouter tries `models` in order; the alias id itself is never sent.
    onPayload: (payload: unknown) => {
      const body = payload as Record<string, unknown>;
      const [primary, ...rest] = TIER_MODELS[tierOf(model)];
      return { ...body, model: primary, models: [primary, ...rest] };
    },
  });

  const provider = createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: "Rhumbatron tiers",
    baseUrl,
    headers: { "X-Title": "Rhumbatron" },
    auth: {
      apiKey: {
        name: "OpenRouter API key",
        resolve: async () => ({ auth: { apiKey: access.apiKey }, source: "OPENROUTER_API_KEY" }),
      },
    },
    models,
    api: {
      stream(model, context, options) {
        return api.stream(model, context, withTier(model, options));
      },
      streamSimple(model, context, options) {
        // A rejected budget check must fail this request before it reaches the network.
        const gate = access.beforeCall(tierOf(model));
        const stream = api.streamSimple(model, context, {
          ...withTier(model, options),
          onPayload: async (payload: unknown) => {
            await gate;
            return withTier(model, options).onPayload(payload);
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
