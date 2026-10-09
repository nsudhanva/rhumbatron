import type { ProjectViewDO } from "@rhumbatron/coordinator";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Live endpoint `WS /v1/projects/:projectId/live?afterSequence=<n>` (AGENTS.md sections 16.2, 39).
 * The caller authenticates with `Authorization: Bearer` like every other route. The web Worker sets
 * that header server-side, so no token is in a URL. After the access check, the upgrade goes to
 * ProjectViewDO, which owns the hibernating socket and sends snapshot plus sequence deltas.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const LiveParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const LiveQuery = z.object({ afterSequence: z.coerce.number().int().nonnegative().optional() });

export const live = new Hono<AppEnv>().get(
  "/v1/projects/:projectId/live",
  requireAuth,
  validate("param", LiveParam),
  validate("query", LiveQuery),
  async (c) => {
    if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      return fail(c, 426, "invalid_request", "Expected a WebSocket upgrade");
    }
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const { afterSequence } = c.req.valid("query");
    const ns = c.env.PROJECT_VIEW as DurableObjectNamespace<ProjectViewDO>;
    const target = new URL(`https://project-view/v1/projects/${projectId}/live`);
    if (afterSequence !== undefined)
      target.searchParams.set("afterSequence", String(afterSequence));
    // Forward only the upgrade. The session token stops here and never reaches the object.
    return ns
      .get(ns.idFromName(projectId))
      .fetch(new Request(target, { headers: { upgrade: "websocket" } }));
  },
);
