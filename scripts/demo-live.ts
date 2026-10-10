/**
 * Live model-driven demo runner for Rhumbatron (AGENTS.md sections 4, 16.1, 54).
 *
 * Runs a real model-driven Change end to end on dev and streams progress:
 *   bun run demo:live
 *   bun run demo:live --project <slug> --goal "<text>" --budget <usd> --timeout <minutes>
 *   bun run demo:live --change <id>
 */
import { WISHLIST_GOAL } from "../fixtures/wishlist/manifest.ts";

const API = process.env.API_URL ?? "https://api-dev.rhumbatron.com";
const WEB = process.env.WEB_URL ?? "https://dev.rhumbatron.com";

const secretKey = process.env.CLERK_SECRET_KEY;
const userId = process.env.CLERK_SMOKE_USER_ID;
if (!secretKey || !userId) {
  console.error("CLERK_SECRET_KEY and CLERK_SMOKE_USER_ID are required (see package.json).");
  process.exit(2);
}

// CLI arguments
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }
  for (const arg of args) {
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

const projectSlug = getArg("--project") ?? "acme-shop-live";
const goal = getArg("--goal") ?? WISHLIST_GOAL;
const budgetRaw = getArg("--budget");
const parsedBudget = budgetRaw ? Number.parseFloat(budgetRaw) : 3;
const budget = Number.isNaN(parsedBudget) || parsedBudget <= 0 ? 3 : parsedBudget;
const changeIdArg = getArg("--change");
const timeoutRaw = getArg("--timeout");
const parsedTimeout = timeoutRaw ? Number.parseFloat(timeoutRaw) : 120;
const timeoutMinutes = Number.isNaN(parsedTimeout) || parsedTimeout <= 0 ? 120 : parsedTimeout;

// Clerk API helpers
async function clerk<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`https://api.clerk.com/v1${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Clerk ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

const session = await clerk<{ id: string }>("/sessions", { user_id: userId });

let sessionRevoked = false;
async function revokeSession(): Promise<void> {
  if (sessionRevoked) return;
  sessionRevoked = true;
  try {
    await clerk(`/sessions/${session.id}/revoke`, {});
  } catch {
    // Ignore revoke errors on shutdown
  }
}

process.on("SIGINT", async () => {
  console.log("\nReceived SIGINT. Revoking Clerk session...");
  await revokeSession();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  console.log("\nReceived SIGTERM. Revoking Clerk session...");
  await revokeSession();
  process.exit(143);
});

async function getFreshHeaders(): Promise<Record<string, string>> {
  const { jwt } = await clerk<{ jwt: string }>(`/sessions/${session.id}/tokens`, {});
  return {
    authorization: `Bearer ${jwt}`,
    "content-type": "application/json",
  };
}

async function apiGet<T>(path: string, headers: Record<string, string>): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text) as { data: T }).data;
}

async function apiPost<T>(
  path: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return (JSON.parse(text) as { data: T }).data;
}

type ProjectSummary = {
  id: string;
  name: string;
  slug: string;
  status: string;
  canonicalGeneration: number;
  createdAt: string;
};

type ProjectDetail = {
  id: string;
  orgId: string;
  name: string;
  slug: string;
  status: string;
  canonical: {
    provider: string;
    artifactRef: string;
    generation: number;
    treeSha: string;
  };
};

type ChangeDetail = {
  id: string;
  projectId: string;
  goal: string;
  status: string;
  baseGeneration: number;
  budgetUsd: number;
  riskTier: string | null;
  createdAt: string;
  updatedAt: string;
};

type TaskRunItem = {
  attempt: number;
  tier: string;
  status: string;
  failureKind: string | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
};

type TaskItem = {
  id: string;
  changeId: string;
  key: string;
  title: string;
  kind: string;
  objective: string;
  status: string;
  assignedAgentId: string | null;
  runs: TaskRunItem[];
};

type CandidateItem = {
  id: string;
  changeId: string;
  projectId: string;
  status: string;
  statusReason: string | null;
  approvalRequired: boolean;
  approval: {
    id: string;
    candidateId: string;
    decision: "granted" | "rejected";
  } | null;
  gate: {
    promotable: boolean;
  } | null;
};

type RunProgressItem = {
  taskId: string;
  attempt: number;
  tier: string;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  lastStep: string | null;
  startedAt: string;
  progressAt: string | null;
};

const TERMINAL_CHANGE_STATUSES = new Set(["completed", "failed", "cancelled", "budget_blocked"]);

const ACTIVE_CANDIDATE_STATUSES = new Set(["composing", "composed", "verifying"]);

async function runDemo(): Promise<void> {
  let changeId = changeIdArg;

  if (!changeId) {
    const headers = await getFreshHeaders();
    const projects = await apiGet<ProjectSummary[]>("/v1/projects", headers);
    const existing = projects.find((p) => p.slug === projectSlug);
    let projectId: string;

    if (existing) {
      projectId = existing.id;
    } else {
      console.log(`Project "${projectSlug}" not found. Creating it with the Acme Shop fixture...`);
      const created = await apiPost<{ id: string }>(
        "/v1/fixtures/projects",
        {
          name: projectSlug === "acme-shop-live" ? "Acme Shop Live" : projectSlug,
          slug: projectSlug,
        },
        headers,
      );
      projectId = created.id;
      console.log(`Created project ${projectId}; waiting for source provisioning...`);
    }

    let projectDetail = await apiGet<ProjectDetail>(`/v1/projects/${projectId}`, headers);
    if (projectDetail.canonical.artifactRef === "unassigned") {
      console.log(`Waiting for source provisioning on project ${projectId}...`);
      const until = Date.now() + 180_000;
      while (Date.now() < until) {
        await Bun.sleep(5000);
        const freshHeaders = await getFreshHeaders();
        projectDetail = await apiGet<ProjectDetail>(`/v1/projects/${projectId}`, freshHeaders);
        if (projectDetail.canonical.artifactRef !== "unassigned") break;
      }
    }

    if (projectDetail.canonical.artifactRef === "unassigned") {
      throw new Error("Project source not provisioned yet; run again shortly");
    }

    console.log(
      `Project ready: ${projectDetail.id} (${projectDetail.slug}, generation S${projectDetail.canonical.generation})`,
    );

    const clientRequestId = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    console.log(`Creating Change (goal: "${goal}", budget: $${budget})...`);
    const createdChange = await apiPost<{ id: string }>(
      `/v1/projects/${projectId}/changes`,
      {
        goal,
        budgetUsd: budget,
        startPlanning: true,
        clientRequestId,
      },
      await getFreshHeaders(),
    );
    changeId = createdChange.id;
    console.log(`Created Change: ${changeId}`);
  } else {
    console.log(`Watching existing Change: ${changeId}`);
  }

  console.log(`Streaming progress for Change ${changeId} (polling every 30s)...`);

  const deadline = Date.now() + timeoutMinutes * 60 * 1000;
  let lastStateKey = "";
  let lastCandidates: CandidateItem[] = [];

  while (true) {
    let change: ChangeDetail;
    let tasks: TaskItem[];
    let candidates: CandidateItem[];
    let progress: RunProgressItem[];

    try {
      const headers = await getFreshHeaders();
      [change, tasks, candidates, progress] = await Promise.all([
        apiGet<ChangeDetail>(`/v1/changes/${changeId}`, headers),
        apiGet<TaskItem[]>(`/v1/changes/${changeId}/tasks`, headers),
        apiGet<CandidateItem[]>(`/v1/changes/${changeId}/candidates`, headers),
        apiGet<RunProgressItem[]>(`/v1/changes/${changeId}/progress`, headers),
      ]);
      lastCandidates = candidates;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${new Date().toISOString()}] Poll failed: ${msg}; retrying in 30s...`);
      if (Date.now() >= deadline) {
        console.error(`Timed out after ${timeoutMinutes} minutes.`);
        break;
      }
      await Bun.sleep(30_000);
      continue;
    }

    const runningCalls = progress.reduce((acc, p) => acc + p.modelCalls, 0);
    const runningCost = progress.reduce((acc, p) => acc + p.costUsd, 0);

    const taskParts = tasks.map((t) => {
      const runs = t.runs ?? [];
      const lastRun = runs.length > 0 ? runs[runs.length - 1] : undefined;
      const tier = lastRun?.tier ?? "-";
      const runStatus = lastRun?.status ?? "-";
      const failureKind = lastRun?.failureKind ?? "-";
      return `${t.key}:${t.status}(${tier}/${runStatus}/${failureKind})`;
    });
    const tasksStr = taskParts.length > 0 ? taskParts.join(" ") : "-";

    const candidateParts = candidates.map((c) => {
      return c.statusReason ? `${c.id}:${c.status}(${c.statusReason})` : `${c.id}:${c.status}`;
    });
    const candidatesStr = candidateParts.length > 0 ? candidateParts.join(" ") : "-";

    const progressStr = `running: ${runningCalls} calls / $${runningCost.toFixed(3)}`;

    const stateKey = `${change.status}|${tasksStr}|${candidatesStr}|${runningCalls}|${runningCost.toFixed(4)}`;

    if (stateKey !== lastStateKey) {
      lastStateKey = stateKey;
      const time = new Date().toISOString();
      console.log(
        `${time} | ${change.status} | tasks: ${tasksStr} | candidates: ${candidatesStr} | ${progressStr}`,
      );
    }

    const isChangeDone = TERMINAL_CHANGE_STATUSES.has(change.status);
    const hasActiveCandidates = candidates.some((c) => ACTIVE_CANDIDATE_STATUSES.has(c.status));

    if (isChangeDone && !hasActiveCandidates) {
      break;
    }

    if (Date.now() >= deadline) {
      console.log(`\nTimed out after ${timeoutMinutes} minutes.`);
      break;
    }

    await Bun.sleep(30_000);
  }

  // Print links and final status
  console.log(`\nFlight link: ${WEB}/changes/${changeId}/flight`);
  if (lastCandidates.length > 0) {
    console.log("Candidates:");
    for (const c of lastCandidates) {
      console.log(`  ${WEB}/candidates/${c.id} (${c.status})`);
    }
    const waiting = lastCandidates.filter(
      (c) => c.status === "verified" && c.approvalRequired && c.approval?.decision !== "granted",
    );
    if (waiting.length > 0) {
      for (const c of waiting) {
        console.log(`Candidate ${c.id} waits for approval.`);
      }
    } else {
      console.log("No candidates are waiting for approval.");
    }
  } else {
    console.log("No candidates produced.");
  }

  const verifiedOrPromoted = lastCandidates.some(
    (c) => c.status === "verified" || c.status === "promoted",
  );
  process.exitCode = verifiedOrPromoted ? 0 : 1;
}

try {
  await runDemo();
} catch (error) {
  console.error("Demo failed:", error);
  process.exitCode = 1;
} finally {
  await revokeSession();
}
