import type { ProjectRootDO } from "@rhumbatron/coordinator";
import type { CompletionRequest, CompletionResult } from "@rhumbatron/model-router";
import type { ChangeClarification } from "@rhumbatron/protocol";
import { cancelChange, releaseRequestScope } from "./change-commands.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { type CanonicalSummary, UNKNOWN_CANONICAL } from "./intake-context.ts";
import {
  type Arbitration,
  arbitrateRequests,
  type Criterion,
  losingCriterionIds,
  type RequestInput,
  type RequestReview,
  reviewRequests,
  unconfirmedReview,
} from "./request-policy.ts";

/** Who decides a conflict when the system arbiter chose a request. */
export const SYSTEM_ARBITER = "system:arbiter";
/** The same requester asked twice: the later request replaces the earlier one. */
export const SAME_REQUESTER = "system:same_requester";

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
  requester_name: string | null;
};
export async function loadRequest(
  env: Env,
  changeId: string,
  criteria: Criterion[] = [],
  resources: string[] = [],
): Promise<
  | (RequestInput & {
      status: string;
      outcome: string | null;
      /** Attribution snapshot for ProjectRootDO scope rows. No decision reads it. */
      requesterRank: number;
    })
  | null
> {
  const row = await env.DB.prepare(
    `SELECT c.id, c.goal, c.status, c.created_by, c.requester_rank, c.outcome,
        u.display_name AS requester_name FROM changes c LEFT JOIN users u ON u.id = c.created_by WHERE c.id = ?`,
  )
    .bind(changeId)
    .first<Row>();
  if (!row) return null;
  return {
    changeId,
    goal: row.goal,
    requesterUserId: row.created_by,
    requesterRank: row.requester_rank ?? 10,
    requesterName: row.requester_name ?? null,
    criteria,
    resources,
    scoped: criteria.length > 0,
    status: row.status,
    outcome: row.outcome,
  };
}

export type PairOutcome = {
  costUsd: number;
  excluded: string[];
  stop: "needs_input" | "not_selected" | null;
};

export type PairOptions = {
  /** Answered clarification rounds of the later Change: a new round compares the pair again. */
  round?: number;
  /** False after the third answer or a "plan anyway": no question, the Change goes on. */
  mayAsk?: boolean;
  /** False when the review limit or the budget is reached: no arbiter call. */
  canArbitrate?: boolean;
  canonical?: CanonicalSummary;
};

type Stored = {
  review: RequestReview;
  receipt: Record<string, unknown>;
  costUsd: number;
  arbiter?: Arbitration;
};

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** Pair row ID: one row per sorted pair and clarification round of the later Change. */
export const pairId = (first: string, second: string, round = 0) =>
  `rc_${first}_${second}${round > 0 ? `_r${round}` : ""}`;

/**
 * Compare the earlier request `a` with the later request `b` (the Change that runs this check).
 * Persist the review first; retries use it and never call a model again for the same pair round.
 *
 * - `independent` or `compatible`: both go on.
 * - `duplicate` (cited and quoted): `b` waits for its requester (`needs_input`, kind `duplicate`).
 * - `conflicting`, unsupported or past the review limit: `b` waits (kind `conflict`).
 * - `conflicting`, supported: the same requester's later request replaces the earlier one;
 *   otherwise the system arbiter runs twice with the order swapped. Agreement applies the choice;
 *   anything else makes `b` wait (kind `conflict`). Who asked never decides.
 */
export async function checkRequestPair(
  env: Env,
  ctx: ChangeContext,
  a: RequestInput,
  b: RequestInput,
  complete: (request: CompletionRequest) => Promise<CompletionResult>,
  canReview = true,
  options: PairOptions = {},
): Promise<PairOutcome> {
  const round = options.round ?? 0;
  const mayAsk = options.mayAsk ?? true;
  const [first, second] = [a.changeId, b.changeId].sort() as [string, string];
  const id = pairId(first, second, round);
  const read = () =>
    env.DB.prepare("SELECT review_json FROM request_conflicts WHERE id = ?")
      .bind(id)
      .first<{ review_json: string }>();
  let previous = await read();
  // Claim the pair before external I/O. If execution stops after a provider call, a retry
  // uses this conservative receipt rather than spending on a second call.
  if (!previous) {
    const pending = JSON.stringify({
      review: unconfirmedReview(),
      receipt: { method: "review-interrupted", reason: "review could not confirm compatibility" },
      costUsd: 0,
    });
    const reserved = await env.DB.prepare(`INSERT OR IGNORE INTO request_conflicts
      (id, project_id, change_a, change_b, round, verdict, criteria_json, review_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'conflicting', '[]', ?, ?)`)
      .bind(id, ctx.projectId, first, second, round, pending, new Date().toISOString())
      .run();
    if (!reserved.meta.changes) previous = await read();
  }
  let stored: Stored;
  if (previous) {
    stored = JSON.parse(previous.review_json) as Stored;
  } else if (!canReview) {
    const review = unconfirmedReview();
    stored = { review, receipt: { method: "review-limit", reason: review.reason }, costUsd: 0 };
  } else {
    stored = await reviewRequests(a, b, complete);
  }
  const { review } = stored;
  const inputs = {
    a: { changeId: a.changeId, goal: a.goal, criteria: a.criteria },
    b: { changeId: b.changeId, goal: b.goal, criteria: b.criteria },
  };
  const save = (value: Stored & { excluded?: unknown }) =>
    env.DB.prepare(
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
        JSON.stringify({ ...value, inputs }),
        id,
      )
      .run();
  if (!previous) await save(stored);
  let costUsd = previous ? 0 : stored.costUsd;

  // Arbitration for a supported conflict between different requesters. Reserved first, like the
  // review, so a retry after a provider call reuses the conservative `ask`.
  const conflicting = review.verdict === "conflicting" && review.supported;
  const sameRequester = a.requesterUserId === b.requesterUserId;
  if (conflicting && !sameRequester && !stored.arbiter) {
    const interrupted: Arbitration = {
      decision: "ask",
      rationale: null,
      costUsd: 0,
      receipt: { decisionType: "REQUEST_ARBITER", method: "arbiter-interrupted", decision: "ask" },
    };
    await save({ ...stored, arbiter: interrupted });
    stored.arbiter =
      options.canArbitrate === false
        ? {
            ...interrupted,
            receipt: { decisionType: "REQUEST_ARBITER", method: "review-limit", decision: "ask" },
          }
        : await arbitrateRequests(
            a,
            b,
            review.conflicts,
            options.canonical ?? UNKNOWN_CANONICAL,
            complete,
          );
    costUsd += stored.arbiter.costUsd;
    await save(stored);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO change_decisions
         (id, change_id, decision_type, round, verdict, decided_by, receipt_json, created_at)
       VALUES (?, ?, 'REQUEST_ARBITER', ?, ?, ?, ?, ?)`,
    )
      .bind(
        `dec_${id}`,
        b.changeId,
        round,
        stored.arbiter.decision,
        SYSTEM_ARBITER,
        JSON.stringify({ ...stored.arbiter.receipt, conflictId: id }),
        new Date().toISOString(),
      )
      .run();
  }

  const selection: { winner: string; loser: string; decidedBy: string } | null = !conflicting
    ? null
    : sameRequester
      ? { winner: b.changeId, loser: a.changeId, decidedBy: SAME_REQUESTER }
      : stored.arbiter?.decision === "prefer_a"
        ? { winner: a.changeId, loser: b.changeId, decidedBy: SYSTEM_ARBITER }
        : stored.arbiter?.decision === "prefer_b"
          ? { winner: b.changeId, loser: a.changeId, decidedBy: SYSTEM_ARBITER }
          : null;
  // The losing side keeps nothing that presupposes a conflicting criterion (cited, dependent, or
  // naming the losing layout). Recomputed from the stored review on retry: it is deterministic.
  const lost = selection
    ? {
        changeId: selection.loser,
        criterionIds:
          selection.loser === b.changeId
            ? losingCriterionIds(review, "b", b.criteria, a.criteria)
            : losingCriterionIds(review, "a", a.criteria, b.criteria),
      }
    : null;
  if (lost) await save({ ...stored, excluded: lost });

  const outcome: PairOutcome = { costUsd, excluded: [], stop: null };
  const question =
    review.verdict === "duplicate"
      ? duplicateClarification(review, a)
      : conflictClarification(review, a, b);
  if (question && !selection) {
    if (mayAsk) {
      outcome.stop = "needs_input";
      const clarification: ChangeClarification = {
        ...question,
        askedAt: new Date().toISOString(),
        round: Math.min(3, round + 1),
      };
      await env.DB.prepare(
        "UPDATE changes SET status = 'needs_input', clarification_json = ?, updated_at = ? WHERE id = ? AND status = 'compiling'",
      )
        .bind(JSON.stringify(clarification), new Date().toISOString(), b.changeId)
        .run();
    }
    await env.DB.prepare(
      "UPDATE request_conflicts SET policy = 'ask_requester', decided_by = ?, decided_at = ? WHERE id = ?",
    )
      .bind(SYSTEM_ARBITER, new Date().toISOString(), id)
      .run();
  } else if (selection) {
    const winner = selection.winner === a.changeId ? a : b;
    const loser = selection.loser === a.changeId ? a : b;
    const { decidedBy } = selection;
    await env.DB.prepare(
      `UPDATE request_conflicts SET policy = ?, winner_change_id = ?, loser_change_id = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
    )
      .bind(
        decidedBy === SAME_REQUESTER ? "same_requester" : "system_arbiter",
        winner.changeId,
        loser.changeId,
        decidedBy,
        new Date().toISOString(),
        id,
      )
      .run();
    const why =
      decidedBy === SAME_REQUESTER
        ? "which replaces the earlier request"
        : `which the system chose: ${clip(stored.arbiter?.rationale ?? "it fits the current app", 200)}`;
    const reason = `Not selected: it conflicts with ${winner.requesterName ?? winner.requesterUserId}'s request "${winner.goal.slice(0, 60)}", ${why}`;
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
            policy: decidedBy === SAME_REQUESTER ? "same_requester" : "system_arbiter",
            decidedBy,
            status: winnerState.status,
            outcome: winnerState.outcome,
          },
          { key: id },
        ),
      ]);
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
        decisionReceipt: stored.receipt,
        arbiter: stored.arbiter?.receipt ?? null,
        status: outcome.stop ?? "compiling",
        excludedCriterionIds: outcome.excluded,
      },
      { key: id },
    ),
  ]);
  return outcome;
}

type Question = Omit<ChangeClarification, "askedAt" | "round">;

/** A cited duplicate: ask what is different, quoting the earlier request's criteria. */
function duplicateClarification(review: RequestReview, a: RequestInput): Question | null {
  if (!review.supported) return null;
  const quotes = [...new Set((review.covered ?? []).map((c) => clip(c.quote.trim(), 160)))].slice(
    0,
    3,
  );
  return {
    kind: "duplicate",
    summary: `This request asks for what "${clip(a.goal, 120)}" already plans to build.`,
    questions: [
      {
        id: "q1",
        text: `This looks covered by "${clip(a.goal, 120)}"${quotes.length ? `: ${quotes.map((q) => `"${q}"`).join("; ")}` : ""}. What is different in your request?`,
      },
    ],
    relatedChangeId: a.changeId,
    relatedGoal: a.goal,
  };
}

/** A conflict the system did not decide: explain it and ask how the later request should change. */
function conflictClarification(
  review: RequestReview,
  a: RequestInput,
  b: RequestInput,
): Question | null {
  if (review.verdict !== "conflicting") return null;
  const text = (list: readonly Criterion[], cid: string) =>
    list.find((c) => c.id === cid)?.text ?? cid;
  const pairs = review.conflicts
    .slice(0, 2)
    .map(
      (c) => `"${clip(text(b.criteria, c.b), 120)}" versus "${clip(text(a.criteria, c.a), 120)}"`,
    );
  return {
    kind: "conflict",
    summary: review.supported
      ? `This request conflicts with "${clip(a.goal, 120)}" and the system could not choose one.`
      : `This request may conflict with "${clip(a.goal, 120)}". The check could not confirm that both can be built.`,
    questions: [
      {
        id: "q1",
        text: `Your request conflicts with "${clip(a.goal, 120)}"${pairs.length ? `: ${pairs.join("; ")}` : ""}. How should your request change so both fit?`,
      },
    ],
    relatedChangeId: a.changeId,
    relatedGoal: a.goal,
  };
}
