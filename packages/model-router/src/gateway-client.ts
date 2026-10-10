import Anthropic from "@anthropic-ai/sdk";
import type { ModelTier } from "@rhumbatron/protocol";
import { resolveTier, TIER_REASONING_EFFORT } from "./models.ts";
import { anthropicCostUsd, classifyProviderFailure, type ModelProvider } from "./provider.ts";

/**
 * One Messages API call to Anthropic through the Cloudflare AI Gateway (ADR 0021). Runs in Workers
 * and Bun. The request shape is provider-neutral (OpenAI-style messages and function tools) so the
 * callers stay unchanged; this module maps it to Anthropic content blocks and back.
 *
 * - URL: `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic/v1/messages`.
 * - Every request sends `anthropic-workspace-id`: the API key is organization-level.
 * - Prompt caching: one `cache_control` breakpoint on the last system block, which also covers the
 *   tool definitions (render order tools -> system -> messages).
 * - Cost: exact, from the response `usage` fields, cache reads and writes included.
 * Never logs the API key, prompts, or completions; callers record only the returned metadata.
 * The monthly budget is the caller's job (spend-meter.ts): reserve before, settle after.
 */

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
      /**
       * Anthropic content blocks of this turn as returned (thinking blocks included). Replayed
       * as is: a tool-use turn with thinking must keep its thinking block.
       */
      blocks?: unknown[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolDefinition = {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type CompletionRequest = {
  tier: ModelTier;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens: number;
  /** Up to 5 small values, sent as cf-aig-metadata for gateway log filtering. */
  metadata?: Record<string, string>;
};

export type CompletionResult = {
  provider: ModelProvider;
  model: string;
  /** The tier that ran: sonnet for an opus request while Opus is off. */
  tier: ModelTier;
  /** Set when policy lowered the requested tier (ADR 0021). */
  requestedTier?: ModelTier;
  content: string | null;
  toolCalls: ToolCall[];
  /** The assistant turn to append to `messages` for a follow-up call. */
  message: Extract<ChatMessage, { role: "assistant" }>;
  /** Anthropic `stop_reason`: end_turn, tool_use, max_tokens, refusal, ... */
  finishReason: string | null;
  /** Every prompt token: uncached input, cache reads, and cache writes. */
  inputTokens: number;
  /** Output tokens, thinking included. */
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  latencyMs: number;
  gatewayLogId: string | null;
};

/**
 * Failure classes for section 42.8: retry `rate_limited` and `transient` once at the same tier.
 * `spend_limited` (gateway spend limit, billing error, monthly budget) is a budget stop, never
 * retried and never sent to another provider.
 */
export type ModelErrorKind =
  | "spend_limited"
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
  /** Anthropic API key (organization-level). */
  apiKey: string;
  /** Sent as `anthropic-workspace-id` on every request. Not a secret. */
  workspaceId: string;
  /** `ALLOW_OPUS` binding is "true". Otherwise the opus tier runs on Sonnet. */
  allowOpus?: boolean;
  timeoutMs?: number;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

export const gatewayAnthropicUrl = (accountId: string, gatewayId: string) =>
  `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/anthropic`;

const EPHEMERAL = { type: "ephemeral" } as const;

/** Maps the neutral messages to Anthropic `system` blocks and `messages`. Exported for tests. */
export function toAnthropicRequest(
  messages: readonly ChatMessage[],
  tools: readonly ToolDefinition[] = [],
): {
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
} {
  const systemText = messages.flatMap((m) => (m.role === "system" ? [m.content] : []));
  const system: Anthropic.TextBlockParam[] = systemText.map((text, i) => ({
    type: "text",
    text,
    ...(i === systemText.length - 1 ? { cache_control: EPHEMERAL } : {}),
  }));

  const out: Anthropic.MessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: Anthropic.ContentBlockParam[]) => {
    const last = out.at(-1);
    if (last && last.role === role && Array.isArray(last.content)) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: blocks });
    }
  };
  for (const m of messages) {
    if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
    } else if (m.role !== "assistant") {
      if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
    } else if (m.blocks?.length) {
      push("assistant", m.blocks as Anthropic.ContentBlockParam[]);
    } else {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.function.name,
          input: safeJson(call.function.arguments),
        });
      }
      if (blocks.length) push("assistant", blocks);
    }
  }

  return {
    system,
    messages: out,
    tools: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: { type: "object", ...t.function.parameters } as Anthropic.Tool.InputSchema,
    })),
  };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** One non-streaming Messages API call. Throws ModelCallError; never retries on its own. */
export async function complete(
  config: GatewayConfig,
  req: CompletionRequest,
): Promise<CompletionResult> {
  const resolved = resolveTier(req.tier, config.allowOpus === true);
  const client = new Anthropic({
    apiKey: config.apiKey,
    baseURL: gatewayAnthropicUrl(config.accountId, config.gatewayId),
    defaultHeaders: { "anthropic-workspace-id": config.workspaceId },
    maxRetries: 0,
    timeout: config.timeoutMs ?? 120_000,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  const mapped = toAnthropicRequest(req.messages, req.tools);
  // Haiku runs bounded transforms (compaction, small edits): thinking off keeps every output
  // token for the answer. Sonnet and Opus think adaptively; the text is never returned.
  const thinking: Anthropic.ThinkingConfigParam =
    resolved.tier === "haiku" ? { type: "disabled" } : { type: "adaptive", display: "omitted" };

  const started = Date.now();
  let message: Anthropic.Message;
  let headers: Headers;
  try {
    const { data, response } = await client.messages
      .create(
        {
          model: resolved.model,
          max_tokens: req.maxOutputTokens,
          ...(mapped.system.length ? { system: mapped.system } : {}),
          messages: mapped.messages,
          ...(mapped.tools.length ? { tools: mapped.tools } : {}),
          thinking,
          ...(resolved.tier === "haiku"
            ? {}
            : { output_config: { effort: TIER_REASONING_EFFORT[resolved.tier] } }),
        },
        {
          headers: {
            // Agent and planner turns must never be served from the AI Gateway response cache: a
            // repair turn after a rejected answer would get the same stored answer back.
            "cf-aig-skip-cache": "true",
            ...(req.metadata ? { "cf-aig-metadata": JSON.stringify(req.metadata) } : {}),
          },
        },
      )
      .withResponse();
    message = data;
    headers = response.headers;
  } catch (error) {
    throw toModelError(error);
  }
  const latencyMs = Date.now() - started;

  const usage = message.usage;
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens ?? 0;
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const toolCalls: ToolCall[] = message.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({
      id: b.id,
      type: "function",
      function: { name: b.name, arguments: JSON.stringify(b.input) },
    }));
  const content = message.stop_reason === "refusal" ? null : text || null;

  return {
    provider: "anthropic",
    model: message.model,
    tier: resolved.tier,
    ...(resolved.downgradedFrom ? { requestedTier: resolved.downgradedFrom } : {}),
    content,
    toolCalls,
    message: {
      role: "assistant",
      content,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      blocks: message.content,
    },
    finishReason: message.stop_reason,
    inputTokens: usage.input_tokens + cacheReadTokens + cacheWriteTokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: anthropicCostUsd(resolved.model, {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens,
      cacheWriteTokens,
      cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    }),
    latencyMs,
    gatewayLogId: headers.get("cf-aig-log-id"),
  };
}

function toModelError(error: unknown): ModelCallError {
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ModelCallError("timeout", "Model call timed out", null);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ModelCallError("transient", "Model call failed", null);
  }
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : null;
    const kind = classifyProviderFailure(status, JSON.stringify(error.error ?? error.message));
    return new ModelCallError(kind, error.message.slice(0, 300), status);
  }
  return new ModelCallError("bad_response", "Unexpected model response", null);
}
