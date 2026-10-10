// Pi model access (ADR 0021). If Pi prices Claude at $0 the Change budget, the monthly meter, and
// the Costs page never see spend; if the tier payload keeps the alias id or the thinking text,
// every call fails or private reasoning is stored.
import { calculateCost } from "@earendil-works/pi-ai/models";
import { anthropicCostUsd } from "@rhumbatron/model-router";
import { describe, expect, it } from "vitest";
import { modelIdFor, parseModelId, tierModelCost, tierPayload } from "./models.ts";

describe("Pi tier models", () => {
  it("price usage with cache reads and writes exactly like the model router", () => {
    const usage = {
      input: 2_000,
      output: 1_500,
      cacheRead: 30_000,
      cacheWrite: 4_000,
      totalTokens: 37_500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost({ cost: tierModelCost("sonnet") } as never, usage as never);
    expect(usage.cost.total).toBeGreaterThan(0);
    expect(usage.cost.total).toBeCloseTo(
      anthropicCostUsd("claude-sonnet-5-5", {
        inputTokens: 2_000,
        outputTokens: 1_500,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 4_000,
      }),
      12,
    );
  });

  it("price a Haiku prompt above 100K tokens at the long-prompt rate", () => {
    const usage = {
      input: 90_000,
      output: 100,
      cacheRead: 20_000,
      cacheWrite: 0,
      totalTokens: 110_100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    calculateCost({ cost: tierModelCost("haiku") } as never, usage as never);
    expect(usage.cost.total).toBeCloseTo(
      anthropicCostUsd("claude-haiku-5-5", {
        inputTokens: 90_000,
        outputTokens: 100,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 0,
      }),
      12,
    );
  });

  it("round-trip model ids", () => {
    expect(parseModelId(modelIdFor("opus"))).toEqual({ tier: "opus" });
  });

  it("send the real model id, omitted thinking text, and the tier's effort", () => {
    const body = tierPayload(
      {
        model: "tier-haiku",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "low" },
      },
      "sonnet",
    );
    expect(body).toMatchObject({
      model: "claude-sonnet-5-5",
      thinking: { type: "adaptive", display: "omitted" },
      output_config: { effort: "medium" },
    });
  });
});
