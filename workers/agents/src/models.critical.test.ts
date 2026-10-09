// Gemini overflow pricing and replay (ADR 0016). If Vertex models price at $0 the Change budget and
// the Costs page never see paid spend; if a replayed tool call lacks its thought signature, Gemini 3
// rejects every second call of a run with HTTP 400.
import { calculateCost } from "@earendil-works/pi-ai/models";
import { TIER_VERTEX_MODEL, vertexCostUsd } from "@rhumbatron/model-router";
import { describe, expect, it } from "vitest";
import { modelIdFor, parseModelId, vertexModelCost, vertexPayload } from "./models.ts";

describe("Vertex models", () => {
  it("compute a non-zero cost from tokens at Vertex prices", () => {
    const usage = {
      input: 20_000,
      output: 1_500,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 21_500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost({ cost: vertexModelCost("sonnet") } as never, usage as never);
    expect(usage.cost.total).toBeGreaterThan(0);
    expect(usage.cost.total).toBeCloseTo(
      vertexCostUsd(TIER_VERTEX_MODEL.sonnet, 20_000, 1_500),
      10,
    );
  });

  it("round-trip model ids per provider", () => {
    expect(parseModelId(modelIdFor("opus", "google-vertex-ai"))).toEqual({
      tier: "opus",
      provider: "google-vertex-ai",
    });
    expect(parseModelId(modelIdFor("haiku"))).toEqual({ tier: "haiku", provider: "openrouter" });
  });

  it("send the Vertex model and a thought signature on every replayed tool call", () => {
    const body = vertexPayload(
      {
        model: "tier-haiku-vertex",
        models: ["x"],
        prompt_cache_key: "k",
        stream: true,
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: "{}" } },
              { id: "call_2", type: "function", function: { name: "read_file", arguments: "{}" } },
            ],
          },
        ],
      },
      "haiku",
      new Map([["call_1", "sig-1"]]),
    );
    expect(body.model).toBe(`google-vertex-ai/${TIER_VERTEX_MODEL.haiku}`);
    expect(body).not.toHaveProperty("models");
    expect(body).not.toHaveProperty("prompt_cache_key");
    const calls = (body.messages as { tool_calls?: { extra_content: unknown }[] }[])[1]?.tool_calls;
    expect(calls?.map((c) => c.extra_content)).toEqual([
      { google: { thought_signature: "sig-1" } },
      { google: { thought_signature: "skip_thought_signature_validator" } },
    ]);
  });
});
