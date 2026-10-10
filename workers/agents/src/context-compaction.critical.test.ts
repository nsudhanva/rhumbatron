// Compaction is optional; failures must preserve replay evidence and refuse unbudgeted model work.
import { type CompileInput, compilePacket } from "@rhumbatron/context-compiler";
import {
  AGENT_DAILY_CALL_CAP,
  type CompletionRequest,
  type CompletionResult,
  USAGE_COUNTER,
} from "@rhumbatron/model-router";
import { describe, expect, it, vi } from "vitest";
import {
  COMPACTION_MAX_OUTPUT_TOKENS,
  COMPACTION_THRESHOLD_TOKENS,
  CompactionAccountingError,
  type CompactionDeps,
  compactPriorLogs,
} from "./context-compaction.ts";

const prefix = "context/proj_1/chg_1/tsk_1";
const originalRef = `${prefix}/attempt-1.json`;
const failureRef = "task_runs:run_1:outcome_json";
const error = "src/wishlist.ts:7: TS2304: Cannot find name 'Wishlist'.";
const summary = {
  summary: "Added wishlist storage. The TypeScript build failed.",
  errors: [error],
  files: ["src/wishlist.ts"],
};
const logs = [{ sourceRefs: [failureRef, originalRef], body: `Edited src/wishlist.ts. ${error}` }];
const input = { prefix, attempt: 2, logs, budgetUsd: 1 };

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected test evidence to exist");
  return value;
}

function fakeDeps(overrides: Partial<CompletionResult> = {}) {
  const objects = new Map<string, unknown>([[originalRef, { fullTranscript: logs[0]?.body }]]);
  const completion: CompletionResult = {
    provider: "anthropic",
    model: "claude-haiku-5-5",
    tier: "haiku",
    content: JSON.stringify(summary),
    toolCalls: [],
    message: { role: "assistant", content: JSON.stringify(summary) },
    finishReason: "end_turn",
    inputTokens: 120,
    outputTokens: 60,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.001,
    latencyMs: 1,
    gatewayLogId: "test-log",
    ...overrides,
  };
  const deps = {
    readJson: vi.fn(async (key: string) => objects.get(key) ?? null),
    writeJson: vi.fn(async (key: string, value: unknown) => {
      objects.set(key, structuredClone(value));
    }),
    takeQuota: vi.fn(async (_counter: string, _cap: number) => true),
    callModel: vi.fn(async (_request: CompletionRequest) => completion),
    recordCall: vi.fn(async (_hash: string, _result: CompletionResult | null) => undefined),
  } satisfies CompactionDeps;
  return { deps, objects, completion };
}

function fallbackPacket(sourceRefs: string[]) {
  const packetInput: CompileInput = {
    projectId: "proj_1",
    canonicalGeneration: 1841,
    now: "2026-10-09T00:00:00.000Z",
    change: {
      id: "chg_1",
      goal: "Add wishlists",
      acceptanceCriteria: ["wishlist works"],
      invariants: ["cart unchanged"],
      updatedAt: "v1",
    },
    task: {
      id: "tsk_1",
      key: "t1",
      kind: "implement",
      title: "Wishlist storage",
      objective: "Implement wishlist storage",
      riskTier: "medium",
      acceptanceCriteria: ["build passes"],
      semanticResources: ["project:acme:wishlist:storage"],
      updatedAt: "v1",
    },
    dependencyIntents: [],
    nearbyIntents: [],
    priorFailures: [
      {
        runId: "run_1",
        attempt: 1,
        tier: "haiku",
        kind: "agent_failed",
        reason: error.repeat(100),
        endedAt: "2026-10-09T00:00:00.000Z",
        sourceRefs,
      },
    ],
    allowedTools: ["read_file", "complete_task"],
    budget: { maxModelCalls: 6, budgetUsd: 0 },
    maxTokens: 1,
  };
  return compilePacket(packetInput);
}

describe("prior Task context compaction", () => {
  it("stops new work when a charged call cannot be accounted for durably", async () => {
    const { deps, objects } = fakeDeps();
    deps.recordCall.mockRejectedValue(new Error("D1 unavailable"));
    await expect(compactPriorLogs(deps, input)).rejects.toBeInstanceOf(CompactionAccountingError);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(objects.has(originalRef)).toBe(true);
    expect([...objects.keys()].some((key) => key.includes("/compact-"))).toBe(false);
  });

  it("reuses the same source hash without a model call or quota slot", async () => {
    const { deps, objects } = fakeDeps();
    const first = await compactPriorLogs(deps, input);
    expect(first.compaction).toMatchObject(summary);
    const second = await compactPriorLogs(deps, { ...input, attempt: 3, budgetUsd: 0 });

    expect(second.compaction).toEqual(first.compaction);
    expect(second.costUsd).toBe(0);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(deps.takeQuota).toHaveBeenCalledTimes(1);
    expect(deps.recordCall).toHaveBeenCalledTimes(1);
    expect(objects.get(required(first.compaction).r2Key)).toMatchObject({
      result: summary,
      sourceHash: required(first.compaction).sourceHash,
      sourceRefs: first.sourceRefs,
    });
  });

  it.each([0, Number.MIN_VALUE])(
    "refuses budget %s and preserves truncation fallback provenance",
    async (budgetUsd) => {
      const { deps, objects } = fakeDeps();
      const result = await compactPriorLogs(deps, { ...input, budgetUsd });
      expect(result.compaction).toBeNull();
      expect(result.costUsd).toBe(0);
      expect(deps.callModel).not.toHaveBeenCalled();
      expect(deps.takeQuota).not.toHaveBeenCalled();
      expect(deps.recordCall).not.toHaveBeenCalled();
      expect(result.sourceRefs).toEqual(expect.arrayContaining([failureRef, originalRef]));
      const sourceKey = result.sourceRefs.find((ref) => ref.startsWith(`${prefix}/source-`));
      expect(sourceKey).toBeDefined();
      expect(objects.get(required(sourceKey))).toEqual(logs);
      const packet = fallbackPacket(result.sourceRefs);
      expect(packet.items.some((item) => item.source === "compaction")).toBe(false);
      expect(packet.items.some((item) => item.itemId === "failure:run_1")).toBe(false);
      const provenance = packet.items.find((item) => item.itemId === "failure-evidence:run_1");
      for (const ref of result.sourceRefs) expect(provenance?.body).toContain(ref);
    },
  );

  it("refuses the daily agent call cap without calling or charging a model", async () => {
    const { deps } = fakeDeps();
    deps.takeQuota.mockResolvedValue(false);
    const result = await compactPriorLogs(deps, input);
    expect(result.compaction).toBeNull();
    expect(deps.takeQuota).toHaveBeenCalledWith(USAGE_COUNTER.agentCalls, AGENT_DAILY_CALL_CAP);
    expect(deps.callModel).not.toHaveBeenCalled();
    expect(deps.recordCall).not.toHaveBeenCalled();
    expect(result.sourceRefs).toContain(originalRef);
  });

  it("accounts for a call the monthly budget refused, and keeps the fallback", async () => {
    const { deps } = fakeDeps();
    deps.callModel.mockRejectedValue(new Error("Monthly Anthropic budget reached"));
    const result = await compactPriorLogs(deps, input);
    expect(result.compaction).toBeNull();
    expect(result.costUsd).toBe(0);
    expect(deps.recordCall).toHaveBeenCalledExactlyOnceWith(expect.any(String), null);
  });

  it.each([
    ["non-JSON", "not json"],
    ["missing files", JSON.stringify({ summary: "Tried building", errors: [error] })],
    ["wrong error type", JSON.stringify({ ...summary, errors: error })],
    ["extra model fields", JSON.stringify({ ...summary, sourceRefs: ["invented evidence"] })],
    ["empty summary", JSON.stringify({ ...summary, summary: " " })],
    [
      "over output bound",
      JSON.stringify({ ...summary, summary: "s".repeat(3100), errors: ["e".repeat(500)] }),
    ],
  ])("rejects %s output while accounting for the spent call", async (_name, content) => {
    const { deps, completion, objects } = fakeDeps({ content });
    const result = await compactPriorLogs(deps, input);
    expect(result.compaction).toBeNull();
    expect(result.costUsd).toBe(completion.costUsd);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
    expect(deps.recordCall).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^[a-f0-9]{64}$/),
      completion,
    );
    expect([...objects.keys()].some((key) => key.includes("/compact-"))).toBe(false);
    expect(result.sourceRefs).toEqual(expect.arrayContaining([failureRef, originalRef]));
  });

  it("rejects a length-limited response even if its partial JSON validates", async () => {
    const { deps, completion } = fakeDeps({ finishReason: "max_tokens" });
    const result = await compactPriorLogs(deps, input);
    expect(result.compaction).toBeNull();
    expect(result.costUsd).toBe(completion.costUsd);
    expect(deps.recordCall).toHaveBeenCalledExactlyOnceWith(expect.any(String), completion);
    expect(result.sourceRefs).toContain(originalRef);
  });

  it("keeps source evidence complete and untouched when the model input is bounded", async () => {
    const { deps, objects } = fakeDeps();
    const priorEvidence = structuredClone(objects.get(originalRef));
    const largeLogs = [
      { sourceRefs: [failureRef, originalRef], body: `${"x".repeat(70_000)}\n${error}` },
    ];
    const result = await compactPriorLogs(deps, { ...input, logs: largeLogs });
    const compact = required(result.compaction);
    expect(compact).not.toBeNull();
    expect(objects.get(originalRef)).toEqual(priorEvidence);
    const sourceKey = required(
      result.sourceRefs.find((ref) => ref.startsWith(`${prefix}/source-`)),
    );
    expect(objects.get(sourceKey)).toEqual(largeLogs);
    expect(compact.sourceRefs).toEqual(result.sourceRefs);
    expect(compact.r2Key).toBe(`${prefix}/compact-${compact.sourceHash}.json`);
    expect(objects.get(compact.r2Key)).toMatchObject({ sourceRefs: result.sourceRefs });
    expect(deps.writeJson.mock.calls.every(([key]) => key !== originalRef)).toBe(true);
    const [request] = required(deps.callModel.mock.calls[0]);
    const prompt = required(request.messages.find((message) => message.role === "user")?.content);
    expect(prompt).toContain(sourceKey);
    expect(prompt).toContain(error);
    expect(prompt.length).toBeLessThan(required(largeLogs[0]).body.length);
  });

  it("skips short first-attempt logs but compacts a first-attempt log above the threshold", async () => {
    const { deps } = fakeDeps();
    const skipped = await compactPriorLogs(deps, { ...input, attempt: 1 });
    expect(skipped.compaction).toBeNull();
    expect(deps.callModel).not.toHaveBeenCalled();
    expect(deps.takeQuota).not.toHaveBeenCalled();
    expect(skipped.sourceRefs).toEqual([failureRef, originalRef]);
    const largeLogs = [
      { sourceRefs: [originalRef], body: "x".repeat(COMPACTION_THRESHOLD_TOKENS * 4 + 1) },
    ];
    const compacted = await compactPriorLogs(deps, { ...input, attempt: 1, logs: largeLogs });
    expect(compacted.compaction).toMatchObject(summary);
    expect(deps.callModel).toHaveBeenCalledTimes(1);
  });

  it("uses the Haiku tier with at most 800 output tokens", async () => {
    const { deps } = fakeDeps();
    await compactPriorLogs(deps, input);
    const [request] = required(deps.callModel.mock.calls[0]);
    expect(request.tier).toBe("haiku");
    expect(request.maxOutputTokens).toBeLessThanOrEqual(800);
    expect(request.maxOutputTokens).toBe(COMPACTION_MAX_OUTPUT_TOKENS);
    expect(request.metadata?.kind).toBe("context_compaction");
    expect(request.messages.find((message) => message.role === "system")?.content).toContain(
      "exact error messages",
    );
  });
});
