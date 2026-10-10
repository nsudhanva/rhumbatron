import type {
  ClaimFact,
  DecisionReceiptView,
  FeedEvent,
  WorkspaceFork,
  WorkspaceView,
} from "../../lib/api";
import { previewActivityInput } from "../agents/activity-fixture";
import type { FlightInput } from "./flight-model";

/**
 * Fixture input for the Debug view design preview (`/design/flight`). Shaped exactly like
 * the API responses and run through the same `deriveFlight` and `foldFlight` as the real page.
 * Used only for local visual checks of the panels; product pages never read it.
 */

const T0 = Date.parse("2026-10-09T09:00:00Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function fork(
  n: number,
  attempt: number,
  start: number,
  end: number | null,
  files: [string, number, number][] | null,
): WorkspaceFork {
  const taskId = `tsk_wish${n}`;
  const id = `cs_wish${n}_${attempt}`;
  return {
    fork: `acme-shop/ws-${taskId}-${attempt}`,
    runId: `run_wish${n}_${attempt}`,
    changeId: "chg_preview",
    taskId,
    taskKey: `T${String(n).padStart(2, "0")}`,
    taskTitle: null,
    attempt,
    runStatus: end === null ? "running" : files ? "completed" : "failed",
    baseGeneration: 1841,
    startedAt: at(start),
    endedAt: end === null ? null : at(end),
    changeSet:
      files && end !== null
        ? {
            id,
            status: "proposed",
            fork: `acme-shop/ws-${taskId}-${attempt}`,
            commit: `${n}a${attempt}f00${n}c0ffee`,
            baseCommit: "1841base",
            files: files.map(([path]) => path),
            fileStats: files.map(([path, adds, dels]) => ({
              path,
              changes: adds + dels,
              adds,
              dels,
              exact: true,
              binary: false,
            })),
            insertions: files.reduce((s, [, a]) => s + a, 0),
            deletions: files.reduce((s, [, , d]) => s + d, 0),
            diffStat: files
              .map(([p, a, d]) => ` ${p} | ${a + d} ${"+".repeat(a)}${"-".repeat(d)}`)
              .join("\n"),
            createdAt: at(end),
          }
        : null,
  };
}

const workspace: WorkspaceView = {
  canonical: {
    assigned: true,
    generation: 1842,
    artifactRef: "rhumbatron-projects/acme-shop",
    treeSha: "1842tree0000",
    lastPromotedCandidateId: "cand_b",
    updatedAt: at(260),
  },
  changes: [
    {
      id: "chg_preview",
      goal: "Add shared wishlists.",
      status: "completed",
      baseGeneration: 1841,
      createdAt: at(0),
    },
  ],
  truncated: false,
  workspaces: [
    fork(1, 1, 2, 40, [
      ["docs/wishlist-model.md", 64, 0],
      ["src/wishlist/types.ts", 48, 0],
    ]),
    fork(2, 1, 44, 98, [
      ["src/wishlist/routes.ts", 212, 0],
      ["src/wishlist/membership.ts", 96, 0],
      ["src/db/schema.sql", 18, 2],
    ]),
    fork(3, 1, 45, 104, [
      ["src/wishlist/membership.ts", 140, 0],
      ["src/wishlist/membership-events.ts", 88, 0],
      ["src/db/schema.sql", 12, 0],
    ]),
    fork(4, 1, 46, 70, null),
    fork(4, 2, 72, 110, [
      ["src/wishlist/share.ts", 74, 0],
      ["src/wishlist/routes.ts", 22, 4],
    ]),
    fork(5, 1, 50, 120, [
      ["src/pages/wishlist.tsx", 180, 0],
      ["src/components/share-link.tsx", 56, 0],
    ]),
    fork(6, 1, 48, 66, [["tests/cart.invariant.test.ts", 44, 0]]),
    fork(7, 1, 124, null, null),
  ],
  candidates: [],
};

const claims: ClaimFact[] = [
  {
    seq: 10,
    eventId: "evt_claim_1",
    action: "acquired",
    claimId: "clm_1",
    agentId: "agt_02",
    resource: "project:acme:wishlist:membership",
    leaseExpiresAt: at(400),
    occurredAt: at(46),
  },
  {
    seq: 11,
    eventId: "evt_claim_2",
    action: "acquired",
    claimId: "clm_2",
    agentId: "agt_03",
    resource: "project:acme:wishlist:membership",
    leaseExpiresAt: at(400),
    occurredAt: at(47),
  },
  {
    seq: 12,
    eventId: "evt_claim_3",
    action: "acquired",
    claimId: "clm_3",
    agentId: "agt_04",
    resource: "project:acme:wishlist:share",
    leaseExpiresAt: at(400),
    occurredAt: at(48),
  },
  {
    seq: 30,
    eventId: "evt_claim_4",
    action: "released",
    claimId: "clm_1",
    agentId: "agt_02",
    resource: "project:acme:wishlist:membership",
    leaseExpiresAt: null,
    occurredAt: at(98),
  },
  {
    seq: 31,
    eventId: "evt_claim_5",
    action: "released",
    claimId: "clm_2",
    agentId: "agt_03",
    resource: "project:acme:wishlist:membership",
    leaseExpiresAt: null,
    occurredAt: at(104),
  },
  {
    seq: 32,
    eventId: "evt_claim_6",
    action: "expired",
    claimId: "clm_3",
    agentId: "agt_04",
    resource: "project:acme:wishlist:share",
    leaseExpiresAt: null,
    occurredAt: at(140),
  },
];

function feedEvent(
  seq: number,
  eventType: string,
  seconds: number,
  taskId: string | null,
  actor: FeedEvent["actor"],
  summary: string,
  data: FeedEvent["data"] = {},
): FeedEvent {
  return {
    seq,
    eventId: `evt_${seq}`,
    eventType,
    eventVersion: 1,
    occurredAt: at(seconds),
    recordedAt: at(seconds + 1),
    actor,
    changeId: "chg_preview",
    taskId,
    candidateId: null,
    resource: null,
    summary,
    data,
  };
}

const agent = (n: number): FeedEvent["actor"] => ({
  kind: "agent",
  id: `agt_${String(n).padStart(2, "0")}`,
});

const feed: FeedEvent[] = [
  feedEvent(1, "change.created", 0, null, { kind: "user", id: "usr_preview" }, "Change created."),
  feedEvent(
    2,
    "change.compiled",
    1,
    null,
    { kind: "system", id: "root-planner" },
    "Work Graph compiled.",
    { taskCount: 8, riskTier: "medium" },
  ),
  feedEvent(3, "task.ready", 1, "tsk_wish1", { kind: "system", id: "scheduler" }, "T01 ready."),
  feedEvent(4, "agent.woken", 2, "tsk_wish1", agent(1), "T01 agent woken.", {
    reason: "task.ready",
  }),
  feedEvent(5, "model.route.decided", 2, "tsk_wish1", agent(1), "T01 routed to opus.", {
    selectedTier: "opus",
    decidedBy: "rules",
  }),
  feedEvent(6, "task.started", 2, "tsk_wish1", agent(1), "T01 started."),
  feedEvent(7, "task.ready", 41, "tsk_wish2", { kind: "system", id: "scheduler" }, "T02 ready."),
  feedEvent(8, "task.ready", 41, "tsk_wish3", { kind: "system", id: "scheduler" }, "T03 ready."),
  feedEvent(9, "task.ready", 41, "tsk_wish4", { kind: "system", id: "scheduler" }, "T04 ready."),
  feedEvent(13, "model.route.decided", 44, "tsk_wish2", agent(2), "T02 routed to sonnet.", {
    selectedTier: "sonnet",
    decidedBy: "clef",
  }),
  feedEvent(14, "task.started", 44, "tsk_wish2", agent(2), "T02 started."),
  feedEvent(15, "task.started", 45, "tsk_wish3", agent(3), "T03 started."),
  feedEvent(16, "task.started", 46, "tsk_wish4", agent(4), "T04 started."),
  feedEvent(
    17,
    "task.started",
    48,
    "tsk_wish6",
    { kind: "system", id: "system:fixture" },
    "T06 started.",
  ),
  feedEvent(18, "task.started", 50, "tsk_wish5", agent(5), "T05 started."),
  feedEvent(20, "changeset.proposed", 98, "tsk_wish2", agent(2), "T02 proposes a ChangeSet.", {
    changeSetId: "cs_wish2_1",
  }),
  feedEvent(21, "changeset.proposed", 104, "tsk_wish3", agent(3), "T03 proposes a ChangeSet.", {
    changeSetId: "cs_wish3_1",
  }),
  feedEvent(
    22,
    "changeset.proposed",
    66,
    "tsk_wish6",
    { kind: "system", id: "system:fixture" },
    "T06 proposes a ChangeSet.",
    { changeSetId: "cs_wish6_1" },
  ),
  feedEvent(23, "task.started", 124, "tsk_wish7", agent(7), "T07 started."),
];

const decisions: DecisionReceiptView[] = [
  {
    id: "dr_wish1_1",
    taskId: "tsk_wish1",
    agentId: "agt_01",
    decisionType: "MODEL_ROUTE",
    decidedBy: "rules",
    selectedTier: "opus",
    receipt: {
      signals: { complexity: "large", riskTier: "medium", attempt: 1, designConflict: false },
      reasons: ["complexity large: Opus plans, children implement"],
      escalateOn: ["two_failures"],
    },
    createdAt: at(2),
  },
  {
    id: "dr_wish2_1",
    taskId: "tsk_wish2",
    agentId: "agt_02",
    decisionType: "MODEL_ROUTE",
    decidedBy: "clef",
    selectedTier: "sonnet",
    receipt: {
      probabilities: { haiku: 0.08, sonnet: 0.79, opus: 0.13 },
      signals: { complexity: "medium", riskTier: "medium", attempt: 1, designConflict: false },
      reasons: ["medium complexity, medium risk"],
      escalateOn: ["two_failures", "cross_resource_conflict"],
    },
    createdAt: at(44),
  },
  {
    id: "dr_wish4_2",
    taskId: "tsk_wish4",
    agentId: "agt_04",
    decisionType: "MODEL_ROUTE",
    decidedBy: "rules",
    selectedTier: "sonnet",
    receipt: {
      signals: {
        complexity: "small",
        riskTier: "medium",
        attempt: 2,
        priorFailureKinds: ["two_failures"],
      },
      reasons: ["haiku failed twice: escalate to sonnet"],
      escalateOn: ["two_failures"],
    },
    createdAt: at(72),
  },
];

/** The Wishlist story as Debug view input. */
export function previewFlightInput(): FlightInput {
  const base = previewActivityInput();
  const tasks = base.tasks.map((t) => ({
    ...t,
    semanticResources:
      t.id === "tsk_wish2" || t.id === "tsk_wish3"
        ? ["project:acme:wishlist:membership"]
        : t.id === "tsk_wish4"
          ? ["project:acme:wishlist:share"]
          : t.id === "tsk_wish6"
            ? ["project:acme:cart"]
            : ["project:acme:wishlist"],
  }));
  return {
    ...base,
    change: {
      ...base.change,
      acceptanceCriteria: [
        "Users can create a wishlist and share it with a link.",
        "Collaborators can add or remove products.",
      ],
      invariants: ["Existing cart add, remove, quantity and total behavior is unchanged."],
    },
    tasks,
    progress: [
      {
        taskId: "tsk_wish7",
        attempt: 1,
        tier: "sonnet",
        modelCalls: 3,
        inputTokens: 12_400,
        outputTokens: 1_900,
        costUsd: 0.04,
        lastStep: "run_command bun run bench:wishlist",
        startedAt: at(124),
        progressAt: at(131),
      },
    ],
    claims,
    feed,
    workspace,
    decisions,
    now: T0 + 262_000,
  };
}
