import type { ModelTier } from "@rhumbatron/protocol";
import { z } from "zod";
import { TIER_MODELS, TIER_REASONING_EFFORT } from "./models.ts";

/**
 * OpenRouter chat completions through Cloudflare AI Gateway (ADR 0007). Runs in Workers and Bun.
 * Never logs the API key, prompts, or completions; callers record only the returned metadata.
 */

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal("function"),
  function: z.object({ name: z.string(), arguments: z.string() }),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

const CompletionSchema = z.object({
  model: z.string(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable(),
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z.array(ToolCallSchema).nullable().optional(),
        }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number(),
      completion_tokens: z.number(),
      cost: z.number().optional(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional(),
      prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).optional(),
    })
    .optional(),
});

const ErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.union([z.number(), z.string()]).optional(),
  }),
});

export type CompletionRequest = {
  tier: ModelTier;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens: number;
  /** Up to 5 small values, sent as cf-aig-metadata for gateway log filtering. */
  metadata?: Record<string, string>;
  /** Overrides the tier's model list (tests and pinned experiments only). */
  models?: readonly string[];
};

export type CompletionResult = {
  model: string;
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  latencyMs: number;
  gatewayLogId: string | null;
};

/** Failure classes for section 42.8: retry `rate_limited` and `transient` once at the same tier. */
export type ModelErrorKind =
  | "rate_limited"
  | "transient"
  | "timeout"
  | "invalid_request"
  | "auth"
  | "bad_response";

export class ModelCallError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export type GatewayConfig = {
  accountId: string;
  gatewayId: string;
  apiKey: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
};

function classify(status: number, code: number | string | undefined): ModelErrorKind {
  const effective = typeof code === "number" ? code : status;
  if (effective === 429) return "rate_limited";
  if (effective === 401 || effective === 403) return "auth";
  if (effective === 408) return "timeout";
  if (effective >= 500) return "transient";
  return "invalid_request";
}

export async function complete(
  config: GatewayConfig,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const url = `https://gateway.ai.cloudflare.com/v1/${config.accountId}/${config.gatewayId}/openrouter/v1/chat/completions`;
  const models = req.models ?? TIER_MODELS[req.tier];
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.apiKey}`,
    "Content-Type": "application/json",
    "X-Title": "Rhumbatron",
  };
  if (req.metadata) headers["cf-aig-metadata"] = JSON.stringify(req.metadata);

  const started = Date.now();
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        models,
        messages: req.messages,
        tools: req.tools?.length ? req.tools : undefined,
        max_tokens: req.maxOutputTokens,
        reasoning: { effort: TIER_REASONING_EFFORT[req.tier], exclude: true },
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? 120_000),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    throw new ModelCallError(
      timedOut ? "timeout" : "transient",
      timedOut ? "Model call timed out" : "Model call failed",
      null,
    );
  }
  const latencyMs = Date.now() - started;

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ModelCallError(
      response.ok ? "bad_response" : classify(response.status, undefined),
      "Non-JSON model response",
      response.status,
    );
  }

  // OpenRouter can return HTTP 200 with an error body when every fallback model fails.
  const failure = ErrorSchema.safeParse(json);
  if (!response.ok || failure.success) {
    const err = failure.success ? failure.data.error : {};
    throw new ModelCallError(
      classify(response.status, err.code),
      err.message ?? `HTTP ${response.status}`,
      response.status,
    );
  }

  const parsed = CompletionSchema.safeParse(json);
  if (!parsed.success)
    throw new ModelCallError("bad_response", "Unexpected completion shape", response.status);
  const { model, choices, usage } = parsed.data;
  const choice = choices[0];
  if (!choice) throw new ModelCallError("bad_response", "No completion choice", response.status);

  return {
    model,
    content: choice.message.content ?? null,
    toolCalls: choice.message.tool_calls ?? [],
    finishReason: choice.finish_reason,
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? 0,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
    costUsd: usage?.cost ?? 0,
    latencyMs,
    gatewayLogId: response.headers.get("cf-aig-log-id"),
  };
}
