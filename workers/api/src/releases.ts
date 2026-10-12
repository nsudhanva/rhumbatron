import {
  apiData,
  can,
  deniedMessage,
  ProjectReleases,
  ReleaseInjectionOutcome,
  type ReleaseView,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity, projectRole } from "./identity.ts";

/**
 * Releases of a Project (ADR 0020). Read-only from D1: the
 * integration Worker's ReleaseWorkflow owns every release row. The failure injection route
 * is an RPC to the integration Worker; only the Project owner or an admin can call it.
 *
 * Cost: a read is 1 D1 query (releases by `idx_releases_project`).
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });

type Rpc = {
  injectReleaseFailure(input: { projectId: string; actorUserId: string }): Promise<unknown>;
};
const integration = (env: Env) => env.INTEGRATION as unknown as Rpc;

type Row = {
  id: string;
  project_id: string;
  change_id: string;
  candidate_id: string;
  generation: number;
  commit_sha: string;
  status: ReleaseView["status"];
  version_id: string | null;
  started_at: string;
  finished_at: string | null;
  failure_reason: string | null;
  evidence_id: string | null;
  evidence_r2_key: string | null;
};

const toView = (row: Row): ReleaseView => ({
  id: row.id,
  projectId: row.project_id,
  changeId: row.change_id,
  candidateId: row.candidate_id,
  generation: row.generation,
  commit: row.commit_sha,
  status: row.status,
  versionId: row.version_id,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  failureReason: row.failure_reason,
  evidenceId: row.evidence_id,
  evidenceR2Key: row.evidence_r2_key,
});

async function member(env: Env, authSubject: string, projectId: string) {
  const { userId } = await ensureIdentity(env.DB, authSubject);
  return (await canAccessProject(env.DB, userId, projectId)) ? userId : null;
}

export const releases = new Hono<AppEnv>()
  /** The newest releases of the Project, newest generation first. */
  .get(
    "/v1/projects/:projectId/releases",
    requireAuth,
    validate("param", ProjectIdParam),
    validate("query", ListQuery),
    async (c) => {
      const { projectId } = c.req.valid("param");
      if (!(await member(c.env, c.get("authSubject"), projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      const { limit } = c.req.valid("query");
      const rows = await c.env.DB.prepare(
        `SELECT * FROM releases WHERE project_id = ? ORDER BY generation DESC LIMIT ${limit}`,
      )
        .bind(projectId)
        .all<Row>();
      return respond(c, apiData(ProjectReleases), {
        data: { releases: rows.results.map(toView) },
      });
    },
  )

  /**
   * A real smoke failure on the latest deployed release, marked injected: the live app
   * is probed through the apps router with the normal smoke probes plus a route that does not exist. The Canonical
   * Generation does not change; recovery is the next promotion. Safe to repeat.
   */
  .post(
    "/v1/projects/:projectId/releases/inject-failure",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const userId = await member(c.env, c.get("authSubject"), projectId);
      if (!userId) return fail(c, 404, "not_found", "Project not found");
      if (!can(await projectRole(c.env.DB, userId, projectId), "release.injectFailure")) {
        return fail(
          c,
          403,
          "forbidden",
          deniedMessage("release.injectFailure", "inject a release failure"),
        );
      }
      const outcome = ReleaseInjectionOutcome.parse(
        await integration(c.env).injectReleaseFailure({ projectId, actorUserId: userId }),
      );
      if (outcome.status === "refused") {
        const status = outcome.reason === "no_app" || outcome.reason === "no_release" ? 404 : 409;
        return c.json(
          errorBody(status === 404 ? "not_found" : "conflict", outcome.detail, outcome),
          status,
        );
      }
      return respond(c, apiData(ReleaseInjectionOutcome), { data: outcome });
    },
  );
