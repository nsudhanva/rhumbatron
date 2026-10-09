// Deterministic routing floors (AGENTS.md section 23.2). A wrong floor sends risky work to a weak model.
import type { RouteRequest } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { routeByRules } from "./rules.ts";

const base: RouteRequest = {
  taskKind: "implement",
  complexity: "medium",
  riskTier: "medium",
  affectedFiles: 2,
  affectedResources: ["project:acme:wishlist"],
  attempt: 1,
  priorFailureKinds: [],
  hasDesignConflict: false,
  touchesAuthorization: false,
  touchesBilling: false,
  touchesMigration: false,
  destructiveMigration: false,
  contextTokensEstimate: 4000,
  expectedToolCalls: 5,
  budgetRemainingUsd: 3,
};
const tier = (patch: Partial<RouteRequest>) => routeByRules({ ...base, ...patch }).selectedTier;

describe("routeByRules", () => {
  it("routes by complexity and risk", () => {
    expect(tier({ complexity: "small", riskTier: "low" })).toBe("haiku");
    expect(tier({ complexity: "small", riskTier: "low", attempt: 2 })).toBe("sonnet");
    expect(tier({})).toBe("sonnet");
    expect(tier({ complexity: "large", taskKind: "plan" })).toBe("opus");
    expect(tier({ complexity: "large" })).toBe("sonnet");
    expect(tier({ taskKind: "summarize", complexity: "large", riskTier: "high" })).toBe("haiku");
  });

  it("forces opus for destructive migrations and cross-resource conflicts", () => {
    expect(tier({ complexity: "small", riskTier: "low", destructiveMigration: true })).toBe("opus");
    expect(tier({ hasDesignConflict: true, affectedResources: ["a:b", "c:d"] })).toBe("opus");
    expect(tier({ hasDesignConflict: true })).toBe("sonnet");
  });

  it("keeps authorization and billing work at sonnet or above", () => {
    expect(tier({ taskKind: "transform", touchesAuthorization: true })).toBe("sonnet");
    expect(tier({ complexity: "small", riskTier: "low", touchesAuthorization: true })).toBe(
      "haiku",
    );
    expect(tier({ complexity: "small", riskTier: "low", touchesBilling: true })).toBe("sonnet");
  });
});
