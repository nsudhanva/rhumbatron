import type { ProjectRootDO } from "@rhumbatron/coordinator";
import type { CompletionRequest, CompletionResult } from "@rhumbatron/model-router";
import { cancelChange, releaseRequestScope } from "./change-commands.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import {
  type Criterion,
  losingCriterionIds,
  priorityWins,
  type RequestInput,
  type RequestReview,
  reviewRequests,
  unconfirmedReview,
} from "./request-policy.ts";

export const requestRoot = (env: Pick<Env, "PROJECT_ROOT">, projectId: string) => {
  const roots = env.PROJECT_ROOT as DurableObjectNamespace<ProjectRootDO>;
  return roots.get(roots.idFromName(projectId));
};

/** Convert the RPC result to plain Workflow step data (RPC handles are disposable). */
export async function readRequestScope(
  env: Env,
  projectId: string,
  changeId: string,
): Promise<Omit<RequestInput, "goal"> | null> {
  const scope = await requestRoot(env, projectId).getScope(changeId);
  return scope
    ? {
        changeId: scope.changeId,
        requesterUserId: scope.requesterUserId,
        requesterRank: scope.requesterRank,
        criteria: scope.criteria,
        resources: scope.resources,
        scoped: scope.scoped,
      }
    : null;
}

/** A terminal Change may have ended in an agent Worker; reconcile before registration. */
export async function releaseClosedRequests(env: Env, projectId: string) {
  const rows = await env.DB.prepare(
    "SELECT id FROM changes WHERE project_id = ? AND scope_registered_at IS NOT NULL AND status IN ('completed', 'failed', 'cancelled', 'not_selected')",
  )
    .bind(projectId)
    .all<{ id: string }>();
  for (const row of rows.results) await releaseRequestScope(env, projectId, row.id);
}

type Row = {
  id: string;
  goal: string;
  status: string;
  created_by: string;
  requester_rank: number | null;
  outcome: string | null;
  supersedes_change_id: string | null;
  requester_name: string | null;
};
export async function loadRequest(
  env: Env,
  changeId: string,
  criteria: Criterion[] = [],
  resources: string[] = [],
): Promise<
  | (RequestInput & { status: string; outcome: string | null; supersedesChangeId: string | null })
  | null
> {
  const row = await env.DB.prepare(
    `SELECT c.id, c.goal, c.status, c.created_by, c.requester_rank, c.outcome, c.supersedes_change_id,
        u.display_name AS requester_name FROM changes c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?`,
  )
    .bind(changeId)
    .first<Row>();
  if (!row) return null;
  return {
    changeId,
    goal: row.goal,
    requesterUserId: row.created_by,
    requesterRank: row.requester_rank ?? 0,
    requesterName: row.requester_name ?? null,
    criteria,
    resources,
    scoped: criteria.length > 0,
    status: row.status,
    outcome: row.outcome,
    supersedesChangeId: row.supersedes_change_id,
  };
}

export type PairOutcome = {
  costUsd: number;
  excluded: string[];
  stop: "awaiting_owner" | "not_selected" | null;
};

/** Persist review first; retries use it and never call the reviewer again for the same pair. */
export async function checkRequestPair(
  env: Env,
  ctx: ChangeContext,
  a: RequestInput,
  b: RequestInput & { supersedesChangeId?: string | null },
  complete: (request: CompletionRequest) => Promise<CompletionResult>,
  canReview = true,
): Promise<PairOutcome> {
  const [first, second] = [a.changeId, b.changeId].sort();
  const id = `rc_${first}_${second}`;
  let previous = await env.DB.prepare(
    "SELECT review_json FROM request_conflicts WHERE change_a = ? AND change_b = ?",
  )
    .bind(first, second)
    .first<{ review_json: string }>();
  // Claim the pair before external I/O. If execution stops after a provider call, a retry
  // uses this conservative receipt rather than spending on a second call.
  if (!previous) {
    const pending = JSON.stringify({
      review: unconfirmedReview(),
      receipt: { method: "review-interrupted", reason: "review could not confirm compatibility" },
      costUsd: 0,
    });
    const reserved = await env.DB.prepare(`INSERT OR IGNORE INTO request_conflicts
      (id, project_id, change_a, change_b, verdict, criteria_json, review_json, created_at)
      VALUES (?, ?, ?, ?, 'conflicting', '[]', ?, ?)`)
      .bind(id, ctx.projectId, first, second, pending, new Date().toISOString())
      .run();
    if (!reserved.meta.changes)
      previous = await env.DB.prepare(
        "SELECT review_json FROM request_conflicts WHERE change_a = ? AND change_b = ?",
      )
        .bind(first, second)
        .first<{ review_json: string }>();
  }
  const ownerChoice = b.supersedesChangeId
    ? await env.DB.prepare(`SELECT decided_by FROM request_conflicts
    WHERE (change_a = ? OR change_b = ?) AND (winner_change_id = ? OR (winner_change_id IS NULL AND (change_a = ? OR change_b = ?))) AND verdict = 'conflicting'`)
        .bind(b.supersedesChangeId, b.supersedesChangeId, a.changeId, a.changeId, a.changeId)
        .first<{ decided_by: string }>()
    : null;
  let review: RequestReview;
  let receipt: Record<string, unknown>;
  let costUsd = 0;
  if (previous) {
    const stored = JSON.parse(previous.review_json) as {
      review: RequestReview;
      receipt: Record<string, unknown>;
      costUsd: number;
    };
    ({ review, receipt, costUsd } = stored);
  } else if (ownerChoice) {
    review = { verdict: "conflicting", conflicts: [], supported: true };
    receipt = { method: "owner-override", supersedesChangeId: b.supersedesChangeId };
  } else if (!canReview) {
    review = unconfirmedReview();
    receipt = { method: "review-limit", reason: review.reason };
  } else {
    ({ review, receipt, costUsd } = await reviewRequests(a, b, complete));
  }
  const selection = ownerChoice ? { winner: b.changeId, loser: a.changeId } : priorityWins(a, b);
  // The losing side keeps nothing that presupposes a conflicting criterion (cited, dependent, or
  // naming the losing layout). Recomputed from the stored review on retry: it is deterministic.
  const lost =
    "winner" in selection
      ? {
          changeId: selection.loser,
          criterionIds:
            selection.loser === b.changeId
              ? losingCriterionIds(review, "b", b.criteria, a.criteria)
              : losingCriterionIds(review, "a", a.criteria, b.criteria),
        }
      : null;
  if (!previous)
    await env.DB.prepare(
      `UPDATE request_conflicts SET verdict = ?, criteria_json = ?, review_json = ? WHERE id = ?`,
    )
      .bind(
        review.verdict,
        JSON.stringify(
          a.changeId === first
            ? review.conflicts
            : review.conflicts.map((conflict) => ({
                a: conflict.b,
                b: conflict.a,
                why: conflict.why,
              })),
        ),
        JSON.stringify({
          review,
          receipt,
          costUsd,
          excluded: lost,
          inputs: {
            a: { changeId: a.changeId, goal: a.goal, criteria: a.criteria },
            b: { changeId: b.changeId, goal: b.goal, criteria: b.criteria },
          },
        }),
        id,
      )
      .run();
  const outcome: PairOutcome = { costUsd, excluded: [], stop: null };
  if (review.verdict === "conflicting") {
    if (!review.supported || "awaitingOwner" in selection) {
      outcome.stop = "awaiting_owner";
      await env.DB.prepare(
        "UPDATE changes SET status = 'awaiting_owner', outcome_reason = ?, updated_at = ? WHERE id = ? AND status = 'compiling'",
      )
        .bind(
          review.reason ?? "The requests have equal priority. The owner must choose.",
          new Date().toISOString(),
          b.changeId,
        )
        .run();
      await env.DB.prepare("UPDATE request_conflicts SET policy = 'priority_wins' WHERE id = ?")
        .bind(id)
        .run();
    } else {
      const winner = selection.winner === a.changeId ? a : b;
      const loser = selection.loser === a.changeId ? a : b;
      const decidedBy = ownerChoice
        ? ((
            await env.DB.prepare("SELECT outcome_decided_by FROM changes WHERE id = ?")
              .bind(b.changeId)
              .first<{ outcome_decided_by: string }>()
          )?.outcome_decided_by ?? "policy:priority_wins")
        : "policy:priority_wins";
      await env.DB.prepare(
        `UPDATE request_conflicts SET policy = 'priority_wins', winner_change_id = ?, loser_change_id = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
      )
        .bind(winner.changeId, loser.changeId, decidedBy, new Date().toISOString(), id)
        .run();
      const reason = ownerChoice
        ? "Replaced by the owner's choice"
        : `Not selected: it conflicts with ${winner.requesterName ?? winner.requesterUserId}'s request "${winner.goal.slice(0, 60)}", which ${winner.requesterUserId === loser.requesterUserId ? "supersedes the earlier request" : `has higher priority (${winner.requesterRank === 0 ? "owner" : "requester"})`}.`;
      const promoted = await env.DB.prepare(
        "SELECT id FROM candidates WHERE change_id = ? AND status = 'promoted' LIMIT 1",
      )
        .bind(loser.changeId)
        .first<{ id: string }>();
      if (loser.changeId === b.changeId) {
        outcome.excluded = lost?.criterionIds ?? [];
        await env.DB.prepare(
          `UPDATE changes SET outcome = 'not_selected', outcome_reason = ?, outcome_winner_change_id = ?, outcome_decided_by = ?, updated_at = ? WHERE id = ? AND status = 'compiling'`,
        )
          .bind(reason, winner.changeId, decidedBy, new Date().toISOString(), loser.changeId)
          .run();
      } else if (!promoted) {
        const stopped = await cancelChange(
          env,
          { changeId: loser.changeId, actorUserId: decidedBy },
          { reason, winnerChangeId: winner.changeId, decidedBy },
        );
        if (stopped.status === "refused") {
          // Promotion has started and can already be committed in Root. Never undo it.
          await env.DB.prepare(
            "UPDATE changes SET outcome = 'replaces' WHERE id = ? AND status = 'compiling'",
          )
            .bind(b.changeId)
            .run();
        }
      }
      await env.DB.prepare(
        `UPDATE changes SET outcome = CASE WHEN ? THEN 'replaces' WHEN outcome IN ('partially_selected', 'replaces') THEN outcome ELSE 'selected' END, updated_at = ? WHERE id = ? AND (outcome IS NULL OR outcome IN ('selected', 'replaces', 'partially_selected'))`,
      )
        .bind(promoted ? 1 : 0, new Date().toISOString(), winner.changeId)
        .run();
      const winnerState = await env.DB.prepare(
        "SELECT base_generation, status, outcome FROM changes WHERE id = ?",
      )
        .bind(winner.changeId)
        .first<{ base_generation: number; status: string; outcome: string | null }>();
      if (winnerState && winner.changeId !== ctx.changeId) {
        const winnerCtx = {
          ...ctx,
          changeId: winner.changeId,
          baseGeneration: winnerState.base_generation,
        };
        await appendChangeEvents(env.RESOURCE_SHARD, winnerCtx, [
          await changeEvent(
            winnerCtx,
            "conflict.reviewed",
            {
              conflictId: id,
              winnerChangeId: winner.changeId,
              loserChangeId: loser.changeId,
              policy: "priority_wins",
              decidedBy,
              status: winnerState.status,
              outcome: winnerState.outcome,
            },
            { key: id },
          ),
        ]);
      }
    }
  }
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "conflict.reviewed",
      {
        conflictId: id,
        otherChangeId: a.changeId,
        verdict: review.verdict,
        criteria: review.conflicts,
        decisionReceipt: receipt,
        status: outcome.stop ?? "compiling",
        excludedCriterionIds: outcome.excluded,
      },
      { key: id },
    ),
  ]);
  return outcome;
}
