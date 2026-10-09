// Conflict persistence is idempotent only if two agents that detect the same pair compute the same
// conflict ID and an identical Challenge. Otherwise the shard rejects the second Challenge as
// `id_reused`, or D1 records the conflict twice.
import type { Intent } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { conflictId, planConflicts } from "./conflicts.ts";

const intent = (id: string, taskId: string, model: "mutable_table" | "append_only"): Intent => ({
  intentId: id,
  taskId,
  agentId: `agent-${taskId}`,
  summary: `Store wishlist membership as ${model}`,
  semanticResources: ["wishlist:membership"],
  expectedFiles: [`src/wishlist/${model}.ts`],
  expectedSymbols: [],
  expectedContractChanges: [],
  expectedDataChanges: [
    { entity: "wishlist_members", kind: "add", model, description: `wishlist_members ${model}` },
  ],
  expectedSideEffects: [],
  assumptions: [],
  createdAt: id === "int-a" ? "2026-10-09T00:00:00.000Z" : "2026-10-09T00:01:00.000Z",
});

const a = intent("int-a", "task-a", "mutable_table");
const b = intent("int-b", "task-b", "append_only");
const tasks = new Map([
  ["task-a", { key: "T1", title: "Relational" }],
  ["task-b", { key: "T2", title: "Append-only" }],
]);
const plan = (intents: Intent[], done = new Set<string>(), activeCandidates = 0) =>
  planConflicts({
    intents,
    tasks,
    dependsOn: {},
    protectedResources: ["cart"],
    done,
    activeCandidates,
  });

describe("conflict persistence", () => {
  it("derives one ID per pair and resource, in any order", async () => {
    const id = await conflictId({ intentIds: ["int-a", "int-b"], resource: "wishlist:membership" });
    expect(
      await conflictId({ intentIds: ["int-b", "int-a"], resource: "wishlist:membership" }),
    ).toBe(id);
    expect(await conflictId({ intentIds: ["int-a", "int-b"], resource: "wishlist" })).not.toBe(id);
  });

  it("plans the same confirmed conflict and Challenge from either detector, once", async () => {
    const [first, ...rest] = await plan([a, b]);
    expect(rest).toHaveLength(0);
    expect(first?.review.state).toBe("confirmed");
    expect(first?.forkDecision.kind).toBe("fork");
    expect(first?.challenge).toMatchObject({
      kind: "data_semantics_conflict",
      sourceAgentId: "agent-task-a",
      targetIntentId: "int-b",
    });
    expect(await plan([b, a])).toEqual([first]);
    expect(await plan([a, b], new Set([first?.id ?? ""]))).toEqual([]);
  });

  it("blocks a fork that would pass the Candidate limit", async () => {
    const [conflict] = await plan([a, b], new Set(), 2);
    expect(conflict?.forkDecision).toMatchObject({ kind: "blocked", maxCandidates: 3 });
  });
});
