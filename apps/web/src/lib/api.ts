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
