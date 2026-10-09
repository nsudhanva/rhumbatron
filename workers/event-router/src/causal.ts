import { type ActiveAgent, type GraphTask, routeEvent, type Wake } from "@rhumbatron/causal-router";
import { type DecisionModel, WorkersAiDecisionModel } from "@rhumbatron/model-router";
import type {
  AgentWakePayload,
  CommandEnvelope,
  EventEnvelope,
  TaskStatus,
} from "@rhumbatron/protocol";

/**
 * Causal Router (AGENTS.md section 31). Deterministic rules first; Clef-flash only for ambiguous
 * resource overlaps, under a daily cap. Never wakes an agent without a causal dependency.
 */

/** Clef-flash calls per day. Keeps Workers AI usage far inside the free daily allowance. */
const CLEF_DAILY_CAP = 200;
/** Below this probability Clef abstains and the safe fallback applies. */
const CLEF_ABSTAIN_BELOW = 0.7;

type TaskRow = {
  id: string;
  change_id: string;
  status: TaskStatus;
  assigned_agent_id: string | null;
  semantic_resources_json: string;
  title: string | null;
};

const log = (line: Record<string, unknown>) => console.warn(JSON.stringify(line));

/** Atomically takes one unit of a daily counter. False when the cap is reached. */
async function takeDailyQuota(db: D1Database, counter: string, cap: number): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, ?, 1)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(day, counter, cap)
    .first<{ count: number }>();
  return row !== null;
}

async function loadTasks(env: Env, changeIds: string[], projectIds: string[]) {
  if (changeIds.length === 0 && projectIds.length === 0)
    return {
      rows: [] as TaskRow[],
      edges: [] as { task_id: string; depends_on_task_id: string }[],
    };
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
  const scope = [
    changeIds.length ? `t.change_id IN (${marks(changeIds.length)})` : null,
    projectIds.length
      ? `(c.project_id IN (${marks(projectIds.length)}) AND t.status IN ('assigned', 'running'))`
      : null,
  ]
    .filter(Boolean)
    .join(" OR ");
  const [tasks, deps] = await env.DB.batch([
    env.DB.prepare(
      `SELECT t.id, t.change_id, t.status, t.assigned_agent_id, t.semantic_resources_json, t.title
       FROM tasks t JOIN changes c ON c.id = t.change_id WHERE ${scope}`,
    ).bind(...changeIds, ...projectIds),
    env.DB.prepare(
      `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d JOIN tasks t ON t.id = d.task_id
       JOIN changes c ON c.id = t.change_id WHERE ${scope}`,
    ).bind(...changeIds, ...projectIds),
  ]);
  return {
    rows: (tasks?.results ?? []) as TaskRow[],
    edges: (deps?.results ?? []) as { task_id: string; depends_on_task_id: string }[],
  };
}

/** Asks the integration Worker to dispatch newly ready Tasks (Queue `rhumbatron-integration`). */
function dispatchCommand(
  event: EventEnvelope,
  changeId: string,
): CommandEnvelope<Record<string, never>> {
  return {
    commandId: `cmd_${event.eventId.slice(4)}_dispatch`,
    commandType: "change.dispatch",
    projectId: event.projectId,
    changeId,
    attempt: 0,
    createdAt: new Date().toISOString(),
    payload: {},
  };
}

/** Asks Clef-flash whether an ambiguous overlap matters. Abstain or cap reached: wake (safe side). */
async function decideAmbiguous(
  model: DecisionModel,
  event: EventEnvelope,
  candidates: Wake[],
  titles: Map<string, string>,
): Promise<Wake[]> {
  if (candidates.length === 0) return [];
  const answers = await model.decide({
    model: "clef-flash",
    state: {
      event: { type: event.eventType, resource: event.resource ?? null },
      agents: candidates.map((w) => ({ taskId: w.taskId, task: titles.get(w.taskId) ?? "" })),
    },
    questions: candidates.map((w, i) => ({
      id: `q${i}`,
      prompt: `Does this event change the inputs or assumptions of task ${w.taskId}, so its agent must re-check its work?`,
      options: ["wake", "skip"],
    })),
  });
  const wakes: Wake[] = [];
  candidates.forEach((w, i) => {
    const answer = answers[i];
    const wake = !answer || answer.abstained || answer.choice === "wake";
    // Decision Receipt without private reasoning (AGENTS.md section 23.5).
    log({
      event: "router.clef_decision",
      eventId: event.eventId,
      taskId: w.taskId,
      choice: answer?.choice ?? null,
      abstained: answer?.abstained ?? true,
      probabilities: answer?.probabilities ?? {},
      woke: wake,
    });
    if (wake) wakes.push(w);
  });
  return wakes;
}

/** Routes one batch of fresh events. Throws on failure so the caller can release and redeliver. */
export async function routeCausalBatch(
  env: Env,
  events: EventEnvelope[],
): Promise<{ woke: number; dispatched: number }> {
  const relevant = events.filter((e) => e.eventType !== "task.ready");
  const changeIds = [
    ...new Set(relevant.map((e) => e.changeId).filter((id): id is string => !!id)),
  ];
  const projectIds = [
    ...new Set(
      relevant.filter((e) => e.eventType === "canonical.advanced").map((e) => e.projectId),
    ),
  ];
  const { rows, edges } = await loadTasks(env, changeIds, projectIds);

  const graphFor = (changeId: string | undefined): GraphTask[] =>
    rows
      .filter((r) => r.change_id === changeId)
      .map((r) => ({
        id: r.id,
        status: r.status,
        dependsOn: edges.filter((e) => e.task_id === r.id).map((e) => e.depends_on_task_id),
      }));
  const activeAgents: ActiveAgent[] = rows
    .filter((r) => r.assigned_agent_id && (r.status === "assigned" || r.status === "running"))
    .map((r) => ({
      agentId: r.assigned_agent_id ?? "",
      taskId: r.id,
      resources: JSON.parse(r.semantic_resources_json) as string[],
    }));
  const titles = new Map(rows.map((r) => [r.id, r.title ?? ""]));
  const clef = new WorkersAiDecisionModel({
    ai: env.AI,
    abstainBelow: CLEF_ABSTAIN_BELOW,
    allowCall: () => takeDailyQuota(env.DB, "clef-flash", CLEF_DAILY_CAP),
  });

  const dispatches = new Map<string, CommandEnvelope<Record<string, never>>>();
  const commands: CommandEnvelope<AgentWakePayload>[] = [];
  for (const event of relevant) {
    const scoped = activeAgents.filter((a) =>
      event.eventType === "canonical.advanced"
        ? rows.some((r) => r.id === a.taskId)
        : rows.find((r) => r.id === a.taskId)?.change_id === event.changeId,
    );
    const decision = routeEvent(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        ...(event.taskId ? { taskId: event.taskId } : {}),
        ...(event.resource ? { resource: event.resource } : {}),
      },
      { activeAgents: scoped },
      graphFor(event.changeId),
    );
    if (decision.ready.length > 0 && event.changeId && !dispatches.has(event.changeId)) {
      dispatches.set(event.changeId, dispatchCommand(event, event.changeId));
    }
    const wakes = [
      ...decision.wake,
      ...(await decideAmbiguous(clef, event, decision.ambiguous, titles)),
    ];
    for (const w of wakes) {
      const changeId = rows.find((r) => r.id === w.taskId)?.change_id ?? event.changeId ?? "";
      commands.push({
        commandId: `cmd_${event.eventId.slice(4)}_${w.taskId.slice(4)}`,
        commandType: "agent.wake",
        projectId: event.projectId,
        changeId,
        taskId: w.taskId,
        attempt: 0,
        createdAt: new Date().toISOString(),
        payload: {
          eventId: event.eventId,
          agentId: w.agentId,
          reason: w.reason,
          contextCursor: event.eventId,
          priority: 5,
          budgetRemainingUsd: 0,
        },
      });
    }
  }

  if (dispatches.size > 0) {
    await env.INTEGRATION_COMMANDS.sendBatch(
      [...dispatches.values()].map((body) => ({ body, contentType: "json" })),
    );
  }
  if (commands.length > 0) {
    await env.AGENT_WAKEUPS.sendBatch(commands.map((body) => ({ body, contentType: "json" })));
  }
  return { woke: commands.length, dispatched: dispatches.size };
}
