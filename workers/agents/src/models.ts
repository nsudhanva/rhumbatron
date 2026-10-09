import type { Api, Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels, createProvider, type MutableModels } from "@earendil-works/pi-ai/models";
import {
  type ModelProvider,
  TIER_MODELS,
  TIER_VERTEX_MODEL,
  vertexPrice,
} from "@rhumbatron/model-router";
import type { ModelTier } from "@rhumbatron/protocol";

/**
 * Pi model access (ADR 0007, ADR 0009, ADR 0016). One pi-ai provider, `rhumbatron`, with two models
 * per tier, both through our AI Gateway:
 * - `tier-<t>`: OpenRouter with the tier's free-model fallback list ($0).
 * - `tier-<t>-vertex`: Gemini on Vertex AI through the gateway compat endpoint, priced from
 *   VERTEX_PRICES so Pi's usage records real cost. The gateway caps Vertex spend per environment.
 * The AgentDO picks the provider once per run. `beforeCall` runs before every model request and may
 * throw to stop a run (budget, daily cap); `onFailure` sees every failed provider response.
 */

export const PROVIDER_ID = "rhumbatron";

const TIER_LIMITS: Record<ModelTier, { contextWindow: number; maxTokens: number }> = {
  haiku: { contextWindow: 200_000, maxTokens: 4000 },
  sonnet: { contextWindow: 200_000, maxTokens: 8000 },
  opus: { contextWindow: 200_000, maxTokens: 8000 },
};

/** Request fields the gateway compat endpoint accepts for Vertex; anything else is dropped. */
const VERTEX_FIELDS = new Set([
  "model",
  "messages",
  "tools",
  "tool_choice",
  "max_tokens",
  "max_completion_tokens",
  "stream",
  "stream_options",
  "reasoning_effort",
  "temperature",
  "top_p",
  "stop",
]);

/**
 * Gemini 3 rejects a replayed tool call without its thought signature (HTTP 400), and pi-ai does
 * not round-trip `extra_content`. Real signatures are kept per tool call id; a call whose signature
 * was lost (Durable Object eviction) gets Google's documented validator bypass value.
 */
const SIGNATURE_BYPASS = "skip_thought_signature_validator";
const MAX_SIGNATURES = 256;

export type ModelAccess = {
  accountId: string;
  gatewayId: string;
  apiKey: string;
  /** Base64 service account JSON. Without it, Vertex models fail with an auth error. */
  vertexServiceAccount?: string;
  beforeCall: (tier: ModelTier, provider: ModelProvider) => Promise<void>;
  onFailure: (provider: ModelProvider, status: number | null, body: string) => Promise<void>;
};

export const modelIdFor = (tier: ModelTier, provider: ModelProvider = "openrouter") =>
  provider === "google-vertex-ai" ? `tier-${tier}-vertex` : `tier-${tier}`;

export function parseModelId(id: string): { tier: ModelTier; provider: ModelProvider } {
  const match = /^tier-(haiku|sonnet|opus)(-vertex)?$/.exec(id);
  if (!match) throw new Error(`unknown model ${id}`);
  return {
    tier: match[1] as ModelTier,
    provider: match[2] ? "google-vertex-ai" : "openrouter",
  };
}

/** Per-million-token prices of a tier's Vertex model in Pi's cost shape. Cache reads at full price. */
export function vertexModelCost(tier: ModelTier) {
  const price = vertexPrice(TIER_VERTEX_MODEL[tier]);
  return {
    input: price.input,
    output: price.output,
    cacheRead: price.input,
    cacheWrite: price.input,
  };
}

type ChatMessage = {
  role?: string;
  tool_calls?: { id?: string; extra_content?: unknown }[];
};

/** Rewrites a Pi payload for the Vertex compat endpoint. Exported for tests. */
export function vertexPayload(
  payload: Record<string, unknown>,
  tier: ModelTier,
  signatures: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (VERTEX_FIELDS.has(key)) body[key] = value;
  }
  body.model = `google-vertex-ai/${TIER_VERTEX_MODEL[tier]}`;
  const messages = Array.isArray(payload.messages) ? (payload.messages as ChatMessage[]) : [];
  body.messages = messages.map((message) =>
    message.role === "assistant" && message.tool_calls?.length
      ? {
          ...message,
          tool_calls: message.tool_calls.map((call) => ({
            ...call,
            extra_content: {
              google: {
                thought_signature: (call.id && signatures.get(call.id)) || SIGNATURE_BYPASS,
              },
            },
          })),
        }
      : message,
  );
  return body;
}

type StreamChunk = {
  error?: { code?: number | string; message?: string };
  choices?: {
    delta?: {
      tool_calls?: { id?: string; extra_content?: { google?: { thought_signature?: string } } }[];
    };
  }[];
};

export function createTierModels(access: ModelAccess): MutableModels {
  const gateway = `https://gateway.ai.cloudflare.com/v1/${access.accountId}/${access.gatewayId}`;
  const openrouterUrl = `${gateway}/openrouter/v1`;
  const tiers = Object.keys(TIER_MODELS) as ModelTier[];
  const base = (tier: ModelTier) => ({
    api: "openai-completions" as const,
    provider: PROVIDER_ID,
    reasoning: true,
    input: ["text" as const],
    contextWindow: TIER_LIMITS[tier].contextWindow,
    maxTokens: TIER_LIMITS[tier].maxTokens,
  });
  const models: Model<"openai-completions">[] = tiers.flatMap((tier) => [
    {
      ...base(tier),
      id: modelIdFor(tier, "openrouter"),
      name: `Rhumbatron ${tier}`,
      baseUrl: openrouterUrl,
      // OpenRouter :free models cost nothing (ADR 0007).
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { thinkingFormat: "openrouter" },
    },
    {
      ...base(tier),
      id: modelIdFor(tier, "google-vertex-ai"),
      name: `Rhumbatron ${tier} (Gemini)`,
      // The OpenAI client appends /chat/completions.
      baseUrl: `${gateway}/compat`,
      cost: vertexModelCost(tier),
      compat: {
        thinkingFormat: "openai",
        supportsReasoningEffort: true,
        supportsStore: false,
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        sendSessionAffinityHeaders: false,
        supportsLongCacheRetention: false,
      },
    },
  ]);

  // Thought signatures of this agent's recent Vertex tool calls (see SIGNATURE_BYPASS).
  const signatures = new Map<string, string>();
  const remember = (id: string, signature: string) => {
    signatures.set(id, signature);
    if (signatures.size > MAX_SIGNATURES) {
      const oldest = signatures.keys().next().value;
      if (oldest !== undefined) signatures.delete(oldest);
    }
  };

  /** Reports every failed response or network failure, then hands the response to pi-ai. */
  const observedFetch =
    (provider: ModelProvider) =>
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      let response: Response;
      try {
        response = await fetch(input, init);
      } catch (error) {
        if (!init?.signal?.aborted) await access.onFailure(provider, null, "");
        throw error;
      }
      if (!response.ok) {
        const body = await response
          .clone()
          .text()
          .catch(() => "");
        await access.onFailure(provider, response.status, body.slice(0, 2000));
      }
      return response;
    };

  const api = openAICompletionsApi();
  const withTier = <T extends object>(model: Model<Api>, options: T | undefined) => {
    const { tier, provider } = parseModelId(model.id);
    const vertex = provider === "google-vertex-ai";
    return {
      ...options,
      ...(vertex ? { apiKey: access.vertexServiceAccount ?? "" } : {}),
      fetch: observedFetch(provider),
      onPayload: (payload: unknown) => {
        const body = payload as Record<string, unknown>;
        if (vertex) return vertexPayload(body, tier, signatures);
        // OpenRouter tries `models` in order; the alias id itself is never sent.
        const [primary, ...rest] = TIER_MODELS[tier];
        return { ...body, model: primary, models: [primary, ...rest] };
      },
      onProviderStreamEvent: async (data: unknown) => {
        const chunk = data as StreamChunk | null;
        if (!chunk || typeof chunk !== "object") return;
        // OpenRouter can fail inside an HTTP 200 stream when every fallback model is limited.
        if (chunk.error) {
          const code = Number(chunk.error.code);
          await access.onFailure(
            provider,
            Number.isFinite(code) ? code : null,
            String(chunk.error.message ?? ""),
          );
        }
        if (!vertex) return;
        for (const call of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
          const signature = call.extra_content?.google?.thought_signature;
          if (call.id && signature) remember(call.id, signature);
        }
      },
    };
  };

  const provider = createProvider<"openai-completions">({
    id: PROVIDER_ID,
    name: "Rhumbatron tiers",
    baseUrl: openrouterUrl,
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
        const { tier, provider: modelProvider } = parseModelId(model.id);
        const gate = access.beforeCall(tier, modelProvider);
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
