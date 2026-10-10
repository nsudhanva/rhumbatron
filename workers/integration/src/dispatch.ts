import { type GraphTask, readyTaskIds } from "@rhumbatron/causal-router";
import type { AgentWakePayload, CommandEnvelope, TaskStatus } from "@rhumbatron/protocol";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";

type TaskRow = {
  id: string;
  status: TaskStatus;
  wake_sent_at: string | null;
  semantic_resource: string | null;
  kind: string;
  attempts_reset_at?: string | null;
};

/** One logical agent per Task until AgentDO pools agents by role (Phase 6). */
const agentIdFor = (taskId: string) => `agt_${taskId.slice(4)}`;

/**
 * Marks every pending Task with completed dependencies `ready`, records `task.ready`, and sends one
 * wake command per ready Task that has not had one, only while the Change is `running`. Safe to
 * repeat: the status update is conditional, IDs are stable, and `wake_sent_at` is written only
 * after the send succeeds.
 */
export async function dispatchReadyTasks(
  env: Pick<Env, "DB" | "RESOURCE_SHARD" | "AGENT_WAKEUPS">,
  ctx: ChangeContext,
  budgetRemainingUsd: number,
): Promise<string[]> {
  const [change, tasks, deps] = await env.DB.batch([
    env.DB.prepare("SELECT status FROM changes WHERE id = ?").bind(ctx.changeId),
    env.DB.prepare(
      "SELECT id, status, semantic_resource, kind, wake_sent_at, attempts_reset_at FROM tasks WHERE change_id = ?",
    ).bind(ctx.changeId),
    env.DB.prepare(
      `SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
       JOIN tasks t ON t.id = d.task_id WHERE t.change_id = ?`,
    ).bind(ctx.changeId),
  ]);
  // Only a running Change dispatches: a cancelled, budget-blocked, or finished one starts nothing.
  const changeStatus = (change?.results?.[0] as { status?: string } | undefined)?.status;
  if (changeStatus !== "running") return [];
  const rows = (tasks?.results ?? []) as TaskRow[];
  const edges = (deps?.results ?? []) as { task_id: string; depends_on_task_id: string }[];
  const graph: GraphTask[] = rows.map((r) => ({
    id: r.id,
    status: r.status,
    dependsOn: edges.filter((e) => e.task_id === r.id).map((e) => e.depends_on_task_id),
  }));

  const toReady = readyTaskIds(graph);
  const now = new Date().toISOString();
  if (toReady.length > 0) {
    await env.DB.batch(
      toReady.map((id) =>
        env.DB.prepare(
          "UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ? AND status = 'pending'",
        ).bind(now, id),
      ),
    );
  }
  // Includes Tasks an earlier attempt marked ready but did not wake.
  const unwoken = rows.filter((r) => r.status === "ready" && !r.wake_sent_at).map((r) => r.id);
  const ready = [...new Set([...toReady, ...unwoken])];
  if (ready.length === 0) return [];

  const byId = new Map(rows.map((r) => [r.id, r]));
  const events = await Promise.all(
    ready.map((taskId) =>
      changeEvent(
        ctx,
        "task.ready",
        { agentId: agentIdFor(taskId) },
        {
          taskId,
          ...(byId.get(taskId)?.attempts_reset_at
            ? { key: byId.get(taskId)?.attempts_reset_at ?? "" }
            : {}),
          ...(byId.get(taskId)?.semantic_resource
            ? { resource: byId.get(taskId)?.semantic_resource ?? "" }
            : {}),
        },
      ),
    ),
  );
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, events);

  const commands: CommandEnvelope<AgentWakePayload>[] = ready.map((taskId, i) => ({
    commandId: `cmd_${taskId.slice(4)}_ready${byId.get(taskId)?.attempts_reset_at ? `_${events[i]?.eventId}` : ""}`,
    commandType: "agent.wake",
    projectId: ctx.projectId,
    changeId: ctx.changeId,
    taskId,
    attempt: 0,
    createdAt: now,
    payload: {
      eventId: events[i]?.eventId ?? "",
      agentId: agentIdFor(taskId),
      reason: "task_ready",
      contextCursor: events[i]?.eventId ?? "",
      priority: 5,
      budgetRemainingUsd,
    },
  }));
  await env.AGENT_WAKEUPS.sendBatch(commands.map((body) => ({ body, contentType: "json" })));
  await env.DB.batch(
    ready.map((id) =>
      env.DB.prepare(
        "UPDATE tasks SET wake_sent_at = ? WHERE id = ? AND wake_sent_at IS NULL",
      ).bind(new Date().toISOString(), id),
    ),
  );
  return ready;
}
