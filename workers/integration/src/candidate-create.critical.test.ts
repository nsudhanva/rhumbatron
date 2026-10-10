// Candidate creation is a retry boundary (AGENTS.md section 60) and enforces the fork rule
// (section 32.4) and the Candidate limit (section 44). Invariants: a repeated trigger yields the
// same Candidate IDs and no new rows; a fork conflict yields one Candidate per side, each with the
// shared non-conflicting ChangeSets; a ChangeSet stacked on or dependent on one side joins only that
// side's Candidate, and one requiring both sides joins neither (deferred, with a reason); a Change
// never holds more than MAX_CANDIDATES Candidates.
import { COMPOSITION_RULES_VERSION } from "@rhumbatron/evidence";
import { MAX_TASKS_PER_CHANGE } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import type { TaskEdge } from "./candidate-composer.ts";
import {
  composeChangeCandidates,
  compositionKeyFor,
  createCandidate,
  type ForkConflict,
  MAX_CANDIDATES,
  planCandidateSets,
} from "./candidate-create.ts";

const CHANGE = "chg_test-1";

describe("compositionKeyFor", () => {
  it("is stable, order-independent, and includes the rules version", async () => {
    const a = await compositionKeyFor(CHANGE, 7, ["cs_b", "cs_a"]);
    const b = await compositionKeyFor(CHANGE, 7, ["cs_a", "cs_b"]);
    expect(a).toEqual(b);
    expect(a.candidateId).toMatch(/^cand_[a-f0-9]{24}$/);
    expect(a.candidateId).toBe(`cand_${a.compositionKey.slice(0, 24)}`);
    const text = `${CHANGE}\n7\ncs_a,cs_b\nrules=${COMPOSITION_RULES_VERSION}`;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    const hex = [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, "0")).join("");
    expect(a.compositionKey).toBe(hex);
    expect((await compositionKeyFor(CHANGE, 8, ["cs_a", "cs_b"])).candidateId).not.toBe(
      a.candidateId,
    );
  });
});

describe("planCandidateSets", () => {
  const proposed = [
    { id: "cs_t1_1", taskId: "tsk_t1" },
    { id: "cs_t2_1", taskId: "tsk_t2" },
    { id: "cs_t3_1", taskId: "tsk_t3" },
    { id: "cs_t4_1", taskId: "tsk_t4" },
  ];

  it("composes every proposed ChangeSet when no fork conflict exists", () => {
    expect(planCandidateSets(proposed, [])).toEqual({
      sets: [["cs_t1_1", "cs_t2_1", "cs_t3_1", "cs_t4_1"]],
      forkConflictId: null,
      deferred: [],
    });
  });

  it("forks one Candidate per side, each with the shared non-conflicting ChangeSets", () => {
    const plan = planCandidateSets(proposed, [{ id: "cf_1", sides: [["tsk_t2"], ["tsk_t3"]] }]);
    expect(plan.forkConflictId).toBe("cf_1");
    expect(plan.sets).toEqual([
      ["cs_t1_1", "cs_t2_1", "cs_t4_1"],
      ["cs_t1_1", "cs_t3_1", "cs_t4_1"],
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("ignores a fork conflict with a side that published nothing", () => {
    const plan = planCandidateSets(proposed, [{ id: "cf_1", sides: [["tsk_t2"], ["tsk_t9"]] }]);
    expect(plan.sets).toEqual([["cs_t1_1", "cs_t2_1", "cs_t3_1", "cs_t4_1"]]);
    expect(plan.forkConflictId).toBeNull();
  });

  it("stays within MAX_CANDIDATES and defers a second fork conflict", () => {
    const plan = planCandidateSets(proposed, [
      { id: "cf_1", sides: [["tsk_t1"], ["tsk_t2"]] },
      { id: "cf_2", sides: [["tsk_t3"], ["tsk_t4"]] },
    ]);
    expect(plan.sets).toEqual([["cs_t1_1"], ["cs_t2_1"]]);
    expect(plan.sets.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(plan.deferred.map((d) => d.id)).toEqual(["cs_t3_1", "cs_t4_1"]);
    expect(plan.deferred[0]?.reason).toContain("cf_2");
  });

  // t2 and t3 are the two designs; t1 is unstacked; t4 builds on t2 (stacked workspace).
  const stacked = (over: Record<string, string[]>) =>
    proposed.map((c) => ({ ...c, ...(over[c.id] ? { stackedOn: over[c.id] } : {}) }));
  const fork: ForkConflict[] = [{ id: "cf_1", sides: [["tsk_t2"], ["tsk_t3"]] }];

  it("puts an unstacked ChangeSet whose Task depends on side A only in A's Candidate", () => {
    const edges = [{ task_id: "tsk_t4", depends_on_task_id: "tsk_t2" }];
    const plan = planCandidateSets(proposed, fork, edges);
    expect(plan.sets).toEqual([
      ["cs_t1_1", "cs_t2_1", "cs_t4_1"],
      ["cs_t1_1", "cs_t3_1"],
    ]);
    expect(plan.deferred).toEqual([]);
    expect(planCandidateSets([...proposed].reverse(), fork, edges)).toEqual(plan);
  });

  it("defers an unstacked ChangeSet whose Task depends on both sides, with a reason", () => {
    const plan = planCandidateSets(proposed, fork, [
      { task_id: "tsk_t4", depends_on_task_id: "tsk_t2" },
      { task_id: "tsk_t4", depends_on_task_id: "tsk_t3" },
    ]);
    expect(plan.sets).toEqual([
      ["cs_t1_1", "cs_t2_1"],
      ["cs_t1_1", "cs_t3_1"],
    ]);
    expect(plan.deferred).toEqual([
      { id: "cs_t4_1", reason: expect.stringContaining("both sides of fork conflict cf_1") },
    ]);
    expect(plan.deferred[0]?.reason).toContain("cs_t2_1");
    expect(plan.deferred[0]?.reason).toContain("cs_t3_1");
  });

  it("follows transitive Task dependencies through a Task without a ChangeSet", () => {
    const edges = [
      { task_id: "tsk_t4", depends_on_task_id: "tsk_bridge" },
      { task_id: "tsk_bridge", depends_on_task_id: "tsk_t2" },
      { task_id: "tsk_t1", depends_on_task_id: "tsk_t4" },
    ];
    const plan = planCandidateSets(proposed, fork, edges);
    expect(plan.sets).toEqual([["cs_t1_1", "cs_t2_1", "cs_t4_1"], ["cs_t3_1"]]);
    expect(plan.deferred).toEqual([]);
    expect(planCandidateSets([...proposed].reverse(), fork, [...edges].reverse())).toEqual(plan);
  });

  it("unions stacked lineage and Task dependencies and defers their descendants", () => {
    const plan = planCandidateSets(stacked({ cs_t4_1: ["cs_t2_1"], cs_t1_1: ["cs_t4_1"] }), fork, [
      { task_id: "tsk_t4", depends_on_task_id: "tsk_t3" },
    ]);
    expect(plan.sets).toEqual([["cs_t2_1"], ["cs_t3_1"]]);
    expect(plan.deferred.map((d) => d.id)).toEqual(["cs_t1_1", "cs_t4_1"]);
  });

  it("puts a ChangeSet stacked on one side only in that side's Candidate", () => {
    const plan = planCandidateSets(stacked({ cs_t4_1: ["cs_t2_1"] }), fork);
    expect(plan.forkConflictId).toBe("cf_1");
    expect(plan.sets).toEqual([
      ["cs_t1_1", "cs_t2_1", "cs_t4_1"],
      ["cs_t1_1", "cs_t3_1"],
    ]);
    expect(plan.deferred).toEqual([]);
    // The same assignment for the other side, and through a transitive lineage.
    const other = planCandidateSets(stacked({ cs_t1_1: ["cs_t4_1"], cs_t4_1: ["cs_t3_1"] }), fork);
    expect(other.sets).toEqual([["cs_t2_1"], ["cs_t1_1", "cs_t3_1", "cs_t4_1"]]);
  });

  it("keeps an unstacked ChangeSet shared in both Candidates", () => {
    const plan = planCandidateSets(stacked({ cs_t4_1: ["cs_t2_1"] }), fork);
    for (const set of plan.sets) expect(set).toContain("cs_t1_1");
    // Stacked on a shared ChangeSet only: still shared.
    const onShared = planCandidateSets(stacked({ cs_t4_1: ["cs_t1_1"] }), fork);
    expect(onShared.sets).toEqual([
      ["cs_t1_1", "cs_t2_1", "cs_t4_1"],
      ["cs_t1_1", "cs_t3_1", "cs_t4_1"],
    ]);
  });

  it("defers a ChangeSet stacked on both sides, with a reason, and anything stacked on it", () => {
    const plan = planCandidateSets(
      stacked({ cs_t4_1: ["cs_t2_1", "cs_t3_1"], cs_t1_1: ["cs_t4_1"] }),
      fork,
    );
    expect(plan.sets).toEqual([["cs_t2_1"], ["cs_t3_1"]]);
    expect(plan.deferred.map((d) => d.id)).toEqual(["cs_t1_1", "cs_t4_1"]);
    for (const d of plan.deferred) {
      expect(d.reason).toContain("cf_1");
      expect(d.reason).toContain("cs_t2_1");
      expect(d.reason).toContain("cs_t3_1");
    }
    for (const set of plan.sets) for (const d of plan.deferred) expect(set).not.toContain(d.id);
  });

  it("defers a ChangeSet stacked on a later fork conflict's side, within MAX_CANDIDATES", () => {
    const five = [...proposed, { id: "cs_t5_1", taskId: "tsk_t5", stackedOn: ["cs_t4_1"] }];
    const plan = planCandidateSets(five, [
      { id: "cf_1", sides: [["tsk_t1"], ["tsk_t2"]] },
      { id: "cf_2", sides: [["tsk_t3"], ["tsk_t4"]] },
    ]);
    expect(plan.sets).toEqual([["cs_t1_1"], ["cs_t2_1"]]);
    expect(plan.sets.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    expect(plan.deferred.map((d) => d.id)).toEqual(["cs_t3_1", "cs_t4_1", "cs_t5_1"]);
    expect(plan.deferred[2]?.reason).toContain("stacked on cs_t4_1");
  });
});

/** A stored ChangeSet intent; only `changeSet.stackedOn` matters to the fork rule. */
function intentWith(stackedOn: string[] | undefined) {
  return {
    summary: "change",
    ...(stackedOn
      ? {
          changeSet: {
            fork: "acme-fork",
            commit: "a".repeat(40),
            baseCommit: "b".repeat(40),
            diffStat: "1 file changed",
            files: ["src/x.ts"],
            stackedOn,
          },
        }
      : {}),
  };
}

type CandidateRow = { id: string; change_id: string; change_set_ids_json: string };

/** Minimal D1, ProjectRootDO, ResourceShardDO, and Workflow stand-ins, answering by SQL shape. */
function fakeEnv(input: {
  changeSets: { id: string; taskId: string; stackedOn?: string[] }[];
  conflicts?: { id: string; taskIds: [string, string] }[];
  taskDependencies?: TaskEdge[];
  status?: string;
}) {
  const candidates: CandidateRow[] = [];
  const workflows = new Set<string>();
  const events: string[] = [];
  const payloads: Record<string, unknown>[] = [];
  const statement = (sql: string, args: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => {
      if (sql.includes("FROM changes c JOIN projects p")) {
        return {
          id: CHANGE,
          project_id: "proj_1",
          status: input.status ?? "verifying",
          base_generation: 3,
          org_id: "org_1",
          slug: "acme",
          project_status: "active",
        };
      }
      if (sql.startsWith("SELECT id FROM candidates")) {
        return candidates.find((c) => c.id === args[0]) ?? null;
      }
      throw new Error(`unexpected first: ${sql}`);
    },
    all: async () => {
      if (sql.includes("FROM task_dependencies d")) {
        expect(args).toEqual([CHANGE, MAX_TASKS_PER_CHANGE * MAX_TASKS_PER_CHANGE + 1]);
        expect(sql).toContain("JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?");
        expect(sql).toContain("LIMIT ?");
        return { results: (input.taskDependencies ?? []).slice(0, Number(args[1])) };
      }
      if (sql.includes("FROM changesets cs")) {
        return {
          results: input.changeSets.map((c) => ({
            id: c.id,
            task_id: c.taskId,
            intent_json: JSON.stringify(intentWith(c.stackedOn)),
          })),
        };
      }
      if (sql.includes("FROM conflicts")) {
        return {
          results: (input.conflicts ?? []).map((c) => ({
            id: c.id,
            intents_json: JSON.stringify(c.taskIds.map((taskId) => ({ taskId }))),
          })),
        };
      }
      throw new Error(`unexpected all: ${sql}`);
    },
    run: async () => {
      if (!sql.startsWith("INSERT INTO candidates")) throw new Error(`unexpected run: ${sql}`);
      // Includes two lineage lookups before the per-Change Candidate limit.
      const [id, changeId, , , , , ids, , , , max] = args as [
        string,
        string,
        number,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        number,
      ];
      const count = candidates.filter((c) => c.change_id === changeId).length;
      if (candidates.some((c) => c.id === id) || count >= Number(max)) {
        return { meta: { changes: 0 } };
      }
      candidates.push({ id, change_id: changeId, change_set_ids_json: ids });
      return { meta: { changes: 1 } };
    },
  });
  const namespace = (stub: object) => ({ idFromName: (n: string) => n, get: () => stub });
  const env = {
    DB: { prepare: (sql: string) => statement(sql) },
    PROJECT_ROOT: namespace({ getCanonical: async () => ({ artifactRef: "artifacts://acme" }) }),
    RESOURCE_SHARD: namespace({
      appendEvents: async (list: { eventId: string; payload: Record<string, unknown> }[]) => {
        for (const e of list) {
          if (events.includes(e.eventId)) continue;
          events.push(e.eventId);
          payloads.push(e.payload);
        }
      },
    }),
    CANDIDATE_WORKFLOW: {
      create: async ({ id }: { id: string }) => {
        if (workflows.has(id)) throw new Error("instance exists");
        workflows.add(id);
      },
      get: async (id: string) => {
        if (!workflows.has(id)) throw new Error("not found");
        return { id };
      },
    },
  } as unknown as Env;
  return { env, candidates, workflows, events, payloads };
}

const ids = (outcome: Awaited<ReturnType<typeof composeChangeCandidates>>) =>
  outcome.status === "composed"
    ? outcome.candidates.map((c) => (c.status === "refused" ? c.reason : c.candidateId))
    : [];

describe("composeChangeCandidates", () => {
  const changeSets = [
    { id: "cs_t1_1", taskId: "tsk_t1" },
    { id: "cs_t2_1", taskId: "tsk_t2" },
    { id: "cs_t3_1", taskId: "tsk_t3" },
  ];

  it("returns the same Candidates on a repeated trigger and creates nothing new", async () => {
    const fake = fakeEnv({ changeSets });
    const first = await composeChangeCandidates(fake.env, CHANGE);
    const second = await composeChangeCandidates(fake.env, CHANGE);
    expect(ids(first)).toEqual(ids(second));
    expect(fake.candidates).toHaveLength(1);
    expect(fake.workflows.size).toBe(1);
    expect(fake.events).toHaveLength(1);
    if (second.status !== "composed") throw new Error("expected composed");
    expect(second.candidates[0]?.status).toBe("existing");
    // The API path with the same ChangeSets finds the same Candidate.
    const api = await createCandidate(fake.env, { changeId: CHANGE });
    expect(api.status === "existing" && api.candidateId).toBe(ids(first)[0]);
  });

  it("forks one Candidate per side that shares the non-conflicting ChangeSets", async () => {
    const fake = fakeEnv({
      changeSets,
      conflicts: [{ id: "cf_1", taskIds: ["tsk_t2", "tsk_t3"] }],
    });
    const outcome = await composeChangeCandidates(fake.env, CHANGE);
    expect(outcome.status === "composed" && outcome.forkConflictId).toBe("cf_1");
    expect(fake.candidates.map((c) => JSON.parse(c.change_set_ids_json))).toEqual([
      ["cs_t1_1", "cs_t2_1"],
      ["cs_t1_1", "cs_t3_1"],
    ]);
    expect(fake.workflows.size).toBe(2);
    expect(ids(await composeChangeCandidates(fake.env, CHANGE))).toEqual(ids(outcome));
    expect(fake.candidates).toHaveLength(2);
  });

  it("reads stackedOn from the stored intent and reports a both-sides ChangeSet as deferred", async () => {
    const fake = fakeEnv({
      changeSets: [
        ...changeSets,
        { id: "cs_t4_1", taskId: "tsk_t4", stackedOn: ["cs_t2_1"] },
        { id: "cs_t5_1", taskId: "tsk_t5", stackedOn: ["cs_t2_1", "cs_t3_1"] },
      ],
      conflicts: [{ id: "cf_1", taskIds: ["tsk_t2", "tsk_t3"] }],
    });
    const outcome = await composeChangeCandidates(fake.env, CHANGE);
    if (outcome.status !== "composed") throw new Error("expected composed");
    expect(fake.candidates.map((c) => JSON.parse(c.change_set_ids_json))).toEqual([
      ["cs_t1_1", "cs_t2_1", "cs_t4_1"],
      ["cs_t1_1", "cs_t3_1"],
    ]);
    expect(outcome.deferred.map((d) => d.id)).toEqual(["cs_t5_1"]);
    // The event of every Candidate of the round records the deferral and its reason.
    for (const payload of fake.payloads) expect(payload.deferred).toEqual(outcome.deferred);
  });

  it("loads Task dependencies to assign unstacked ChangeSets and report deferrals", async () => {
    const fake = fakeEnv({
      changeSets: [
        ...changeSets,
        { id: "cs_t4_1", taskId: "tsk_t4", stackedOn: [] },
        { id: "cs_t5_1", taskId: "tsk_t5", stackedOn: [] },
      ],
      conflicts: [{ id: "cf_1", taskIds: ["tsk_t2", "tsk_t3"] }],
      taskDependencies: [
        { task_id: "tsk_t4", depends_on_task_id: "tsk_bridge" },
        { task_id: "tsk_bridge", depends_on_task_id: "tsk_t2" },
        { task_id: "tsk_t5", depends_on_task_id: "tsk_t4" },
        { task_id: "tsk_t5", depends_on_task_id: "tsk_t3" },
      ],
    });
    const outcome = await composeChangeCandidates(fake.env, CHANGE);
    if (outcome.status !== "composed") throw new Error("expected composed");
    expect(fake.candidates.map((c) => JSON.parse(c.change_set_ids_json))).toEqual([
      ["cs_t1_1", "cs_t2_1", "cs_t4_1"],
      ["cs_t1_1", "cs_t3_1"],
    ]);
    expect(outcome.deferred).toEqual([
      { id: "cs_t5_1", reason: expect.stringContaining("both sides of fork conflict cf_1") },
    ]);
    for (const payload of fake.payloads) expect(payload.deferred).toEqual(outcome.deferred);
    expect(ids(await composeChangeCandidates(fake.env, CHANGE))).toEqual(ids(outcome));
    expect(fake.candidates).toHaveLength(2);
  });

  it("creates no Candidates when the Task dependency graph exceeds the loader cap", async () => {
    const fake = fakeEnv({
      changeSets,
      taskDependencies: Array.from(
        { length: MAX_TASKS_PER_CHANGE * MAX_TASKS_PER_CHANGE + 1 },
        (_, i) => ({ task_id: `tsk_${i}`, depends_on_task_id: "tsk_t2" }),
      ),
    });
    await expect(composeChangeCandidates(fake.env, CHANGE)).rejects.toThrow(
      "Task dependency limit exceeded",
    );
    expect(fake.candidates).toHaveLength(0);
    expect(fake.workflows.size).toBe(0);
  });

  it("refuses a Candidate beyond MAX_CANDIDATES and starts no verification for it", async () => {
    const fake = fakeEnv({
      changeSets,
      conflicts: [{ id: "cf_1", taskIds: ["tsk_t2", "tsk_t3"] }],
    });
    for (const subset of [["cs_t1_1"], ["cs_t2_1"]]) {
      expect(
        (await createCandidate(fake.env, { changeId: CHANGE, changeSetIds: subset })).status,
      ).toBe("created");
    }
    const outcome = await composeChangeCandidates(fake.env, CHANGE);
    expect(ids(outcome)).toEqual([expect.stringMatching(/^cand_/), "candidate_limit"]);
    expect(fake.candidates).toHaveLength(MAX_CANDIDATES);
    expect(fake.workflows.size).toBe(MAX_CANDIDATES);
    const refused = await createCandidate(fake.env, { changeId: CHANGE });
    expect(refused.status === "refused" && refused.reason).toBe("candidate_limit");
  });

  it("refuses a subset that is not a proposed ChangeSet of the Change", async () => {
    const fake = fakeEnv({ changeSets });
    const outcome = await createCandidate(fake.env, { changeId: CHANGE, changeSetIds: ["cs_x"] });
    expect(outcome.status === "refused" && outcome.reason).toBe("not_proposed");
    expect(fake.candidates).toHaveLength(0);
  });

  it("composes nothing for a Change that is not verifying", async () => {
    const fake = fakeEnv({ changeSets, status: "running" });
    expect((await composeChangeCandidates(fake.env, CHANGE)).status).toBe("skipped");
    expect(fake.candidates).toHaveLength(0);
  });
});
