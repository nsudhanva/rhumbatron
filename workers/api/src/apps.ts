import {
  APP_PRODUCTION_CHANNEL,
  type AppDeploymentStatus,
  AppProvisionOutcome,
  apiData,
  appUrl,
  ProjectApp,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Live app of a Project (Phase 16, ADR 0020). Prod only: the `APPS_DOMAIN` binding exists only
 * where the apps routes serve traffic. Without it the read answers `enabled: false` and the
 * deploy route queues nothing.
 *
 * Cost: a read is 1 D1 query by primary key. A deploy request is 1 Queue message.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

const ProjectAppView = z.object({ enabled: z.boolean(), app: ProjectApp.nullable() });

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
    const row = await c.env.DB.prepare(
      `SELECT slug, commit_sha, generation, status, failure_reason, updated_at
         FROM app_deployments WHERE project_id = ? AND channel = ?`,
    )
      .bind(projectId, APP_PRODUCTION_CHANNEL)
      .first<Row>();
    return respond(c, apiData(ProjectAppView), {
      data: {
        enabled: true,
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
      if (!(await member(c.env, c.get("authSubject"), projectId))) {
        return fail(c, 404, "not_found", "Project not found");
      }
      if (!c.env.APPS_DOMAIN) {
        return respond(c, apiData(AppProvisionOutcome), { data: { status: "disabled" } });
      }
      const project = await c.env.DB.prepare("SELECT status FROM projects WHERE id = ?")
        .bind(projectId)
        .first<{ status: string }>();
      if (project?.status !== "active") return fail(c, 409, "conflict", "Project is archived");
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
  );
