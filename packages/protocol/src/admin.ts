import { z } from "zod";

/**
 * Platform admin, sign-up approval, and user costs (ADR 0033, docs/protocols/README.md "Platform
 * admin"). The API decides admin rights from the session user ID and the `PLATFORM_ADMIN_USER_IDS`
 * binding. These schemas are the response bodies inside `{ data }`.
 */

/** Access of a person to Rhumbatron (`users.access_status`). */
export const AccessStatus = z.enum(["approved", "pending", "declined"]);
export type AccessStatus = z.infer<typeof AccessStatus>;

/** `details` of the 403 `approval_required` error. */
export const ApprovalRequiredDetails = z.object({
  status: z.enum(["pending", "declined"]),
});
export type ApprovalRequiredDetails = z.infer<typeof ApprovalRequiredDetails>;

const Month = z.string().regex(/^\d{4}-\d{2}$/);
const Usd = z.number().nonnegative();
const Count = z.number().int().nonnegative();

/** `GET /v1/admin/overview`. Every figure reads a meter or a row count; nothing is estimated. */
export const AdminOverview = z.object({
  /** This calendar month (UTC), `YYYY-MM`. */
  month: Month,
  /** Anthropic spend this month on the environment meter, open reservations included. */
  spendUsd: Usd,
  /** The sum of every user meter this month (`user-usd-micro`). */
  attributedUsd: Usd,
  /**
   * `spendUsd` minus `attributedUsd`, never below 0: model calls that no request paid for, and
   * spend before the user meters started (2026-10-11).
   */
  unattributedUsd: Usd,
  /** The environment's Anthropic budget per calendar month. */
  capUsd: Usd,
  sandbox: z.object({ usedSeconds: Count, capSeconds: Count }),
  browser: z.object({ usedSecondsToday: Count, capSecondsPerDay: Count }),
  /** App builds today (each build is one new app version) against the daily build cap. */
  appVersions: z.object({ used: Count, cap: Count }),
  users: z.object({ total: Count, pending: Count }),
  projects: z.object({ active: Count, archived: Count }),
  /** Changes that are not in a final status. */
  changes: z.object({ active: Count }),
  /** Tasks that an agent works now (`assigned` or `running`). */
  agents: z.object({ active: Count }),
});
export type AdminOverview = z.infer<typeof AdminOverview>;

/** One person in the admin user list. */
export const AdminUser = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  accessStatus: AccessStatus,
  /** Projects that the person owns or that another person shares with them. */
  projects: Count,
  /** Changes that the person requested. */
  requests: Count,
  /** The person's meter this month (`user-usd-micro`). */
  spendMonthUsd: Usd,
  /** The person's meter summed over every month (`user-usd-micro`). */
  spendAllTimeUsd: Usd,
  monthlyBudgetUsd: z.number().nullable(),
  createdAt: z.string(),
  /** The last authenticated request, to the hour. Null before the first request is recorded. */
  lastActiveAt: z.string().nullable(),
});
export type AdminUser = z.infer<typeof AdminUser>;

/**
 * Spend totals of a list, over every row whatever the filters and the page. `monthUsd` and
 * `allTimeUsd` sum the meters of the list (user or Project meters). The unattributed figures are
 * the environment meter (`anthropic-usd-micro`) of the same period minus that sum, never below 0.
 * The two figures of one period add up to the environment meter.
 */
export const AdminSpendTotals = z.object({
  monthUsd: Usd,
  allTimeUsd: Usd,
  unattributedMonthUsd: Usd,
  unattributedAllTimeUsd: Usd,
});
export type AdminSpendTotals = z.infer<typeof AdminSpendTotals>;

export const AdminUserList = z.object({
  users: z.array(AdminUser),
  nextCursor: z.string().nullable(),
  totals: AdminSpendTotals,
});
export type AdminUserList = z.infer<typeof AdminUserList>;

/** `GET /v1/admin/users/:userId`: the list fields plus Projects, recent requests, and months. */
export const AdminUserDetail = AdminUser.omit({ projects: true }).extend({
  projects: z.array(
    z.object({
      projectId: z.string(),
      name: z.string(),
      role: z.string(),
      /** The Change meters of this person's requests in the Project, all time. */
      spendUsd: Usd,
    }),
  ),
  recentChanges: z.array(
    z.object({
      changeId: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      title: z.string(),
      status: z.string(),
      /** The Change meter, all time. */
      spendUsd: Usd,
      createdAt: z.string(),
    }),
  ),
  /** The person's monthly meter, oldest first, 12 months. */
  monthly: z.array(z.object({ month: Month, spendUsd: Usd })),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetail>;

export const AdminProject = z.object({
  projectId: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  owner: z.object({ userId: z.string(), name: z.string().nullable() }).nullable(),
  members: Count,
  generation: Count,
  /** The Project meter this month (`project-usd-micro`). */
  spendMonthUsd: Usd,
  /** The Project meter summed over every month (`project-usd-micro`). */
  spendAllTimeUsd: Usd,
  changes: Count,
  /** The production app URL while the app serves. Null otherwise. */
  liveAppUrl: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AdminProject = z.infer<typeof AdminProject>;

export const AdminProjectList = z.object({
  projects: z.array(AdminProject),
  nextCursor: z.string().nullable(),
  totals: AdminSpendTotals,
});
export type AdminProjectList = z.infer<typeof AdminProjectList>;

export const AdminCostGroup = z.enum(["user", "project", "model", "day"]);
export type AdminCostGroup = z.infer<typeof AdminCostGroup>;

/** `key` of the cost row with the spend of no user or Project meter. */
export const UNATTRIBUTED_COST_KEY = "unattributed";
/** `key` of the cost row with the meter spend that has no `task_runs` row. */
export const OTHER_CALLS_COST_KEY = "other";

/**
 * One cost row. A meter row (`groupBy` user or project, and the two keys above) has no call or
 * token counts: `calls`, `inputTokens`, and `outputTokens` are null.
 */
export const AdminCostRow = z.object({
  key: z.string(),
  label: z.string(),
  spendUsd: Usd,
  calls: Count.nullable(),
  inputTokens: Count.nullable(),
  outputTokens: Count.nullable(),
});
export type AdminCostRow = z.infer<typeof AdminCostRow>;

/** `GET /v1/admin/costs`. `source` names the data and what the rows do not cover. */
export const AdminCosts = z.object({
  rows: z.array(AdminCostRow),
  totalUsd: Usd,
  /** The UTC days that the rows cover. A meter view covers whole months. */
  from: z.string(),
  to: z.string(),
  source: z.string(),
});
export type AdminCosts = z.infer<typeof AdminCosts>;

export const AdminEvent = z.object({
  seq: z.number().int(),
  projectId: z.string(),
  projectName: z.string().nullable(),
  changeId: z.string().nullable(),
  eventType: z.string(),
  actorKind: z.string(),
  actorId: z.string(),
  /** The person's name for a user actor. Null for agents and the system. */
  actorName: z.string().nullable(),
  occurredAt: z.string(),
  summary: z.string(),
});
export type AdminEvent = z.infer<typeof AdminEvent>;

export const AdminEventList = z.object({
  events: z.array(AdminEvent),
  nextCursor: z.string().nullable(),
});
export type AdminEventList = z.infer<typeof AdminEventList>;

/** `GET` and `PATCH /v1/admin/settings`. */
export const PlatformSettings = z.object({
  signupApprovalRequired: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type PlatformSettings = z.infer<typeof PlatformSettings>;

export const UpdatePlatformSettingsRequest = z.object({ signupApprovalRequired: z.boolean() });
export type UpdatePlatformSettingsRequest = z.infer<typeof UpdatePlatformSettingsRequest>;

export const AccessRequestList = z.object({
  users: z.array(
    z.object({
      userId: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      requestedAt: z.string(),
    }),
  ),
});
export type AccessRequestList = z.infer<typeof AccessRequestList>;

export const AccessDecisionRequest = z.object({ decision: z.enum(["approve", "decline"]) });
export type AccessDecisionRequest = z.infer<typeof AccessDecisionRequest>;

export const AccessDecisionResult = z.object({ userId: z.string(), accessStatus: AccessStatus });
export type AccessDecisionResult = z.infer<typeof AccessDecisionResult>;

export const ApproveAllResult = z.object({ approved: Count });
export type ApproveAllResult = z.infer<typeof ApproveAllResult>;

/** `GET /v1/me/costs`: the signed-in person's own spend only. */
export const MyCosts = z.object({
  /** The person's monthly meter, oldest first, the current month last. */
  months: z.array(z.object({ month: Month, spendUsd: Usd })),
  /** This month: the Change meters of the person's requests created this month, per Project. */
  byProject: z.array(z.object({ projectId: z.string(), name: z.string(), spendUsd: Usd })),
  /** This month: the person's requests created this month, top 50 by spend. */
  byChange: z.array(
    z.object({
      changeId: z.string(),
      projectId: z.string(),
      projectName: z.string(),
      title: z.string(),
      spendUsd: Usd,
    }),
  ),
  source: z.string(),
});
export type MyCosts = z.infer<typeof MyCosts>;
