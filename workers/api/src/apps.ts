import {
  APP_PRODUCTION_CHANNEL,
  type AppDeploymentStatus,
  AppProvisionOutcome,
  AppRemoveOutcome,
  AppVersionLink,
  apiData,
  appUrl,
  CandidatePreview,
  isVersionPreviewId,
  ProjectApp,
  previewChannel,
  previewIdFor,
  RollbackOutcome,
  RollbackRequest,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity, ownerOnlyMessage, projectRole } from "./identity.ts";

/**
 * Live app of a Project (Phase 16, ADR 0020). Prod only: the `APPS_DOMAIN` binding exists only
 * where the apps routes serve traffic. Without it the read answers `enabled: false` and the
 * deploy route queues nothing.
 *
 * Cost: a read is 1 D1 query by primary key. A deploy request is 1 Queue message.
 *
 * Milestone B: Candidate previews, version links, "Remove app" (P16-20), and "Roll back to Sk"
 * (P16-13). A rollback is canonical, not app-specific, so it works without the apps Worker too.
 */

/** Internal RPC on the integration Worker (service binding `INTEGRATION`). */
type RollbackRpc = {
  requestRollback(input: {
    projectId: string;
    targetGeneration: number;
    expectedGeneration: number;
    actorUserId: string;
  }): Promise<unknown>;
};

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

const CandidateIdParam = z.object({ candidateId: z.string().regex(/^cand_[a-z0-9]+$/) });

const ProjectAppView = z.object({
  enabled: z.boolean(),
  app: ProjectApp.nullable(),
  /** "Open" links of promoted generations whose bundle is stored (Versions page). */
  versions: z.array(AppVersionLink).default([]),
});

type Row = {
  slug: string;
  commit_sha: string | null;
  generation: number | null;
  status: AppDeploymentStatus;
  failure_reason: string | null;
  updated_at: string;
};

async function member(env: Env, authSubject: string, projectId: string) {
  const { userId } = await ensureIdentity(env.DB, authSubject);
  return (await canAccessProject(env.DB, userId, projectId)) ? userId : null;
}

export const apps = new Hono<AppEnv>()
  .get("/v1/projects/:projectId/app", requireAuth, validate("param", ProjectIdParam), async (c) => {
    const { projectId } = c.req.valid("param");
    if (!(await member(c.env, c.get("authSubject"), projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const domain = c.env.APPS_DOMAIN;
    if (!domain)
      return respond(c, apiData(ProjectAppView), { data: { enabled: false, app: null } });
    const [production, versionRows] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT slug, commit_sha, generation, status, failure_reason, updated_at
         FROM app_deployments WHERE project_id = ? AND channel = ?`,
      ).bind(projectId, APP_PRODUCTION_CHANNEL),
      // Version hosts (`preview:v<generation>`): production bundles, which never expire.
      c.env.DB.prepare(
        `SELECT channel, generation FROM app_deployments
         WHERE project_id = ? AND channel LIKE 'preview:v%' AND status = 'ready'
           AND candidate_id IS NULL ORDER BY generation DESC LIMIT 200`,
      ).bind(projectId),
    ]);
    const row = (production?.results?.[0] as Row | undefined) ?? null;
    const versions =
      row && row.status !== "removed"
        ? ((versionRows?.results ?? []) as { channel: string; generation: number | null }[])
            .map((v) => ({ id: v.channel.slice("preview:".length), generation: v.generation }))
            .filter((v) => isVersionPreviewId(v.id) && v.generation !== null)
            .map((v) => ({
              generation: v.generation as number,
              url: appUrl(domain, row.slug, v.id),
            }))
        : [];
    return respond(c, apiData(ProjectAppView), {
      data: {
        enabled: true,
        versions,
        app: row
          ? {
              label: row.slug,
              url: appUrl(domain, row.slug),
              status: row.status,
              commit: row.commit_sha,
              generation: row.generation,
              failureReason: row.failure_reason,
              updatedAt: row.updated_at,
            }
          : null,
      },
    });
  })

  // Builds and publishes the canonical commit (Projects that predate live apps, or a retry).
  .post(
    "/v1/projects/:projectId/app",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const userId = await member(c.env, c.get("authSubject"), projectId);
      if (!userId) return fail(c, 404, "not_found", "Project not found");
      if ((await projectRole(c.env.DB, userId, projectId)) !== "owner") {
        return fail(c, 403, "forbidden", ownerOnlyMessage("publish the app"));
      }
      if (!c.env.APPS_DOMAIN) {
        return respond(c, apiData(AppProvisionOutcome), { data: { status: "disabled" } });
      }
      const project = await c.env.DB.prepare("SELECT status FROM projects WHERE id = ?")
        .bind(projectId)
        .first<{ status: string }>();
      if (project?.status !== "active") return fail(c, 409, "conflict", "Project is archived");
      // A removed app whose cleanup finished keeps a tombstone row (410 on its hosts, its label).
      // Publishing again revives it; a removal still in progress (commit or bundle left) is not.
      await c.env.DB.prepare(
        `UPDATE app_deployments SET status = 'building', updated_at = ?
         WHERE project_id = ? AND channel = ? AND status = 'removed'
           AND commit_sha IS NULL AND bundle_key IS NULL`,
      )
        .bind(new Date().toISOString(), projectId, APP_PRODUCTION_CHANNEL)
        .run();
      await c.env.INTEGRATION_COMMANDS.send(
        {
          commandId: `cmd_${crypto.randomUUID()}`,
          commandType: "app.provision",
          projectId,
          attempt: 0,
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { contentType: "json" },
      );
      return respond(c, apiData(AppProvisionOutcome), { data: { status: "queued" } }, 202);
    },
  )

  /**
   * P16-20: "Remove app" keeps the Project. Every host of the app answers 410 at once; the
   * integration Worker then deletes its data stores, bundles, and preview and version rows, and
   * keeps the production row as a tombstone so the hosts go on answering 410 (`app.remove`).
   */
  .delete(
    "/v1/projects/:projectId/app",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const userId = await member(c.env, c.get("authSubject"), projectId);
      if (!userId) return fail(c, 404, "not_found", "Project not found");
      if ((await projectRole(c.env.DB, userId, projectId)) !== "owner") {
        return fail(c, 403, "forbidden", ownerOnlyMessage("remove the app"));
      }
      const removed = await c.env.DB.prepare(
        "UPDATE app_deployments SET status = 'removed', updated_at = ? WHERE project_id = ?",
      )
        .bind(new Date().toISOString(), projectId)
        .run();
      if (!removed.meta.changes) {
        return respond(c, apiData(AppRemoveOutcome), { data: { status: "not_found" } });
      }
      await c.env.INTEGRATION_COMMANDS.send(
        {
          // One removal per request; the handler is idempotent, so a duplicate is harmless.
          commandId: `cmd_${crypto.randomUUID()}`,
          commandType: "app.remove",
          projectId,
          attempt: 0,
          createdAt: new Date().toISOString(),
          payload: {},
        },
        { contentType: "json" },
      );
      return respond(c, apiData(AppRemoveOutcome), { data: { status: "removing" } }, 202);
    },
  )

  /** P16-10: the live preview of one Candidate (prod only), for "Open preview". */
  .get(
    "/v1/candidates/:candidateId/preview",
    requireAuth,
    validate("param", CandidateIdParam),
    async (c) => {
      const { candidateId } = c.req.valid("param");
      const candidate = await c.env.DB.prepare(
        `SELECT ch.project_id FROM candidates ca JOIN changes ch ON ch.id = ca.change_id
         WHERE ca.id = ?`,
      )
        .bind(candidateId)
        .first<{ project_id: string }>();
      if (!candidate || !(await member(c.env, c.get("authSubject"), candidate.project_id))) {
        return fail(c, 404, "not_found", "Candidate not found");
      }
      const domain = c.env.APPS_DOMAIN;
      if (!domain) {
        return respond(c, apiData(CandidatePreview), { data: { enabled: false, preview: null } });
      }
      const previewId = previewIdFor(candidateId);
      const row = await c.env.DB.prepare(
        `SELECT slug, commit_sha, status, failure_reason, updated_at FROM app_deployments
         WHERE project_id = ? AND channel = ? AND candidate_id = ?`,
      )
        .bind(candidate.project_id, previewChannel(previewId), candidateId)
        .first<Omit<Row, "generation">>();
      return respond(c, apiData(CandidatePreview), {
        data: {
          enabled: true,
          preview: row
            ? {
                url: appUrl(domain, row.slug, previewId),
                status: row.status,
                commit: row.commit_sha,
                failureReason: row.failure_reason,
                updatedAt: row.updated_at,
              }
            : null,
        },
      });
    },
  )

  /**
   * P16-13: roll back to Sk. A new canonical transition Sn -> Sn+1 whose tree equals Sk's tree,
   * through the Candidate, approval, and compare-and-swap path of every promotion. Never deletes
   * history. 202 when policy requires an approval first.
   */
  .post(
    "/v1/projects/:projectId/rollback",
    requireAuth,
    validate("param", ProjectIdParam),
    validate("json", RollbackRequest),
    async (c) => {
      const { projectId } = c.req.valid("param");
      const userId = await member(c.env, c.get("authSubject"), projectId);
      if (!userId) return fail(c, 404, "not_found", "Project not found");
      if ((await projectRole(c.env.DB, userId, projectId)) !== "owner") {
        return fail(c, 403, "forbidden", ownerOnlyMessage("roll back"));
      }
      const body = c.req.valid("json");
      const outcome = RollbackOutcome.parse(
        await (c.env.INTEGRATION as unknown as RollbackRpc).requestRollback({
          projectId,
          targetGeneration: body.targetGeneration,
          expectedGeneration: body.expectedGeneration,
          actorUserId: userId,
        }),
      );
      if (outcome.status === "refused") {
        const status = outcome.reason === "not_found" ? 404 : 409;
        return c.json(
          errorBody(status === 404 ? "not_found" : "conflict", outcome.detail, outcome),
          status,
        );
      }
      return respond(
        c,
        apiData(RollbackOutcome),
        { data: outcome },
        outcome.status === "awaiting_approval" ? 202 : 200,
      );
    },
  );
