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
