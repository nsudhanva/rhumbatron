import { type ActiveAgent, type GraphTask, routeEvent, type Wake } from "@rhumbatron/causal-router";
import { type DecisionModel, WorkersAiDecisionModel } from "@rhumbatron/model-router";
import type {
  AgentWakePayload,
  CommandEnvelope,
  EventEnvelope,
  TaskStatus,
} from "@rhumbatron/protocol";
import { indexCommands } from "./indexing.ts";

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
  wake_sent_at: string | null;
  blocked_limit: string | null;
};

/**
 * Hard bound on amplification (AGENTS.md sections 44, 61): commands (wakes, dispatches, composes)
 * one Change can produce per UTC day. A Change of 8 agents uses far less than 100. An event to
 * wake to event cycle, whatever its shape, stops here; the dropped commands are logged as errors.
 */
const CHANGE_DAILY_COMMAND_CAP = 1_000;

/** Events after which a Task of the Change no longer holds a reasoning agent slot (section 44). */
const SLOT_FREEING = new Set(["task.completed", "task.failed"]);

/**
 * Section 44 and 61: a ready Task the wake consumer deferred at the active-agent limit has no wake
 * in flight. When a slot frees, the Change is dispatched again so the integration Worker wakes it.
 */
export const hasDeferredReady = (rows: readonly TaskRow[], changeId: string | undefined) =>
  rows.some(
    (r) =>
      r.change_id === changeId &&
      r.status === "ready" &&
      (r.wake_sent_at === null || r.blocked_limit === "max_active_agents_per_change"),
  );

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

/**
 * Takes `count` commands from each Change's daily budget in one D1 batch. Returns the Changes whose
 * budget is spent: their commands must not be sent. All or nothing per Change and batch.
 */
async function overBudgetChanges(
  db: D1Database,
  counts: Map<string, number>,
): Promise<Set<string>> {
  const entries = [...counts].filter(([, n]) => n > 0);
  if (entries.length === 0) return new Set();
  const day = new Date().toISOString().slice(0, 10);
  const results = await db.batch<{ count: number }>(
    entries.map(([changeId, n]) =>
      db
        .prepare(
          `INSERT INTO usage_counters (day, counter, count) SELECT ?, ?, ? WHERE ? <= ?
           ON CONFLICT (day, counter) DO UPDATE SET count = count + excluded.count
           WHERE count + excluded.count <= ?
           RETURNING count`,
        )
        .bind(
          day,
          `router-commands:${changeId}`,
          n,
          n,
          CHANGE_DAILY_COMMAND_CAP,
          CHANGE_DAILY_COMMAND_CAP,
        ),
    ),
  );
  const over = new Set<string>();
  entries.forEach(([changeId, n], i) => {
    if ((results[i]?.results?.length ?? 0) > 0) return;
    over.add(changeId);
    console.error(
      JSON.stringify({
        event: "router.change_command_cap_reached",
        changeId,
        dropped: n,
        cap: CHANGE_DAILY_COMMAND_CAP,
      }),
    );
  });
  return over;
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
      `SELECT t.id, t.change_id, t.status, t.assigned_agent_id, t.semantic_resources_json, t.title,
              t.wake_sent_at, t.blocked_limit
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

/**
 * AGENTS.md section 21.1 step 7. When the last Task completes, the agents Worker moves the Change
 * to `verifying` and records `verification.started` with reason `work_graph_completed`. The
 * integration Worker then composes the Change's Candidates (fork rule, section 32.4). The command
 * ID derives from the event, and the Candidate IDs from the composition key, so a redelivery
 * creates nothing new. Deterministic: no model call.
 */
export function composeCommand(
  event: EventEnvelope,
): CommandEnvelope<Record<string, never>> | null {
  if (event.eventType !== "verification.started" || !event.changeId) return null;
  const reason = (event.payload as { reason?: unknown } | null)?.reason;
  if (reason !== "work_graph_completed") return null;
  return {
    commandId: `cmd_${event.eventId.slice(4)}_compose`,
    commandType: "candidate.create",
    projectId: event.projectId,
    changeId: event.changeId,
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

/**
 * P11-06 (AGENTS.md sections 42.9, 59). After `canonical.advanced`, every other in-flight Candidate
 * of the Project on an older base can never promote: mark it stale, so nobody verifies or approves
 * it further. The promoted Candidate itself is marked promoted, which repairs the D1 mirror if the
 * integration Worker stopped between the compare-and-swap and its own write. One D1 batch.
 */
async function settleCandidates(env: Env, events: EventEnvelope[]): Promise<number> {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const event of events) {
    if (event.eventType !== "canonical.advanced") continue;
    const payload = event.payload as { toGeneration?: unknown; candidateId?: unknown } | null;
    const generation = payload?.toGeneration;
    const candidateId = payload?.candidateId;
    if (typeof generation !== "number" || typeof candidateId !== "string") continue;
    statements.push(
      env.DB.prepare(
        `UPDATE candidates SET status = 'promoted', promoted_generation = ?, status_reason = NULL,
           updated_at = ? WHERE id = ? AND status != 'promoted'`,
      ).bind(generation, now, candidateId),
      env.DB.prepare(
        `UPDATE candidates SET status = 'stale', status_reason = ?, updated_at = ?
         WHERE id != ? AND base_generation < ?
           AND status IN ('composing', 'composed', 'verifying', 'verified')
           AND change_id IN (SELECT id FROM changes WHERE project_id = ?)`,
      ).bind(
        `Canonical advanced to S${generation}; this Candidate's base is older.`,
        now,
        candidateId,
        generation,
        event.projectId,
      ),
    );
  }
  if (statements.length === 0) return 0;
  const results = await env.DB.batch(statements);
  // Every second statement is a stale sweep.
  return results.reduce((n, r, i) => n + (i % 2 === 1 ? (r.meta.changes ?? 0) : 0), 0);
}

/** Routes one batch of fresh events. Throws on failure so the caller can release and redeliver. */
export async function routeCausalBatch(
  env: Env,
  events: EventEnvelope[],
): Promise<{ woke: number; dispatched: number; composed: number; staled: number }> {
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
  const composes = relevant
    .map(composeCommand)
    .filter((c): c is CommandEnvelope<Record<string, never>> => c !== null);
  const readmitted = new Set<string>();
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
    const readmit = SLOT_FREEING.has(event.eventType) && hasDeferredReady(rows, event.changeId);
    if (readmit && event.changeId) readmitted.add(event.changeId);
    if (
      (decision.ready.length > 0 || readmit) &&
      event.changeId &&
      !dispatches.has(event.changeId)
    ) {
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

  if (readmitted.size > 0) {
    // A deferred Task must look unwoken to the dispatcher, even if a late dispatch write set it.
    await env.DB.batch(
      [...readmitted].map((changeId) =>
        env.DB.prepare(
          `UPDATE tasks SET wake_sent_at = NULL
           WHERE change_id = ? AND status = 'ready' AND blocked_limit = 'max_active_agents_per_change'`,
        ).bind(changeId),
      ),
    );
  }
  // Per-Change daily command budget, taken before any send (CHANGE_DAILY_COMMAND_CAP).
  const perChange = new Map<string, number>();
  for (const c of [...dispatches.values(), ...composes, ...commands]) {
    perChange.set(c.changeId ?? "", (perChange.get(c.changeId ?? "") ?? 0) + 1);
  }
  const over = await overBudgetChanges(env.DB, perChange);
  const withinBudget = <T extends { changeId?: string | undefined }>(c: T) =>
    !over.has(c.changeId ?? "");
  const integrationCommands = [...dispatches.values(), ...composes].filter(withinBudget);
  if (integrationCommands.length > 0) {
    await env.INTEGRATION_COMMANDS.sendBatch(
      integrationCommands.map((body) => ({ body, contentType: "json" })),
    );
  }
  const wakeCommands = commands.filter(withinBudget);
  if (wakeCommands.length > 0) {
    await env.AGENT_WAKEUPS.sendBatch(wakeCommands.map((body) => ({ body, contentType: "json" })));
  }
  const indexing = indexCommands(relevant);
  if (indexing.length > 0) {
    await env.INDEXING.sendBatch(indexing.map((body) => ({ body, contentType: "json" })));
  }
  const staled = await settleCandidates(env, relevant);
  return {
    woke: wakeCommands.length,
    dispatched: integrationCommands.length - composes.filter(withinBudget).length,
    composed: composes.filter(withinBudget).length,
    staled,
  };
}
