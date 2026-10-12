import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import {
  CODE_SESSION_IDLE_MS,
  type CodeSessionClosed,
  type CodeSessionDetail,
  type CodeSessionEdit,
  type CodeSessionExecResult,
  type CodeSessionFileContent,
  type CodeSessionSubmitResult,
  type CodeSessionView,
  MAX_COMMAND_CHARS,
  MAX_EDIT_BYTES,
} from "@rhumbatron/protocol";
import { createServerFn } from "@tanstack/react-start";
import { apiErrorMessage } from "./access";

/**
 * Code page edit sessions (`/v1/code/sessions`, docs/protocols/README.md): server functions over
 * the API Worker with the same call pattern as `api.ts`. Each call returns a result object
 * instead of throwing, so the browser keeps the HTTP status and the API reason (for example
 * 429 `sandbox_cap`); `unwrap` turns a failure into a `CodeSessionError` on the client.
 */

export type {
  CodeSessionDetail,
  CodeSessionExecResult,
  CodeSessionFile,
  CodeSessionView,
} from "@rhumbatron/protocol";

/** Body of a write, delete, rename or close. */
type CodeSessionAck = CodeSessionEdit | CodeSessionClosed;

export type CodeSessionResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; message: string; reason: string | null };

/** A failed session request with its HTTP status and API reason (`sandbox_cap`, `binary`). */
export class CodeSessionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly reason: string | null,
  ) {
    super(message);
  }
}

/** The data of a result, or a `CodeSessionError` with its status and reason. */
export function unwrap<T>(result: CodeSessionResult<T>): T {
  if (result.ok) return result.data;
  throw new CodeSessionError(result.status, result.message, result.reason);
}

/** True when the session ended: submitted, discarded or expired (410, or those reasons). */
export function isSessionGone(error: unknown) {
  return (
    error instanceof CodeSessionError &&
    (error.status === 410 || error.reason === "expired" || error.reason === "closed")
  );
}

/** Largest file the session editor opens and writes (the API limit). */
export const SESSION_FILE_MAX_BYTES = MAX_EDIT_BYTES;
/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = CODE_SESSION_IDLE_MS;
/** Longest command text. */
export const SESSION_COMMAND_MAX = MAX_COMMAND_CHARS;

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<CodeSessionResult<T>> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) return { ok: false, status: 401, message: "Sign in to continue", reason: null };
  const response = await env.API.fetch(
    new Request(`https://api.internal${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  const json = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string; message?: string; details?: { reason?: unknown } };
  };
  if (!response.ok || json.data === undefined) {
    const reason = json.error?.details?.reason;
    return {
      ok: false,
      status: response.status,
      message: apiErrorMessage(response.status, json.error),
      reason: typeof reason === "string" ? reason : (json.error?.code ?? null),
    };
  }
  return { ok: true, data: json.data };
}

const session = (id: string) => `/v1/code/sessions/${encodeURIComponent(id)}`;
const pathQuery = (path: string) => `?${new URLSearchParams({ path }).toString()}`;

/** Opens the caller's session for the Project, or returns the one already open. */
export const openCodeSession = createServerFn({ method: "POST" })
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) =>
    call<CodeSessionView>(`/v1/projects/${data}/code/sessions`, { method: "POST", body: {} }),
  );

/** The session and the tree of its fork. Any request keeps the session alive. */
export const getCodeSession = createServerFn()
  .inputValidator((sessionId: string) => sessionId)
  .handler(({ data }) => call<CodeSessionDetail>(session(data)));

export const readSessionFile = createServerFn()
  .inputValidator((input: { sessionId: string; path: string }) => input)
  .handler(({ data }) =>
    call<CodeSessionFileContent>(`${session(data.sessionId)}/file${pathQuery(data.path)}`),
  );

/** Creates or updates one file. */
export const writeSessionFile = createServerFn({ method: "POST" })
  .inputValidator((input: { sessionId: string; path: string; content: string }) => input)
  .handler(({ data }) =>
    call<CodeSessionAck>(`${session(data.sessionId)}/file`, {
      method: "PUT",
      body: { path: data.path, content: data.content },
    }),
  );

export const deleteSessionFile = createServerFn({ method: "POST" })
  .inputValidator((input: { sessionId: string; path: string }) => input)
  .handler(({ data }) =>
    call<CodeSessionAck>(`${session(data.sessionId)}/file${pathQuery(data.path)}`, {
      method: "DELETE",
    }),
  );

export const renameSessionFile = createServerFn({ method: "POST" })
  .inputValidator((input: { sessionId: string; from: string; to: string }) => input)
  .handler(({ data }) =>
    call<CodeSessionAck>(`${session(data.sessionId)}/rename`, {
      method: "POST",
      body: { from: data.from, to: data.to },
    }),
  );

/** Runs one command in the session Sandbox (120 s timeout; 429 `sandbox_cap` at the cap). */
export const execSessionCommand = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { sessionId: string; command: string; cwd?: string | undefined }) => input,
  )
  .handler(({ data }) =>
    call<CodeSessionExecResult>(`${session(data.sessionId)}/exec`, {
      method: "POST",
      body: data.cwd ? { command: data.command, cwd: data.cwd } : { command: data.command },
    }),
  );

/** Commits every change and creates a Change from it; the session closes. */
export const submitCodeSession = createServerFn({ method: "POST" })
  .inputValidator((input: { sessionId: string; message: string }) => input)
  .handler(({ data }) =>
    call<CodeSessionSubmitResult>(`${session(data.sessionId)}/submit`, {
      method: "POST",
      body: { message: data.message },
    }),
  );

/** Closes the session: the Sandbox stops and the fork is deleted. */
export const closeCodeSession = createServerFn({ method: "POST" })
  .inputValidator((sessionId: string) => sessionId)
  .handler(({ data }) => call<CodeSessionAck>(session(data), { method: "DELETE" }));
