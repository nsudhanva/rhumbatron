import { env } from "cloudflare:workers";
import { auth } from "@clerk/tanstack-react-start/server";
import { createServerFn } from "@tanstack/react-start";

/**
 * Budget scopes (docs/operations/costs.md): which budget a Change draws on, the Project and
 * personal monthly budgets, and which budget stopped a `budget_blocked` Change. Same transport
 * as lib/api.ts: the web Worker calls the API Worker over the `API` service binding with the
 * user's Clerk session token.
 *
 * The types mirror the API: `GET /v1/me`, `PATCH /v1/me/budget`, the `budget` field of
 * `GET /v1/changes/:changeId`, `projectBudget` of `GET /v1/projects/:projectId/cost`, and
 * `monthlyBudgetUsd` / `monthSpendUsd` of the Project settings.
 */

/** `change`: the Change has its own cap. `project` / `account`: it draws on a monthly pool. */
export type BudgetScope = "change" | "project" | "account";

/** The budget that stopped a Change. */
export type BudgetBlockedBy =
  | "change_budget"
  | "project_budget"
  | "account_budget"
  | "monthly_model_spend";

/** `budget` of the Change read. `capUsd` is null when the Change draws on a monthly pool. */
export type ChangeBudget = {
  scope: BudgetScope;
  capUsd: number | null;
  spentUsd: number;
  blockedBy: BudgetBlockedBy | null;
};

/** `projectBudget` of the cost read. `capUsd` is null when the Project has no monthly budget. */
export type ProjectBudget = { capUsd: number | null; spentUsd: number; month: string };

/** `GET /v1/me`: the signed-in user with their monthly budget and this month's spend. */
export type Me = {
  userId: string;
  name: string | null;
  email: string | null;
  /** Null: no personal monthly budget. */
  monthlyBudgetUsd: number | null;
  /** Model spend this calendar month across every Project. */
  monthSpendUsd: number;
  /** `YYYY-MM`. */
  month: string;
};

/** The API accepts a monthly budget (Project or personal) from $1 to $100, or null. */
export const MONTHLY_BUDGET_LIMITS = { min: 1, max: 100 } as const;

export const ME_KEY = ["me"] as const;

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

export const getMe = createServerFn().handler(() => call<Me>("/v1/me"));

export const updateMyBudget = createServerFn({ method: "POST" })
  .inputValidator((monthlyBudgetUsd: number | null) => monthlyBudgetUsd)
  .handler(({ data }) =>
    call<Me>("/v1/me/budget", { method: "PATCH", body: { monthlyBudgetUsd: data } }),
  );

/** Money left in a monthly pool, never below zero. */
export const remainingUsd = (capUsd: number, spentUsd: number) => Math.max(0, capUsd - spentUsd);

/** "October 2026" from `2026-10`; the input itself when it does not parse. */
export function monthName(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return date.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}
