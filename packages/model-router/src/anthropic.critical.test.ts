// Anthropic provider (ADR 0021). A wrong tier mapping silently runs Opus while it is off; a wrong
// cost formula under-reports spend to the monthly budget that is the only hard money stop; a spend
// rejection that retries loops against that stop; a missing workspace header fails every call.
import type { RouteRequest } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { nextStep } from "./escalation.ts";
import { complete, ModelCallError } from "./gateway-client.ts";
import { opusAllowed, resolveTier } from "./models.ts";
import { anthropicCostUsd, classifyProviderFailure } from "./provider.ts";
import { routeStep } from "./route.ts";

describe("tier mapping with ALLOW_OPUS", () => {
  it("maps haiku and sonnet to Claude 5.5, and opus to Sonnet unless ALLOW_OPUS is exactly true", () => {
    expect(resolveTier("haiku", false)).toEqual({ tier: "haiku", model: "claude-haiku-5-5" });
    expect(resolveTier("sonnet", false)).toEqual({ tier: "sonnet", model: "claude-sonnet-5-5" });
    expect(resolveTier("opus", opusAllowed(undefined))).toEqual({
      tier: "sonnet",
      model: "claude-sonnet-5-5",
      downgradedFrom: "opus",
      downgradeReason: "opus_disabled",
    });
    for (const flag of [undefined, "", "false", "TRUE", "1"]) expect(opusAllowed(flag)).toBe(false);
    expect(resolveTier("opus", opusAllowed("true"))).toEqual({
      tier: "opus",
      model: "claude-opus-5-5",
    });
  });

  it("records the downgrade in the Decision Receipt", async () => {
    const req: RouteRequest = {
      taskKind: "implement",
      complexity: "medium",
      riskTier: "medium",
      affectedFiles: 2,
      affectedResources: ["a:x", "b:y"],
      attempt: 1,
      priorFailureKinds: [],
      hasDesignConflict: false,
      touchesAuthorization: false,
      touchesBilling: false,
      touchesMigration: false,
      destructiveMigration: true,
      contextTokensEstimate: 2000,
      expectedToolCalls: 1,
      budgetRemainingUsd: 1,
    };
    const off = await routeStep(req);
    expect(off.decision.selectedTier).toBe("opus");
    const capped = await routeStep(req, undefined, { allowOpus: false });
    expect(capped.decision.selectedTier).toBe("sonnet");
    expect(capped.receipt).toMatchObject({
      selectedTier: "sonnet",
      selectedModels: ["claude-sonnet-5-5"],
      requestedTier: "opus",
      downgradeReason: "opus_disabled",
    });
    expect(capped.receipt.reasons).toEqual(["destructive_migration", "opus_disabled"]);
  });

  it("caps escalation at Sonnet while Opus is off", () => {
    const twice = [
      { tier: "sonnet" as const, kind: "agent_failed" as const },
      { tier: "sonnet" as const, kind: "invalid_output" as const },
    ];
    expect(nextStep("sonnet", twice, { allowOpus: false })).toEqual({
      action: "replan",
      reason: "two_failures_at_sonnet",
    });
    expect(nextStep("sonnet", twice, { allowOpus: true })).toMatchObject({
      action: "escalate",
      tier: "opus",
    });
  });
});

describe("cost from usage fields", () => {
  it("prices uncached input, output, cache reads, and 5-minute and 1-hour cache writes", () => {
    // Sonnet 5.5: $2 in, $10 out, $0.20 cache read, $2.50 5m write, $4 1h write per million.
    expect(
      anthropicCostUsd("claude-sonnet-5-5", {
        inputTokens: 1_000,
        outputTokens: 500,
        cacheReadTokens: 10_000,
        cacheWriteTokens: 3_000,
        cacheWrite1hTokens: 1_000,
      }),
    ).toBeCloseTo((1_000 * 2 + 500 * 10 + 10_000 * 0.2 + 2_000 * 2.5 + 1_000 * 4) / 1e6, 12);
  });

  it("bills every Haiku token at the long-prompt rate when the prompt passes 100K, cache included", () => {
    const usage = {
      inputTokens: 90_000,
      outputTokens: 1_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(anthropicCostUsd("claude-haiku-5-5", usage)).toBeCloseTo(
      (90_000 * 0.1 + 1_000 * 0.5) / 1e6,
      12,
    );
    expect(anthropicCostUsd("claude-haiku-5-5", { ...usage, cacheReadTokens: 20_000 })).toBeCloseTo(
      (90_000 * 0.5 + 1_000 * 2.5 + 20_000 * 0.05) / 1e6,
      12,
    );
  });

  it("prices an unknown model at the highest known rates, never $0", () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(anthropicCostUsd("claude-unknown", usage)).toBeCloseTo(4, 12);
  });
});

describe("failure classes", () => {
  it("stops on the gateway spend limit and billing errors, retries rate limits and overload", () => {
    expect(
      classifyProviderFailure(429, '{"error":[{"code":2017,"message":"Spend limit exceeded"}]}'),
    ).toBe("spend_limited");
    expect(classifyProviderFailure(429, "")).toBe("spend_limited");
    expect(classifyProviderFailure(400, "Your credit balance is too low")).toBe("spend_limited");
    expect(classifyProviderFailure(429, '{"type":"rate_limit_error"}')).toBe("rate_limited");
    expect(classifyProviderFailure(529, '{"type":"overloaded_error"}')).toBe("transient");
    expect(classifyProviderFailure(null, "")).toBe("transient");
    expect(classifyProviderFailure(401, "")).toBe("auth");
    expect(nextStep("sonnet", [{ tier: "sonnet", kind: "spend_limited" }])).toEqual({
      action: "stop",
      reason: "monthly_model_spend",
    });
  });
});

describe("gateway client", () => {
  const config = {
    accountId: "acct",
    gatewayId: "gw",
    apiKey: "sk-test",
    workspaceId: "wrkspc_test",
  };

  it("sends the workspace header, caches the system prompt, maps tools, and prices the usage", async () => {
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      seen = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return Response.json(
        {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [
            { type: "thinking", thinking: "", signature: "sig" },
            { type: "tool_use", id: "toolu_1", name: "submit", input: { ok: true } },
          ],
          stop_reason: "tool_use",
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 1_000,
            cache_creation_input_tokens: 0,
          },
        },
        { headers: { "cf-aig-log-id": "log-1" } },
      );
    };
    const result = await complete(
      { ...config, fetch },
      {
        tier: "opus",
        maxOutputTokens: 8000,
        messages: [
          { role: "system", content: "stable" },
          { role: "user", content: "go" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "submit",
              description: "d",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
    );
    const request = seen as unknown as {
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    };
    expect(request.url).toBe("https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages");
    expect(request.headers.get("anthropic-workspace-id")).toBe("wrkspc_test");
    expect(request.headers.get("x-api-key")).toBe("sk-test");
    expect(request.body.model).toBe("claude-sonnet-5-5");
    expect(request.body.max_tokens).toBe(8000);
    expect(request.body.system).toEqual([
      { type: "text", text: "stable", cache_control: { type: "ephemeral" } },
    ]);
    expect(request.body.tools).toEqual([
      { name: "submit", description: "d", input_schema: { type: "object", properties: {} } },
    ]);
    expect(result).toMatchObject({
      provider: "anthropic",
      tier: "sonnet",
      requestedTier: "opus",
      toolCalls: [
        { id: "toolu_1", type: "function", function: { name: "submit", arguments: '{"ok":true}' } },
      ],
      inputTokens: 1_100,
      cacheReadTokens: 1_000,
      gatewayLogId: "log-1",
    });
    expect(result.costUsd).toBeCloseTo((100 * 2 + 50 * 10 + 1_000 * 0.2) / 1e6, 12);
    // The thinking block travels back with the turn.
    expect(result.message.blocks?.[0]).toMatchObject({ type: "thinking", signature: "sig" });
  });

  it("raises spend_limited on the gateway spend limit without retrying", async () => {
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return Response.json({ success: false, error: [{ message: "spend" }] }, { status: 429 });
    };
    const error = await complete(
      { ...config, fetch },
      { tier: "haiku", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).kind).toBe("spend_limited");
    expect(calls).toBe(1);
  });
});
