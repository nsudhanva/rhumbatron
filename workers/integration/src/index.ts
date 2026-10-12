import { WorkerEntrypoint } from "cloudflare:workers";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import {
  AnyCommandEnvelope,
  type ApprovalOutcome,
  type ChangeCommandOutcome,
  type ClarifyChangeOutcome,
  type ClarifyChangeRequest,
  type CodeEditOutcome,
  type PromotionOutcome,
  type ReleaseInjectionOutcome,
  type ReviewChangeOutcome,
  type RollbackOutcome,
} from "@rhumbatron/protocol";
import { z } from "zod";
import { provisionApp } from "./app-provision.ts";
import { expirePreviews, removeApp } from "./app-release.ts";
import {
  type CreateCandidateOutcome,
  composeChangeCandidates,
  createCandidate,
  startCandidateVerification,
} from "./candidate-create.ts";
import {
  cancelChange,
  clarifyChange,
  declineChange,
  includeChange,
  raiseChangeBudget,
  recordProposal,
  resumeBudgetBlocked,
} from "./change-commands.ts";
import {
  closeCodeSession,
  deleteCodeSessionFile,
  execCodeSessionCommand,
  expireCodeSessions,
  getCodeSession,
  openCodeSession,
  readCodeSessionFile,
  renameCodeSessionFile,
  submitCodeSession,
  writeCodeSessionFile,
} from "./code-sessions.ts";
import { backfillTreeCode, type CodeBackfill } from "./code-store.ts";
import { resolveDeadLetter } from "./dead-letters.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { handleFixtureCommand } from "./fixture-changesets.ts";
import { type HumanEditInput, submitHumanEdit } from "./human-edit.ts";
import { recoverIntegrations } from "./integrate.ts";
import { cleanupProject, FORK_RETENTION_DAYS, sweepForks } from "./project-cleanup.ts";
import { decideApproval, promoteCandidate } from "./promotion.ts";
import { provisionProject } from "./provision.ts";
import { recoverSourceConflicts } from "./rebase.ts";
import { settleStaleBehind } from "./recompose.ts";
import { injectReleaseFailure, recoverStuckRelease } from "./release.ts";
import { requestRollback } from "./rollback.ts";
import { type SourceSeed, seedOf, seedSourceIfUnassigned } from "./source-seed.ts";
import { startWorkflow, workflowStartFor } from "./workflow-commands.ts";

export { ChangeWorkflow } from "./change-workflow.ts";
export { ReleaseWorkflow } from "./release-workflow.ts";
export { CandidateVerificationWorkflow } from "./verification-workflow.ts";

type ChangeRow = {
  project_id: string;
  org_id: string;
  slug: string;
  base_generation: number;
  budget_usd: number;
};

const CandidateVerifyPayload = z.object({ candidateId: z.string().regex(/^cand_[a-z0-9]+$/) });
const CandidatesRecomposePayload = z.object({ generation: z.number().int().positive() });

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

/** Seeds the Project's first commit when its canonical source is unassigned (source-seed.ts). */
async function seedSource(env: Env, projectId: string, seed: SourceSeed) {
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const stub = root.get(root.idFromName(projectId));
  const provisioned: object[] = [];
  const outcome = await seedSourceIfUnassigned({
    getCanonical: () => stub.getCanonical(),
    provision: async () => {
      provisioned.push(await provisionProject(env, { projectId, seed }));
    },
  });
  console.warn(
    JSON.stringify({ event: "project.provisioned", projectId, seed, outcome, ...provisioned[0] }),
  );
}

async function logAppProvision(env: Env, projectId: string) {
  const result = await provisionApp(env, projectId);
  console.warn(JSON.stringify({ event: "app.provision", projectId, ...result }));
}

/**
 * Handles one command. Unknown commands and Changes are acknowledged and dropped. Returns
 * "continue" when a bounded command has more work for another delivery.
 */
async function handleCommand(
  env: Env,
  body: unknown,
  attempts = 1,
): Promise<"continue" | "wait" | undefined> {
  const command = AnyCommandEnvelope.safeParse(body);
  if (!command.success) return;
  // Section 20: `verification.start` and `release.start` from their own Queues (HOM-202). The
  // instance ID is the command's idempotency key, so a redelivery finds the running instance.
  const start = workflowStartFor(command.data);
  if (start) {
    const result = await startWorkflow(env, start);
    console.warn(
      JSON.stringify({
        event: "workflow.start",
        workflow: start.workflow,
        id: start.instanceId,
        result,
      }),
    );
    return;
  }
  if (command.data.commandType === "project.cleanup") {
    // Live apps (P16-20): the app's data stores go too. Prod only; bounded per delivery.
    const app = env.APPS ? await removeApp(env, command.data.projectId) : null;
    const result = await cleanupProject(env, command.data.projectId);
    console.warn(
      JSON.stringify({ event: "project.cleanup", projectId: command.data.projectId, ...result }),
    );
    return result.status === "partial" || app?.status === "partial" ? "continue" : undefined;
  }
  // "Remove app" (P16-20): the API already answers 410; delete data stores, bundles, and rows.
  if (command.data.commandType === "app.remove") {
    const result = await removeApp(env, command.data.projectId);
    console.warn(
      JSON.stringify({ event: "app.remove", projectId: command.data.projectId, ...result }),
    );
    return result.status === "partial" ? "continue" : undefined;
  }
  if (command.data.commandType === "forks.sweep") {
    const rebases = await recoverSourceConflicts(env);
    const result = await sweepForks(env, {
      now: Date.now(),
      retentionDays: FORK_RETENTION_DAYS,
    });
    // P16-22: preview rows (and their data) expire with their 7-day bundles.
    const previews = await expirePreviews(env);
    // ADR 0029: Code page edit sessions past their idle or 2-hour limit end; their forks go.
    const sessions = await expireCodeSessions(env, { now: Date.now() });
    console.warn(
      JSON.stringify({ event: "forks.sweep", ...result, ...previews, rebases, sessions }),
    );
    return result.more ? "continue" : undefined;
  }
  // A Change stuck in `releasing` (event router sweep, HOM-204). Bounded: one Change per command.
  if (command.data.commandType === "release.recover") {
    if (!command.data.changeId) return;
    const result = await recoverStuckRelease(env, command.data.changeId);
    console.warn(
      JSON.stringify({ event: "release.recover", changeId: command.data.changeId, ...result }),
    );
    return;
  }
  if (
    [
      "project.provision",
      "app.provision",
      "candidate.verify",
      "candidate.create",
      "candidates.recompose",
    ].includes(command.data.commandType) &&
    (await isArchived(env, command.data.projectId))
  ) {
    return;
  }
  if (command.data.commandType === "project.provision") {
    await seedSource(env, command.data.projectId, seedOf(command.data.payload));
    // Live apps (ADR 0020): the S0 bundle and production pointer. Prod only; dev returns disabled.
    if (env.APPS) await logAppProvision(env, command.data.projectId);
    return;
  }
  // "Deploy app" for a Project that existed before live apps, or a retry after a failed build. A
  // Project created before every Project got a repository gets its empty repository first.
  if (command.data.commandType === "app.provision") {
    await seedSource(env, command.data.projectId, "blank");
    await logAppProvision(env, command.data.projectId);
    return;
  }
  // Dev-only Wishlist fixture ChangeSets (P9-08); refused outside dev inside the handler.
  if (command.data.commandType === "fixture.publish") {
    return handleFixtureCommand(env, command.data);
  }
  if (command.data.commandType === "candidate.verify") {
    // Older API deployments queued this after creating the Candidate; createCandidate now starts it.
    const parsed = CandidateVerifyPayload.safeParse(command.data.payload);
    if (parsed.success) await startCandidateVerification(env, parsed.data.candidateId);
    return;
  }
  // Section 42.9: the event router marked older-base Candidates stale after `canonical.advanced`
  // and does not compose. Each one ends recomposed, its Change blocked, or its Change closed.
  if (command.data.commandType === "candidates.recompose") {
    const parsed = CandidatesRecomposePayload.safeParse(command.data.payload);
    if (!parsed.success) return;
    const settled = await settleStaleBehind(env, command.data.projectId, parsed.data.generation);
    console.warn(
      JSON.stringify({
        event: "candidates.recompose",
        projectId: command.data.projectId,
        generation: parsed.data.generation,
        settled,
      }),
    );
    return;
  }
  // Section 21.1 step 7: the Work Graph completed; compose its Candidates (Causal Router).
  if (command.data.commandType === "candidate.create") {
    if (!command.data.changeId) return;
    await recoverSourceConflicts(env, command.data.changeId);
    await recoverIntegrations(env, command.data.changeId);
    // The last delivery composes anyway: a stuck review must not hold the Change forever.
    const result = await composeChangeCandidates(env, command.data.changeId, {
      force: attempts >= MAX_DELIVERIES,
    });
    console.warn(
      JSON.stringify({ event: "candidate.create", changeId: command.data.changeId, ...result }),
    );
    return result.status === "waiting" ? "wait" : undefined;
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
        const outcome = await handleCommand(this.env, message.body, message.attempts);
        if (outcome && message.attempts < MAX_DELIVERIES) {
          message.retry({ delaySeconds: outcome === "wait" ? 45 : 10 });
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

  /**
   * Creates (or finds) one Candidate of a Change and starts its verification (sections 33, 60).
   * The API authenticated the user and checked Project membership. `changeSetIds` narrows the
   * composition to a subset of the proposed ChangeSets (competing designs, P9-08).
   */
  async createCandidate(input: {
    changeId: string;
    changeSetIds?: string[] | undefined;
  }): Promise<CreateCandidateOutcome> {
    return createCandidate(this.env, input);
  }

  /** P11-03/P11-04: preconditions, then ProjectRootDO compare-and-swap (section 36). */
  async promoteCandidate(input: {
    candidateId: string;
    actorUserId: string;
  }): Promise<PromotionOutcome> {
    return promoteCandidate(this.env, {
      candidateId: input.candidateId,
      trigger: "manual",
      actor: { kind: "user", id: input.actorUserId },
    });
  }

  /** Cancels a Change before promotion starts (section 16.1). Safe to repeat. */
  async cancelChange(input: {
    changeId: string;
    actorUserId: string;
  }): Promise<ChangeCommandOutcome> {
    return cancelChange(this.env, input);
  }

  /** A person raises a Change budget; a budget-blocked Change resumes (section 44). */
  async raiseChangeBudget(input: {
    changeId: string;
    budgetUsd: number;
    actorUserId: string;
  }): Promise<ChangeCommandOutcome> {
    return raiseChangeBudget(this.env, input);
  }

  /**
   * A person raised a Project or their own monthly budget: the Changes that budget stopped
   * resume (ADR 0030).
   */
  async resumeBudgetBlocked(
    input:
      | { limit: "project_budget"; projectId: string; actorUserId: string }
      | { limit: "account_budget"; userId: string; actorUserId: string },
  ): Promise<{ resumedChangeIds: string[] }> {
    return resumeBudgetBlocked(this.env, input);
  }

  /** Records `change.proposed` for a member's request that waits for review (ADR 0028). */
  async recordProposal(input: {
    changeId: string;
    actorUserId: string;
  }): Promise<{ recorded: boolean }> {
    return recordProposal(this.env, input);
  }

  /**
   * An owner or admin includes a `proposed` request: it becomes `created` and its ChangeWorkflow
   * starts (ADR 0028). The API checked `change.review`. Safe to repeat.
   */
  async includeChange(input: {
    changeId: string;
    actorUserId: string;
  }): Promise<ReviewChangeOutcome> {
    return includeChange(this.env, input);
  }

  /** An owner or admin declines a `proposed` request. Terminal. Safe to repeat. */
  async declineChange(input: {
    changeId: string;
    actorUserId: string;
    reason: string | null;
  }): Promise<ReviewChangeOutcome> {
    return declineChange(this.env, input);
  }

  /**
   * Answers a `needs_input` Change, plans it without another question, or withdraws it (ADR 0025).
   * The API authenticated the actor and checked the requester, the Project owner, or an admin.
   */
  async clarifyChange(input: {
    changeId: string;
    actorUserId: string;
    request: ClarifyChangeRequest;
  }): Promise<ClarifyChangeOutcome> {
    return clarifyChange(this.env, input);
  }

  /**
   * P13-12: a real smoke failure on the Project's latest deployed release, marked injected. The
   * API checked membership and the FIXTURES_ENABLED guard. The Canonical Generation never moves.
   */
  async injectReleaseFailure(input: {
    projectId: string;
    actorUserId: string;
  }): Promise<ReleaseInjectionOutcome> {
    return injectReleaseFailure(this.env, input);
  }

  /**
   * P16-16: copies one canonical tree's files to the code store when a code read finds it missing
   * or partial. The API checked membership; only canonical trees of this Project are accepted.
   */
  async backfillTreeCode(input: { projectId: string; treeSha: string }): Promise<CodeBackfill> {
    return backfillTreeCode(this.env, input);
  }

  /**
   * P16-19: one file saved on the Code page becomes a new Change with one human ChangeSet, then
   * composes and verifies like agent work. The API checked membership and the edit limits.
   */
  async submitHumanEdit(input: HumanEditInput): Promise<CodeEditOutcome> {
    return submitHumanEdit(this.env, input);
  }

  /*
   * Code page edit sessions (ADR 0029). The API checked `code.edit` for the Project and that the
   * caller owns the session; each function checks the owner and the session state again.
   */

  /** Opens the caller's session (one per user per Project), or returns the open one. */
  async openCodeSession(input: { projectId: string; userId: string }) {
    return openCodeSession(this.env, input);
  }

  async getCodeSession(input: { sessionId: string; userId: string }) {
    return getCodeSession(this.env, input);
  }

  async readCodeSessionFile(input: { sessionId: string; userId: string; path: string }) {
    return readCodeSessionFile(this.env, input);
  }

  async writeCodeSessionFile(input: {
    sessionId: string;
    userId: string;
    path: string;
    content: string;
  }) {
    return writeCodeSessionFile(this.env, input);
  }

  async deleteCodeSessionFile(input: { sessionId: string; userId: string; path: string }) {
    return deleteCodeSessionFile(this.env, input);
  }

  async renameCodeSessionFile(input: {
    sessionId: string;
    userId: string;
    from: string;
    to: string;
  }) {
    return renameCodeSessionFile(this.env, input);
  }

  /** One terminal command in the Project Sandbox, 120 s at most, on the monthly Sandbox meter. */
  async execCodeSessionCommand(input: {
    sessionId: string;
    userId: string;
    command: string;
    cwd?: string | undefined;
  }) {
    return execCodeSessionCommand(this.env, input);
  }

  /** Every edit becomes one Change with one human ChangeSet; the session ends. */
  async submitCodeSession(input: {
    sessionId: string;
    userId: string;
    message: string;
    authorName: string | null;
  }) {
    return submitCodeSession(this.env, input);
  }

  async closeCodeSession(input: { sessionId: string; userId: string }) {
    return closeCodeSession(this.env, input);
  }

  /**
   * P16-13: roll back to Sk as the new transition Sn -> Sn+1 with Sk's tree, through the same
   * Candidate, approval, and compare-and-swap path as any promotion. The API checked membership.
   */
  async requestRollback(input: {
    projectId: string;
    targetGeneration: number;
    expectedGeneration: number;
    actorUserId: string;
  }): Promise<RollbackOutcome> {
    return requestRollback(this.env, input);
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
