import type { ProjectRootDO, ProjectViewDO } from "@rhumbatron/coordinator";
import {
  apiData,
  Change,
  CreateChangeRequest,
  CreateProjectRequest,
  Project,
  type ProjectPolicies,
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
};

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const ChangeIdParam = z.object({ changeId: z.string().regex(/^chg_[a-z0-9-]+$/) });

function toChange(row: ChangeRow): Change {
  return {
    id: row.id,
    projectId: row.project_id,
    goal: row.goal,
    acceptanceCriteria: [],
    invariants: [],
    status: Change.shape.status.parse(row.status),
    baseGeneration: row.base_generation,
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

    // Both initializers are idempotent, so a retry after a partial failure is safe.
    await projectRoot(c.env, projectId).initialize({
      projectId,
      orgId,
      ...UNASSIGNED_ARTIFACT,
      generation: 0,
      policyVersion: DEFAULT_POLICIES.modelPolicyVersion,
    });
    await projectView(c.env, projectId).initialize({
      projectId,
      name: body.name,
      canonicalGeneration: 0,
    });

    const project = await loadProject(c.env, projectId);
    if (!project || !(await canAccessProject(c.env.DB, userId, projectId))) {
      throw new Error("Project was not readable after creation");
    }
    return respond(c, apiData(Project), { data: project }, 201);
  })

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
  });
