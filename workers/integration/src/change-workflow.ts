import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { complete } from "@rhumbatron/model-router";
import { dispatchReadyTasks } from "./dispatch.ts";
import { appendChangeEvents, type ChangeContext, changeEvent, qualify } from "./events.ts";
import { PlannerError, type PlannerResult, planChange } from "./root-planner.ts";

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

const taskIdFor = (changeId: string, key: string) => `tsk_${changeId.slice(4)}_${key}`;

export class ChangeWorkflow extends WorkflowEntrypoint<Env, ChangeWorkflowParams> {
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
    if (!loaded || !["created", "compiling"].includes(loaded.status)) return { skipped: true };
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
    if (compiling === "cancelled") return { cancelled: true };

    let planned: PlannerResult;
    try {
      planned = await step.do(
        "plan work graph",
        // One retry for transient model failures. Each attempt makes at most two model calls.
        { retries: { limit: 1, delay: "30 seconds", backoff: "constant" }, timeout: "5 minutes" },
        async () =>
          planChange({ goal: loaded.goal, projectName: loaded.projectName }, (req) =>
            complete(
              {
                accountId: this.env.AI_ACCOUNT_ID,
                gatewayId: this.env.AI_GATEWAY_ID,
                apiKey: this.env.OPENROUTER_API_KEY,
                ...(this.env.VERTEX_SERVICE_ACCOUNT
                  ? { vertexServiceAccount: this.env.VERTEX_SERVICE_ACCOUNT }
                  : {}),
                preferVertex: this.env.MODEL_PROVIDER === "vertex",
              },
              { ...req, metadata: { ...req.metadata, changeId } },
            ),
          ),
      );
    } catch (error) {
      await step.do("mark failed", async () => {
        await this.env.DB.prepare(
          "UPDATE changes SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'compiling'",
        )
          .bind(new Date().toISOString(), changeId)
          .run();
      });
      const reason =
        error instanceof PlannerError
          ? error.lastErrors.slice(0, 3)
          : [String(error).slice(0, 200)];
      return { failed: true, reason };
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
      const taskStatus = `CASE WHEN EXISTS (SELECT 1 FROM changes WHERE id = ? AND status = 'cancelled')
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
      if (change?.status === "cancelled") return false;
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

    const spent = planned.calls.reduce((sum, c) => sum + c.costUsd, 0);
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
