import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { opusAllowed } from "@rhumbatron/model-router";
import { cancelChange, closeNeedsInput, releaseRequestScope } from "./change-commands.ts";
import { changeComplete } from "./change-meter.ts";
import { readTreeFiles } from "./code-store.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent, qualify } from "./events.ts";
import {
  buildPacket,
  clefModel,
  type IntakeClarification,
  type IntakeOutcome,
  retrieveRelated,
  reviewIntake,
} from "./intake.ts";
import {
  answeredRounds,
  type CanonicalSummary,
  goalWithAnswers,
  loadRelatedRequests,
  parseAnswers,
  readCanonicalSummary,
  type StoredAnswer,
} from "./intake-context.ts";
import {
  checkRequestPair,
  loadRequest,
  readRequestScope,
  releaseClosedRequests,
  requestRoot,
  SYSTEM_ARBITER,
} from "./request-check.ts";
import { nothingSelected, requestsOverlap, selectedCriteria } from "./request-policy.ts";
import { type PlannerResult, type PlannerStepResult, planChangeResult } from "./root-planner.ts";

/**
 * ChangeWorkflow: load the Change, run the intake gate (ADR 0025),
 * compile the Work Graph, compare it with the other open requests, persist Tasks, and dispatch the
 * ready ones. When the intake gate or the request comparison asks a question, the Change is
 * `needs_input` and the workflow waits for the answer (`clarification` event, re-checked daily,
 * at most 7 days), then runs the next pass with the answers in the goal. At most 3 rounds.
 * Every step is idempotent, because Workflows retries steps.
 */

export type ChangeWorkflowParams = { changeId: string };

/** Days a `needs_input` Change waits for an answer before it is cancelled. */
const ANSWER_DAYS = 7;
const MAX_ROUNDS = 3;
type WorkersAi = { run(model: string, input: unknown): Promise<unknown> };
type AnswerState = { status: string; answers: StoredAnswer[]; expired: boolean };

async function readAnswerState(env: Env, changeId: string): Promise<AnswerState> {
  const row = await env.DB.prepare(
    "SELECT status, clarification_json, clarification_answers_json FROM changes WHERE id = ?",
  )
    .bind(changeId)
    .first<{
      status: string;
      clarification_json: string | null;
      clarification_answers_json: string | null;
    }>();
  let askedAt = Date.now();
  try {
    const asked = JSON.parse(row?.clarification_json ?? "null") as { askedAt?: string } | null;
    if (asked?.askedAt) askedAt = Date.parse(asked.askedAt);
  } catch {
    // A missing or broken clarification counts from now.
  }
  return {
    status: row?.status ?? "missing",
    answers: parseAnswers(row?.clarification_answers_json),
    expired: Date.now() - askedAt >= ANSWER_DAYS * 86_400_000,
  };
}

type ChangeRow = {
  id: string;
  project_id: string;
  goal: string;
  status: string;
  base_generation: number;
  budget_usd: number;
  org_id: string;
  slug: string;
  name: string;
  clarification_answers_json: string | null;
};

type Loaded = {
  ctx: ChangeContext;
  goal: string;
  projectName: string;
  budgetUsd: number;
  status: string;
  answers: StoredAnswer[];
};

/** Resolve the current canonical tree, then read its code store or tree listing. */
async function canonicalFiles(env: Env, projectId: string): Promise<string[] | null> {
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(projectId)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") return null;
  return readTreeFiles(env, projectId, canonical.treeSha);
}

const taskIdFor = (changeId: string, key: string) => `tsk_${changeId.slice(4)}_${key}`;

const scopeResources = (ctx: ChangeContext, planned: PlannerResult) => [
  ...new Set(
    planned.plan.tasks.flatMap((task) =>
      task.semanticResources.map((resource) => qualify(ctx, resource)),
    ),
  ),
];

export class ChangeWorkflow extends WorkflowEntrypoint<Env, ChangeWorkflowParams> {
  private complete(req: import("@rhumbatron/model-router").CompletionRequest, changeId: string) {
    return changeComplete(this.env, changeId, req);
  }

  /**
   * One intake review (ADR 0025): retrieval, Clef-flash, Sonnet. Records the INTAKE Decision
   * Receipt and `change.intake.reviewed`. The model cost counts against the Change budget.
   */
  private async intake(
    ctx: ChangeContext,
    goal: string,
    canonical: CanonicalSummary,
    round: number,
    remainingUsd: number,
  ): Promise<Omit<IntakeOutcome, "receipt">> {
    const ai = (this.env as { AI?: WorkersAi }).AI;
    const related = await loadRelatedRequests(this.env, ctx.projectId, ctx.changeId);
    const retrieval = await retrieveRelated(ai, goal, related);
    const outcome = await reviewIntake(
      {
        changeId: ctx.changeId,
        request: goal,
        packet: buildPacket(goal, retrieval.related, canonical),
        retrieval,
      },
      {
        clef: clefModel(ai, this.env.DB),
        complete: (req) => this.complete(req, ctx.changeId),
        canSpend: (spentUsd) => spentUsd < remainingUsd,
      },
    );
    const verdict = String(outcome.receipt.verdict ?? outcome.decision);
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO change_decisions
         (id, change_id, decision_type, round, verdict, decided_by, receipt_json, created_at)
       VALUES (?, ?, 'INTAKE', ?, ?, 'system:intake', ?, ?)`,
    )
      .bind(
        `dec_${ctx.changeId}_intake_${round}`,
        ctx.changeId,
        round,
        verdict,
        JSON.stringify(outcome.receipt),
        new Date().toISOString(),
      )
      .run();
    await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, [
      await changeEvent(
        ctx,
        "change.intake.reviewed",
        {
          round,
          decision: outcome.decision,
          verdict,
          kind: outcome.clarification?.kind ?? null,
          relatedChangeId: outcome.clarification?.relatedChangeId ?? null,
          costUsd: outcome.costUsd,
          decisionReceipt: outcome.receipt,
        },
        { key: `intake-${round}` },
      ),
    ]);
    return {
      decision: outcome.decision,
      clarification: outcome.clarification,
      costUsd: outcome.costUsd,
    };
  }

  /** The Change waits for its requester. False when it left `compiling` first (cancelled). */
  private async ask(
    changeId: string,
    clarification: IntakeClarification,
    round: number,
  ): Promise<boolean> {
    const now = new Date().toISOString();
    await this.env.DB.prepare(
      "UPDATE changes SET status = 'needs_input', clarification_json = ?, updated_at = ? WHERE id = ? AND status = 'compiling'",
    )
      .bind(JSON.stringify({ ...clarification, askedAt: now, round }), now, changeId)
      .run();
    const row = await this.env.DB.prepare("SELECT status FROM changes WHERE id = ?")
      .bind(changeId)
      .first<{ status: string }>();
    return row?.status === "needs_input";
  }

  /**
   * Waits for `clarification` events, one day at a time, and reads D1 after each event or day: the
   * row is the truth, so a lost or stale event only delays. After 7 days without an answer the
   * Change is cancelled with a reason. Returns the status after the wait.
   */
  private async waitForAnswer(
    step: WorkflowStep,
    changeId: string,
    tag: string,
  ): Promise<AnswerState> {
    for (let i = 0; i < ANSWER_DAYS * 2; i += 1) {
      try {
        await step.waitForEvent(`wait for answer${tag} ${i}`, {
          type: "clarification",
          timeout: "1 day",
        });
      } catch {
        // Timed out: re-check the row once a day.
      }
      const state = await step.do(`read answer${tag} ${i}`, () =>
        readAnswerState(this.env, changeId),
      );
      if (state.status !== "needs_input" || state.expired) {
        if (state.status !== "needs_input") return state;
        break;
      }
    }
    await step.do(`close unanswered${tag}`, () =>
      closeNeedsInput(this.env, {
        changeId,
        actorUserId: "system:intake",
        reason: `No answer within ${ANSWER_DAYS} days`,
      }),
    );
    return step.do(`read answer${tag} final`, () => readAnswerState(this.env, changeId));
  }

  override async run(event: Readonly<WorkflowEvent<ChangeWorkflowParams>>, step: WorkflowStep) {
    const { changeId } = event.payload;

    const loaded = await step.do("load change", async (): Promise<Loaded | null> => {
      const row = await this.env.DB.prepare(
        `SELECT c.id, c.project_id, c.goal, c.status, c.base_generation, c.budget_usd,
                c.clarification_answers_json, p.org_id, p.slug, p.name
         FROM changes c JOIN projects p ON p.id = c.project_id WHERE c.id = ?`,
      )
        .bind(changeId)
        .first<ChangeRow>();
      if (!row) return null;
      return {
        ctx: {
          projectId: row.project_id,
          orgId: row.org_id,
          projectSlug: row.slug,
          changeId: row.id,
          baseGeneration: row.base_generation,
        },
        goal: row.goal,
        projectName: row.name,
        budgetUsd: row.budget_usd,
        status: row.status,
        answers: parseAnswers(row.clarification_answers_json),
      };
    });
    // A missing Change, or one that already compiled, needs no work.
    if (!loaded) return { skipped: true };
    if (!["created", "compiling"].includes(loaded.status)) {
      // A `proposed` or `declined` request was never admitted: nothing to release.
      if (["completed", "failed", "cancelled", "not_selected"].includes(loaded.status)) {
        await step.do("release closed request", () =>
          releaseRequestScope(this.env, loaded.ctx.projectId, changeId),
        );
      }
      return { skipped: true };
    }
    const { ctx } = loaded;

    const compiling = await step.do("mark compiling", async () => {
      await this.env.DB.prepare(
        "UPDATE changes SET status = 'compiling', updated_at = ? WHERE id = ? AND status = 'created'",
      )
        .bind(new Date().toISOString(), changeId)
        .run();
      const row = await this.env.DB.prepare("SELECT status FROM changes WHERE id = ?")
        .bind(changeId)
        .first<{ status: string }>();
      return row?.status ?? null;
    });
    // Cancelled before planning: no model call is spent on it.
    if (compiling !== "compiling") {
      await step.do("release cancelled request", () =>
        releaseRequestScope(this.env, ctx.projectId, changeId),
      );
      return { cancelled: true };
    }

    let answers = loaded.answers;
    // A new instance after an answer to a Change asked before this instance existed (resume).
    let skipAsk = answers.at(-1)?.action === "proceed_anyway";
    let admitted = false;
    let spent = 0;
    let planned: PlannerResult;
    let goal: string;
    let canonical: CanonicalSummary;
    let current: NonNullable<Awaited<ReturnType<typeof loadRequest>>>;
    const excluded = new Set<string>();
    for (let pass = 0; ; pass += 1) {
      const tag = pass === 0 ? "" : ` ${pass}`;
      const answered = answeredRounds(answers);
      const mayAsk = !skipAsk && answered < MAX_ROUNDS;
      goal = goalWithAnswers(loaded.goal, answers);
      canonical = await step.do(`read canonical summary${tag}`, () =>
        readCanonicalSummary(this.env, ctx.projectId),
      );

      if (mayAsk) {
        const remaining = loaded.budgetUsd - spent;
        const intake = await step.do(
          `intake review${tag}`,
          { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "5 minutes" },
          () => this.intake(ctx, goal, canonical, answered + 1, remaining),
        );
        spent += intake.costUsd;
        if (intake.decision === "ask" && intake.clarification) {
          const clarification = intake.clarification;
          const asked = await step.do(`ask for input${tag}`, () =>
            this.ask(changeId, clarification, answered + 1),
          );
          if (!asked) {
            await step.do(`release unasked request${tag}`, () =>
              releaseRequestScope(this.env, ctx.projectId, changeId),
            );
            return { cancelled: true };
          }
          const state = await this.waitForAnswer(step, changeId, `${tag} intake`);
          if (state.status !== "compiling") {
            await step.do(`release unanswered request${tag}`, () =>
              releaseRequestScope(this.env, ctx.projectId, changeId),
            );
            return { status: state.status };
          }
          answers = state.answers;
          skipAsk = answers.at(-1)?.action === "proceed_anyway";
          continue;
        }
      }

      if (!admitted) {
        await step.do("admit request", async () => {
          const requester = await loadRequest(this.env, changeId);
          return requestRoot(this.env, ctx.projectId).admit(
            changeId,
            requester
              ? {
                  requesterUserId: requester.requesterUserId,
                  requesterRank: requester.requesterRank,
                }
              : undefined,
          );
        });
        admitted = true;
      }

      let result: PlannerStepResult;
      try {
        result = await step.do(
          `plan work graph${tag}`,
          // One retry for transient model failures. Each attempt makes at most two model calls.
          { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "5 minutes" },
          async () => {
            // Resolve at planning time (and again on transient retries), not in cached load output.
            // Unknown source is not an empty repository and must not force a bootstrap Task.
            const files = await canonicalFiles(this.env, ctx.projectId).catch(() => null);
            return planChangeResult(
              { goal, projectName: loaded.projectName, files },
              (req) => this.complete(req, changeId),
              { allowOpus: opusAllowed(this.env.ALLOW_OPUS) },
            );
          },
        );
      } catch (error) {
        // Model failures reach here only after the Workflow's transient retry is exhausted.
        result = { ok: false, errors: [String(error).slice(0, 200)] };
      }
      if (!result.ok) {
        const errors = result.errors;
        const reason = `Planning failed: ${errors.join("; ")}`;
        const failed = await step.do("mark failed", async () => {
          await this.env.DB.prepare(
            `UPDATE changes SET status = 'failed', blocked_reason = ?, updated_at = ?
             WHERE id = ? AND status = 'compiling'`,
          )
            .bind(reason, new Date().toISOString(), changeId)
            .run();
          const row = await this.env.DB.prepare("SELECT status FROM changes WHERE id = ?")
            .bind(changeId)
            .first<{ status: string }>();
          return row?.status === "failed";
        });
        if (!failed) {
          await step.do("release cancelled planning request", () =>
            releaseRequestScope(this.env, ctx.projectId, changeId),
          );
          return { cancelled: true };
        }
        await step.do("record failed event", async () => {
          await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, [
            await changeEvent(ctx, "change.failed", {
              status: "failed",
              phase: "planning",
              reason,
              errors,
            }),
          ]);
        });
        await step.do("release failed request", () =>
          releaseRequestScope(this.env, ctx.projectId, changeId),
        );
        return { failed: true, reason: errors };
      }
      planned = result.planned;
      spent += planned.calls.reduce((sum, call) => sum + call.costUsd, 0);
      const resources = scopeResources(ctx, planned);
      const loadedRequest = await step.do(`load request scope${tag}`, () =>
        loadRequest(this.env, changeId, planned.criteria, resources),
      );
      if (loadedRequest?.status !== "compiling") {
        await step.do("release stopped request", () =>
          releaseRequestScope(this.env, ctx.projectId, changeId),
        );
        return { skipped: true };
      }
      current = { ...loadedRequest, goal };
      const registrant = current;
      const plannedNow = planned;
      const registration = await step.do(`check other requests${tag}`, async () => {
        await releaseClosedRequests(this.env, ctx.projectId);
        await this.env.EVIDENCE.put(
          `work-graphs/${ctx.projectId}/${changeId}.json`,
          JSON.stringify(plannedNow),
          { httpMetadata: { contentType: "application/json" } },
        );
        const registeredAt = new Date().toISOString();
        const scope = {
          changeId,
          requesterUserId: registrant.requesterUserId,
          requesterRank: registrant.requesterRank,
          criteria: plannedNow.criteria,
          resources,
          registeredAt,
        };
        const root = requestRoot(this.env, ctx.projectId);
        // The receipt is immutable: a later pass keeps its order and earlier set, new criteria.
        const receipt = await root.registerScope(scope);
        if (pass > 0) await root.updateScope(scope);
        await this.env.DB.prepare(
          "UPDATE changes SET scope_registered_at = COALESCE(scope_registered_at, ?) WHERE id = ?",
        )
          .bind(registeredAt, changeId)
          .run();
        return {
          order: receipt.order,
          earlier: receipt.earlier.map((scope) => ({
            changeId: scope.changeId,
            requesterUserId: scope.requesterUserId,
            criteria: scope.criteria,
            resources: scope.resources,
            scoped: scope.scoped,
          })),
        };
      });
      let reviews = 0;
      let askedInCompare = false;
      excluded.clear();
      // Diagnostic: which earlier requests this one compares with (ids only).
      console.warn(
        JSON.stringify({
          event: "request.compare_set",
          changeId,
          order: registration.order,
          earlier: registration.earlier.map((e) => e.changeId),
        }),
      );
      for (const earlier of registration.earlier) {
        let scope = await step.do(`read scope ${earlier.changeId}${tag}`, () =>
          readRequestScope(this.env, ctx.projectId, earlier.changeId),
        );
        for (let attempt = 0; scope && !scope.scoped && attempt < 10; attempt += 1) {
          await step.sleep(`wait for scope ${earlier.changeId} ${attempt}${tag}`, "15 seconds");
          scope = await step.do(`refresh scope ${earlier.changeId} ${attempt}${tag}`, () =>
            readRequestScope(this.env, ctx.projectId, earlier.changeId),
          );
        }
        if (!scope) {
          console.warn(
            JSON.stringify({
              event: "request.compare_skipped",
              changeId,
              earlier: earlier.changeId,
              why: "released",
            }),
          );
          continue;
        }
        const known = scope;
        const a = await step.do(`load request ${earlier.changeId}${tag}`, () =>
          loadRequest(this.env, earlier.changeId, known.criteria, known.resources),
        );
        if (!a || ["cancelled", "not_selected", "failed", "completed"].includes(a.status)) {
          console.warn(
            JSON.stringify({
              event: "request.compare_skipped",
              changeId,
              earlier: earlier.changeId,
              why: a ? a.status : "missing",
            }),
          );
          continue;
        }
        a.scoped = scope.scoped;
        const overlaps = requestsOverlap(a, registrant);
        const affordable = spent < loaded.budgetUsd;
        const pair = await step.do(
          `compare request ${earlier.changeId}${tag}`,
          { retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "4 minutes" },
          () =>
            checkRequestPair(
              this.env,
              ctx,
              a,
              registrant,
              (req) => this.complete(req, changeId),
              !overlaps || (reviews < 4 && affordable),
              { round: answered, mayAsk, canArbitrate: affordable, canonical },
            ),
        );
        if (overlaps) reviews += 1;
        spent += pair.costUsd;
        if (pair.stop === "not_selected") return { status: "not_selected" };
        if (pair.stop === "needs_input") {
          askedInCompare = true;
          break;
        }
        for (const id of pair.excluded) excluded.add(id);
      }
      if (askedInCompare) {
        const state = await this.waitForAnswer(step, changeId, `${tag} compare`);
        if (state.status !== "compiling") {
          await step.do(`release unanswered request${tag} compare`, () =>
            releaseRequestScope(this.env, ctx.projectId, changeId),
          );
          return { status: state.status };
        }
        answers = state.answers;
        skipAsk = answers.at(-1)?.action === "proceed_anyway";
        continue;
      }
      break;
    }
    if (excluded.size > 0) {
      const remaining = selectedCriteria(planned.criteria, [...excluded]);
      if (nothingSelected(remaining)) {
        await step.do("stop unselected request", async () => {
          // Keep what was asked for visible on the request, although nothing of it is built.
          await this.env.DB.prepare(
            `UPDATE changes SET title = ?, acceptance_criteria_json = ?, invariants_json = ?,
               risk_tier = ?
             WHERE id = ? AND status = 'compiling'`,
          )
            .bind(
              planned.plan.title || null,
              JSON.stringify(planned.plan.acceptanceCriteria),
              JSON.stringify(planned.plan.invariants),
              planned.plan.riskTier,
              changeId,
            )
            .run();
          const fields = await this.env.DB.prepare(
            "SELECT outcome_reason, outcome_winner_change_id, outcome_decided_by FROM changes WHERE id = ?",
          )
            .bind(changeId)
            .first<{
              outcome_reason: string;
              outcome_winner_change_id: string;
              outcome_decided_by: string;
            }>();
          await cancelChange(
            this.env,
            { changeId, actorUserId: fields?.outcome_decided_by ?? SYSTEM_ARBITER },
            {
              reason: fields?.outcome_reason ?? "Not selected: conflicts with an earlier request",
              winnerChangeId: fields?.outcome_winner_change_id ?? "",
              decidedBy: fields?.outcome_decided_by ?? SYSTEM_ARBITER,
            },
          );
        });
        return { status: "not_selected" };
      }
      const losing = planned.criteria.filter((criterion) => excluded.has(criterion.id));
      let replanned: PlannerStepResult;
      try {
        replanned = await step.do(
          "replan selected criteria",
          { retries: { limit: 0, delay: "1 second" }, timeout: "5 minutes" },
          async () => {
            const files = await canonicalFiles(this.env, ctx.projectId).catch(() => null);
            return planChangeResult(
              {
                goal,
                projectName: loaded.projectName,
                files,
                excludedCriteria: losing,
                selectedCriteria: remaining,
              },
              (req) => this.complete(req, changeId),
              { allowOpus: opusAllowed(this.env.ALLOW_OPUS) },
            );
          },
        );
      } catch {
        replanned = { ok: false, errors: ["Planning the selected criteria failed"] };
      }
      if (!replanned.ok) {
        await step.do("fail partial plan", async () => {
          await this.env.DB.prepare(
            "UPDATE changes SET status = 'failed', blocked_reason = ?, updated_at = ? WHERE id = ? AND status = 'compiling'",
          )
            .bind("Planning the selected criteria failed", new Date().toISOString(), changeId)
            .run();
          await releaseRequestScope(this.env, ctx.projectId, changeId);
          await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, [
            await changeEvent(ctx, "change.failed", {
              status: "failed",
              reason: "Planning the selected criteria failed",
            }),
          ]);
        });
        return { failed: true };
      }
      planned = replanned.planned;
      spent += planned.calls.reduce((sum, call) => sum + call.costUsd, 0);
      const replannedGraph = planned;
      await step.do("mark partially selected", async () => {
        await this.env.DB.prepare(
          "UPDATE changes SET outcome = 'partially_selected', outcome_reason = replace(outcome_reason, 'Not selected:', 'Partially selected:') WHERE id = ? AND status = 'compiling'",
        )
          .bind(changeId)
          .run();
        await requestRoot(this.env, ctx.projectId).updateScope({
          changeId,
          requesterUserId: current.requesterUserId,
          requesterRank: current.requesterRank,
          criteria: replannedGraph.criteria,
          resources: scopeResources(ctx, replannedGraph),
          registeredAt: new Date().toISOString(),
        });
        await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, [
          await changeEvent(
            ctx,
            "conflict.reviewed",
            { outcome: "partially_selected", excludedCriterionIds: [...excluded] },
            { key: "partial-selection" },
          ),
        ]);
      });
    }

    const workGraphRef = `work-graphs/${ctx.projectId}/${changeId}.json`;
    await step.do("persist work graph", async () => {
      await this.env.EVIDENCE.put(workGraphRef, JSON.stringify(planned), {
        httpMetadata: { contentType: "application/json" },
      });
      const now = new Date().toISOString();
      const { plan } = planned;
      // A cancel during `compiling` wins: the planned Tasks are kept as history, already
      // `cancelled`, so nothing dispatches them. Evaluated inside the batch transaction, so a cancel
      // either commits first (Tasks insert cancelled) or after (cancelChange cancels them).
      const taskStatus = `CASE WHEN EXISTS (SELECT 1 FROM changes WHERE id = ? AND status <> 'compiling')
        THEN 'cancelled' ELSE 'pending' END`;
      const statements = plan.tasks.flatMap((t) => {
        const id = taskIdFor(changeId, t.key);
        const resources = t.semanticResources.map((r) => qualify(ctx, r));
        return [
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO tasks (id, change_id, kind, semantic_resource, status, complexity,
               risk_tier, model_policy, task_key, title, objective, acceptance_criteria_json,
               semantic_resources_json, route_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ${taskStatus}, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            id,
            changeId,
            t.kind,
            resources[0] ?? null,
            changeId,
            t.complexity,
            t.riskTier,
            "policy-1",
            t.key,
            t.title,
            t.objective,
            JSON.stringify(t.acceptanceCriteria),
            JSON.stringify(resources),
            JSON.stringify({
              touchesAuthorization: t.touchesAuthorization,
              touchesBilling: t.touchesBilling,
              touchesMigration: t.touchesMigration,
            }),
            now,
            now,
          ),
          ...t.dependsOn.map((dep) =>
            this.env.DB.prepare(
              "INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
            ).bind(id, taskIdFor(changeId, dep)),
          ),
        ];
      });
      // One D1 batch is one transaction: Tasks, edges, and the Change status commit together.
      await this.env.DB.batch([
        ...statements,
        this.env.DB.prepare(
          `UPDATE changes SET status = 'running', title = ?, risk_tier = ?,
             acceptance_criteria_json = ?, invariants_json = ?, work_graph_ref = ?, updated_at = ?
           WHERE id = ? AND status = 'compiling'`,
        ).bind(
          // Blank when the planner gave no usable title: the API then derives one from the goal.
          plan.title || null,
          plan.riskTier,
          JSON.stringify(plan.acceptanceCriteria),
          JSON.stringify(plan.invariants),
          workGraphRef,
          now,
          changeId,
        ),
      ]);
    });

    const compiled = await step.do("record compiled events", async () => {
      // A Change cancelled while it compiled records no compile: its Tasks are already cancelled.
      const change = await this.env.DB.prepare("SELECT status FROM changes WHERE id = ?")
        .bind(changeId)
        .first<{ status: string }>();
      if (change?.status !== "running") return false;
      const { plan } = planned;
      const events = await Promise.all([
        changeEvent(ctx, "change.compiled", {
          taskCount: plan.tasks.length,
          riskTier: plan.riskTier,
          workGraphRef,
          planner: planned.calls.map((c) => ({
            provider: c.provider,
            model: c.model,
            costUsd: c.costUsd,
          })),
        }),
        ...plan.tasks.map((t) =>
          changeEvent(
            ctx,
            "task.created",
            {
              key: t.key,
              title: t.title,
              kind: t.kind,
              dependsOn: t.dependsOn.map((d) => taskIdFor(changeId, d)),
            },
            {
              taskId: taskIdFor(changeId, t.key),
              resource: qualify(ctx, t.semanticResources[0] ?? "general"),
            },
          ),
        ),
      ]);
      await appendChangeEvents(this.env.RESOURCE_SHARD, ctx, events);
      return true;
    });
    if (compiled === false) return { cancelled: true, tasks: planned.plan.tasks.length };

    const ready = await step.do("dispatch ready tasks", async () =>
      dispatchReadyTasks(this.env, ctx, Math.max(0, loaded.budgetUsd - spent)),
    );

    return {
      tasks: planned.plan.tasks.length,
      ready: ready.length,
      plannerAttempts: planned.attempts,
    };
  }
}
