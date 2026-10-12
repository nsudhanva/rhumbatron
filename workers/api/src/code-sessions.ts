import type { ProjectViewDO } from "@rhumbatron/coordinator";
import {
  type ApiErrorCode,
  apiData,
  CodeSessionClosed,
  CodeSessionDetail,
  CodeSessionEdit,
  CodeSessionExecRequest,
  CodeSessionExecResult,
  CodeSessionFileContent,
  CodeSessionId,
  type CodeSessionRefused,
  CodeSessionRenameRequest,
  CodeSessionSubmitRequest,
  CodeSessionSubmitResult,
  CodeSessionView,
  CodeSessionWriteRequest,
  can,
  codeSessionOutcome,
  deniedMessage,
  sessionRefusalStatus,
} from "@rhumbatron/protocol";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { errorBody, fail, respond, validate } from "./http.ts";
import { ensureIdentity, projectRole } from "./identity.ts";

/**
 * Code page edit sessions (ADR 0029). Only the owner and admins (`can(role, "code.edit")`) open
 * and use a session; each session belongs to the person who opened it. Every other caller gets
 * 404 for the session of another person, or 403 without the permission. The integration Worker
 * (service binding `INTEGRATION`) owns the session state, the fork, and the Sandbox: this Worker
 * has no Sandbox binding and no public internal route.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

type In = { sessionId: string; userId: string };

/** Internal RPC on the integration Worker. Each method returns `{ status: "ok", data }` or a refusal. */
type SessionRpc = {
  openCodeSession(input: { projectId: string; userId: string }): Promise<unknown>;
  getCodeSession(input: In): Promise<unknown>;
  readCodeSessionFile(input: In & { path: string }): Promise<unknown>;
  writeCodeSessionFile(input: In & { path: string; content: string }): Promise<unknown>;
  deleteCodeSessionFile(input: In & { path: string }): Promise<unknown>;
  renameCodeSessionFile(input: In & { from: string; to: string }): Promise<unknown>;
  execCodeSessionCommand(
    input: In & { command: string; cwd?: string | undefined },
  ): Promise<unknown>;
  submitCodeSession(input: In & { message: string; authorName: string | null }): Promise<unknown>;
  closeCodeSession(input: In): Promise<unknown>;
};

const rpc = (env: Env) => env.INTEGRATION as unknown as SessionRpc;

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });
const SessionParam = z.object({ sessionId: CodeSessionId });
const PathQuery = z.object({ path: z.string().min(1).max(1024) });

/** JSON escaping can grow a 256 KB file several times; anything above this is not an edit. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const tooLarge = bodyLimit({
  maxSize: MAX_BODY_BYTES,
  onError: (c) =>
    c.json(
      errorBody("invalid_request", "Files over 256 KB cannot be edited here.", {
        reason: "too_large",
      }),
      413,
    ),
});

const projectView = (env: Env, projectId: string) => {
  const ns = env.PROJECT_VIEW as DurableObjectNamespace<ProjectViewDO>;
  return ns.get(ns.idFromName(projectId));
};

const CODE_OF: Record<ReturnType<typeof sessionRefusalStatus>, ApiErrorCode> = {
  400: "invalid_request",
  404: "not_found",
  409: "conflict",
  410: "not_found",
  413: "invalid_request",
  415: "invalid_request",
  429: "rate_limited",
  503: "internal",
};

function refused(c: Context, outcome: CodeSessionRefused) {
  const status = sessionRefusalStatus(outcome.reason);
  return c.json(errorBody(CODE_OF[status], outcome.detail, { reason: outcome.reason }), status);
}

/** Sends the result of one session RPC: the data with `status`, or the refusal. */
async function reply<T extends z.ZodType>(
  c: Context,
  schema: T,
  call: Promise<unknown>,
  status: 200 | 201 = 200,
) {
  // The parse validates the data against its contract; a mismatch is a server bug (500).
  const outcome = codeSessionOutcome(schema).parse(await call) as
    | { status: "ok"; data: unknown }
    | CodeSessionRefused;
  if (outcome.status === "refused") return refused(c, outcome);
  return c.json({ data: outcome.data }, status);
}

/**
 * The caller of a session route: their user ID when they own the session and may still edit
 * code in its Project. Another person's session is 404, the same as a missing one.
 */
async function sessionCaller(
  c: Context<AppEnv>,
  sessionId: string,
): Promise<{ userId: string; projectId: string } | Response> {
  const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
  const row = await c.env.DB.prepare("SELECT project_id, user_id FROM code_sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ project_id: string; user_id: string }>();
  if (!row || row.user_id !== userId) return fail(c, 404, "not_found", "Session not found");
  const role = await projectRole(c.env.DB, userId, row.project_id);
  if (!role) return fail(c, 404, "not_found", "Session not found");
  if (!can(role, "code.edit")) {
    return fail(c, 403, "forbidden", deniedMessage("code.edit", "edit code directly"));
  }
  return { userId, projectId: row.project_id };
}

export const codeSessions = new Hono<AppEnv>()
  .post(
    "/v1/projects/:projectId/code/sessions",
    requireAuth,
    validate("param", ProjectIdParam),
    async (c) => {
      const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
      const { projectId } = c.req.valid("param");
      const role = await projectRole(c.env.DB, userId, projectId);
      if (!role) return fail(c, 404, "not_found", "Project not found");
      if (!can(role, "code.edit")) {
        return fail(c, 403, "forbidden", deniedMessage("code.edit", "edit code directly"));
      }
      return reply(c, CodeSessionView, rpc(c.env).openCodeSession({ projectId, userId }), 201);
    },
  )
  .get("/v1/code/sessions/:sessionId", requireAuth, validate("param", SessionParam), async (c) => {
    const { sessionId } = c.req.valid("param");
    const caller = await sessionCaller(c, sessionId);
    if (caller instanceof Response) return caller;
    return reply(c, CodeSessionDetail, rpc(c.env).getCodeSession({ sessionId, ...caller }));
  })
  .get(
    "/v1/code/sessions/:sessionId/file",
    requireAuth,
    validate("param", SessionParam),
    validate("query", PathQuery),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const caller = await sessionCaller(c, sessionId);
      if (caller instanceof Response) return caller;
      const { path } = c.req.valid("query");
      return reply(
        c,
        CodeSessionFileContent,
        rpc(c.env).readCodeSessionFile({ sessionId, userId: caller.userId, path }),
      );
    },
  )
  .put(
    "/v1/code/sessions/:sessionId/file",
    requireAuth,
    tooLarge,
    validate("param", SessionParam),
    validate("json", CodeSessionWriteRequest),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const caller = await sessionCaller(c, sessionId);
      if (caller instanceof Response) return caller;
      const body = c.req.valid("json");
      return reply(
        c,
        CodeSessionEdit,
        rpc(c.env).writeCodeSessionFile({
          sessionId,
          userId: caller.userId,
          path: body.path,
          content: body.content,
        }),
      );
    },
  )
  .delete(
    "/v1/code/sessions/:sessionId/file",
    requireAuth,
    validate("param", SessionParam),
    validate("query", PathQuery),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const caller = await sessionCaller(c, sessionId);
      if (caller instanceof Response) return caller;
      const { path } = c.req.valid("query");
      return reply(
        c,
        CodeSessionEdit,
        rpc(c.env).deleteCodeSessionFile({ sessionId, userId: caller.userId, path }),
      );
    },
  )
  .post(
    "/v1/code/sessions/:sessionId/rename",
    requireAuth,
    validate("param", SessionParam),
    validate("json", CodeSessionRenameRequest),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const caller = await sessionCaller(c, sessionId);
      if (caller instanceof Response) return caller;
      const body = c.req.valid("json");
      return reply(
        c,
        CodeSessionEdit,
        rpc(c.env).renameCodeSessionFile({
          sessionId,
          userId: caller.userId,
          from: body.from,
          to: body.to,
        }),
      );
    },
  )
  .post(
    "/v1/code/sessions/:sessionId/exec",
    requireAuth,
    validate("param", SessionParam),
    validate("json", CodeSessionExecRequest),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const caller = await sessionCaller(c, sessionId);
      if (caller instanceof Response) return caller;
      const body = c.req.valid("json");
      return reply(
        c,
        CodeSessionExecResult,
        rpc(c.env).execCodeSessionCommand({
          sessionId,
          userId: caller.userId,
          command: body.command,
          cwd: body.cwd,
        }),
      );
    },
  )
  .post(
    "/v1/code/sessions/:sessionId/submit",
    requireAuth,
    validate("param", SessionParam),
    validate("json", CodeSessionSubmitRequest),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const caller = await sessionCaller(c, sessionId);
      if (caller instanceof Response) return caller;
      const body = c.req.valid("json");
      const outcome = codeSessionOutcome(CodeSessionSubmitResult).parse(
        await rpc(c.env).submitCodeSession({
          sessionId,
          userId: caller.userId,
          message: body.message,
          authorName: body.authorName ?? null,
        }),
      );
      if (outcome.status === "refused") return refused(c, outcome);
      if (outcome.data.status === "created") {
        // The dashboard projection is eventually consistent (AGENTS.md section 59).
        await projectView(c.env, caller.projectId)
          .applyDelta({
            upsert: {
              activeChanges: [
                {
                  id: outcome.data.changeId,
                  status: "verifying",
                  label: body.message.slice(0, 80),
                },
              ],
            },
          })
          .catch(() => undefined);
      }
      return respond(
        c,
        apiData(CodeSessionSubmitResult),
        { data: outcome.data },
        outcome.data.status === "created" ? 201 : 200,
      );
    },
  )
  .delete(
    "/v1/code/sessions/:sessionId",
    requireAuth,
    validate("param", SessionParam),
    async (c) => {
      const { sessionId } = c.req.valid("param");
      const caller = await sessionCaller(c, sessionId);
      if (caller instanceof Response) return caller;
      return reply(
        c,
        CodeSessionClosed,
        rpc(c.env).closeCodeSession({ sessionId, userId: caller.userId }),
      );
    },
  );
