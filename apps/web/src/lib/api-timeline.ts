import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import { apiErrorMessage } from "./access";
import type { TaskDetail } from "./api";

/**
 * Server functions for the Project execution timeline (components/timeline). They read the same
 * API Worker routes as lib/api.ts through the `API` service binding, with the user's Clerk
 * session token. Read-only.
 */

/** Changes read per call: one service-binding subrequest each, well under the Worker limit. */
export const TIMELINE_TASK_BATCH = 20;

async function read<T>(path: string, token: string): Promise<T> {
  const response = await env.API.fetch(
    new Request(`https://api.internal${path}`, {
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    }),
  );
  const json = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { code?: string; message?: string };
  };
  if (!response.ok || json.data === undefined) {
    throw new Error(apiErrorMessage(response.status, json.error));
  }
  return json.data;
}

/** Tasks (with their attempts) of each listed Change, or the read error of that Change. */
export type TimelineTasks = Record<string, { tasks: TaskDetail[] } | { error: string }>;

/**
 * Tasks of up to `TIMELINE_TASK_BATCH` Changes in one browser request: `GET
 * /v1/changes/:changeId/tasks` per Change, in parallel. One failed Change does not fail the rest.
 */
export const getTimelineTasks = createServerFn()
  .inputValidator((changeIds: string[]) => {
    if (!Array.isArray(changeIds)) throw new Error("changeIds must be an array");
    return changeIds
      .filter((id): id is string => typeof id === "string" && /^chg_[a-z0-9-]+$/.test(id))
      .slice(0, TIMELINE_TASK_BATCH);
  })
  .handler(async ({ data }): Promise<TimelineTasks> => {
    const { getToken } = await auth();
    const token = await getToken();
    if (!token) throw new Error("Sign in to continue");
    const entries = await Promise.all(
      data.map(async (changeId) => {
        try {
          const tasks = await read<TaskDetail[]>(`/v1/changes/${changeId}/tasks`, token);
          return [changeId, { tasks }] as const;
        } catch (error) {
          return [changeId, { error: error instanceof Error ? error.message : String(error) }];
        }
      }),
    );
    return Object.fromEntries(entries);
  });
