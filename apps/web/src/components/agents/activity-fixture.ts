import type {
  CandidateDetail,
  ChangeDetail,
  ConflictDetail,
  EvidenceRecord,
  TaskDetail,
  TaskRun,
} from "../../lib/api";
import type { ActivityInput } from "./activity-model";

/**
 * Fixture records for the agent-activity preview (`AgentActivityPreview` in agent-activity.tsx).
 * They are shaped exactly like the API responses and go through the same derivation as the
 * Change page: the Wishlist story with one design conflict, two Candidates, a rejected loser and
 * a promoted winner. Built inside a function so product bundles drop it when unused.
 */

const T0 = Date.parse("2026-10-09T09:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function run(
  attempt: number,
  tier: TaskRun["tier"],
  start: number,
  end: number | null,
  calls: number,
  outcome: TaskRun["outcome"],
  failureKind: string | null = null,
): TaskRun {
  return {
    attempt,
    tier,
    status: end === null ? "running" : failureKind ? "failed" : "completed",
    failureKind,
    outcome,
    modelCalls: calls,
    inputTokens: calls * 4200,
    outputTokens: calls * 610,
    costUsd: calls * (tier === "haiku" ? 0.002 : tier === "sonnet" ? 0.03 : 0.06),
    startedAt: at(start),
    endedAt: end === null ? null : at(end),
    decidedBy: "rules",
    routeReasons: [],
  };
}

const intent = (summary: string, resources: string[], assumptions: string[] = []) => ({
  summary,
  semanticResources: resources,
  expectedFiles: [],
  expectedContractChanges: [],
  expectedDataChanges: [],
  assumptions,
  acceptanceEvidence: [],
});

function task(
  n: number,
  title: string,
  kind: TaskDetail["kind"],
  status: TaskDetail["status"],
  runs: TaskRun[],
  dependsOn: number[] = [],
): TaskDetail {
  const id = `tsk_wish${n}`;
  return {
    id,
    key: `T${String(n).padStart(2, "0")}`,
    title,
    kind,
    objective: title,
    semanticResources: [],
    dependsOn: dependsOn.map((d) => `tsk_wish${d}`),
    acceptanceCriteria: [],
    riskTier: "medium",
    complexity: "medium",
    status,
    assignedAgentId: runs.length > 0 ? `agt_${String(n).padStart(2, "0")}` : null,
    runs,
  };
}

const MEMBERSHIP = "project:acme:wishlist:membership";
const NORMALIZED = "Store collaborators in a normalized mutable membership table.";
const APPEND_ONLY = "Record membership as an append-only event log; derive the current set.";

const change: ChangeDetail = {
  id: "chg_preview",
  projectId: "prj_acme",
  goal: "Add shared wishlists.",
  acceptanceCriteria: [],
  invariants: [],
  status: "completed",
  baseGeneration: 1841,
  budgetUsd: 3,
};

/** The Wishlist story as API records. */
export function previewActivityInput(): ActivityInput {
  const tasks: TaskDetail[] = [
    task(1, "Design the wishlist data model", "design", "completed", [
      run(1, "opus", 2, 40, 7, intent("Wishlist, item and share-link entities.", ["wishlist"])),
    ]),
    task(
      2,
      "Wishlist API routes",
      "implement",
      "completed",
      [run(1, "sonnet", 44, 98, 11, intent(NORMALIZED, [MEMBERSHIP]))],
      [1],
    ),
    task(
      3,
      "Collaborator membership",
      "implement",
      "completed",
      [run(1, "sonnet", 45, 104, 12, intent(APPEND_ONLY, [MEMBERSHIP]))],
      [1],
    ),
    task(
      4,
      "Share link tokens",
      "implement",
      "completed",
      [
        run(1, "haiku", 46, 70, 8, { reason: "token expiry contract unclear" }, "two_failures"),
        run(2, "sonnet", 72, 110, 9, intent("Signed, revocable share tokens.", ["wishlist:share"])),
      ],
      [1],
    ),
    task(
      5,
      "Wishlist page",
      "implement",
      "completed",
      [run(1, "sonnet", 50, 120, 10, intent("Owner and collaborator views.", ["wishlist:ui"]))],
      [1],
    ),
    task(
      6,
      "Cart invariant test",
      "test",
      "completed",
      [run(1, "haiku", 48, 66, 4, intent("Cart totals unchanged.", ["cart"]))],
      [],
    ),
    task(
      7,
      "Wishlist p95 benchmark",
      "test",
      "running",
      [run(1, "sonnet", 124, null, 0, null)],
      [2, 3],
    ),
    task(8, "Document sharing", "document", "pending", [], [5]),
  ];

  const intentOf = (t: TaskDetail) => {
    const r = t.runs.at(-1);
    return {
      intentId: `int_${t.id.slice(4)}_1`,
      taskId: t.id,
      taskKey: t.key,
      title: t.title,
      agentId: t.assignedAgentId ?? "",
      summary: r?.outcome && "summary" in r.outcome ? r.outcome.summary : "",
      semanticResources: [MEMBERSHIP],
      assumptions: [],
      createdAt: r?.endedAt ?? at(0),
    };
  };

  const [t2, t3] = [tasks[1], tasks[2]] as [TaskDetail, TaskDetail];

  const conflicts: ConflictDetail[] = [
    {
      id: "cfl_preview",
      changeId: change.id,
      resource: MEMBERSHIP,
      state: "fork_required",
      recommendedAction: "fork_candidates",
      intents: [intentOf(t2), intentOf(t3)],
      signals: [
        {
          kind: "data_model_conflict",
          severity: "hard",
          detail: "Mutable rows vs append-only events for one membership set.",
          evidenceRefs: [],
        },
      ],
      review: { decidedBy: "rules" },
      forkDecision: {
        kind: "fork",
        candidateIntentIds: ["int_wish2_1", "int_wish3_1"],
        reason: "Both designs are plausible; executable evidence can decide.",
      },
      challengeId: "chl_preview",
      createdAt: at(105),
      updatedAt: at(105),
    },
  ];

  const CHECKS = ["build", "unit", "contract", "cart-invariant", "performance", "browser"];

  function candidate(
    id: string,
    created: number,
    changeSets: number[],
    status: CandidateDetail["status"],
    updated: number,
    extra: Partial<CandidateDetail> = {},
  ): CandidateDetail {
    return {
      id,
      changeId: change.id,
      projectId: change.projectId,
      status,
      statusReason: null,
      baseGeneration: 1841,
      artifactRef: null,
      composedCommit: null,
      composedTree: null,
      changeSetIds: changeSets.map((n) => `cs_wish${n}_${n === 4 ? 2 : 1}`),
      plan: {
        checks: CHECKS.map((checkId) => ({
          checkId,
          kind: checkId,
          reason: "",
          timeoutMs: 60_000,
          required: true,
          expected: { kind: "exit_code" as const, code: 0 },
        })),
        requiredCheckIds: CHECKS,
        humanApprovalRequired: true,
        policyVersion: "policy-1",
      },
      gate: null,
      approvalRequired: true,
      approval: null,
      baseTree: null,
      promotedGeneration: null,
      createdAt: at(created),
      updatedAt: at(updated),
      ...extra,
    };
  }

  const candidates: CandidateDetail[] = [
    candidate("cand_a", 130, [1, 2, 4, 5, 6], "rejected", 196, {
      statusReason: "performance: wishlist p95 312 ms is over the 200 ms threshold",
    }),
    candidate("cand_b", 131, [1, 3, 4, 5, 6], "promoted", 260, {
      promotedGeneration: 1842,
      approval: {
        id: "apr_preview",
        candidateId: "cand_b",
        changeId: change.id,
        decision: "granted",
        approverUserId: "usr_preview",
        candidateTree: "tree",
        policyVersion: "policy-1",
        reason: null,
        createdAt: at(240),
      },
    }),
  ];

  function evidence(candidateId: string, results: [string, EvidenceRecord["status"], number][]) {
    return results.map(
      ([checkId, status, t]): EvidenceRecord => ({
        evidenceId: `ev_${candidateId}_${checkId}`,
        candidateId,
        checkId,
        kind: checkId,
        status,
        coverage: "checked_supported",
        startedAt: at(t - 4),
        completedAt: at(t),
        summary: status === "pass" ? "passed" : "p95 312 ms over 200 ms",
        contentHash: "0",
        sourceRefs: [],
      }),
    );
  }

  const EVIDENCE: Record<string, EvidenceRecord[]> = {
    cand_a: evidence("cand_a", [
      ["build", "pass", 150],
      ["unit", "pass", 162],
      ["contract", "pass", 170],
      ["cart-invariant", "pass", 178],
      ["performance", "fail", 194],
    ]),
    cand_b: evidence("cand_b", [
      ["build", "pass", 151],
      ["unit", "pass", 164],
      ["contract", "pass", 172],
      ["cart-invariant", "pass", 180],
      ["performance", "pass", 196],
      ["browser", "pass", 228],
    ]),
  };

  return { change, tasks, conflicts, candidates, evidence: EVIDENCE };
}
