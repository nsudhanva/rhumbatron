import { apiData, GoalSuggestions } from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * Goal suggestion pills for the new Change goal box. The agents Worker ranks them with Clef (on
 * Workers AI) and caches them per Canonical Generation; see workers/agents/src/suggestions.ts.
 * Cost per request: a few D1 reads; at most one capped Clef call per Project and generation.
 */

/** Internal RPC on the agents Worker (service binding `AGENTS`). */
type SuggestionsRpc = { goalSuggestions(projectId: string): Promise<unknown> };

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

export const suggestions = new Hono<AppEnv>().get(
  "/v1/projects/:projectId/suggestions",
  requireAuth,
  validate("param", ProjectIdParam),
  async (c) => {
    const { projectId } = c.req.valid("param");
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const parsed = GoalSuggestions.safeParse(
      await (c.env.AGENTS as unknown as SuggestionsRpc).goalSuggestions(projectId),
    );
    // Suggestions are optional: a bad answer shows no pills rather than an error.
    const data = parsed.success ? parsed.data : { suggestions: [], generation: null };
    return respond(c, apiData(GoalSuggestions), { data });
  },
);
