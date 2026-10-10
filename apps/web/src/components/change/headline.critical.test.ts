import { describe, expect, it } from "vitest";
import type { CandidateDetail, TaskDetail, TaskRun } from "../../lib/api";
import type { CheckRow } from "../candidate/model";
import { changeHeadline, type HeadlineInput, type VersionView } from "./headline";

/**
 * The Change page status machine: one word and at most one primary action per state
 * (docs/ux/research-2026-10-09.md 7.4, 7.5). Plain objects only; no API or DOM.
 */

const NOW = Date.parse("2026-10-09T12:00:00Z");

function run(status: TaskRun["status"], extra: Partial<TaskRun> = {}): TaskRun {
  return {
    attempt: 1,
    tier: "sonnet",
    status,
    failureKind: null,
    outcome: null,
    modelCalls: 3,
    inputTokens: 1000,
    outputTokens: 200,
    costUsd: 0.1,
    startedAt: "2026-10-09T11:50:00Z",
    endedAt: status === "running" ? null : "2026-10-09T11:55:00Z",
    decidedBy: "rules",
    routeReasons: [],
    ...extra,
  };
}

function task(id: string, status: TaskDetail["status"], runs: TaskRun[] = []): TaskDetail {
  return {
    id,
    key: id,
    title: `Task ${id}`,
    kind: "implement",
    objective: "",
    semanticResources: ["project:acme:wishlist:membership"],
    dependsOn: [],
    acceptanceCriteria: [],
    riskTier: "high",
    complexity: "medium",
    status,
    assignedAgentId: null,
    runs,
  };
}

const passRow: CheckRow = {
  checkId: "build",
  kind: "build",
  check: undefined,
  record: undefined,
  required: true,
  verdict: "pass",
  reason: null,
};

function version(extra: Partial<CandidateDetail> = {}): VersionView {
  const candidate: CandidateDetail = {
    id: "cand_a",
    changeId: "chg_1",
    projectId: "proj_1",
    status: "verified",
    statusReason: null,
    baseGeneration: 1841,
    artifactRef: null,
    composedCommit: null,
    composedTree: "tree",
    changeSetIds: ["cs_1"],
    plan: null,
    gate: { promotable: true, gaps: [] },
    approvalRequired: false,
    approval: null,
    baseTree: null,
    promotedGeneration: null,
    release: null,
    createdAt: "2026-10-09T11:56:00Z",
    updatedAt: "2026-10-09T11:58:00Z",
    ...extra,
  };
  return { candidate, rows: [passRow], label: "Version A" };
}

function input(extra: Partial<HeadlineInput>): HeadlineInput {
  return {
    status: "running",
    riskTier: "high",
    baseGeneration: 1841,
    budgetUsd: 3,
    spentUsd: 1.42,
    tasks: [],
    conflicts: [],
    versions: [],
    filesChanged: null,
    now: NOW,
    ...extra,
  };
}

describe("changeHeadline", () => {
  it("shows Building with no button while tasks are open", () => {
    const h = changeHeadline(
      input({
        tasks: [task("a", "running", [run("running")]), task("b", "completed", [run("completed")])],
        conflicts: [{ state: "fork_required", resource: "project:acme:wishlist:membership" }],
      }),
    );
    expect(h.word).toBe("Building");
    expect(h.primary).toBeNull();
    expect(h.sentence).toContain("1 agent is working. 1 of 2 tasks done.");
    expect(h.sentence).toContain("wishlist membership");
  });

  it("offers Run checks when every task is done and no version exists", () => {
    const h = changeHeadline(input({ tasks: [task("a", "completed", [run("completed")])] }));
    expect(h.word).toBe("Code ready");
    expect(h.primary?.kind).toBe("run-checks");
  });

  it("asks for approval when the version passed and policy needs a person", () => {
    const h = changeHeadline(
      input({
        status: "awaiting_approval",
        tasks: [task("a", "completed", [run("completed")])],
        versions: [version({ approvalRequired: true })],
      }),
    );
    expect(h.word).toBe("Needs your approval");
    expect(h.primary?.kind).toBe("review-approve");
    expect(h.sentence).toContain("high risk changes");
  });

  it("offers Ship when the version passed and no approval is required", () => {
    const h = changeHeadline(
      input({
        status: "verifying",
        tasks: [task("a", "completed", [run("completed")])],
        versions: [version()],
      }),
    );
    expect(h.word).toBe("Ready to ship");
    expect(h.primary).toEqual({ kind: "ship", label: "Ship Release 1842" });
  });

  it("says live and offers Open app only after a recorded deployment", () => {
    const shipped = version({ status: "promoted", promotedGeneration: 1842 });
    const deployed = changeHeadline(
      input({
        status: "completed",
        filesChanged: 9,
        versions: [
          {
            ...shipped,
            candidate: {
              ...shipped.candidate,
              release: {
                id: "rel_1",
                projectId: "proj_1",
                changeId: "chg_1",
                candidateId: "cand_a",
                generation: 1842,
                commit: "abc",
                status: "deployed",
                buildUuid: null,
                versionId: null,
                url: "https://shop.example.com",
                workerName: null,
                startedAt: "2026-10-09T11:59:00Z",
                finishedAt: "2026-10-09T11:59:30Z",
                failureReason: null,
                evidenceId: null,
                evidenceR2Key: null,
              },
            },
          },
        ],
      }),
    );
    expect(deployed.word).toBe("Shipped");
    expect(deployed.sentence).toBe("Release 1842 is live. 9 files changed.");
    expect(deployed.primary?.kind).toBe("open-app");

    const unknown = changeHeadline(input({ status: "completed", versions: [shipped] }));
    expect(unknown.sentence).not.toContain("live");
    expect(unknown.primary?.kind).toBe("view-release");
  });

  it("names the failed task and offers See what failed", () => {
    const h = changeHeadline(
      input({
        status: "failed",
        tasks: [
          task("a", "failed", [run("failed", { outcome: { reason: "tests did not compile" } })]),
        ],
      }),
    );
    expect(h.word).toBe("Failed");
    expect(h.sentence).toBe("Task a failed: tests did not compile.");
    expect(h.primary?.kind).toBe("see-failed");
    expect(h.failedStep).toBe("agents");
  });

  it("pauses on budget and offers a restart with a larger budget", () => {
    const h = changeHeadline(input({ status: "budget_blocked", spentUsd: 3 }));
    expect(h.word).toBe("Paused");
    expect(h.sentence).toBe("Budget reached: $3.00 of $3.00. Work is saved.");
    expect(h.primary?.kind).toBe("restart-larger");
  });
});
