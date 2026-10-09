// Gemini overflow (ADR 0016). A wrong choice either burns paid Gemini while OpenRouter is still
// free, or keeps hammering an exhausted OpenRouter. A spend-limit rejection that retries would loop
// against the only hard money ceiling, so it must be a budget stop.
import { describe, expect, it } from "vitest";
import { OPENROUTER_DAILY_CALL_CAP } from "./budget.ts";
import { nextStep } from "./escalation.ts";
import { complete, ModelCallError } from "./gateway-client.ts";
import { classifyProviderFailure, selectProvider, vertexCostUsd } from "./provider.ts";

const fresh = {
  openrouterCallsToday: 0,
  openrouterExhaustedToday: false,
  vertexSpendLimitedToday: false,
  vertexConfigured: true,
};

describe("selectProvider", () => {
  it("uses OpenRouter while today's OpenRouter is not used up", () => {
    expect(selectProvider(fresh).provider).toBe("openrouter");
    expect(
      selectProvider({ ...fresh, openrouterCallsToday: OPENROUTER_DAILY_CALL_CAP - 1 }).provider,
    ).toBe("openrouter");
  });

  it("moves to Vertex after a rate limit today or at our OpenRouter cap, never one call later", () => {
    expect(selectProvider({ ...fresh, openrouterExhaustedToday: true })).toEqual({
      provider: "google-vertex-ai",
      reason: "openrouter_rate_limited_today",
    });
    expect(selectProvider({ ...fresh, openrouterCallsToday: OPENROUTER_DAILY_CALL_CAP })).toEqual({
      provider: "google-vertex-ai",
      reason: "openrouter_daily_cap",
    });
  });

  it("stays on OpenRouter without a Vertex credential, and runs nothing once Vertex is capped", () => {
    expect(
      selectProvider({ ...fresh, openrouterExhaustedToday: true, vertexConfigured: false })
        .provider,
    ).toBe("openrouter");
    expect(
      selectProvider({ ...fresh, openrouterExhaustedToday: true, vertexSpendLimitedToday: true }),
    ).toEqual({ provider: null, reason: "vertex_spend_limit" });
  });
});

describe("classifyProviderFailure", () => {
  it("treats a gateway 429 on Vertex as the spend limit, and a budget stop, not a retry", () => {
    const failure = classifyProviderFailure(
      "google-vertex-ai",
      429,
      '{"success":false,"error":[{"code":2017,"message":"Spend limit exceeded"}]}',
    );
    expect(failure.kind).toBe("spend_limited");
    // Unknown 429 body on Vertex: stop rather than risk a loop.
    expect(classifyProviderFailure("google-vertex-ai", 429, "").kind).toBe("spend_limited");
    expect(nextStep("sonnet", [{ tier: "sonnet", kind: "spend_limited" }])).toEqual({
      action: "stop",
      reason: "vertex_spend_limit",
    });
  });

  it("keeps Google's own quota and the gateway request rate limit as retryable rate limits", () => {
    const google =
      '[{"error":{"code":429,"message":"Resource exhausted.","status":"RESOURCE_EXHAUSTED"}}]';
    expect(classifyProviderFailure("google-vertex-ai", 429, google).kind).toBe("rate_limited");
    expect(
      classifyProviderFailure("google-vertex-ai", 429, '{"error":[{"message":"Rate limited"}]}')
        .kind,
    ).toBe("rate_limited");
  });

  it("marks OpenRouter used up on a 429 or a quota error, and not on an outage", () => {
    expect(classifyProviderFailure("openrouter", 429, "")).toEqual({
      kind: "rate_limited",
      openrouterExhausted: true,
    });
    expect(
      classifyProviderFailure("openrouter", 200, "Rate limit exceeded: free-models-per-day")
        .openrouterExhausted,
    ).toBe(true);
    expect(classifyProviderFailure("openrouter", 503, "Service unavailable")).toEqual({
      kind: "transient",
      openrouterExhausted: false,
    });
  });
});

describe("Vertex cost", () => {
  it("prices tokens at the model's rate, and an unknown model at the highest rate, never $0", () => {
    // google/gemini-3.8-flash: $0.75 in, $3.75 out per million tokens.
    expect(vertexCostUsd("google-vertex-ai/google/gemini-3.8-flash", 100_000, 10_000)).toBeCloseTo(
      0.075 + 0.0375,
      10,
    );
    expect(vertexCostUsd("google/unknown", 1_000_000, 0)).toBeCloseTo(0.75, 10);
  });

  it("raises spend_limited from the gateway client without falling back or retrying", async () => {
    let calls = 0;
    const fetch = async (input: string | URL | Request) => {
      calls++;
      return String(input).includes("/openrouter/")
        ? Response.json({ error: { message: "limited", code: 429 } }, { status: 429 })
        : Response.json({ success: false, error: [{ message: "spend" }] }, { status: 429 });
    };
    const error = await complete(
      { accountId: "a", gatewayId: "g", apiKey: "k", vertexServiceAccount: "sa", fetch },
      { tier: "haiku", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 10 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelCallError);
    expect((error as ModelCallError).kind).toBe("spend_limited");
    expect(calls).toBe(2);
  });
});
