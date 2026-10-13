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

  it("cuts a long title at a word boundary and never rejects a plan for its title", () => {
    const titled = (title: unknown) =>
      parsePlan(JSON.stringify({ ...JSON.parse(plan([task("t1")])), title }));
    expect(titled("Shared wishlists with collaborator links and revocable sharing.")).toMatchObject(
      { ok: true, plan: { title: "Shared wishlists with collaborator links" } },
    );
    expect(titled("Kanban feature")).toMatchObject({ ok: true, plan: { title: "Kanban feature" } });
    expect(parsePlan(plan([task("t1")]))).toMatchObject({ ok: true, plan: { title: "" } });
    expect(titled(42)).toMatchObject({ ok: true, plan: { title: "" } });
  });

  it("records open details as assumptions and never rejects a plan for them", () => {
    const withAssumptions = (assumptions: unknown) =>
      parsePlan(JSON.stringify({ ...JSON.parse(plan([task("t1")])), assumptions }));
    expect(
      withAssumptions(["Use the classic 16-color set.", 7, "ok", "  ", "  Pixels are 8 px.  "]),
    ).toMatchObject({
      ok: true,
      plan: { assumptions: ["Use the classic 16-color set.", "Pixels are 8 px."] },
    });
    const many = Array.from({ length: 12 }, (_, i) => `Assumption number ${i}`);
    expect(withAssumptions(many)).toMatchObject({ ok: true });
    const parsed = withAssumptions(many);
    expect(parsed.ok && parsed.plan.assumptions).toHaveLength(8);
    expect(parsePlan(plan([task("t1")]))).toMatchObject({ ok: true, plan: { assumptions: [] } });
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

// Seen on prod: a todo UI planned in parallel with its API guessed the routes and field names.
describe("UI -> API dependency repair", () => {
  const titled = (key: string, title: string, resources: string[], dependsOn: string[] = []) => ({
    ...task(key, dependsOn),
    title,
    semanticResources: resources,
  });

  it("makes a UI Task depend on the API Task of the same area, with no model call", () => {
    const outcome = parsePlan(
      plan([
        titled("t1", "Bootstrap the app", ["app:shell"]),
        titled("t2", "Todo API with storage", ["todos:api"], ["t1"]),
        titled("t3", "Todo home page UI", ["todos:ui"], ["t1"]),
      ]),
      { emptyRepository: true },
    );
    expect(outcome).toMatchObject({ ok: true, order: ["t1", "t2", "t3"], linked: ["t3->t2"] });
    if (!outcome.ok) throw new Error("expected a plan");
    expect(outcome.plan.tasks.find((t) => t.key === "t3")?.dependsOn).toEqual(["t1", "t2"]);
  });

  it("finds the UI by title, keeps existing paths, and ignores other areas", () => {
    const byTitle = parsePlan(
      plan([
        titled("t1", "Missions API", ["missions:api"]),
        titled("t2", "Calendar page", ["missions:calendar"]),
        titled("t3", "Cart UI", ["cart:ui"]),
      ]),
    );
    // The two UI Tasks share public/index.html: the later one runs after the earlier one.
    expect(byTitle).toMatchObject({ ok: true, linked: ["t2->t1", "t3->t2"] });
    // A path already exists (t3 -> t2 -> t1): nothing to add.
    const ordered = parsePlan(
      plan([
        titled("t1", "Todo API", ["todos:api"]),
        titled("t2", "Todo storage", ["todos:storage"], ["t1"]),
        titled("t3", "Todo UI", ["todos:ui"], ["t2"]),
      ]),
    );
    expect(ordered).toMatchObject({ ok: true, linked: [] });
  });
});

// Seen on prod: two UI Tasks built in parallel both edited public/index.html and did not merge.
describe("same-surface ordering", () => {
  const titled = (key: string, title: string, resources: string[], dependsOn: string[] = []) => ({
    ...task(key, dependsOn),
    title,
    semanticResources: resources,
  });
  it("runs Tasks of one kind in plan order and keeps a UI and an API Task in parallel", () => {
    const outcome = parsePlan(
      plan([
        titled("t1", "Bootstrap the app", ["app:bootstrap"]),
        titled("t2", "Laws API", ["laws:api"], ["t1"]),
        titled("t3", "Votes API", ["votes:api"], ["t1"]),
        titled("t4", "Laws page", ["laws:ui"], ["t2"]),
        titled("t5", "Constitution page", ["constitution:ui"], ["t2"]),
      ]),
      { emptyRepository: true },
    );
    if (!outcome.ok) throw new Error("expected a plan");
    const deps = Object.fromEntries(outcome.plan.tasks.map((t) => [t.key, t.dependsOn]));
    expect(deps.t3).toEqual(["t1", "t2"]);
    expect(deps.t5).toEqual(["t2", "t4"]);
    // The laws page and the votes API share no file: no edge between them.
    expect(deps.t4).toEqual(["t2"]);
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
