import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import {
  type AssignableRole,
  type BoardAgent,
  type BoardCard,
  BoardColumn,
  type BoardPerson,
  type BoardResponse,
  type ProjectRole,
} from "@rhumbatron/protocol";
import { createServerFn } from "@tanstack/react-start";

export type { BoardAgent, BoardCard, BoardColumn, BoardPerson };
export type ProjectBoard = BoardResponse;

/**
 * Board, request review and member roles (docs/architecture/shared-projects.md): server
 * functions over the API Worker with the same call pattern as `api.ts` (the browser never calls
 * the API directly; each call runs on the web Worker with the user's Clerk session token).
 */

/** Board columns, left to right (protocol `BoardColumn`; `BOARD_COLUMN_OF` maps each status). */
export const BOARD_COLUMNS = BoardColumn.options;

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) throw new ApiError(401, "Sign in to continue");
  const response = await env.API.fetch(
    new Request(`https://api.internal${path}`, {
      method: init.method ?? "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
  );
  const json = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok || json.data === undefined) {
    throw new ApiError(response.status, json.error?.message ?? `API returned ${response.status}`);
  }
  return json.data;
}

/** One D1-batched read: people, the newest 100 Changes as cards, and whether the caller reviews. */
export const getProjectBoard = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<ProjectBoard>(`/v1/projects/${data}/board`));

type ReviewResult = { changeId: string; status: string };

/** Admin or owner: a proposed request starts building (409 when it is no longer proposed). */
export const includeChange = createServerFn({ method: "POST" })
  .inputValidator((changeId: string) => changeId)
  .handler(({ data }) =>
    call<ReviewResult>(`/v1/changes/${data}/include`, { method: "POST", body: {} }),
  );

/** Admin or owner: a proposed request ends as "Not built", with an optional reason. */
export const declineChange = createServerFn({ method: "POST" })
  .inputValidator((input: { changeId: string; reason?: string }) => input)
  .handler(({ data }) =>
    call<ReviewResult>(`/v1/changes/${data.changeId}/decline`, {
      method: "POST",
      body: data.reason ? { reason: data.reason } : {},
    }),
  );

/** Owner or admin, under the role rules (the owner role is not assignable). */
export const updateMemberRole = createServerFn({ method: "POST" })
  .inputValidator((input: { projectId: string; userId: string; role: AssignableRole }) => input)
  .handler(({ data }) =>
    call<{ userId: string; role: ProjectRole }>(
      `/v1/projects/${data.projectId}/members/${data.userId}`,
      { method: "PATCH", body: { role: data.role } },
    ),
  );
