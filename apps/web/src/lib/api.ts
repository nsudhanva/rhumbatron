import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";

/**
 * Server functions over the API Worker (service binding `API`). The browser never calls the API
 * directly: each call runs on the web Worker with the user's Clerk session token (AGENTS.md 12.1).
 */

export type ProjectSummary = {
  id: string;
  name: string;
  slug: string;
  status: string;
  canonicalGeneration: number;
  createdAt: string;
};

export type ChangeSummary = {
  id: string;
  goal: string;
  status: string;
  riskTier: string | null;
  budgetUsd: number;
  createdAt: string;
  taskCount: number;
  completedCount: number;
};

export type ChangeDetail = {
  id: string;
  projectId: string;
  goal: string;
  acceptanceCriteria: string[];
  invariants: string[];
  status: string;
  baseGeneration: number;
  budgetUsd: number;
  workGraphRef?: string;
};

export type Intent = {
  summary: string;
  semanticResources: string[];
  expectedFiles: string[];
  expectedContractChanges: string[];
  expectedDataChanges: string[];
  assumptions: string[];
  acceptanceEvidence: string[];
};

export type TaskRun = {
  attempt: number;
  tier: "haiku" | "sonnet" | "opus";
  status: "running" | "completed" | "failed";
  failureKind: string | null;
  /** The Intent on success, `{ reason }` on failure. */
  outcome: Intent | { reason: string } | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  decidedBy: "rules" | "clef" | null;
  routeReasons: string[];
};

export type TaskDetail = {
  id: string;
  key: string;
  title: string;
  kind: "design" | "implement" | "migrate" | "test" | "review" | "document";
  objective: string;
  semanticResources: string[];
  dependsOn: string[];
  acceptanceCriteria: string[];
  riskTier: "low" | "medium" | "high" | "critical";
  complexity: "small" | "medium" | "large";
  status:
    | "pending"
    | "ready"
    | "assigned"
    | "running"
    | "completed"
    | "failed"
    | "blocked"
    | "cancelled";
  assignedAgentId: string | null;
  runs: TaskRun[];
};

export type ConflictIntent = {
  intentId: string;
  taskId: string;
  taskKey: string;
  title: string;
  agentId: string;
  summary: string;
  semanticResources: string[];
  assumptions: string[];
  createdAt: string;
};

export type ConflictSignal = {
  kind:
    | "resource_overlap"
    | "file_overlap"
    | "contract_conflict"
    | "contract_overlap"
    | "data_model_conflict"
    | "data_overlap"
    | "assumption_conflict"
    | "invariant_reference";
  severity: "benign" | "soft" | "hard";
  detail: string;
  evidenceRefs: string[];
};

export type ForkDecision =
  | { kind: "fork"; candidateIntentIds: [string, string]; reason: string }
  | { kind: "no_fork"; reason: "benign_overlap" | "needs_review" | "already_resolved" }
  | { kind: "blocked"; reason: "candidate_limit"; maxCandidates: number };

/** A semantic conflict between two Intents of one Change (AGENTS.md section 32). */
export type ConflictDetail = {
  id: string;
  changeId: string;
  resource: string;
  state: "suspected" | "confirmed" | "fork_required" | "resolved";
  recommendedAction: "dismiss" | "review" | "fork_candidates";
  intents: [ConflictIntent, ConflictIntent];
  /** Hard signals first. */
  signals: ConflictSignal[];
  review: { decidedBy: "rules" | "sonnet" | "opus"; rationale?: string };
  forkDecision: ForkDecision;
  challengeId: string | null;
  createdAt: string;
  updatedAt: string;
};

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) throw new ApiError(401, "Sign in to continue");
  const response = await env.API.fetch(
    new Request(`https://api.internal${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  const json = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok || json.data === undefined) {
    throw new ApiError(response.status, json.error?.message ?? `API returned ${response.status}`);
  }
  return json.data;
}

export const listProjects = createServerFn().handler(() => call<ProjectSummary[]>("/v1/projects"));

export const createProject = createServerFn({ method: "POST" })
  .inputValidator((input: { name: string; slug: string; template: "empty" | "acme-shop" }) => input)
  .handler(({ data }) => call<{ id: string }>("/v1/projects", { method: "POST", body: data }));

export const provisionProject = createServerFn({ method: "POST" })
  .inputValidator((input: { projectId: string; template: "acme-shop" }) => input)
  .handler(({ data }) =>
    call<{ queued: boolean }>(`/v1/projects/${data.projectId}/provision`, {
      method: "POST",
      body: { template: data.template },
    }),
  );

export const listChanges = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<ChangeSummary[]>(`/v1/projects/${data}/changes`));

export const getProject = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) =>
    call<{
      id: string;
      name: string;
      slug: string;
      canonical: { generation: number; artifactRef: string; treeSha: string };
    }>(`/v1/projects/${data}`),
  );

export const createChange = createServerFn({ method: "POST" })
  .inputValidator((input: { projectId: string; goal: string; budgetUsd: number }) => input)
  .handler(({ data }) =>
    call<{ id: string }>(`/v1/projects/${data.projectId}/changes`, {
      method: "POST",
      body: {
        goal: data.goal,
        budgetUsd: data.budgetUsd,
        clientRequestId: `web-${crypto.randomUUID()}`,
      },
    }),
  );

export const getChange = createServerFn()
  .inputValidator((changeId: string) => changeId)
  .handler(({ data }) => call<ChangeDetail>(`/v1/changes/${data}`));

export const listTasks = createServerFn()
  .inputValidator((changeId: string) => changeId)
  .handler(({ data }) => call<TaskDetail[]>(`/v1/changes/${data}/tasks`));

export const getConflicts = createServerFn()
  .inputValidator((changeId: string) => changeId)
  .handler(({ data }) => call<ConflictDetail[]>(`/v1/changes/${data}/conflicts`));

export type CheckGap = { checkId: string; reason: string };

export type VerificationCheck = {
  checkId: string;
  kind: string;
  reason: string;
  command?: string;
  procedure?: string;
  timeoutMs: number;
  required: boolean;
  expected:
    | { kind: "exit_code"; code: number }
    | { kind: "metric_below"; metric: string; threshold: number }
    | { kind: "procedure"; description: string };
};

export type CandidateDetail = {
  id: string;
  changeId: string;
  projectId: string;
  status: "composing" | "composed" | "verifying" | "verified" | "rejected" | "stale" | "promoted";
  statusReason: string | null;
  baseGeneration: number;
  artifactRef: string | null;
  composedCommit: string | null;
  composedTree: string | null;
  changeSetIds: string[];
  plan: {
    checks: VerificationCheck[];
    requiredCheckIds: string[];
    humanApprovalRequired: boolean;
    policyVersion: string;
  } | null;
  /** Null until verification finishes. Only `promotable` Candidates can be promoted. */
  gate: {
    promotable: boolean;
    gaps: CheckGap[];
    humanApprovalRequired?: boolean;
    p95Ms?: number;
  } | null;
  /** The plan gates promotion on a human decision (AGENTS.md section 36, rule 4). */
  approvalRequired: boolean;
  approval: Approval | null;
  baseTree: string | null;
  promotedGeneration: number | null;
  createdAt: string;
  updatedAt: string;
};

/** One recorded human decision, bound to the composed tree the approver saw. */
export type Approval = {
  id: string;
  candidateId: string;
  changeId: string;
  decision: "granted" | "rejected";
  approverUserId: string;
  candidateTree: string;
  policyVersion: string;
  reason: string | null;
  createdAt: string;
};

export type PromotionOutcome = {
  status: "promoted";
  candidateId: string;
  fromGeneration: number;
  generation: number;
  alreadyPromoted: boolean;
  treeSha: string;
  sourceSynced: boolean;
  sourceCommit: string | null;
};

export type EvidenceRecord = {
  evidenceId: string;
  candidateId: string;
  checkId: string;
  kind: string;
  status: "pass" | "fail" | "error" | "skipped";
  coverage: "not_checked" | "checked_no_signal" | "checked_supported";
  startedAt: string;
  completedAt: string;
  summary: string;
  contentHash: string;
  r2Key?: string;
  metrics?: Record<string, number>;
  sourceRefs: string[];
};

export const listCandidates = createServerFn()
  .inputValidator((changeId: string) => changeId)
  .handler(({ data }) => call<CandidateDetail[]>(`/v1/changes/${data}/candidates`));

export const getCandidate = createServerFn()
  .inputValidator((candidateId: string) => candidateId)
  .handler(({ data }) => call<CandidateDetail>(`/v1/candidates/${data}`));

export const listCandidateEvidence = createServerFn()
  .inputValidator((candidateId: string) => candidateId)
  .handler(({ data }) => call<EvidenceRecord[]>(`/v1/candidates/${data}/evidence`));

/** Composes the Change's proposed ChangeSets into a Candidate and queues its verification. */
export const createCandidate = createServerFn({ method: "POST" })
  .inputValidator((changeId: string) => changeId)
  .handler(({ data }) =>
    call<CandidateDetail>(`/v1/changes/${data}/candidates`, { method: "POST", body: {} }),
  );

/**
 * Records the signed-in user's decision on a gated Candidate. The API takes the approver from the
 * session; the browser cannot name one. A stale or refused request throws with the API message.
 */
export const decideApproval = createServerFn({ method: "POST" })
  .inputValidator(
    (input: {
      changeId: string;
      candidateId: string;
      decision: "approve" | "reject";
      reason?: string;
    }) => input,
  )
  .handler(({ data }) =>
    call<{ status: "recorded"; approval: Approval; repeated: boolean }>(
      `/v1/changes/${data.changeId}/approve`,
      {
        method: "POST",
        body: {
          candidateId: data.candidateId,
          decision: data.decision,
          ...(data.reason ? { reason: data.reason } : {}),
        },
      },
    ),
  );

/** Promotes a verified Candidate (compare-and-swap in ProjectRootDO). Safe to retry. */
export const promoteCandidate = createServerFn({ method: "POST" })
  .inputValidator((candidateId: string) => candidateId)
  .handler(({ data }) =>
    call<PromotionOutcome>(`/v1/candidates/${data}/promote`, { method: "POST", body: {} }),
  );

/** Stored output (stdout and stderr) of one check, as plain text. Null when nothing was stored. */
export const getCheckOutput = createServerFn()
  .inputValidator((input: { candidateId: string; checkId: string }) => input)
  .handler(async ({ data }) => {
    const { getToken } = await auth();
    const token = await getToken();
    if (!token) throw new ApiError(401, "Sign in to continue");
    const response = await env.API.fetch(
      new Request(
        `https://api.internal/v1/candidates/${data.candidateId}/evidence/${data.checkId}/output`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiError(response.status, `API returned ${response.status}`);
    return response.text();
  });

/** Recent Candidates of one Project with their Evidence, for the Verification page. */
export type ProjectVerification = {
  /** Newest first: the latest `limit` Candidates plus older Candidates of the same Changes. */
  candidates: CandidateDetail[];
  evidence: EvidenceRecord[];
  changes: { id: string; goal: string; status: string; riskTier: string | null }[];
  limit: number;
  /** The Evidence cap cut rows; affected checks read as gaps, never as passes. */
  evidenceTruncated: boolean;
};

export const getProjectVerification = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<ProjectVerification>(`/v1/projects/${data}/verification`));

/** Recorded usage of one Change, tier, or Task (sums over `task_runs` attempts). */
export type CostUsage = {
  runs: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

/** Cost read model of one Project (workers/api cost.ts). Only recorded figures, never estimates. */
export type ProjectCost = {
  generatedAt: string;
  changes: (CostUsage & {
    id: string;
    goal: string;
    status: string;
    budgetUsd: number;
    createdAt: string;
  })[];
  selected: {
    changeId: string;
    byTier: (CostUsage & {
      tier: "haiku" | "sonnet" | "opus";
      callCapPerRun: number;
      maxCallsInRun: number;
    })[];
    byTask: (CostUsage & {
      id: string;
      key: string;
      title: string;
      kind: string;
      status: string;
      tiers: ("haiku" | "sonnet" | "opus")[];
      maxCallsInRun: number;
    })[];
    routing: {
      receipts: Record<"haiku" | "sonnet" | "opus", number>;
      decidedBy: { rules: number; clef: number };
      escalations: number;
      retries: number;
      failuresByKind: Record<string, number>;
    };
  } | null;
  meters: {
    day: string;
    month: string;
    agentModelCallsToday: number;
    agentDailyCallCap: number;
    clefFlashCallsToday: number;
    clefDailyCap: number;
    sandboxSecondsMonth: number;
    sandboxMonthlyCapSeconds: number;
    agentModelCallsByDay: { day: string; count: number }[];
  };
  callCapPerRun: Record<"haiku" | "sonnet" | "opus", number>;
};

export const getProjectCost = createServerFn()
  .inputValidator((input: { projectId: string; changeId?: string }) => input)
  .handler(({ data }) =>
    call<ProjectCost>(
      `/v1/projects/${data.projectId}/cost${data.changeId ? `?changeId=${encodeURIComponent(data.changeId)}` : ""}`,
    ),
  );

/* --------------------------------------------------------------------------------------------
 * Activity reads (workers/api activity.ts, packages/protocol activity.ts).
 * ------------------------------------------------------------------------------------------ */

/** `GET /v1/changes/:changeId` also returns these (workers/api changes.ts). */
export type ChangeMeta = {
  riskTier: "low" | "medium" | "high" | "critical" | null;
  createdAt: string;
  updatedAt: string;
};

/** The approval with the approver's display name (their email) when the API knows it. */
export type ApprovalWithName = Approval & { approverName?: string | null };

/** One recorded event. `seq` only grows, in the order the projector recorded events. */
export type FeedEvent = {
  seq: number;
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  recordedAt: string;
  actor: { kind: "user" | "agent" | "system"; id: string };
  changeId: string | null;
  taskId: string | null;
  candidateId: string | null;
  resource: string | null;
  summary: string;
  data: Record<string, string | number | boolean>;
};

/** Events newest first. Follow `after = nextAfter` while `hasMore` to read every newer event. */
export type FeedPage = {
  events: FeedEvent[];
  hasMore: boolean;
  nextAfter: number;
  nextBefore: number | null;
};

export type FeedCursor = { after?: number; before?: number; limit?: number };

export type ClaimFact = {
  seq: number;
  eventId: string;
  action: "acquired" | "renewed" | "released" | "expired";
  claimId: string;
  agentId: string;
  resource: string;
  leaseExpiresAt: string | null;
  occurredAt: string;
};

export type ClaimState = {
  claimId: string;
  agentId: string;
  resource: string;
  status: "active" | "released" | "expired";
  leaseExpiresAt: string | null;
  acquiredAt: string | null;
  updatedAt: string;
};

export type ChangeClaims = { facts: ClaimFact[]; claims: ClaimState[]; truncated: boolean };

/** Live progress of one running attempt, written once per model call. */
export type RunProgress = {
  taskId: string;
  attempt: number;
  tier: TaskRun["tier"];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastStep: string | null;
  startedAt: string;
  progressAt: string | null;
};

export type ProjectStats = {
  changes: { total: number; active: number };
  candidates: { total: number; verified: number; promoted: number; rejected: number };
  model: {
    runs: number;
    running: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  events: { latestSeq: number };
};

function feedQuery(cursor: FeedCursor) {
  const params = new URLSearchParams();
  if (cursor.after !== undefined) params.set("after", String(cursor.after));
  if (cursor.before !== undefined) params.set("before", String(cursor.before));
  if (cursor.limit !== undefined) params.set("limit", String(cursor.limit));
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const listProjectEvents = createServerFn()
  .inputValidator((input: { projectId: string } & FeedCursor) => input)
  .handler(({ data }) => call<FeedPage>(`/v1/projects/${data.projectId}/events${feedQuery(data)}`));

export const listChangeEvents = createServerFn()
  .inputValidator((input: { changeId: string } & FeedCursor) => input)
  .handler(({ data }) => call<FeedPage>(`/v1/changes/${data.changeId}/events${feedQuery(data)}`));

export const getProjectStats = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<ProjectStats>(`/v1/projects/${data}/stats`));

export const getChangeClaims = createServerFn()
  .inputValidator((changeId: string) => changeId)
  .handler(({ data }) => call<ChangeClaims>(`/v1/changes/${data}/claims`));

export const getChangeProgress = createServerFn()
  .inputValidator((changeId: string) => changeId)
  .handler(({ data }) => call<RunProgress[]>(`/v1/changes/${data}/progress`));

/* Workspace page (AGENTS.md 38.5): canonical Artifact, Task and Candidate forks, file index. */

export type WorkspaceFileStat = {
  path: string;
  /** Changed lines from `git diff --stat`; null for a binary file. */
  changes: number | null;
  adds: number | null;
  dels: number | null;
  /** False when git scaled the +/- bar, so `adds` and `dels` are proportional estimates. */
  exact: boolean;
  binary: boolean;
};

export type WorkspaceChangeSet = {
  id: string;
  status: string;
  fork: string;
  commit: string;
  baseCommit: string;
  files: string[];
  fileStats: WorkspaceFileStat[];
  insertions: number;
  deletions: number;
  /** Raw `git diff --stat` output as the agent stored it. */
  diffStat: string;
  createdAt: string;
};

export type WorkspaceFork = {
  fork: string;
  runId: string | null;
  changeId: string;
  taskId: string | null;
  taskKey: string | null;
  taskTitle: string | null;
  attempt: number | null;
  runStatus: string | null;
  baseGeneration: number;
  startedAt: string | null;
  endedAt: string | null;
  changeSet: WorkspaceChangeSet | null;
};

export type CandidateFork = {
  fork: string;
  id: string;
  changeId: string;
  status: string;
  statusReason: string | null;
  baseGeneration: number;
  composedCommit: string | null;
  composedTree: string | null;
  changeSetIds: string[];
  promotedGeneration: number | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkspaceView = {
  canonical: {
    assigned: boolean;
    generation: number;
    artifactRef: string;
    treeSha: string;
    lastPromotedCandidateId: string | null;
    updatedAt: string | null;
  };
  changes: {
    id: string;
    goal: string;
    status: string;
    baseGeneration: number;
    createdAt: string;
  }[];
  /** More Changes exist than `changes` lists. */
  truncated: boolean;
  workspaces: WorkspaceFork[];
  candidates: CandidateFork[];
};

export type WorkspaceFileIndex = {
  treeSha: string;
  indexed: boolean;
  commit: string | null;
  files: string[];
  truncated: boolean;
};

export const getWorkspace = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<WorkspaceView>(`/v1/projects/${data}/workspace`));

export const getWorkspaceFiles = createServerFn()
  .inputValidator((input: { projectId: string; tree?: string }) => input)
  .handler(({ data }) =>
    call<WorkspaceFileIndex>(
      `/v1/projects/${data.projectId}/workspace/files${data.tree ? `?tree=${encodeURIComponent(data.tree)}` : ""}`,
    ),
  );

/** One attempt of an agent, with its Decision Receipt (routing inputs and outputs only). */
export type AgentRunView = {
  attempt: number;
  tier: TaskRun["tier"];
  status: TaskRun["status"];
  failureKind: string | null;
  failureReason: string | null;
  decidedBy: string | null;
  reasons: string[];
  /** The previous attempt's tier when this attempt moved up a tier. */
  escalatedFrom: TaskRun["tier"] | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  lastStep: string | null;
  progressAt: string | null;
};

export type AgentClaim = {
  claimId: string;
  agentId: string;
  resource: string;
  status: "active" | "released" | "expired";
  leaseExpiresAt: string | null;
  acquiredAt: string | null;
  updatedAt: string;
};

/** One logical agent (one per Task) of a Project, for the Agents page (AGENTS.md 38.6). */
export type AgentView = {
  agentId: string;
  role: string;
  state: "active" | "sleeping";
  task: {
    id: string;
    key: string;
    title: string;
    kind: string;
    status: string;
    riskTier: string | null;
    complexity: string | null;
    changeId: string;
    changeGoal: string;
  };
  tier: TaskRun["tier"] | null;
  attempts: number;
  escalations: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  intent: { summary: string; semanticResources: string[]; assumptions: string[] } | null;
  /** Null when the event feed is not readable. */
  claims: AgentClaim[] | null;
  lastEvent: { type: string; summary: string; occurredAt: string } | null;
  lastActiveAt: string;
  runs: AgentRunView[];
};

export type ProjectAgents = {
  agents: AgentView[];
  sleeping: { total: number; unlisted: { role: string; count: number }[] };
  notWoken: number;
  totals: {
    agents: number;
    active: number;
    runs: number;
    escalations: number;
    modelCalls: number;
    costUsd: number;
  };
  today: { day: string; accountCalls: number; cap: number; projectCalls: number };
  recentHours: number;
  feed: { available: boolean };
};

export const getProjectAgents = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<ProjectAgents>(`/v1/projects/${data}/agents`));

/**
 * Product Graph (AGENTS.md 28, 38.3), derived by the API from Task resources, Intents, Task
 * dependencies, ChangeSets, conflicts, policy protected resources and the seeded fixture imports
 * (workers/api product-graph.ts). Nothing is stored yet (P7-04).
 */
export type ProductGraphEdgeOrigin =
  | { kind: "fixture_import"; file: string; detail: string }
  | { kind: "task_dependency"; changeId: string; taskKey: string; dependsOnTaskKey: string }
  | { kind: "shared_task"; changeId: string; taskKey: string; resources: string[] };

export type ProductGraphNode = {
  id: string;
  name: string;
  baseline: boolean;
  baselineFile: string | null;
  protectedResources: string[];
  touches: {
    changeId: string;
    resources: string[];
    tasks: { id: string; key: string; title: string; kind: string; status: string }[];
    changeSetCount: number;
  }[];
  conflicts: { id: string; changeId: string; resource: string; state: string }[];
};

export type ProductGraphEdge = {
  id: string;
  source: string;
  target: string;
  kind: "authorization" | "product_reference" | "state" | "dependency";
  label: string;
  changeIds: string[];
  origins: ProductGraphEdgeOrigin[];
  moreOrigins: number;
};

export type ProductGraph = {
  projectId: string;
  canonicalGeneration: number | null;
  policyVersion: string;
  protectedResources: string[];
  fixture: { applied: boolean; source: string; hiddenFiles: string[] };
  /** Oldest first, newest 20. */
  changes: { id: string; goal: string; status: string; createdAt: string }[];
  nodes: ProductGraphNode[];
  edges: ProductGraphEdge[];
  counts: {
    tasks: number;
    intents: number;
    dependencies: number;
    changeSets: number;
    conflicts: number;
  };
  truncated: boolean;
};

export const getProductGraph = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<ProductGraph>(`/v1/projects/${data}/product-graph`));
