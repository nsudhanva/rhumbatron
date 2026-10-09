import { WorkerEntrypoint } from "cloudflare:workers";
import {
  AnyCommandEnvelope,
  type ApprovalOutcome,
  type PromotionOutcome,
} from "@rhumbatron/protocol";
import { z } from "zod";
import { resolveDeadLetter } from "./dead-letters.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { handleFixtureCommand } from "./fixture-changesets.ts";
import { cleanupProject, forkRetentionDays, sweepForks } from "./project-cleanup.ts";
import { decideApproval, promoteCandidate } from "./promotion.ts";
import { provisionProject } from "./provision.ts";

export { ChangeWorkflow } from "./change-workflow.ts";
export { CandidateVerificationWorkflow } from "./verification-workflow.ts";

type ChangeRow = {
  project_id: string;
  org_id: string;
  slug: string;
  base_generation: number;
  budget_usd: number;
};

const CandidateVerifyPayload = z.object({ candidateId: z.string().regex(/^cand_[a-z0-9]+$/) });

/**
 * Starts CandidateVerificationWorkflow for a Candidate the API created (AGENTS.md section 21.2).
 * The instance ID is the Candidate ID, so a duplicate command finds the running instance.
 */
async function startCandidateVerification(env: Env, payload: unknown) {
  const parsed = CandidateVerifyPayload.safeParse(payload);
  if (!parsed.success) return;
  const { candidateId } = parsed.data;
  try {
    await env.CANDIDATE_WORKFLOW.create({ id: candidateId, params: { candidateId } });
  } catch (error) {
    // Already started by an earlier delivery: nothing to do. Anything else is retried.
    const existing = await env.CANDIDATE_WORKFLOW.get(candidateId).catch(() => null);
    if (!existing) throw error;
  }
}

/**
 * Queue deliveries per message (consumer `max_retries` = 3, plus the first). A bounded command
 * that has more work asks for another delivery; on the last one it is acked instead of going to
 * the dead-letter Queue, and the event router's daily maintenance tick queues it again.
 */
const MAX_DELIVERIES = 4;

/** Commands for archived Projects stop here: no new source, Tasks, or Candidate checks. */
async function isArchived(env: Env, projectId: string) {
  const row = await env.DB.prepare("SELECT status FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ status: string }>();
  return row?.status === "archived";
}

/**
 * Handles one command. Unknown commands and Changes are acknowledged and dropped. Returns
 * "continue" when a bounded command has more work for another delivery.
 */
async function handleCommand(env: Env, body: unknown): Promise<"continue" | undefined> {
  const command = AnyCommandEnvelope.safeParse(body);
  if (!command.success) return;
  if (command.data.commandType === "project.cleanup") {
    const result = await cleanupProject(env, command.data.projectId);
    console.warn(
      JSON.stringify({ event: "project.cleanup", projectId: command.data.projectId, ...result }),
    );
    return result.status === "partial" ? "continue" : undefined;
  }
  if (command.data.commandType === "forks.sweep") {
    const result = await sweepForks(env, {
      now: Date.now(),
      retentionDays: forkRetentionDays(env.ENVIRONMENT),
    });
    console.warn(JSON.stringify({ event: "forks.sweep", ...result }));
    return result.more ? "continue" : undefined;
  }
  if (
    ["project.provision", "candidate.verify"].includes(command.data.commandType) &&
    (await isArchived(env, command.data.projectId))
  ) {
    return;
  }
  if (command.data.commandType === "project.provision") {
    const template = (command.data.payload as { template?: string } | null)?.template ?? "empty";
    const result = await provisionProject(env, { projectId: command.data.projectId, template });
    console.warn(
      JSON.stringify({
        event: "project.provisioned",
        projectId: command.data.projectId,
        ...result,
      }),
    );
    return;
  }
  // Dev-only Wishlist fixture ChangeSets (P9-08); refused outside dev inside the handler.
  if (command.data.commandType === "fixture.publish") {
    return handleFixtureCommand(env, command.data);
  }
  if (command.data.commandType === "candidate.verify") {
    await startCandidateVerification(env, command.data.payload);
    return;
  }
  if (command.data.commandType !== "change.dispatch" || !command.data.changeId) return;
  const { changeId } = command.data;
  const row = await env.DB.prepare(
    `SELECT c.project_id, p.org_id, p.slug, c.base_generation, c.budget_usd
     FROM changes c JOIN projects p ON p.id = c.project_id
     WHERE c.id = ? AND c.status = 'running' AND p.status = 'active'`,
  )
    .bind(changeId)
    .first<ChangeRow>();
  if (!row) return;
  await dispatchReadyTasks(
    env,
    {
      projectId: row.project_id,
      orgId: row.org_id,
      projectSlug: row.slug,
      changeId,
      baseGeneration: row.base_generation,
    },
    row.budget_usd,
  );
}

/**
 * Queue consumer plus internal RPC for the API (service binding `INTEGRATION`). The Worker has no
 * public route: callers authenticate users and check project membership before an RPC.
 */
export default class Integration extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: this.env.SERVICE_NAME,
        environment: this.env.ENVIRONMENT,
      });
    }
    return new Response("Not Found", { status: 404 });
  }

  override async queue(batch: MessageBatch): Promise<void> {
    for (const message of batch.messages) {
      try {
        const outcome = await handleCommand(this.env, message.body);
        if (outcome === "continue" && message.attempts < MAX_DELIVERIES) {
          message.retry({ delaySeconds: 10 });
        } else {
          await resolveDeadLetter(this.env.DB, message.body);
          message.ack();
        }
      } catch (error) {
        console.error(
          JSON.stringify({ event: "dispatch.failed", message: String(error).slice(0, 200) }),
        );
        message.retry({ delaySeconds: 30 });
      }
    }
  }

  /** P11-03/P11-04: preconditions, then ProjectRootDO compare-and-swap (section 36). */
  async promoteCandidate(input: {
    candidateId: string;
    actorUserId: string;
  }): Promise<PromotionOutcome> {
    return promoteCandidate(this.env, input);
  }

  /** P11-01: one human decision on a gated Candidate (section 40.2). */
  async decideApproval(input: {
    candidateId: string;
    approverUserId: string;
    decision: "granted" | "rejected";
    reason: string | null;
  }): Promise<ApprovalOutcome> {
    return decideApproval(this.env, input);
  }
}
