import type { ProjectRootDO, ProjectViewDO } from "@rhumbatron/coordinator";
import {
  apiData,
  Change,
  CreateChangeRequest,
  CreateProjectRequest,
  Project,
  type ProjectPolicies,
  ProjectTemplate,
  Task,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Default policy until project policies are stored (AGENTS.md section 53). */
const DEFAULT_POLICIES: ProjectPolicies = {
  maxCostUsdPerChange: 3,
  humanGateRiskTiers: ["high", "critical"],
  networkPolicy: "restricted",
  modelPolicyVersion: "policy-1",
};

/** Placeholder canonical source until Artifacts exist (Phase 8). */
const UNASSIGNED_ARTIFACT = { artifactRef: "unassigned", treeSha: "empty" };

const projectRoot = (env: Env, projectId: string) => {
  const ns = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  return ns.get(ns.idFromName(projectId));
};

const projectView = (env: Env, projectId: string) => {
  const ns = env.PROJECT_VIEW as DurableObjectNamespace<ProjectViewDO>;
  return ns.get(ns.idFromName(projectId));
};

type ProjectRow = { id: string; org_id: string; name: string; slug: string; status: string };

type ChangeRow = {
  id: string;
  project_id: string;
  goal: string;
  status: string;
  base_generation: number;
  budget_usd: number;
  acceptance_criteria_json: string;
  invariants_json: string;
  work_graph_ref: string | null;
};

type TaskRow = {
  id: string;
  change_id: string;
  task_key: string | null;
  title: string | null;
  kind: string;
  objective: string | null;
  semantic_resources_json: string;
  acceptance_criteria_json: string;
  risk_tier: string | null;
  complexity: string | null;
  status: string;
  assigned_agent_id: string | null;
};

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

function toChange(row: ChangeRow): Change {
  return {
    id: row.id,
    projectId: row.project_id,
    goal: row.goal,
    acceptanceCriteria: JSON.parse(row.acceptance_criteria_json) as string[],
    invariants: JSON.parse(row.invariants_json) as string[],
    status: Change.shape.status.parse(row.status),
    baseGeneration: row.base_generation,
    ...(row.work_graph_ref ? { workGraphRef: row.work_graph_ref } : {}),
    budgetUsd: row.budget_usd,
    rolloutPolicy: { target: "preview" },
  };
}

async function loadProject(env: Env, projectId: string): Promise<Project | null> {
  const row = await env.DB.prepare(
    "SELECT id, org_id, name, slug, status FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<ProjectRow>();
  if (!row) return null;
  const canonical = await projectRoot(env, projectId).getCanonical();
  return {
    id: row.id,
    orgId: row.org_id,
    name: row.name,
    slug: row.slug,
    status: Project.shape.status.parse(row.status),
    canonical: {
      provider: "cloudflare-artifacts",
      artifactRef: canonical?.artifactRef ?? UNASSIGNED_ARTIFACT.artifactRef,
      generation: canonical?.generation ?? 0,
      treeSha: canonical?.treeSha ?? UNASSIGNED_ARTIFACT.treeSha,
    },
    policies: DEFAULT_POLICIES,
  };
}

const ProvisionRequest = z.object({ template: ProjectTemplate });

/** Queues source provisioning. The command ID is stable per Project, so a retry is harmless. */
async function sendProvision(
  env: Env,
  projectId: string,
  template: z.infer<typeof ProjectTemplate>,
) {
  await env.INTEGRATION_COMMANDS.send(
    {
      commandId: `cmd_${projectId.slice(5)}_provision`,
      commandType: "project.provision",
      projectId,
      attempt: 0,
      createdAt: new Date().toISOString(),
      payload: { template },
    },
    { contentType: "json" },
  );
}

export const projects = new Hono<AppEnv>()
  .use("/v1/projects", requireAuth)
  .use("/v1/projects/*", requireAuth)
  .use("/v1/changes/*", requireAuth)

  // P3-08: create a Project owned by the caller's personal organization.
  .post("/v1/projects", validate("json", CreateProjectRequest), async (c) => {
    const { userId, orgId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const body = c.req.valid("json");
    const projectId = `proj_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const inserted = await c.env.DB.prepare(
      `INSERT INTO projects (id, org_id, name, slug, status, canonical_generation, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 0, ?, ?) ON CONFLICT (org_id, slug) DO NOTHING`,
    )
      .bind(projectId, orgId, body.name, body.slug, now, now)
      .run();
    if (inserted.meta.changes === 0) {
      return fail(c, 409, "conflict", `Project slug "${body.slug}" already exists`);
    }

    // Both initializers are idempotent, so a retry after a partial failure is safe. The view goes
    // first: ProjectRootDO emits project.created, and the projector needs the view to exist.
    await projectView(c.env, projectId).initialize({
      projectId,
      name: body.name,
      canonicalGeneration: 0,
    });

    await projectRoot(c.env, projectId).initialize({
      projectId,
      orgId,
      ...UNASSIGNED_ARTIFACT,
      generation: 0,
      policyVersion: DEFAULT_POLICIES.modelPolicyVersion,
    });
    // The integration Worker creates the Artifacts repo and seeds the template (ADR 0010).
    await sendProvision(c.env, projectId, body.template);
    const project = await loadProject(c.env, projectId);
    if (!project || !(await canAccessProject(c.env.DB, userId, projectId))) {
      throw new Error("Project was not readable after creation");
    }
    return respond(c, apiData(Project), { data: project }, 201);
  })

  // Projects the caller can open, newest first (UI navigation).
  .get("/v1/projects", async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const rows = await c.env.DB.prepare(
      `SELECT p.id, p.name, p.slug, p.status, p.canonical_generation, p.created_at
       FROM projects p JOIN memberships m ON m.org_id = p.org_id
       WHERE m.user_id = ? ORDER BY p.created_at DESC LIMIT 50`,
    )
      .bind(userId)
      .all<{
        id: string;
        name: string;
        slug: string;
        status: string;
        canonical_generation: number;
        created_at: string;
      }>();
    return c.json({
      data: (rows.results ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        status: p.status,
        canonicalGeneration: p.canonical_generation,
        createdAt: p.created_at,
      })),
    });
  })

  // Changes of one Project, newest first.
  .get("/v1/projects/:projectId/changes", validate("param", ProjectIdParam), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const rows = await c.env.DB.prepare(
      `SELECT c.id, c.goal, c.status, c.risk_tier, c.budget_usd, c.created_at,
              (SELECT COUNT(*) FROM tasks t WHERE t.change_id = c.id) AS task_count,
              (SELECT COUNT(*) FROM tasks t WHERE t.change_id = c.id AND t.status = 'completed') AS completed_count
       FROM changes c WHERE c.project_id = ? ORDER BY c.created_at DESC LIMIT 20`,
    )
      .bind(projectId)
      .all<{
        id: string;
        goal: string;
        status: string;
        risk_tier: string | null;
        budget_usd: number;
        created_at: string;
        task_count: number;
        completed_count: number;
      }>();
    return c.json({
      data: (rows.results ?? []).map((r) => ({
        id: r.id,
        goal: r.goal,
        status: r.status,
        riskTier: r.risk_tier,
        budgetUsd: r.budget_usd,
        createdAt: r.created_at,
        taskCount: r.task_count,
        completedCount: r.completed_count,
      })),
    });
  })

  // Seeds the source of a Project that has none yet, for example the Acme Shop demo (P12-12).
  .post(
    "/v1/projects/:projectId/provision",
    validate("param", ProjectIdParam),
    validate("json", ProvisionRequest),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      if (!(await canAccessProject(c.env.DB, userId, projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      await sendProvision(c.env, projectId, c.req.valid("json").template);
      return c.json({ data: { queued: true } }, 202);
    },
  )

  .get("/v1/projects/:projectId", validate("param", ProjectIdParam), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const project = await loadProject(c.env, projectId);
    if (!project) return fail(c, 404, "not_found", "Project not found");
    return respond(c, apiData(Project), { data: project });
  })

  // P3-10: human-scale read model from ProjectViewDO.
  .get("/v1/projects/:projectId/snapshot", validate("param", ProjectIdParam), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const view = await projectView(c.env, projectId).getSnapshot();
    return c.json({ data: view });
  })

  // P3-09: create a Change at the current Canonical Generation. Idempotent on clientRequestId.
  .post(
    "/v1/projects/:projectId/changes",
    validate("param", ProjectIdParam),
    validate("json", CreateChangeRequest),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      const body = c.req.valid("json");
      if (!(await canAccessProject(c.env.DB, userId, projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }

      if (body.clientRequestId) {
        const existing = await c.env.DB.prepare(
          "SELECT * FROM changes WHERE project_id = ? AND client_request_id = ?",
        )
          .bind(projectId, body.clientRequestId)
          .first<ChangeRow>();
        if (existing) return respond(c, apiData(Change), { data: toChange(existing) });
      }

      const canonical = await projectRoot(c.env, projectId).getCanonical();
      if (!canonical) throw new Error(`ProjectRootDO missing for ${projectId}`);

      const changeId = `chg_${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      await c.env.DB.prepare(
        `INSERT INTO changes (id, project_id, goal, status, base_generation, budget_usd,
           client_request_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          changeId,
          projectId,
          body.goal,
          canonical.generation,
          body.budgetUsd,
          body.clientRequestId ?? null,
          userId,
          now,
          now,
        )
        .run();

      // ChangeWorkflow compiles the Work Graph asynchronously (AGENTS.md section 58). The instance
      // ID is the Change ID, so a retried request cannot start a second planner.
      if (body.startPlanning) {
        try {
          await c.env.CHANGE_WORKFLOW.create({ id: changeId, params: { changeId } });
        } catch (error) {
          // The Change stays `created`; starting the workflow again with the same ID is safe.
          console.error(
            JSON.stringify({
              event: "change.workflow_start_failed",
              changeId,
              message: String(error).slice(0, 200),
            }),
          );
        }
      }

      // The dashboard projection is eventually consistent (AGENTS.md section 59).
      await projectView(c.env, projectId).applyDelta({
        upsert: {
          activeChanges: [{ id: changeId, status: "created", label: body.goal.slice(0, 80) }],
        },
      });

      const row = await c.env.DB.prepare("SELECT * FROM changes WHERE id = ?")
        .bind(changeId)
        .first<ChangeRow>();
      if (!row) throw new Error("Change was not readable after creation");
      return respond(c, apiData(Change), { data: toChange(row) }, 201);
    },
  )

  .get("/v1/changes/:changeId", validate("param", ChangeIdParam), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { changeId } = c.req.valid("param");
    const row = await c.env.DB.prepare("SELECT * FROM changes WHERE id = ?")
      .bind(changeId)
      .first<ChangeRow>();
    if (!row || !(await canAccessProject(c.env.DB, userId, row.project_id))) {
      return fail(c, 404, "not_found", "Change not found");
    }
    return respond(c, apiData(Change), { data: toChange(row) });
  })

  // The Work Graph of one Change, in plan order (AGENTS.md section 16.1).
  .get("/v1/changes/:changeId/tasks", validate("param", ChangeIdParam), async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { changeId } = c.req.valid("param");
    const change = await c.env.DB.prepare("SELECT project_id FROM changes WHERE id = ?")
      .bind(changeId)
      .first<{ project_id: string }>();
    if (!change || !(await canAccessProject(c.env.DB, userId, change.project_id))) {
      return fail(c, 404, "not_found", "Change not found");
    }
    const [tasks, deps, runs] = await c.env.DB.batch([
      c.env.DB.prepare("SELECT * FROM tasks WHERE change_id = ? ORDER BY task_key").bind(changeId),
      c.env.DB.prepare(
        `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
         JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?`,
      ).bind(changeId),
      c.env.DB.prepare(
        `SELECT r.task_id, r.attempt, r.tier, r.status, r.failure_kind, r.outcome_json, r.model_calls,
                r.input_tokens, r.output_tokens, r.cost_usd, r.started_at, r.ended_at,
                d.decided_by, d.receipt_json
         FROM task_runs r JOIN tasks t ON t.id = r.task_id
         LEFT JOIN decision_receipts d ON d.id = 'rcpt_' || substr(r.id, 5)
         WHERE t.change_id = ? ORDER BY r.attempt`,
      ).bind(changeId),
    ]);
    type RunRow = {
      task_id: string;
      attempt: number;
      tier: string;
      status: string;
      failure_kind: string | null;
      outcome_json: string | null;
      model_calls: number;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
      started_at: string;
      ended_at: string | null;
      decided_by: string | null;
      receipt_json: string | null;
    };
    const runRows = (runs?.results ?? []) as RunRow[];
    const edges = (deps?.results ?? []) as { task_id: string; depends_on_task_id: string }[];
    const data = ((tasks?.results ?? []) as TaskRow[]).map((t) => ({
      id: t.id,
      changeId: t.change_id,
      key: t.task_key ?? "",
      title: t.title ?? "",
      kind: Task.shape.kind.parse(t.kind),
      objective: t.objective ?? "",
      semanticResources: JSON.parse(t.semantic_resources_json) as string[],
      dependsOn: edges.filter((e) => e.task_id === t.id).map((e) => e.depends_on_task_id),
      acceptanceCriteria: JSON.parse(t.acceptance_criteria_json) as string[],
      riskTier: Task.shape.riskTier.parse(t.risk_tier ?? "medium"),
      complexity: Task.shape.complexity.parse(t.complexity ?? "medium"),
      status: Task.shape.status.parse(t.status),
      assignedAgentId: t.assigned_agent_id,
      // Agent runs for this Task: tier, outcome (the typed Intent or a failure), usage, and route.
      runs: runRows
        .filter((r) => r.task_id === t.id)
        .map((r) => ({
          attempt: r.attempt,
          tier: r.tier,
          status: r.status,
          failureKind: r.failure_kind,
          outcome: r.outcome_json ? (JSON.parse(r.outcome_json) as unknown) : null,
          modelCalls: r.model_calls,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          costUsd: r.cost_usd,
          startedAt: r.started_at,
          endedAt: r.ended_at,
          decidedBy: r.decided_by,
          routeReasons: r.receipt_json
            ? ((JSON.parse(r.receipt_json) as { reasons?: string[] }).reasons ?? [])
            : [],
        })),
    }));
    return c.json({ data });
  });
