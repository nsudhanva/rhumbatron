import { isWakeStillRelevant } from "@rhumbatron/causal-router";
import {
  appendChangeEvents,
  type ChangeContext,
  changeEvent,
} from "@rhumbatron/integration/events";
import { AgentWakePayload, AnyCommandEnvelope, type TaskStatus } from "@rhumbatron/protocol";
import { getAgentByName } from "agents";
import type { AgentDO } from "./agent-do.ts";
import { admitAgent } from "./limits.ts";

/**
 * Consumer for `rhumbatron-agent-wakeups`. It checks that the
 * wake is still relevant, assigns the Task, and records `task.assigned` and `agent.woken`.
 * A ready Task then starts a run on its AgentDO (Pi). Other wake reasons are only recorded.
 */

type TaskRow = {
  id: string;
  status: TaskStatus;
  assigned_agent_id: string | null;
  semantic_resource: string | null;
  change_id: string;
  project_id: string;
  org_id: string;
  slug: string;
  base_generation: number;
};

type Outcome = "woken" | "duplicate" | "stale" | "invalid" | "deferred";

// Biome allows only warn and error; Workers Logs keeps them as structured JSON lines.
const log = (line: Record<string, unknown>) => console.warn(JSON.stringify(line));

export async function handleWake(env: Env, body: unknown): Promise<Outcome> {
  const command = AnyCommandEnvelope.safeParse(body);
  const payload = command.success ? AgentWakePayload.safeParse(command.data.payload) : null;
  if (!command.success || !payload?.success || !command.data.taskId) {
    log({ event: "wake.invalid" });
    return "invalid";
  }
  const wake = payload.data;
  const taskId = command.data.taskId;

  const task = await env.DB.prepare(
    `SELECT t.id, t.status, t.assigned_agent_id, t.semantic_resource, t.change_id, c.project_id, p.org_id, p.slug,
            c.base_generation
     FROM tasks t JOIN changes c ON c.id = t.change_id JOIN projects p ON p.id = c.project_id
     WHERE t.id = ?`,
  )
    .bind(taskId)
    .first<TaskRow>();

  // Queues deliver at least once: a redelivered wake for a Task this agent already holds is a duplicate.
  if (task && wake.reason === "task_ready" && task.assigned_agent_id === wake.agentId)
    return "duplicate";

  // A stale wake terminates quickly and counts as a false wakeup.
  if (!isWakeStillRelevant({ taskId, reason: wake.reason }, task) || !task) {
    env.METRICS.writeDataPoint({
      blobs: ["agent_wakeup", "false", wake.reason],
      doubles: [1],
      indexes: [command.data.projectId],
    });
    log({ event: "wake.stale", taskId, reason: wake.reason, status: task?.status ?? "missing" });
    return "stale";
  }

  if (wake.reason === "task_ready") {
    // At most 8 reasoning agents per Change. Count and assignment are one statement.
    const admission = await admitAgent(env.DB, {
      taskId,
      changeId: task.change_id,
      agentId: wake.agentId,
      now: new Date().toISOString(),
    });
    // A concurrent delivery of the same command won the race.
    if (admission.kind === "not_ready") return "duplicate";
    if (admission.kind === "deferred") {
      // The Task stays ready and names the limit; a later dispatch wakes it.
      env.METRICS.writeDataPoint({
        blobs: ["limit_reached", "max_active_agents_per_change", taskId],
        doubles: [admission.active],
        indexes: [command.data.projectId],
      });
      log({ event: "wake.deferred", taskId, active: admission.active });
      return "deferred";
    }
  }

  const ctx: ChangeContext = {
    projectId: task.project_id,
    orgId: task.org_id,
    projectSlug: task.slug,
    changeId: task.change_id,
    baseGeneration: task.base_generation,
  };
  const actor = { kind: "agent" as const, id: wake.agentId };
  const resource = task.semantic_resource ? { resource: task.semantic_resource } : {};
  const events = await Promise.all([
    ...(wake.reason === "task_ready"
      ? [
          changeEvent(
            ctx,
            "task.assigned",
            { agentId: wake.agentId },
            { taskId, actor, ...resource },
          ),
        ]
      : []),
    changeEvent(
      ctx,
      "agent.woken",
      { agentId: wake.agentId, reason: wake.reason, commandId: command.data.commandId },
      { taskId, actor, ...resource },
    ),
  ]);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, events);

  env.METRICS.writeDataPoint({
    blobs: ["agent_wakeup", "true", wake.reason],
    doubles: [1],
    indexes: [ctx.projectId],
  });

  if (wake.reason === "task_ready") {
    const agent = await getAgentByName(
      env.AGENT as unknown as DurableObjectNamespace<AgentDO>,
      wake.agentId,
    );
    await agent.start({ agentId: wake.agentId, taskId, ...ctx });
  }
  return "woken";
}
