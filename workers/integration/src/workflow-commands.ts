import type { CommandEnvelope } from "@rhumbatron/protocol";
import { z } from "zod";

/**
 * Workflow start commands (AGENTS.md sections 20, 21, 60; HOM-202). "Start verification" travels on
 * `rhumbatron-verification-<env>` and "start release" on `rhumbatron-release-<env>`. The integration
 * Worker consumes both and starts the existing Workflow. The command carries the idempotency key,
 * and the Workflow instance ID is that key (Candidate ID, release ID), as before: a redelivery, a
 * retry, or the direct fallback below all find the one instance and start nothing new.
 *
 * Volume: one message per Candidate (at most 3 per Change) and one per promoted generation with a
 * live app. About 3 Queue operations each (write, read, delete), so a busy demo day of 20
 * Changes is about 250 operations, inside the included Queues allowance.
 */

export type WorkflowStartRoute = { projectId: string; changeId: string };

const CandidateId = z.string().regex(/^cand_[a-z0-9]+$/);
const ReleaseId = z.string().regex(/^rel_[A-Za-z0-9_-]+$/);

const StartPayload = {
  "verification.start": z.object({ candidateId: CandidateId }),
  "release.start": z.object({ releaseId: ReleaseId }),
} as const;

export type WorkflowStart =
  | { workflow: "candidate"; instanceId: string; params: { candidateId: string } }
  | { workflow: "release"; instanceId: string; params: { releaseId: string } };

const command = (
  commandType: keyof typeof StartPayload,
  key: string,
  route: WorkflowStartRoute,
  payload: Record<string, string>,
  now: string,
): CommandEnvelope<Record<string, string>> => ({
  // Stable per idempotency key: a resend after an ambiguous failure is the same command.
  commandId: `cmd_${key}_${commandType === "verification.start" ? "verify" : "release"}`,
  commandType,
  projectId: route.projectId,
  changeId: route.changeId,
  attempt: 0,
  createdAt: now,
  payload,
});

export const verificationCommand = (
  candidateId: string,
  route: WorkflowStartRoute,
  now = new Date().toISOString(),
) => command("verification.start", candidateId, route, { candidateId }, now);

export const releaseCommand = (
  releaseId: string,
  route: WorkflowStartRoute,
  now = new Date().toISOString(),
) => command("release.start", releaseId, route, { releaseId }, now);

/**
 * The Workflow and instance a start command names, or null when it is not a valid start command.
 * The instance ID is the command's idempotency key.
 */
export function workflowStartFor(
  body: Pick<CommandEnvelope, "commandType" | "payload">,
): WorkflowStart | null {
  if (body.commandType === "verification.start") {
    const parsed = StartPayload["verification.start"].safeParse(body.payload);
    if (!parsed.success) return null;
    const { candidateId } = parsed.data;
    return { workflow: "candidate", instanceId: candidateId, params: { candidateId } };
  }
  if (body.commandType === "release.start") {
    const parsed = StartPayload["release.start"].safeParse(body.payload);
    if (!parsed.success) return null;
    const { releaseId } = parsed.data;
    return { workflow: "release", instanceId: releaseId, params: { releaseId } };
  }
  return null;
}

type StartableWorkflow<P> = Pick<Workflow<P>, "create" | "get">;

/**
 * Creates the instance, or finds it when an earlier request or delivery created it. Anything else
 * throws, so the Queue retries and, after its bounded retries, dead-letters the command.
 */
export async function startWorkflowOnce<P>(
  workflow: StartableWorkflow<P>,
  id: string,
  params: P,
): Promise<"created" | "existing"> {
  try {
    await workflow.create({ id, params });
    return "created";
  } catch (error) {
    const existing = await workflow.get(id).catch(() => null);
    if (!existing) throw error;
    return "existing";
  }
}

type StartEnv = Pick<Env, "CANDIDATE_WORKFLOW" | "RELEASE_WORKFLOW">;

/** Starts the Workflow a valid start command names. The consumer and the fallback share it. */
export function startWorkflow(env: StartEnv, start: WorkflowStart) {
  return start.workflow === "candidate"
    ? startWorkflowOnce(env.CANDIDATE_WORKFLOW, start.instanceId, start.params)
    : startWorkflowOnce(env.RELEASE_WORKFLOW, start.instanceId, start.params);
}

type RequestEnv = StartEnv & {
  VERIFICATION_COMMANDS?: Pick<Queue, "send">;
  RELEASE_COMMANDS?: Pick<Queue, "send">;
};

/**
 * Sends a start command to its Queue. Only when the send fails (or the Queue is not bound) does it
 * start the Workflow directly, the path before HOM-202. Either way the instance ID is the same, so
 * a send that failed ambiguously and was still delivered finds the existing instance.
 */
export async function requestWorkflowStart(
  env: RequestEnv,
  body: CommandEnvelope<Record<string, string>>,
): Promise<"queued" | "created" | "existing"> {
  const start = workflowStartFor(body);
  if (!start) throw new Error(`Not a workflow start command: ${body.commandType}`);
  const queue = start.workflow === "candidate" ? env.VERIFICATION_COMMANDS : env.RELEASE_COMMANDS;
  if (queue) {
    try {
      await queue.send(body, { contentType: "json" });
      return "queued";
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "workflow_start.queue_failed",
          commandType: body.commandType,
          instanceId: start.instanceId,
          message: String(error).slice(0, 200),
        }),
      );
    }
  }
  return startWorkflow(env, start);
}
