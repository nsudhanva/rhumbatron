// Release safety: a Sandbox result that is not executable evidence must never become a pass
// (AGENTS.md section 34.4.1), and ChangeSets merge after the ChangeSets they depend on (section 33).
import { buildVerificationPlan } from "@rhumbatron/evidence";
import { describe, expect, it } from "vitest";
import {
  type ChangeSetRow,
  classifyCheck,
  DEFAULT_POLICY,
  isAllowedCheckCommand,
  orderChangeSets,
  verificationTouches,
} from "./candidate-composer.ts";

const plan = buildVerificationPlan({
  candidateId: "cand_x",
  riskTier: "low",
  policy: DEFAULT_POLICY,
  touches: {
    authorization: true,
    performanceConstraint: true,
    protectedInvariants: ["Keep existing cart behavior unchanged."],
    ui: false,
  },
});
const check = (id: string) => {
  const found = plan.checks.find((c) => c.checkId === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
};
const ok = (output: string) => ({ exitCode: 0, output, timedOut: false });

describe("classifyCheck", () => {
  it("passes only with an exit code and evidence of tests or a metric", () => {
    expect(classifyCheck(check("build"), ok(""))).toMatchObject({
      status: "pass",
      coverage: "checked_supported",
    });
    expect(classifyCheck(check("unit"), ok(" 13 pass\n 0 fail\n"))).toMatchObject({
      status: "pass",
      coverage: "checked_supported",
    });
    expect(classifyCheck(check("performance"), ok('{"p95Ms": 12}'))).toMatchObject({
      status: "pass",
      metrics: { p95Ms: 12 },
    });
  });

  it("a timeout, a Sandbox error, no matched test, or no metric is never a pass", () => {
    const cases = [
      classifyCheck(check("unit"), { exitCode: null, output: "", timedOut: true }),
      classifyCheck(check("unit"), { exitCode: null, output: "", timedOut: false, error: "lost" }),
      classifyCheck(check("security"), {
        exitCode: 1,
        output: 'error: regex "authorization" matched 0 tests.',
        timedOut: false,
      }),
      classifyCheck(check("security"), ok("")),
      classifyCheck(check("performance"), ok("bench crashed quietly")),
    ];
    for (const outcome of cases) {
      expect(outcome.status).not.toBe("pass");
      expect(outcome.coverage).not.toBe("checked_supported");
    }
  });

  it("a failing test or an over-budget p95 is a supported failure", () => {
    expect(
      classifyCheck(check("protected-invariant-cart"), {
        exitCode: 1,
        output: " 12 pass\n 1 fail\n",
        timedOut: false,
      }),
    ).toMatchObject({ status: "fail", coverage: "checked_supported" });
    expect(classifyCheck(check("performance"), ok('{"p95Ms": 250}'))).toMatchObject({
      status: "fail",
      coverage: "checked_supported",
    });
  });

  it("only allow-listed commands without shell metacharacters run", () => {
    for (const c of plan.checks) if (c.command) expect(isAllowedCheckCommand(c.command)).toBe(true);
    for (const bad of ["bun test; curl x", "bun run deploy", "rm -rf /", "bun test $(id)"]) {
      expect(isAllowedCheckCommand(bad)).toBe(false);
    }
  });
});

describe("composition scope and order", () => {
  it("merges dependencies first, then creation order", () => {
    const row = (id: string, task: string, at: string): ChangeSetRow => ({
      id,
      base_generation: 1,
      artifact_ref: null,
      intent_json: "{}",
      created_at: at,
      task_id: task,
    });
    const { ordered } = orderChangeSets(
      [
        row("cs_api", "t_api", "2026-10-09T10:00:00Z"),
        row("cs_db", "t_db", "2026-10-09T10:05:00Z"),
      ],
      [{ task_id: "t_api", depends_on_task_id: "t_db" }],
    );
    expect(ordered.map((r) => r.id)).toEqual(["cs_db", "cs_api"]);
  });

  it("merges a stacked ChangeSet after its ancestors, even with no direct Work Graph edge", () => {
    const sha = (c: string) => c.repeat(40);
    const stacked = (id: string, task: string, at: string, on: string[]): ChangeSetRow => ({
      id,
      base_generation: 1,
      artifact_ref: null,
      intent_json: JSON.stringify({
        summary: id,
        changeSet: {
          fork: `ws-${id}`,
          commit: sha("a"),
          baseCommit: sha("b"),
          diffStat: "",
          files: [],
          stackedOn: on,
        },
      }),
      created_at: at,
      task_id: task,
    });
    // t5 was created first (clock skew) and depends on t3 only through an intent-only t4.
    const { ordered } = orderChangeSets(
      [
        stacked("cs_t5", "t5", "2026-10-09T10:00:00Z", ["cs_t3"]),
        stacked("cs_t3", "t3", "2026-10-09T10:05:00Z", []),
        { ...stacked("cs_bad", "t9", "2026-10-09T09:00:00Z", []), intent_json: "{oops" },
      ],
      [],
    );
    expect(ordered.map((r) => r.id)).toEqual(["cs_bad", "cs_t3", "cs_t5"]);
  });

  it("an unplanned goal still protects what the user asked to keep", () => {
    const scope = verificationTouches({
      goal: "Add shared wishlists. Keep existing cart behavior unchanged. Keep API p95 below 150 ms.",
      invariants: [],
      acceptanceCriteria: [],
      files: [],
      touchesAuthorization: false,
    });
    expect(scope.touches.protectedInvariants).toEqual(["Keep existing cart behavior unchanged."]);
    expect(scope.touches.performanceConstraint).toBe(true);
    expect(scope.p95BudgetMs).toBe(150);
  });
});
