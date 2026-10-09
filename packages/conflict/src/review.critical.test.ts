// Model conflict review rules (AGENTS.md sections 22.4, 22.5, 32.3, 34.4.2; P9-05, P9-06). A model
// verdict is a hypothesis: only the closed vocabulary parses, only valid citations count, a hard
// deterministic signal is never dismissed, and only high-risk conflicts can reach Opus.
import type { ConflictReport, Intent } from "@rhumbatron/protocol";
import { describe, expect, it } from "vitest";
import { detectConflicts } from "./detect.ts";
import {
  applyVerdict,
  buildReviewPacket,
  checkCitations,
  checkReviewBudget,
  escalationReasons,
  parseReviewOutput,
  shouldEscalate,
} from "./review.ts";

const intent = (id: string, patch: Partial<Intent>): Intent => ({
  intentId: id,
  taskId: `task-${id}`,
  agentId: `agent-${id}`,
  summary: "Tune search ranking",
  semanticResources: ["catalog:search"],
  expectedFiles: [`src/search/${id}.ts`],
  expectedSymbols: [],
  expectedContractChanges: [
    { target: "GET /v1/search", kind: "modify", description: "Change search results" },
  ],
  expectedDataChanges: [],
  expectedSideEffects: [],
  assumptions: [],
  createdAt: "2026-10-09T00:00:00.000Z",
  ...patch,
});

const a = intent("int_a", {});
const b = intent("int_b", { summary: "Add search filters" });
const [suspected] = detectConflicts([a, b]) as [ConflictReport];

const packet = buildReviewPacket({
  conflictId: "cfl_1",
  projectId: "prj_1",
  changeId: "chg_1",
  canonicalGeneration: 1841,
  now: "2026-10-09T00:00:00.000Z",
  change: { goal: "Improve search", acceptanceCriteria: [], invariants: [], updatedAt: "x" },
  report: suspected,
  sides: [
    { intent: a, taskKey: "T1", title: "Ranking", changeSet: null },
    { intent: b, taskKey: "T2", title: "Filters", changeSet: null },
  ],
  protectedResources: ["cart"],
});

describe("review output contract", () => {
  it("accepts only the closed verdict vocabulary", () => {
    const ok = parseReviewOutput(
      '```json\n{"verdict":"benign_overlap","rationale":"Both add.","citations":["intent:int_a"]}\n```',
    );
    expect(ok.ok && ok.output.verdict).toBe("benign_overlap");
    for (const verdict of ["probably_fine", "Benign_Overlap", "approve", ""]) {
      const parsed = parseReviewOutput(JSON.stringify({ verdict, rationale: "x", citations: [] }));
      expect(parsed).toMatchObject({ ok: false, reason: "invalid_output" });
    }
    expect(parseReviewOutput("The designs look fine to me.")).toMatchObject({ ok: false });
    expect(parseReviewOutput('{"verdict":"benign_overlap"}')).toMatchObject({ ok: false });
  });
});

describe("citations and state", () => {
  const current = {
    state: "suspected" as const,
    recommendedAction: "review" as const,
    report: suspected,
  };
  const facts = { bothSidesHaveChangeSets: true, forked: false };

  it("marks an invented or foreign citation unsupported, and it changes nothing", () => {
    const checked = checkCitations(
      { citations: ["intent:int_a", "evidence:made-up"] },
      packet,
      "cfl_1",
    );
    expect(checked.support).toBe("unsupported");
    const effect = applyVerdict(current, { verdict: "benign_overlap", ...checked }, facts);
    expect(effect).toMatchObject({
      state: "suspected",
      recommendedAction: "review",
      applied: false,
    });
    expect(effect.outcome).toBe("rejected_unsupported");
    // No citations at all is unsupported too.
    expect(checkCitations({ citations: [] }, packet, "cfl_1").support).toBe("unsupported");
  });

  it("dismisses a soft overlap only with supported citations", () => {
    const checked = checkCitations(
      { citations: ["intent:int_a:contract:0", "signal:0"] },
      packet,
      "cfl_1",
    );
    expect(checked).toMatchObject({ support: "supported", concrete: true });
    expect(applyVerdict(current, { verdict: "benign_overlap", ...checked }, facts)).toMatchObject({
      state: "resolved",
      recommendedAction: "dismiss",
      outcome: "dismissed",
    });
  });

  it("never dismisses a hard deterministic signal, and never confirms without a concrete citation", () => {
    const hard = detectConflicts([
      intent("int_c", {
        expectedDataChanges: [
          { entity: "members", kind: "add", model: "append_only", description: "" },
        ],
      }),
      intent("int_d", {
        expectedDataChanges: [
          { entity: "members", kind: "add", model: "mutable_table", description: "" },
        ],
      }),
    ])[0] as ConflictReport;
    expect(hard.state).toBe("confirmed");
    const supported = { support: "supported" as const, concrete: true };
    expect(
      applyVerdict(
        { state: hard.state, recommendedAction: hard.recommendedAction, report: hard },
        { verdict: "benign_overlap", ...supported },
        facts,
      ),
    ).toMatchObject({ state: "confirmed", outcome: "rejected_hard_signal", applied: false });

    const rulesOnly = checkCitations({ citations: ["signal:0", `change:chg_1`] }, packet, "cfl_1");
    expect(rulesOnly).toMatchObject({ support: "supported", concrete: false });
    expect(
      applyVerdict(current, { verdict: "confirmed_conflict", ...rulesOnly }, facts),
    ).toMatchObject({ state: "suspected", outcome: "rejected_not_concrete" });
    expect(
      applyVerdict(current, { verdict: "fork_candidates", ...supported }, facts),
    ).toMatchObject({
      state: "confirmed",
      recommendedAction: "fork_candidates",
      outcome: "confirmed",
    });
  });
});

describe("Opus escalation rule", () => {
  it("flags data semantics, authorization, crossing resources, and release safety", () => {
    expect(escalationReasons(suspected, [a, b], ["cart"])).toEqual([]);
    const data = [
      intent("int_e", {
        expectedDataChanges: [
          { entity: "items", kind: "modify", model: "mutable_table", description: "" },
        ],
      }),
      intent("int_f", {
        semanticResources: ["identity:session"],
        summary: "Revoke share links",
        expectedDataChanges: [
          { entity: "items", kind: "modify", model: "mutable_table", description: "" },
        ],
      }),
    ] as const;
    const report = detectConflicts([...data])[0] as ConflictReport;
    expect(escalationReasons(report, data, ["identity"])).toEqual([
      "crosses_resources",
      "authorization",
      "data_semantics",
      "release_safety",
    ]);
  });

  it("escalates high-risk disagreement and bad output, never a transport failure or a low-risk conflict", () => {
    const dismissed = applyVerdict(
      { state: "suspected", recommendedAction: "review", report: suspected },
      { verdict: "benign_overlap", support: "supported", concrete: true },
      { bothSidesHaveChangeSets: true, forked: false },
    );
    expect(shouldEscalate(["data_semantics"], { kind: "reviewed", effect: dismissed })).toBe(true);
    expect(shouldEscalate([], { kind: "reviewed", effect: dismissed })).toBe(false);
    expect(shouldEscalate(["authorization"], { kind: "call_failed" })).toBe(false);
    expect(shouldEscalate(["authorization"], { kind: "invalid_output" })).toBe(true);
    const agreed = { ...dismissed, outcome: "agreed" as const };
    expect(shouldEscalate(["data_semantics"], { kind: "reviewed", effect: agreed })).toBe(false);
  });
});

describe("review budget", () => {
  it("refuses at the Change budget, including this call's worst case", () => {
    expect(checkReviewBudget({ changeBudgetUsd: 3, spentUsd: 1, estimateUsd: 0.01 }).ok).toBe(true);
    expect(checkReviewBudget({ changeBudgetUsd: 3, spentUsd: 3, estimateUsd: 0 }).ok).toBe(false);
    expect(checkReviewBudget({ changeBudgetUsd: 3, spentUsd: 2.995, estimateUsd: 0.01 }).ok).toBe(
      false,
    );
  });
});
