import {
  apiData,
  ProjectReleases,
  ReleaseInjectionOutcome,
  type ReleaseView,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fixturesEnabled } from "./fixtures.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity, ownerOnlyMessage, projectRole } from "./identity.ts";

/**
 * Releases of a Project (AGENTS.md sections 21.3, 37, 42.10; ADR 0018). Read-only from D1: the
 * integration Worker's ReleaseWorkflow owns every release row. The failure injection route (P13-12)
 * is an RPC to the integration Worker and answers only where the fixture routes answer
 * (FIXTURES_ENABLED, dev, local); elsewhere 404, as if absent.
 *
 * Cost: a read is 2 D1 queries (target by primary key, releases by `idx_releases_project`).
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
  build_uuid: string | null;
  version_id: string | null;
  started_at: string;
  finished_at: string | null;
  failure_reason: string | null;
  evidence_id: string | null;
  evidence_r2_key: string | null;
};
type TargetRow = { project_id: string; worker_name: string; url: string };

const toView = (row: Row, target: TargetRow | null): ReleaseView => ({
  id: row.id,
  projectId: row.project_id,
  changeId: row.change_id,
  candidateId: row.candidate_id,
  generation: row.generation,
  commit: row.commit_sha,
  status: row.status,
  buildUuid: row.build_uuid,
  versionId: row.version_id,
  url: target?.url ?? null,
  workerName: target?.worker_name ?? null,
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
  /** The release target and the newest releases, newest generation first. */
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
      const [target, rows] = await c.env.DB.batch([
        c.env.DB.prepare(
          "SELECT project_id, worker_name, url FROM release_targets WHERE project_id = ?",
        ).bind(projectId),
        c.env.DB.prepare(
          `SELECT * FROM releases WHERE project_id = ? ORDER BY generation DESC LIMIT ${limit}`,
        ).bind(projectId),
      ]);
      const t = ((target?.results ?? [])[0] as TargetRow | undefined) ?? null;
      return respond(c, apiData(ProjectReleases), {
        data: {
          target: t ? { projectId: t.project_id, workerName: t.worker_name, url: t.url } : null,
          releases: ((rows?.results ?? []) as Row[]).map((r) => toView(r, t)),
        },
      });
    },
  )

  .use("/v1/projects/:projectId/releases/inject-failure", async (c, next) => {
    if (!fixturesEnabled(c.env)) return fail(c, 404, "not_found", "Route not found");
    await next();
  })

  /**
   * P13-12: a real smoke failure on the latest deployed release, marked injected: the release URL
   * is probed with the normal smoke probes plus a route that does not exist. The Canonical
   * Generation does not change; recovery is the next promotion (section 42.10). Safe to repeat.
   */
  .post(
    "/v1/projects/:projectId/releases/inject-failure",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const userId = await member(c.env, c.get("authSubject"), projectId);
      if (!userId) return fail(c, 404, "not_found", "Project not found");
      if ((await projectRole(c.env.DB, userId, projectId)) !== "owner") {
        return fail(c, 403, "forbidden", ownerOnlyMessage("inject a release failure"));
      }
      const outcome = ReleaseInjectionOutcome.parse(
        await integration(c.env).injectReleaseFailure({ projectId, actorUserId: userId }),
      );
      if (outcome.status === "refused") {
        const status =
          outcome.reason === "no_target" || outcome.reason === "no_release" ? 404 : 409;
        return c.json(
          errorBody(status === 404 ? "not_found" : "conflict", outcome.detail, outcome),
          status,
        );
      }
      return respond(c, apiData(ReleaseInjectionOutcome), { data: outcome });
    },
  );
