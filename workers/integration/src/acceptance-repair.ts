import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";

/**
 * Acceptance repair: one more Task before a person is asked. A verified Candidate passed every
 * required check, but the acceptance check found criteria that the code clearly does not meet
 * (`not_met`, never `unclear`), or a person rejected it with a reason. The Change gets one repair
 * Task (key `repair`) that depends on every Task of the Change, so its workspace holds all their
 * ChangeSets. Its objective is the unmet criteria and the reason. The Candidate is replaced, the
 * Change returns to `running`, and the next Candidate holds the repair. At most one repair per
 * Change: a second shortfall goes to a person.
 *
 * Deterministic: no model call decides. One D1 batch; the repair Task row is the lock.
 */

const ACTOR = { kind: "system", id: "acceptance-repair" } as const;
const MAX_CRITERIA = 8;

type Row = {
  status: string;
  acceptance_json: string | null;
  change_set_ids_json: string | null;
  change_id: string;
  change_status: string;
  project_id: string;
  base_generation: number;
  budget_usd: number;
  org_id: string;
  slug: string;
};
type TaskRow = {
  id: string;
  task_key: string | null;
  status: string;
  acceptance_criteria_json: string | null;
  semantic_resources_json: string | null;
  risk_tier: string | null;
};

const norm = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Criteria the acceptance check judged `not_met`, in order, deduplicated. */
export function unmetCriteria(acceptanceJson: string | null): string[] {
  try {
    const results = JSON.parse(acceptanceJson ?? "[]") as {
      criterion?: unknown;
      status?: unknown;
    }[];
    if (!Array.isArray(results)) return [];
    return [
      ...new Set(
        results
          .filter((r) => r.status === "not_met" && typeof r.criterion === "string")
          .map((r) => r.criterion as string),
      ),
    ].slice(0, MAX_CRITERIA);
  } catch {
    return [];
  }
}

/** Pure: the repair Task's semantic resources: those of the Tasks that own an unmet criterion. */
export function repairResources(tasks: readonly TaskRow[], criteria: readonly string[]): string[] {
  const wanted = new Set(criteria.map(norm));
  const owners = tasks.filter((t) => {
    try {
      return (JSON.parse(t.acceptance_criteria_json ?? "[]") as string[]).some((c) =>
        wanted.has(norm(c)),
      );
    } catch {
      return false;
    }
  });
  const from = owners.length > 0 ? owners : tasks;
  const resources = from.flatMap((t) => {
    try {
      return JSON.parse(t.semantic_resources_json ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  return [...new Set(resources)].slice(0, 4);
}

/**
 * Adds the repair Task when the Change has none, every Task is completed, and there is something
 * to repair. Returns true when this call added it.
 */
export async function requestAcceptanceRepair(
  env: Pick<Env, "DB" | "RESOURCE_SHARD" | "AGENT_WAKEUPS">,
  input: { candidateId: string; reason?: string | null; trigger: "acceptance" | "approver" },
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT c.status, c.acceptance_json, c.change_set_ids_json, c.change_id, ch.status AS change_status, ch.project_id,
            ch.base_generation, ch.budget_usd, p.org_id, p.slug
     FROM candidates c JOIN changes ch ON ch.id = c.change_id JOIN projects p ON p.id = ch.project_id
     WHERE c.id = ? AND p.status = 'active'`,
  )
    .bind(input.candidateId)
    .first<Row>();
  if (!row) return false;
  const open = ["verifying", "awaiting_approval"].includes(row.change_status);
  const candidateOk =
    input.trigger === "acceptance" ? row.status === "verified" : row.status === "rejected";
  if (!open || !candidateOk) return false;
  const criteria = unmetCriteria(row.acceptance_json);
  const reason = input.reason?.trim() || null;
  if (criteria.length === 0 && !reason) return false;

  const tasks = await env.DB.prepare(
    `SELECT id, task_key, status, acceptance_criteria_json, semantic_resources_json, risk_tier
     FROM tasks WHERE change_id = ?`,
  )
    .bind(row.change_id)
    .all<TaskRow>();
  const rows = tasks.results ?? [];
  if (rows.some((t) => t.task_key === "repair")) return false;
  if (rows.some((t) => !["completed", "cancelled"].includes(t.status))) return false;
  // The repair builds on this Candidate's work only: the Tasks of its ChangeSets.
  const sets = new Set(JSON.parse(row.change_set_ids_json ?? "[]") as string[]);
  const runs = await env.DB.prepare(
    `SELECT DISTINCT r.task_id FROM changesets cs JOIN task_runs r ON r.id = 'run_' || substr(cs.id, 4)
     WHERE cs.change_id = ?1 AND cs.id IN (SELECT value FROM json_each(?2))`,
  )
    .bind(row.change_id, JSON.stringify([...sets]))
    .all<{ task_id: string }>();
  const mine = new Set((runs.results ?? []).map((r) => r.task_id));
  const built = rows.filter((t) => t.status === "completed" && mine.has(t.id));
  if (built.length === 0) return false;

  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const changeId = row.change_id;
  const taskId = `tsk_${changeId.slice(4)}_repair`;
  const receiptId = `rcpt_rep_${changeId.slice(4)}`;
  const resources = repairResources(built, criteria);
  const goals = [...criteria, ...(reason ? [`A reviewer asked: ${reason}`] : [])];
  const objective = `The composed app passes its checks, but ${
    input.trigger === "acceptance"
      ? "the acceptance check found that the code does not meet these criteria"
      : "a person reviewed it and asked for changes"
  }. Read the current code and change it so each one holds exactly as written. Keep every other feature working.\n- ${goals.join("\n- ")}`;
  const receipt = {
    decisionType: "ACCEPTANCE_REPAIR",
    changeId,
    candidateId: input.candidateId,
    trigger: input.trigger,
    criteria,
    reason,
    taskId,
    dependsOn: built.map((t) => t.id),
    createdAt: now,
  };
  // The repair Task is the lock (one ID per Change); the receipt references it, so it comes after.
  const owned = `EXISTS (SELECT 1 FROM tasks WHERE id = ? AND json_extract(route_json, '$.repair.token') = ?)`;
  const [taken] = await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO tasks (id, change_id, kind, semantic_resource, status, complexity,
         risk_tier, model_policy, task_key, title, objective, acceptance_criteria_json,
         semantic_resources_json, route_json, created_at, updated_at)
       SELECT ?, ?, 'implement', ?, 'pending', 'small', ?, 'policy-1', 'repair', ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM changes WHERE id = ? AND status IN ('verifying', 'awaiting_approval'))`,
    ).bind(
      taskId,
      changeId,
      resources[0] ?? null,
      built.find((t) => t.risk_tier === "high")?.risk_tier ?? "medium",
      input.trigger === "acceptance" ? "Meet the unmet criteria" : "Apply the requested changes",
      objective,
      JSON.stringify(goals),
      JSON.stringify(resources),
      JSON.stringify({
        repair: { candidateId: input.candidateId, trigger: input.trigger, token },
      }),
      now,
      now,
      changeId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO decision_receipts (id, task_id, agent_id, decision_type, decided_by,
         selected_tier, receipt_json, created_at)
       SELECT ?, ?, ?, 'ACCEPTANCE_REPAIR', 'rules', 'sonnet', ?, ? WHERE ${owned}`,
    ).bind(receiptId, taskId, ACTOR.id, JSON.stringify(receipt), now, taskId, token),
    ...built.map((t) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id)
         SELECT ?, ? WHERE ${owned}`,
      ).bind(taskId, t.id, taskId, token),
    ),
    env.DB.prepare(
      `UPDATE candidates SET status = 'rejected', status_reason = ?, updated_at = ?
       WHERE id = ? AND status IN ('verified', 'rejected') AND ${owned}`,
    ).bind(
      `Replaced: a repair Task ${input.trigger === "acceptance" ? "meets the unmet criteria" : "applies the requested changes"}.`,
      now,
      input.candidateId,
      taskId,
      token,
    ),
    env.DB.prepare(
      `UPDATE changes SET status = 'running', updated_at = ? WHERE id = ? AND ${owned}`,
    ).bind(now, changeId, taskId, token),
  ]);
  if ((taken?.meta.changes ?? 0) === 0) return false;
  const ctx: ChangeContext = {
    projectId: row.project_id,
    orgId: row.org_id,
    projectSlug: row.slug,
    changeId,
    baseGeneration: row.base_generation,
  };
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "task.created",
      {
        key: "repair",
        title:
          input.trigger === "acceptance"
            ? "Meet the unmet criteria"
            : "Apply the requested changes",
        kind: "implement",
        dependsOn: built.map((t) => t.id),
        trigger: `${input.trigger}_repair`,
        criteria: goals,
      },
      { taskId, ...(resources[0] ? { resource: resources[0] } : {}), key: receiptId, actor: ACTOR },
    ),
  ]);
  await dispatchReadyTasks(env, ctx, row.budget_usd);
  return true;
}
