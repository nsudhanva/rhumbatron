import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";
import type { ProjectRole } from "./permissions";

/**
 * Project settings server functions (`GET /v1/projects/:projectId/settings`,
 * `PATCH /v1/projects/:projectId`). Same transport as lib/api.ts: the web Worker calls the API
 * Worker over the `API` service binding with the user's Clerk session token.
 */

export type ProjectSettings = {
  name: string;
  slug: string;
  createdAt: string;
  role: ProjectRole | string;
  /** Null: new Changes without a budget get the built-in default. */
  defaultBudgetUsd: number | null;
  effectiveDefaultBudgetUsd: number;
  limits: { minBudgetUsd: number; maxBudgetUsd: number };
  /** True: a member's request waits for an owner or admin to include it before anything is built. */
  memberRequestReview: boolean;
  /** Project monthly budget in USD; null: the Project has no own monthly cap. */
  monthlyBudgetUsd?: number | null;
  /** Model spend of the Project this calendar month (read only). */
  monthSpendUsd?: number;
};

export type ProjectSettingsPatch = {
  projectId: string;
  name?: string;
  defaultBudgetUsd?: number | null;
  memberRequestReview?: boolean;
  monthlyBudgetUsd?: number | null;
};

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { getToken } = await auth();
  const token = await getToken();
  if (!token) throw new Error("Sign in to continue");
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
    throw new Error(json.error?.message ?? `API returned ${response.status}`);
  }
  return json.data;
}

export const getProjectSettings = createServerFn()
  .inputValidator((projectId: string) => projectId)
  .handler(({ data }) => call<ProjectSettings>(`/v1/projects/${data}/settings`));

export const updateProjectSettings = createServerFn({ method: "POST" })
  .inputValidator((input: ProjectSettingsPatch) => input)
  .handler(({ data: { projectId, ...body } }) =>
    call<ProjectSettings>(`/v1/projects/${projectId}`, { method: "PATCH", body }),
  );
