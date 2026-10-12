import {
  apiData,
  BOARD_CHANGE_LIMIT,
  BOARD_CLOSED_COLUMN_LIMIT,
  type BoardAgent,
  type BoardCard,
  type BoardPerson,
  BoardResponse,
  boardColumn,
  ChangeStatus,
  can,
  changeTitle,
  ModelTier,
  ProjectRole,
  type RequestWaitSummary,
} from "@rhumbatron/protocol";
import { Hono } from "hono";
import { z } from "zod";
import { type AuthVariables, requireAuth } from "./auth.ts";
import { fail, respond, validate } from "./http.ts";
import { ensureIdentity, projectRole } from "./identity.ts";
import {
  REVIEW_COLUMNS,
  REVIEWER_JOIN,
  type ReviewColumns,
  requesterName,
  reviewOf,
} from "./members.ts";

/**
 * `GET /v1/projects/:projectId/board` (ADR 0028): the Project's requests as cards in columns,
 * and the people with their request counts. Any role can read it.
 *
 * Cost: one D1 batch of 3 SELECTs after the role read. The Change read starts from
 * `idx_changes_project_created` and takes the newest 100 Changes. A waiting card (`awaiting_choice`,
 * `queued`) reads its newest `request_choices` row through `idx_request_choices_later`. The Task read takes the Tasks of
 * the same 100 Changes (at most 12 each) with the newest run of each. The member read takes at
 * most 200 rows. The `shipped` and `not_built` columns keep the newest 20 cards each; the counts
 * cover all 100 Changes.
 */

type AppEnv = { Bindings: Env; Variables: AuthVariables };

const ProjectIdParam = z.object({ projectId: z.string().regex(/^proj_[a-z0-9-]+$/) });

const NEWEST = `SELECT id FROM changes WHERE project_id = ?1 ORDER BY created_at DESC LIMIT ${BOARD_CHANGE_LIMIT}`;

export type BoardChangeRow = {
  id: string;
  goal: string;
  title: string | null;
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  display_name: string | null;
  email: string | null;
  requester_role: string | null;
  generation: number | null;
  /** The newest first-come wait while the Change is `awaiting_choice` or `queued` (ADR 0032). */
  waiting_json?: string | null;
} & ReviewColumns;

export type BoardTaskRow = {
  change_id: string;
  id: string;
  title: string | null;
  status: string;
  agent_id: string | null;
  tier: string | null;
};

export type BoardMemberRow = {
  user_id: string;
  role: string;
  display_name: string | null;
  email: string | null;
};

/** The wait of an `awaiting_choice` or `queued` card: who it waits for, and on which request. */
function waitingOf(
  status: ChangeStatus,
  json: string | null | undefined,
): RequestWaitSummary | null {
  if ((status !== "awaiting_choice" && status !== "queued") || !json) return null;
  try {
    const w = JSON.parse(json) as {
      firstChangeId: string;
      firstTitle: string | null;
      firstGoal: string | null;
      userId: string;
      name: string | null;
      email: string | null;
    };
    return {
      state: status === "queued" ? "after_first" : "choosing",
      firstChangeId: w.firstChangeId,
      firstTitle: changeTitle(w.firstTitle, w.firstGoal ?? ""),
      firstRequester: { userId: w.userId, name: requesterName(w.name, w.email) },
    };
  } catch {
    return null;
  }
}

/** Agent state of one Task on a card. */
function agentState(taskStatus: string): BoardAgent["state"] {
  if (taskStatus === "assigned" || taskStatus === "running") return "running";
  if (taskStatus === "completed") return "done";
  if (taskStatus === "failed" || taskStatus === "cancelled") return "failed";
  return "waiting";
}

/** Pure: rows to the Board response. Changes arrive newest first. */
export function buildBoard(input: {
  viewerUserId: string;
  viewerRole: ProjectRole;
  changes: readonly BoardChangeRow[];
  tasks: readonly BoardTaskRow[];
  members: readonly BoardMemberRow[];
}): BoardResponse {
  const tasksOf = new Map<string, BoardTaskRow[]>();
  for (const task of input.tasks) {
    const list = tasksOf.get(task.change_id) ?? [];
    list.push(task);
    tasksOf.set(task.change_id, list);
  }
  const cards: BoardCard[] = [];
  const closedShown = { shipped: 0, not_built: 0 };
  const counts = new Map<string, BoardPerson["counts"]>();
  for (const row of input.changes) {
    const status = ChangeStatus.safeParse(row.status);
    if (!status.success) continue;
    const column = boardColumn(status.data);
    const count = counts.get(row.created_by) ?? { proposed: 0, active: 0, shipped: 0, notBuilt: 0 };
    if (column === "proposed") count.proposed += 1;
    else if (column === "shipped") count.shipped += 1;
    else if (column === "not_built") count.notBuilt += 1;
    else count.active += 1;
    counts.set(row.created_by, count);
    if (column === "shipped" || column === "not_built") {
      if (closedShown[column] >= BOARD_CLOSED_COLUMN_LIMIT) continue;
      closedShown[column] += 1;
    }
    const tasks = tasksOf.get(row.id) ?? [];
    cards.push({
      changeId: row.id,
      title: changeTitle(row.title, row.goal),
      goal: row.goal,
      status: status.data,
      column,
      requester: {
        userId: row.created_by,
        name: requesterName(row.display_name, row.email),
        role: ProjectRole.safeParse(row.requester_role).data ?? null,
        isYou: row.created_by === input.viewerUserId,
      },
      tasks: {
        done: tasks.filter((t) => t.status === "completed").length,
        total: tasks.length,
      },
      agents: tasks.flatMap((t) =>
        t.agent_id
          ? [
              {
                agentId: t.agent_id,
                taskTitle: t.title ?? "",
                tier: ModelTier.safeParse(t.tier).data ?? null,
                state: agentState(t.status),
              },
            ]
          : [],
      ),
      review: reviewOf(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      generation: row.generation ?? null,
      waiting: waitingOf(status.data, row.waiting_json),
    });
  }
  const none = { proposed: 0, active: 0, shipped: 0, notBuilt: 0 };
  const people: BoardPerson[] = input.members.flatMap((m) => {
    const role = ProjectRole.safeParse(m.role);
    if (!role.success) return [];
    return [
      {
        userId: m.user_id,
        name: requesterName(m.display_name, m.email),
        role: role.data,
        isYou: m.user_id === input.viewerUserId,
        counts: counts.get(m.user_id) ?? none,
      },
    ];
  });
  // A requester who left the Project still has cards: list them without a role.
  const listed = new Set(people.map((p) => p.userId));
  for (const row of input.changes) {
    if (listed.has(row.created_by)) continue;
    listed.add(row.created_by);
    people.push({
      userId: row.created_by,
      name: requesterName(row.display_name, row.email),
      role: null,
      isYou: row.created_by === input.viewerUserId,
      counts: counts.get(row.created_by) ?? none,
    });
  }
  return { people, cards, canReview: can(input.viewerRole, "change.review") };
}

export const board = new Hono<AppEnv>().get(
  "/v1/projects/:projectId/board",
  requireAuth,
  validate("param", ProjectIdParam),
  async (c) => {
    const { userId } = await ensureIdentity(c.env.DB, c.get("authSubject"));
    const { projectId } = c.req.valid("param");
    const role = await projectRole(c.env.DB, userId, projectId);
    if (!role) return fail(c, 404, "not_found", "Project not found");
    const [changes, tasks, members] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT c.id, c.goal, c.title, c.status, c.created_by, c.created_at, c.updated_at,
                u.display_name, u.email, ${REVIEW_COLUMNS},
                (SELECT MAX(cd.promoted_generation) FROM candidates cd
                   WHERE cd.change_id = c.id AND cd.status = 'promoted') AS generation,
                CASE WHEN c.status IN ('awaiting_choice', 'queued') THEN (
                  SELECT json_object('firstChangeId', w.first_change_id, 'firstTitle', f.title,
                    'firstGoal', f.goal, 'userId', w.asked_user_id, 'name', uw.display_name,
                    'email', uw.email)
                  FROM request_choices w LEFT JOIN changes f ON f.id = w.first_change_id
                  LEFT JOIN users uw ON uw.id = w.asked_user_id
                  WHERE w.later_change_id = c.id ORDER BY w.created_at DESC LIMIT 1) END AS waiting_json
         FROM changes c LEFT JOIN users u ON u.id = c.created_by ${REVIEWER_JOIN}
         WHERE c.project_id = ?1 ORDER BY c.created_at DESC LIMIT ${BOARD_CHANGE_LIMIT}`,
      ).bind(projectId),
      c.env.DB.prepare(
        `SELECT t.change_id, t.id, t.title, t.status,
                COALESCE(t.assigned_agent_id,
                  (SELECT r.agent_id FROM task_runs r WHERE r.task_id = t.id
                   ORDER BY r.attempt DESC LIMIT 1)) AS agent_id,
                (SELECT r.tier FROM task_runs r WHERE r.task_id = t.id
                 ORDER BY r.attempt DESC LIMIT 1) AS tier
         FROM tasks t WHERE t.change_id IN (${NEWEST}) ORDER BY t.task_key`,
      ).bind(projectId),
      c.env.DB.prepare(
        `SELECT pm.user_id, pm.role, u.display_name, u.email
         FROM project_members pm LEFT JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = ? ORDER BY pm.rank, pm.created_at LIMIT 200`,
      ).bind(projectId),
    ]);
    return respond(c, apiData(BoardResponse), {
      data: buildBoard({
        viewerUserId: userId,
        viewerRole: role,
        changes: (changes?.results ?? []) as BoardChangeRow[],
        tasks: (tasks?.results ?? []) as BoardTaskRow[],
        members: (members?.results ?? []) as BoardMemberRow[],
      }),
    });
  },
);
