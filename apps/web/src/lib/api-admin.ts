import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import {
  type AccessDecisionResult,
  type AccessRequestList,
  type AccessStatus,
  AdminCostGroup,
  type AdminCosts,
  type AdminEventList,
  type AdminOverview,
  type AdminProjectList,
  type AdminUserDetail,
  type AdminUserList,
  type ApproveAllResult,
  type MyCosts,
  type PlatformSettings,
} from "@rhumbatron/protocol";
import { createServerFn } from "@tanstack/react-start";
import { apiErrorMessage } from "./access";

/**
 * Platform admin area and the user's own costs. Same transport as lib/api.ts: the web Worker
 * calls the API Worker over the `API` service binding with the user's Clerk session token.
 *
 * Every `/v1/admin` route needs a platform admin; the API answers 403 `forbidden` otherwise and
 * records each admin read and write in `admin_audit`. The web shows the admin pages only when
 * `GET /v1/me` says `platformAdmin` (components/admin/admin-layout.tsx), so a non-admin never
 * calls these routes from a page.
 */

export const COST_GROUPS = AdminCostGroup.options;
export type CostGroup = AdminCostGroup;

export type UserFilters = {
  q?: string | undefined;
  status?: AccessStatus | undefined;
  cursor?: string | undefined;
};
export type ProjectFilters = {
  q?: string | undefined;
  ownerId?: string | undefined;
  status?: string | undefined;
  cursor?: string | undefined;
};
export type CostFilters = {
  from?: string | undefined;
  to?: string | undefined;
  userId?: string | undefined;
  projectId?: string | undefined;
  groupBy?: CostGroup | undefined;
};
export type EventFilters = {
  userId?: string | undefined;
  projectId?: string | undefined;
  type?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  cursor?: string | undefined;
};

/** `?a=1&b=2` from the set values; empty values are left out. */
export function queryString(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** A `YYYY-MM-DD` filter as the first or last instant of that UTC day (events compare instants). */
const dayStart = (day: string | undefined) =>
  day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T00:00:00.000Z` : day;
const dayEnd = (day: string | undefined) =>
  day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? `${day}T23:59:59.999Z` : day;

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
    error?: { code?: string; message?: string };
  };
  if (!response.ok || json.data === undefined) {
    throw new Error(apiErrorMessage(response.status, json.error));
  }
  return json.data;
}

export const getAdminOverview = createServerFn().handler(() =>
  call<AdminOverview>("/v1/admin/overview"),
);

export const listAdminUsers = createServerFn()
  .inputValidator((filters: UserFilters) => filters)
  .handler(({ data }) => call<AdminUserList>(`/v1/admin/users${queryString(data)}`));

export const getAdminUser = createServerFn()
  .inputValidator((userId: string) => userId)
  .handler(({ data }) => call<AdminUserDetail>(`/v1/admin/users/${encodeURIComponent(data)}`));

export const listAdminProjects = createServerFn()
  .inputValidator((filters: ProjectFilters) => filters)
  .handler(({ data }) => call<AdminProjectList>(`/v1/admin/projects${queryString(data)}`));

export const getAdminCosts = createServerFn()
  .inputValidator((filters: CostFilters) => filters)
  .handler(({ data }) => call<AdminCosts>(`/v1/admin/costs${queryString(data)}`));

export const listAdminEvents = createServerFn()
  .inputValidator((filters: EventFilters) => filters)
  .handler(({ data }) =>
    call<AdminEventList>(
      `/v1/admin/events${queryString({ ...data, from: dayStart(data.from), to: dayEnd(data.to) })}`,
    ),
  );

export const getAdminSettings = createServerFn().handler(() =>
  call<PlatformSettings>("/v1/admin/settings"),
);

export const updateAdminSettings = createServerFn({ method: "POST" })
  .inputValidator((input: { signupApprovalRequired: boolean }) => input)
  .handler(({ data }) =>
    call<PlatformSettings>("/v1/admin/settings", { method: "PATCH", body: data }),
  );

export const listAccessRequests = createServerFn().handler(() =>
  call<AccessRequestList>("/v1/admin/access-requests"),
);

export const decideAccess = createServerFn({ method: "POST" })
  .inputValidator((input: { userId: string; decision: "approve" | "decline" }) => input)
  .handler(({ data }) =>
    call<AccessDecisionResult>(`/v1/admin/users/${encodeURIComponent(data.userId)}/access`, {
      method: "POST",
      body: { decision: data.decision },
    }),
  );

export const approveAllAccess = createServerFn({ method: "POST" }).handler(() =>
  call<ApproveAllResult>("/v1/admin/access-requests/approve-all", {
    method: "POST",
    body: {},
  }),
);

export const getMyCosts = createServerFn()
  .inputValidator((months: number) => months)
  .handler(({ data }) => call<MyCosts>(`/v1/me/costs?months=${data}`));

/** Query keys of the admin reads and the user's costs. */
export const ADMIN_KEYS = {
  overview: ["admin", "overview"] as const,
  users: (filters: UserFilters) => ["admin", "users", filters] as const,
  user: (userId: string) => ["admin", "user", userId] as const,
  projects: (filters: ProjectFilters) => ["admin", "projects", filters] as const,
  costs: (filters: CostFilters) => ["admin", "costs", filters] as const,
  events: (filters: EventFilters) => ["admin", "events", filters] as const,
  settings: ["admin", "settings"] as const,
  accessRequests: ["admin", "access-requests"] as const,
};

export const MY_COSTS_MONTHS = 6;
export const MY_COSTS_KEY = ["my-costs", MY_COSTS_MONTHS] as const;
