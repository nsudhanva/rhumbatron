// Candidate creation is a retry boundary (AGENTS.md section 60) and enforces the fork rule
// (section 32.4) and the Candidate limit (section 44). Invariants: a repeated trigger yields the
// same Candidate IDs and no new rows; a fork conflict yields one Candidate per side, each with the
// shared non-conflicting ChangeSets; a Change never holds more than MAX_CANDIDATES Candidates.
import { COMPOSITION_RULES_VERSION } from "@rhumbatron/evidence";
import { describe, expect, it } from "vitest";
import {
  composeChangeCandidates,
  compositionKeyFor,
  createCandidate,
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
    expect(plan.deferred).toEqual(["cs_t3_1", "cs_t4_1"]);
  });
});

type CandidateRow = { id: string; change_id: string; change_set_ids_json: string };

/** Minimal D1, ProjectRootDO, ResourceShardDO, and Workflow stand-ins, answering by SQL shape. */
function fakeEnv(input: {
  changeSets: { id: string; taskId: string }[];
  conflicts?: { id: string; taskIds: [string, string] }[];
  status?: string;
}) {
  const candidates: CandidateRow[] = [];
  const workflows = new Set<string>();
  const events: string[] = [];
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
      if (sql.includes("FROM changesets cs")) {
        return { results: input.changeSets.map((c) => ({ id: c.id, task_id: c.taskId })) };
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
      // Bind order of insertCandidate: id, change, generation, times, key, ids, change, limit.
      const [id, changeId, , , , , ids, , max] = args as [
        string,
        string,
        number,
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
      appendEvents: async (list: { eventId: string }[]) => {
        for (const e of list) if (!events.includes(e.eventId)) events.push(e.eventId);
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
  return { env, candidates, workflows, events };
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
