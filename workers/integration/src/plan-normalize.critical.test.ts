import { describe, expect, it } from "vitest";
import { normalizeToolArgs } from "./plan-normalize.ts";

describe("normalizeToolArgs", () => {
  it("undoes a twice-encoded enum string (prod planner, riskTier)", () => {
    expect(normalizeToolArgs({ riskTier: '"low"', tasks: [{ kind: ' "implement" ' }] })).toEqual({
      riskTier: "low",
      tasks: [{ kind: "implement" }],
    });
  });

  it("turns string booleans into booleans", () => {
    expect(normalizeToolArgs({ touchesBilling: "false", touchesMigration: '"true"' })).toEqual({
      touchesBilling: false,
      touchesMigration: true,
    });
  });

  it("leaves normal text, quotes inside text, and other types alone", () => {
    const input = {
      objective: 'Add a "Clear done" button',
      title: "  padded  ",
      n: 3,
      list: ["a", "b"],
    };
    expect(normalizeToolArgs(input)).toEqual(input);
  });
});

describe("parsePlan with normalized arguments", () => {
  it("accepts a plan whose riskTier was encoded twice", async () => {
    const { parsePlan } = await import("./root-planner.ts");
    const plan = {
      acceptanceCriteria: ["Sub-items can be added"],
      invariants: [],
      riskTier: '"low"',
      tasks: [
        {
          key: "t1",
          title: "Sub-item API",
          kind: "implement",
          objective: "Add sub-items to each todo item",
          semanticResources: ["todo:subitems"],
          dependsOn: [],
          acceptanceCriteria: ["API adds sub-items"],
          riskTier: '"low"',
          complexity: "small",
          touchesAuthorization: "false",
          touchesBilling: false,
          touchesMigration: false,
        },
      ],
    };
    const outcome = parsePlan(JSON.stringify(plan));
    expect(outcome.ok ? "ok" : outcome.errors.join("; ")).toBe("ok");
  });
});
