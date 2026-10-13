import type { ProjectRootDO } from "@rhumbatron/coordinator";
import type { CompletionRequest, CompletionResult } from "@rhumbatron/model-router";
import { type ChangeClarification, conflictPolicy } from "@rhumbatron/protocol";
import { cancelChange, releaseRequestScope } from "./change-commands.ts";
import { appendChangeEvents, type ChangeContext, changeEvent } from "./events.ts";
import { askFirstRequester, storedChoice } from "./first-come.ts";
import {
  type Criterion,
  type RequestInput,
  type RequestReview,
  reviewRequests,
  unconfirmedReview,
} from "./request-policy.ts";

/** The same requester asked twice: the later request replaces the earlier one. */
const SAME_REQUESTER = "system:same_requester";
/** A question to the later requester (unconfirmed review, or a cited duplicate). */
const SYSTEM_REVIEW = "system:request_review";
/** The system's choice for a later request that builds on an earlier one. */
const FOLLOW = "system:builds_on";

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
  /**
   * `needs_input`: the later requester gets a question. `awaiting_choice`: the earlier requester
   * chooses (ADR 0032). `not_selected`: the later request ended (the earlier requester kept theirs).
   */
  stop: "needs_input" | "awaiting_choice" | "not_selected" | null;
};

export type PairOptions = {
  /** Answered clarification rounds of the later Change: a new round compares the pair again. */
  round?: number;
  /** False after the third answer or a "plan anyway": no question, the Change goes on. */
  mayAsk?: boolean;
  /** Plans of the later Change after a first-come wait: a new plan compares the pair again. */
  sequence?: number;
  /** The waiting workflow instance of the later Change, woken by a choice. */
  instanceId?: string;
};

type Stored = {
  review: RequestReview;
  receipt: Record<string, unknown>;
  costUsd: number;
};

const clip = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

/** Pair row ID: one row per sorted pair, clarification round, and plan of the later Change. */
const pairId = (first: string, second: string, round = 0, sequence = 0) =>
  `rc_${first}_${second}${round > 0 ? `_r${round}` : ""}${sequence > 0 ? `_q${sequence}` : ""}`;

/**
 * Compare the earlier request `a` with the later request `b` (the Change that runs this check).
 * Persist the review first; retries use it and never call a model again for the same pair round.
 *
 * - `independent` or `compatible`: both go on.
 * - `builds_on` (cited): `b` uses or changes what `a` creates. Nobody chooses: the system records
 *   `apply_theirs`, `b` waits (`queued`) and plans after `a` promoted or ended, on the tree that
 *   has the work of `a`. No duplicate build of the same feature runs in parallel.
 * - `duplicate` (cited and quoted): `b` waits for its requester (`needs_input`, kind `duplicate`).
 * - `conflicting`, unsupported or past the review limit: `b` waits (kind `conflict`).
 * - `conflicting`, supported, same requester: the later request replaces the earlier one.
 * - `conflicting`, supported, different requesters: first come (ADR 0032). `a` keeps working; `b`
 *   waits (`awaiting_choice`) until the requester of `a` chooses. A stored `apply_theirs` lets `b`
 *   go on: it plans only after `a` promoted or ended.
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
  // The earlier requester already chose to apply this request after theirs (or the question is
  // moot): it follows the earlier request and plans after it, so no review runs again.
  const decided = await storedChoice(env, a.changeId, b.changeId);
  if (decided === "apply_theirs" || decided === "moot") return { costUsd: 0, stop: null };
  const round = options.round ?? 0;
  const mayAsk = options.mayAsk ?? true;
  const [first, second] = [a.changeId, b.changeId].sort() as [string, string];
  const id = pairId(first, second, round, options.sequence ?? 0);
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
  const costUsd = previous ? 0 : stored.costUsd;

  const policy = conflictPolicy({
    verdict: review.verdict,
    supported: review.supported,
    earlierRequesterUserId: a.requesterUserId,
    laterRequesterUserId: b.requesterUserId,
  });
  const outcome: PairOutcome = { costUsd, stop: null };
  const now = () => new Date().toISOString();

  if (policy === "follow") {
    await followEarlier(env, ctx, id, a, b, options.instanceId ?? b.changeId);
    outcome.stop = "awaiting_choice";
  } else if (policy === "first_come") {
    // Who asked first decides, and only about their own request. No model and no role decides.
    const choice =
      decided === undefined
        ? await askFirstRequester(env, ctx, {
            firstChangeId: a.changeId,
            firstRequesterUserId: a.requesterUserId,
            laterChangeId: b.changeId,
            conflictId: id,
            workflowInstanceId: options.instanceId ?? b.changeId,
          })
        : decided;
    outcome.stop =
      choice === null
        ? "awaiting_choice"
        : choice === "keep_mine" || choice === "expired"
          ? "not_selected"
          : null;
    await env.DB.prepare(
      "UPDATE request_conflicts SET policy = 'first_come', winner_change_id = ?, loser_change_id = ?, decided_by = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?",
    )
      .bind(
        outcome.stop === null ? b.changeId : a.changeId,
        outcome.stop === null ? a.changeId : b.changeId,
        a.requesterUserId,
        now(),
        id,
      )
      .run();
  } else if (policy === "duplicate" || policy === "ask_requester") {
    const question =
      policy === "duplicate"
        ? duplicateClarification(review, a)
        : conflictClarification(review, a, b);
    if (question && mayAsk) {
      outcome.stop = "needs_input";
      const clarification: ChangeClarification = {
        ...question,
        askedAt: now(),
        round: Math.min(3, round + 1),
      };
      await env.DB.prepare(
        "UPDATE changes SET status = 'needs_input', clarification_json = ?, updated_at = ? WHERE id = ? AND status = 'compiling'",
      )
        .bind(JSON.stringify(clarification), now(), b.changeId)
        .run();
    }
    await env.DB.prepare(
      "UPDATE request_conflicts SET policy = 'ask_requester', decided_by = ?, decided_at = ? WHERE id = ?",
    )
      .bind(SYSTEM_REVIEW, now(), id)
      .run();
  } else if (policy === "same_requester") {
    await replaceEarlier(env, id, a, b);
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
        policy,
        status: outcome.stop ?? "compiling",
      },
      { key: id },
    ),
  ]);
  return outcome;
}

/**
 * The later request builds on the earlier one: the system records the choice `apply_theirs`, so
 * the first-come wait (`advanceFirstCome`) queues the later request and plans it after the earlier
 * request promoted or ended. The earlier requester gets no question.
 */
async function followEarlier(
  env: Env,
  ctx: ChangeContext,
  conflictId: string,
  a: RequestInput,
  b: RequestInput,
  workflowInstanceId: string,
) {
  const id = `rw_${a.changeId}_${b.changeId}`;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO request_choices
         (id, project_id, first_change_id, later_change_id, conflict_id, asked_user_id, choice,
          chosen_by, chosen_at, workflow_instance_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'apply_theirs', ?, ?, ?, ?)`,
    ).bind(
      id,
      ctx.projectId,
      a.changeId,
      b.changeId,
      conflictId,
      a.requesterUserId,
      FOLLOW,
      now,
      workflowInstanceId,
      now,
    ),
    env.DB.prepare(
      "UPDATE changes SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'compiling'",
    ).bind(now, b.changeId),
    env.DB.prepare(
      "UPDATE request_conflicts SET policy = 'follow', winner_change_id = ?, loser_change_id = NULL, decided_by = ?, decided_at = COALESCE(decided_at, ?) WHERE id = ?",
    ).bind(a.changeId, FOLLOW, now, conflictId),
  ]);
  await appendChangeEvents(env.RESOURCE_SHARD, ctx, [
    await changeEvent(
      ctx,
      "change.choice.made",
      { choiceId: id, firstChangeId: a.changeId, choice: "apply_theirs", status: "queued" },
      { actor: { kind: "system", id: FOLLOW }, key: id },
    ),
  ]);
}

/**
 * One person asked twice and the requests conflict: the later request replaces the earlier one.
 * An earlier request with a promoted Candidate stays (a canonical transition is never undone), and
 * the later request records `replaces`.
 */
async function replaceEarlier(env: Env, id: string, a: RequestInput, b: RequestInput) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE request_conflicts SET policy = 'same_requester', winner_change_id = ?, loser_change_id = ?, decided_by = ?, decided_at = ? WHERE id = ?`,
  )
    .bind(b.changeId, a.changeId, SAME_REQUESTER, now, id)
    .run();
  const reason = `Not selected: it conflicts with ${b.requesterName ?? b.requesterUserId}'s request "${b.goal.slice(0, 60)}", which replaces the earlier request`;
  const promoted = await env.DB.prepare(
    "SELECT id FROM candidates WHERE change_id = ? AND status = 'promoted' LIMIT 1",
  )
    .bind(a.changeId)
    .first<{ id: string }>();
  let replaces = !!promoted;
  if (!promoted) {
    const stopped = await cancelChange(
      env,
      { changeId: a.changeId, actorUserId: SAME_REQUESTER },
      { reason, winnerChangeId: b.changeId, decidedBy: SAME_REQUESTER },
    );
    // Promotion has started and can already be committed in Root. Never undo it.
    if (stopped.status === "refused") replaces = true;
  }
  await env.DB.prepare(
    `UPDATE changes SET outcome = CASE WHEN ? THEN 'replaces' WHEN outcome = 'replaces' THEN outcome ELSE 'selected' END, updated_at = ? WHERE id = ? AND (outcome IS NULL OR outcome IN ('selected', 'replaces'))`,
  )
    .bind(replaces ? 1 : 0, now, b.changeId)
    .run();
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
