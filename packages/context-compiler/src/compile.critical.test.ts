// The packet decides what an agent may see. Order and trimming must be deterministic and keep the
// Task's own scope, or two agents with the same snapshot could get different inputs.

import { ContextPacket } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { type CompileInput, compilePacket, packetHash } from "./compile.ts";

const intent = (n: number, size = 10) => ({
  taskId: `tsk_${n}`,
  taskKey: `t${n}`,
  title: `Task ${n}`,
  runId: `run_${n}_1`,
  endedAt: "2026-10-08T00:00:00.000Z",
  resources: ["wishlist:core"],
  intent: { summary: "x".repeat(size), expectedFiles: ["a.ts"] },
});

const base: CompileInput = {
  projectId: "proj_1",
  canonicalGeneration: 0,
  now: "2026-10-08T00:00:00.000Z",
  change: {
    id: "chg_1",
    goal: "Add wishlists",
    acceptanceCriteria: ["works"],
    invariants: ["cart unchanged"],
    updatedAt: "v1",
  },
  task: {
    id: "tsk_9",
    key: "t9",
    kind: "implement",
    title: "Build it",
    objective: "Build the wishlist API",
    riskTier: "medium",
    acceptanceCriteria: ["api works"],
    semanticResources: ["project:acme:wishlist:core"],
    updatedAt: "v1",
  },
  dependencyIntents: [intent(1)],
  nearbyIntents: [intent(2)],
  priorFailures: [
    {
      runId: "run_9_1",
      attempt: 1,
      tier: "haiku",
      kind: "no_outcome",
      reason: "stopped",
      endedAt: "t",
    },
  ],
  allowedTools: ["complete_task", "fail_task"],
  budget: { maxModelCalls: 6, budgetUsd: 1 },
  maxTokens: 10_000,
};

describe("compilePacket", () => {
  it("orders items by retrieval priority with provenance", () => {
    const packet = compilePacket(base);
    expect(packet.items.map((i) => i.source)).toEqual([
      "change",
      "task",
      "dependency_intent",
      "prior_failure",
      "nearby_intent",
    ]);
    expect(packet.items.every((i) => i.itemId && i.sourceVersion && i.capturedAt)).toBe(true);
  });

  it("drops optional items over budget but always keeps the Change and the Task", () => {
    const packet = compilePacket({ ...base, nearbyIntents: [intent(2, 40_000)], maxTokens: 500 });
    expect(packet.items.map((i) => i.source)).toEqual([
      "change",
      "task",
      "dependency_intent",
      "prior_failure",
    ]);
    expect(packet.tokenEstimate).toBeLessThanOrEqual(500);
  });

  it("tells a stacked Task which upstream ChangeSets its workspace already contains", () => {
    const packet = compilePacket({
      ...base,
      inheritedChangeSets: [
        {
          changeSetId: "cs_x_t3_1",
          taskKey: "t3",
          title: "Wishlist CRUD",
          commit: "a".repeat(40),
          files: ["src/wishlist.ts", "src/app.ts"],
        },
      ],
      maxTokens: 10,
    });
    // Required, like the Task itself: never trimmed for budget.
    const item = packet.items.find((i) => i.source === "dependency_changeset");
    expect(item?.sourceVersion).toBe("a".repeat(40));
    expect(item?.body).toContain("cs_x_t3_1");
    expect(item?.body).toContain("- src/wishlist.ts");
    expect(compilePacket(base).items.some((i) => i.source === "dependency_changeset")).toBe(false);
  });

  it("hashes identical inputs identically", async () => {
    expect(await packetHash(compilePacket(base))).toBe(await packetHash(compilePacket(base)));
  });

  it("uses compact prior logs with their source hash and keeps every source reference when trimming", () => {
    const sourceHash = "b".repeat(64);
    const sourceRefs = [
      "task_runs:run_9_1:outcome_json",
      "context/proj_1/chg_1/tsk_9/original.json",
      "evidence/proj_1/chg_1/tsk_9/attempt-1.json",
    ];
    const r2Key = `context/proj_1/chg_1/tsk_9/compact-${sourceHash}.json`;
    const packet = compilePacket({
      ...base,
      compaction: {
        sourceHash,
        summary: "Tried adding wishlist storage. The build failed.",
        errors: ["src/wishlist.ts:1: TS2304: Cannot find name 'Wishlist'."],
        files: ["src/wishlist.ts"],
        sourceRefs,
        r2Key,
      },
      maxTokens: 1,
    });
    expect(ContextPacket.safeParse(packet).success).toBe(true);
    const item = packet.items.find((i) => i.source === "compaction");
    expect(item?.sourceVersion).toBe(sourceHash);
    expect(item?.body).toContain("TS2304: Cannot find name 'Wishlist'.");
    expect(item?.body).toContain("src/wishlist.ts");
    expect(item?.body).toContain(r2Key);
    for (const ref of sourceRefs) expect(item?.body).toContain(ref);
    expect(packet.items.some((i) => i.source === "prior_failure")).toBe(false);
    expect(packet.items.map((i) => i.source)).toEqual(["change", "task", "compaction"]);
  });

  it("keeps original failure references when compaction is unavailable and failure text is trimmed", () => {
    const sourceRefs = [
      "task_runs:run_9_1:outcome_json",
      "context/proj_1/chg_1/tsk_9/original.json",
    ];
    const packet = compilePacket({
      ...base,
      priorFailures: base.priorFailures.map((failure) => ({ ...failure, sourceRefs })),
      maxTokens: 1,
    });
    const provenance = packet.items.find((item) => item.itemId === "failure-evidence:run_9_1");
    expect(provenance?.source).toBe("prior_failure");
    expect(provenance?.sourceVersion).toBe("run_9_1");
    for (const ref of sourceRefs) expect(provenance?.body).toContain(ref);
    expect(packet.items.some((item) => item.itemId === "failure:run_9_1")).toBe(false);
  });
});
