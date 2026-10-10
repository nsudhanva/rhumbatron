// The planner output is untrusted model text. Only a schema-valid, acyclic graph may reach D1.
import type { CompletionRequest, CompletionResult } from "@rhumbatron/model-router";
import { describe, expect, it, vi } from "vitest";
import {
  isEmptyRepository,
  PlannerError,
  parsePlan,
  planChange,
  planChangeResult,
} from "./root-planner.ts";

const task = (key: string, dependsOn: string[] = []) => ({
  key,
  title: `Task ${key}`,
  kind: "implement",
  objective: "Implement the shared wishlist storage.",
  semanticResources: ["wishlist:membership"],
  dependsOn,
  acceptanceCriteria: ["Owner can create a wishlist"],
  riskTier: "medium",
  complexity: "medium",
  touchesAuthorization: false,
  touchesBilling: false,
  touchesMigration: false,
});
const plan = (tasks: unknown[]) =>
  JSON.stringify({
    acceptanceCriteria: ["Wishlists can be shared"],
    invariants: [],
    riskTier: "medium",
    tasks,
  });

function reply(args: string | null): CompletionResult {
  const toolCalls: CompletionResult["toolCalls"] =
    args === null
      ? []
      : [{ id: "c1", type: "function", function: { name: "submit_work_graph", arguments: args } }];
  return {
    provider: "anthropic",
    model: "test",
    tier: "sonnet",
    content: null,
    toolCalls,
    message: { role: "assistant", content: null, tool_calls: toolCalls },
    finishReason: "tool_use",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    latencyMs: 1,
    gatewayLogId: null,
  };
}

describe("parsePlan", () => {
  it("accepts a valid DAG and rejects cycles, bad JSON, and schema errors", () => {
    expect(parsePlan(plan([task("t1"), task("t2", ["t1"])]))).toMatchObject({
      ok: true,
      order: ["t1", "t2"],
    });
    expect(parsePlan(plan([task("t1", ["t2"]), task("t2", ["t1"])])).ok).toBe(false);
    expect(parsePlan("{not json").ok).toBe(false);
    expect(parsePlan(plan([{ ...task("t1"), riskTier: "extreme" }])).ok).toBe(false);
    expect(parsePlan(undefined).ok).toBe(false);
  });
});

describe("bootstrap Task for an empty repository", () => {
  it("knows an empty repository by its missing package.json", () => {
    expect(isEmptyRepository([".gitignore"])).toBe(true);
    expect(isEmptyRepository([".gitignore", "package.json", "src/app.ts"])).toBe(false);
    expect(isEmptyRepository(null)).toBe(false);
  });

  it("requires t1 as an implement Task that every other Task reaches", () => {
    const empty = { emptyRepository: true };
    expect(parsePlan(plan([task("t1"), task("t2", ["t1"]), task("t3", ["t2"])]), empty).ok).toBe(
      true,
    );
    // t3 runs in parallel with the bootstrap: rejected.
    const parallel = parsePlan(plan([task("t1"), task("t2", ["t1"]), task("t3")]), empty);
    expect(parallel).toMatchObject({ ok: false });
    expect(JSON.stringify(parallel)).toContain("t3 must depend on the bootstrap Task t1");
    // t1 is a design Task: rejected.
    expect(parsePlan(plan([{ ...task("t1"), kind: "design" }]), empty).ok).toBe(false);
    // A repository with an app needs no bootstrap.
    expect(parsePlan(plan([task("t1"), task("t2")])).ok).toBe(true);
  });
});

describe("planChange", () => {
  it("repairs once with the validation errors, then succeeds", async () => {
    const seen: CompletionRequest[] = [];
    const replies = [reply(plan([task("t1", ["t9"])])), reply(plan([task("t1")]))];
    const result = await planChange({ goal: "Add wishlists", projectName: "Acme" }, async (req) => {
      seen.push(structuredClone(req));
      return replies.shift() ?? reply(null);
    });
    expect(result.attempts).toBe(2);
    expect(seen[0]?.tier).toBe("opus");
    expect(JSON.stringify(seen[1]?.messages.at(-1))).toContain("unknown task t9");
  });

  it("gives up after two invalid answers", async () => {
    await expect(
      planChange({ goal: "Add wishlists", projectName: "Acme" }, async () => reply(null)),
    ).rejects.toBeInstanceOf(PlannerError);
  });
});

describe("planner Workflow step result", () => {
  it("preserves validation errors across serialization and logs each invalid attempt", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const invalid = plan([task("t1", ["t9"])]);
      const expected = parsePlan(invalid);
      expect(expected.ok).toBe(false);
      const complete = vi.fn(async () => {
        const result = reply(invalid);
        result.message.content = "private model reasoning must not be stored";
        return result;
      });
      const result = await planChangeResult(
        { goal: "Add wishlists", projectName: "Acme" },
        complete,
      );
      expect(JSON.parse(JSON.stringify(result))).toEqual(expected);
      expect(complete).toHaveBeenCalledTimes(2);
      expect(warnings.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        { event: "planner.invalid", errors: !expected.ok ? expected.errors : [], attempt: 1 },
        { event: "planner.invalid", errors: !expected.ok ? expected.errors : [], attempt: 2 },
      ]);
      expect(JSON.stringify(result)).not.toContain("private model reasoning");
    } finally {
      warnings.mockRestore();
    }
  });

  it("returns a valid plan as serializable data", async () => {
    const result = await planChangeResult(
      { goal: "Add wishlists", projectName: "Acme" },
      async () => reply(plan([task("t1")])),
    );
    expect(JSON.parse(JSON.stringify(result))).toMatchObject({
      ok: true,
      planned: { attempts: 1, order: ["t1"] },
    });
  });

  it("lets transient model errors throw so the Workflow can retry", async () => {
    const error = new Error("model request timed out");
    const complete = vi.fn(async () => {
      throw error;
    });
    await expect(
      planChangeResult({ goal: "Add wishlists", projectName: "Acme" }, complete),
    ).rejects.toBe(error);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
