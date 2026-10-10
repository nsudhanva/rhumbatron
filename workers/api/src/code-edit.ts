import type { ProjectRootDO, ProjectViewDO } from "@rhumbatron/coordinator";
import {
  apiData,
  CodeEditOutcome,
  CodeEditRequest,
  checkEdit,
  editRefusalStatus,
} from "@rhumbatron/protocol";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { canAccessProject, ensureIdentity } from "./identity.ts";

/**
 * `POST /v1/projects/:projectId/code/edits` (P16-19): a person saves one file on the Code page.
 * The integration Worker records a new Change with one human ChangeSet (an Artifacts fork with
 * the commit, the stored patch, the `changesets` row) and composes it like agent work. The edit
 * never touches canonical: only a verified Candidate can promote (AGENTS.md section 36).
 *
 * Limits are checked here first (path, 256 KB, text only, base tree) and again in the
 * integration Worker against the authoritative canonical state.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

/** Internal RPC on the integration Worker (service binding `INTEGRATION`). */
type EditRpc = {
  submitHumanEdit(input: {
    projectId: string;
    userId: string;
    authorName: string | null;
    path: string;
    content: string;
    baseTree: string;
    message: string;
    clientRequestId?: string | undefined;
  }): Promise<unknown>;
};

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

/** JSON escaping can grow a 256 KB file several times; anything above this is not an edit. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const projectRoot = (env: Env, projectId: string) => {
  const ns = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  return ns.get(ns.idFromName(projectId));
};

const projectView = (env: Env, projectId: string) => {
  const ns = env.PROJECT_VIEW as DurableObjectNamespace<ProjectViewDO>;
  return ns.get(ns.idFromName(projectId));
};

function refused(c: Context, outcome: Extract<CodeEditOutcome, { status: "refused" }>) {
  const status = editRefusalStatus(outcome.reason);
  const code =
    status === 404 ? "not_found" : status === 409 ? "conflict" : ("invalid_request" as const);
  return c.json(errorBody(code, outcome.detail, { reason: outcome.reason }), status);
}

export const codeEdit = new Hono<AppEnv>().post(
  "/v1/projects/:projectId/code/edits",
  requireAuth,
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) =>
      c.json(
        errorBody("invalid_request", "Files over 256 KB cannot be edited here.", {
          reason: "too_large",
        }),
        413,
      ),
  }),
  validate("param", ProjectIdParam),
  validate("json", CodeEditRequest),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    if (!(await canAccessProject(c.env.DB, userId, projectId))) {
      return fail(c, 404, "not_found", "Project not found");
    }
    const body = c.req.valid("json");
    const canonical = await projectRoot(c.env, projectId).getCanonical();
    const liveTree = canonical && canonical.artifactRef !== "unassigned" ? canonical.treeSha : null;
    const checked = checkEdit(body, liveTree);
    if (checked.status === "refused") return refused(c, checked);

    const outcome = CodeEditOutcome.parse(
      await (c.env.INTEGRATION as unknown as EditRpc).submitHumanEdit({
        projectId,
        userId,
        authorName: body.authorName ?? null,
        path: checked.path,
        content: body.content,
        baseTree: body.baseTree,
        message: body.message,
        clientRequestId: body.clientRequestId,
      }),
    );
    if (outcome.status === "refused") return refused(c, outcome);

    if (outcome.status === "created") {
      // The dashboard projection is eventually consistent (AGENTS.md section 59).
      await projectView(c.env, projectId)
        .applyDelta({
          upsert: {
            activeChanges: [
              {
                id: outcome.changeId,
                status: "verifying",
                label: `Edit ${checked.path}`.slice(0, 80),
              },
            ],
          },
        })
        .catch(() => undefined);
    }
    return respond(
      c,
      apiData(CodeEditOutcome),
      { data: outcome },
      outcome.status === "created" ? 201 : 200,
    );
  },
);
