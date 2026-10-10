import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ProjectRootDO } from "@rhumbatron/coordinator";
import { anthropicMonthlyBudgetUsd, meteredComplete, opusAllowed } from "@rhumbatron/model-router";
import { cancelChange, releaseRequestScope } from "./change-commands.ts";
import { readTreeFiles } from "./code-store.ts";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent, qualify } from "./events.ts";
import {
  checkRequestPair,
  loadRequest,
  readRequestScope,
  releaseClosedRequests,
  requestRoot,
} from "./request-check.ts";
import { requestsOverlap, selectedCriteria } from "./request-policy.ts";
import { type PlannerStepResult, planChangeResult } from "./root-planner.ts";

/**
 * ChangeWorkflow (AGENTS.md section 21.1), first slice: load the Change, compile the Work Graph,
 * persist Tasks, and dispatch the ready ones. Later phases add the wait, verification, approval,
 * promotion, and release steps. Every step is idempotent, because Workflows retries steps.
 */

export type ChangeWorkflowParams = { changeId: string };

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
};

type Loaded = {
  ctx: ChangeContext;
  goal: string;
  projectName: string;
  budgetUsd: number;
  status: string;
};

/** Resolve the current canonical tree, then read its code store or tree listing. */
async function canonicalFiles(env: Env, projectId: string): Promise<string[] | null> {
  const root = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  const canonical = await root.get(root.idFromName(projectId)).getCanonical();
  if (!canonical || canonical.artifactRef === "unassigned") return null;
  return readTreeFiles(env, projectId, canonical.treeSha);
}

const taskIdFor = (changeId: string, key: string) => `tsk_${changeId.slice(4)}_${key}`;

export class ChangeWorkflow extends WorkflowEntrypoint<Env, ChangeWorkflowParams> {
  private complete(req: import("@rhumbatron/model-router").CompletionRequest, changeId: string) {
    return meteredComplete(
      {
        db: this.env.DB,
        budgetUsd: anthropicMonthlyBudgetUsd(this.env.ANTHROPIC_MONTHLY_BUDGET_USD),
      },
      {
        accountId: this.env.AI_ACCOUNT_ID,
        gatewayId: this.env.AI_GATEWAY_ID,
        apiKey: this.env.ANTHROPIC_API_KEY,
        workspaceId: this.env.ANTHROPIC_WORKSPACE_ID,
        allowOpus: opusAllowed(this.env.ALLOW_OPUS),
      },
      { ...req, metadata: { ...req.metadata, changeId } },
    );
  }

  override async run(event: Readonly<WorkflowEvent<ChangeWorkflowParams>>, step: WorkflowStep) {
    const { changeId } = event.payload;

    const loaded = await step.do("load change", async (): Promise<Loaded | null> => {
      const row = await this.env.DB.prepare(
        `SELECT c.id, c.project_id, c.goal, c.status, c.base_generation, c.budget_usd,
                p.org_id, p.slug, p.name
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
      };
    });
    // A missing Change, or one that already compiled, needs no work.
    if (!loaded) return { skipped: true };
    if (!["created", "compiling"].includes(loaded.status)) {
      if (["completed", "failed", "cancelled", "not_selected"].includes(loaded.status)) {
        await step.do("release closed request", () =>
          releaseRequestScope(this.env, loaded.ctx.projectId, changeId),
        );
      }
      return { skipped: true };
    }
    const { ctx } = loaded;
    await step.do("admit request", async () => {
      const requester = await loadRequest(this.env, changeId);
      return requestRoot(this.env, ctx.projectId).admit(
        changeId,
        requester
          ? { requesterUserId: requester.requesterUserId, requesterRank: requester.requesterRank }
          : undefined,
      );
    });

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

    let result: PlannerStepResult;
    try {
      result = await step.do(
        "plan work graph",
        // One retry for transient model failures. Each attempt makes at most two model calls.
        { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "5 minutes" },
        async () => {
          // Resolve at planning time (and again on transient retries), not in cached load output.
          // Unknown source is not an empty repository and must not force a bootstrap Task.
          const files = await canonicalFiles(this.env, ctx.projectId).catch(() => null);
          return planChangeResult(
            { goal: loaded.goal, projectName: loaded.projectName, files },
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
    let { planned } = result;
    const initialSpend = planned.calls.reduce((sum, call) => sum + call.costUsd, 0);
    let reviewSpend = 0;
    let replanSpend = 0;
    const scopeResources = () => [
      ...new Set(
        planned.plan.tasks.flatMap((task) =>
          task.semanticResources.map((resource) => qualify(ctx, resource)),
        ),
      ),
    ];
    const current = await step.do("load request scope", () =>
      loadRequest(this.env, changeId, planned.criteria, scopeResources()),
    );
    if (current?.status !== "compiling") {
      await step.do("release stopped request", () =>
        releaseRequestScope(this.env, ctx.projectId, changeId),
      );
      return { skipped: true };
    }
    const registration = await step.do("check other requests", async () => {
      await releaseClosedRequests(this.env, ctx.projectId);
      await this.env.EVIDENCE.put(
        `work-graphs/${ctx.projectId}/${changeId}.json`,
        JSON.stringify(planned),
        { httpMetadata: { contentType: "application/json" } },
      );
      const registeredAt = new Date().toISOString();
      const receipt = await requestRoot(this.env, ctx.projectId).registerScope({
        changeId,
        requesterUserId: current.requesterUserId,
        requesterRank: current.requesterRank,
        criteria: planned.criteria,
        resources: scopeResources(),
        registeredAt,
      });
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
          requesterRank: scope.requesterRank,
          criteria: scope.criteria,
          resources: scope.resources,
          scoped: scope.scoped,
        })),
      };
    });
    const excluded = new Set<string>();
    let reviews = 0;
    for (const earlier of registration.earlier) {
      let scope = await step.do(`read scope ${earlier.changeId}`, () =>
        readRequestScope(this.env, ctx.projectId, earlier.changeId),
      );
      for (let attempt = 0; scope && !scope.scoped && attempt < 10; attempt += 1) {
        await step.sleep(`wait for scope ${earlier.changeId} ${attempt}`, "15 seconds");
        scope = await step.do(`refresh scope ${earlier.changeId} ${attempt}`, () =>
          readRequestScope(this.env, ctx.projectId, earlier.changeId),
        );
      }
      if (!scope) continue;
      const a = await step.do(`load request ${earlier.changeId}`, () =>
        loadRequest(this.env, earlier.changeId, scope.criteria, scope.resources),
      );
      if (!a || ["cancelled", "not_selected", "failed", "completed"].includes(a.status)) continue;
      a.scoped = scope.scoped;
      const overlaps = requestsOverlap(a, current);
      const pair = await step.do(
        `compare request ${earlier.changeId}`,
        { retries: { limit: 1, delay: "15 seconds", backoff: "constant" }, timeout: "3 minutes" },
        () =>
          checkRequestPair(
            this.env,
            ctx,
            a,
            current,
            (req) => this.complete(req, changeId),
            !overlaps || (reviews < 4 && initialSpend + reviewSpend < loaded.budgetUsd),
          ),
      );
      if (overlaps) reviews += 1;
      reviewSpend += pair.costUsd;
      if (pair.stop) return { status: pair.stop };
      for (const id of pair.excluded) excluded.add(id);
    }
    if (excluded.size > 0) {
      const remaining = selectedCriteria(planned.criteria, [...excluded]);
      if (remaining.length === 0) {
        await step.do("stop unselected request", async () => {
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
            { changeId, actorUserId: fields?.outcome_decided_by ?? "policy:priority_wins" },
            {
              reason: fields?.outcome_reason ?? "Not selected: conflicts with an earlier request",
              winnerChangeId: fields?.outcome_winner_change_id ?? "",
              decidedBy: fields?.outcome_decided_by ?? "policy:priority_wins",
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
                goal: loaded.goal,
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
      replanSpend = planned.calls.reduce((sum, call) => sum + call.costUsd, 0);
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
          criteria: planned.criteria,
          resources: scopeResources(),
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
          `UPDATE changes SET status = 'running', risk_tier = ?, acceptance_criteria_json = ?,
             invariants_json = ?, work_graph_ref = ?, updated_at = ?
           WHERE id = ? AND status = 'compiling'`,
        ).bind(
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

    const spent = initialSpend + reviewSpend + replanSpend;
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
