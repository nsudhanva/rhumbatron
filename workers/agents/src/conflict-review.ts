import {
  applyVerdict,
  buildReviewPacket,
  type ConflictReviewRecord,
  checkCitations,
  checkReviewBudget,
  type EscalationReason,
  escalationReasons,
  type FirstReview,
  forkDecision,
  type PriorReview,
  parseReviewOutput,
  REVIEW_MAX_OUTPUT_TOKENS,
  type ReviewEffect,
  type ReviewSide,
  type ReviewTier,
  reviewMessages,
  shouldEscalate,
} from "@rhumbatron/conflict";
import { estimateTokens, packetHash } from "@rhumbatron/context-compiler";
import type { ResourceShardDO } from "@rhumbatron/coordinator";
import { shardKey } from "@rhumbatron/coordinator/shard-key";
import {
  appendChangeEvents,
  type ChangeContext,
  changeEvent,
  qualify,
} from "@rhumbatron/integration/events";
import {
  AGENT_DAILY_CALL_CAP,
  anthropicMonthlyBudgetUsd,
  type CompletionRequest,
  type CompletionResult,
  ModelCallError,
  meteredComplete,
  opusAllowed,
  reserveEstimateUsd,
  TIER_MODELS,
  USAGE_COUNTER,
} from "@rhumbatron/model-router";
import {
  type Challenge,
  type ConflictAction,
  ConflictReport,
  type ConflictReviewReceipt,
  type ConflictState,
  type ContextPacket,
  type EventEnvelope,
  type Intent,
} from "@rhumbatron/protocol";
import {
  type ConflictReview,
  INACTIVE_CANDIDATE_STATUSES,
  type IntentSide,
  readProtectedResources,
} from "./conflicts.ts";

/**
 * Model review of recorded semantic conflicts (AGENTS.md sections 22.4, 32.3, 34.4.2; P9-05 and
 * P9-06). Runs off the agent's run path: AgentDO schedules it after `declareIntentAndDetect`
 * records a conflict, so a slow or failed review never blocks a run.
 *
 * Per conflict: Sonnet first; Opus only when `shouldEscalate` says so and Opus is on (ALLOW_OPUS,
 * ADR 0021); while Opus is off, Sonnet's verdict is final. At most one review per tier per
 * conflict: the tier's slot in `review_json.reviews` is reserved with one conditional D1 update
 * before the call. Each call is admitted like an agent call: the Change budget (section 44), the
 * daily call cap, and the monthly Anthropic budget (meteredComplete). Code applies a verdict through
 * `applyVerdict`; the model output is a hypothesis with citations, never authority.
 */

export type ConflictReviewJob = { ctx: ChangeContext; conflictIds: string[] };

/** Recorded review spend of one Change; part of the Change budget next to `task_runs.cost_usd`. */
export const CONFLICT_REVIEW_SPEND_SQL = `SELECT COALESCE(SUM(
    COALESCE(json_extract(review_json, '$.reviews.sonnet.costUsd'), 0) +
    COALESCE(json_extract(review_json, '$.reviews.opus.costUsd'), 0)), 0) AS n
  FROM conflicts WHERE change_id = ?`;

const ACTOR = { kind: "system" as const, id: "conflict-reviewer" };
const REVIEWABLE: readonly ConflictState[] = ["suspected", "confirmed"];

type Db = Pick<D1Database, "prepare" | "batch">;

/** Everything the review touches outside D1, injectable for tests. */
export type ReviewDeps = {
  db: Db;
  now: () => string;
  /** Typed Intents of the Change, from its ResourceShardDO. */
  intents: (changeId: string) => Promise<Intent[]>;
  createChallenge: (challenge: Challenge) => Promise<boolean>;
  emit: (events: EventEnvelope[]) => Promise<void>;
  /** Anthropic call through the AI Gateway, admitted by the monthly budget. */
  callModel: (req: CompletionRequest) => Promise<CompletionResult>;
  /** ALLOW_OPUS is "true": a Sonnet review can escalate to Opus. */
  allowOpus: boolean;
  /** Protected resources of the Project's stored policy; read once per review run. */
  protectedResources: () => Promise<readonly string[]>;
  /** Stores the Context Packet as an Evidence Snapshot (section 27.5). Best effort. */
  storePacket: (key: string, packet: ContextPacket) => Promise<void>;
  metric: (point: AnalyticsEngineDataPoint) => void;
};

type ConflictRow = {
  id: string;
  change_id: string;
  state: ConflictState;
  recommended_action: ConflictAction;
  report_json: string;
  intents_json: string;
  review_json: string;
  challenge_id: string | null;
};

type Loaded = {
  row: ConflictRow;
  report: ConflictReport;
  review: ConflictReview;
  sides: [IntentSide, IntentSide];
};

const today = (now: string) => now.slice(0, 10);

async function takeQuota(db: Db, day: string, counter: string, cap: number): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO usage_counters (day, counter, count) VALUES (?, ?, 1)
       ON CONFLICT (day, counter) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(day, counter, cap)
    .first<{ count: number }>();
  return row !== null;
}

async function load(db: Db, conflictId: string): Promise<Loaded | null> {
  const row = await db
    .prepare(
      `SELECT id, change_id, state, recommended_action, report_json, intents_json, review_json,
              challenge_id FROM conflicts WHERE id = ?`,
    )
    .bind(conflictId)
    .first<ConflictRow>();
  if (!row) return null;
  return {
    row,
    report: ConflictReport.parse(JSON.parse(row.report_json)),
    review: JSON.parse(row.review_json) as ConflictReview,
    sides: JSON.parse(row.intents_json) as [IntentSide, IntentSide],
  };
}

/** Recorded spend of the Change: Task runs plus earlier conflict reviews. */
async function changeSpend(
  db: Db,
  changeId: string,
): Promise<{ budgetUsd: number; spentUsd: number }> {
  const [budget, runs, reviews] = await db.batch<{ n: number }>([
    db.prepare("SELECT budget_usd AS n FROM changes WHERE id = ?").bind(changeId),
    db
      .prepare(
        "SELECT COALESCE(SUM(r.cost_usd), 0) AS n FROM task_runs r JOIN tasks t ON t.id = r.task_id WHERE t.change_id = ?",
      )
      .bind(changeId),
    db.prepare(CONFLICT_REVIEW_SPEND_SQL).bind(changeId),
  ]);
  return {
    budgetUsd: budget?.results?.[0]?.n ?? 0,
    spentUsd: (runs?.results?.[0]?.n ?? 0) + (reviews?.results?.[0]?.n ?? 0),
  };
}

/** Takes the tier's single slot. False when another review holds or used it. */
async function reserve(db: Db, conflictId: string, tier: ReviewTier, now: string) {
  const record: ConflictReviewRecord = { status: "reserved", at: now };
  const path = `$.reviews.${tier}`;
  const result = await db
    .prepare(
      `UPDATE conflicts SET review_json = json_set(review_json, '${path}', json(?)), updated_at = ?
       WHERE id = ? AND state IN ('suspected', 'confirmed')
         AND COALESCE(json_extract(review_json, '${path}.status'), 'refused') = 'refused'`,
    )
    .bind(JSON.stringify(record), now, conflictId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Writes a slot record without touching conflict state. Never overwrites a finished review. */
async function writeRecord(
  db: Db,
  conflictId: string,
  tier: ReviewTier,
  record: ConflictReviewRecord,
) {
  const path = `$.reviews.${tier}`;
  await db
    .prepare(
      `UPDATE conflicts SET review_json = json_set(review_json, '${path}', json(?)), updated_at = ?
       WHERE id = ? AND COALESCE(json_extract(review_json, '${path}.status'), 'refused')
         IN ('refused', 'reserved')`,
    )
    .bind(JSON.stringify(record), record.at, conflictId)
    .run();
}

function costEstimateUsd(tier: ReviewTier, promptTokens: number) {
  return reserveEstimateUsd(TIER_MODELS[tier], REVIEW_MAX_OUTPUT_TOKENS[tier], promptTokens);
}

/** The Challenge for a conflict a model confirmed (the detector writes one for a hard signal). */
function challengeFor(
  loaded: Loaded,
  pair: readonly [Intent, Intent],
  rationale: string,
  citations: string[],
  action: ConflictAction,
): Challenge {
  const [earlier, later] = [...pair].sort((x, y) =>
    x.createdAt === y.createdAt
      ? x.intentId < y.intentId
        ? -1
        : 1
      : x.createdAt < y.createdAt
        ? -1
        : 1,
  ) as [Intent, Intent];
  const kinds = new Set(loaded.report.signals.map((s) => s.kind));
  return {
    challengeId: `chl_${loaded.row.id.slice(4)}`,
    sourceAgentId: earlier.agentId,
    targetIntentId: later.intentId,
    semanticResource: loaded.report.resource,
    kind:
      kinds.has("data_overlap") || kinds.has("data_model_conflict")
        ? "data_semantics_conflict"
        : kinds.has("contract_overlap") || kinds.has("contract_conflict")
          ? "contract_conflict"
          : "design_alternative",
    summary: `${loaded.report.resource}: ${rationale}`.slice(0, 2000),
    evidenceRefs: citations.filter((c) => c.length <= 128).slice(0, 20),
    ...(action === "fork_candidates"
      ? { proposedResolution: "Fork 2 Candidates and let executable evidence decide." }
      : {}),
  };
}

type TierResult =
  | { kind: "refused" }
  | { kind: "skipped" }
  | { kind: "call_failed" }
  | { kind: "invalid_output" }
  | { kind: "reviewed"; effect: ReviewEffect; record: ConflictReviewRecord };

/**
 * Reviews one conflict: Sonnet, then Opus when the escalation rule says so. Returns the tiers that
 * ran. Never changes Candidate or Evidence state.
 */
export async function reviewConflict(
  deps: ReviewDeps,
  ctx: ChangeContext,
  conflictId: string,
): Promise<ReviewTier[]> {
  const first = await load(deps.db, conflictId);
  if (!first || !REVIEWABLE.includes(first.row.state)) return [];
  if (first.review.reviews?.sonnet && first.review.reviews.sonnet.status !== "refused") return [];

  const intents = new Map((await deps.intents(ctx.changeId)).map((i) => [i.intentId, i]));
  const a = intents.get(first.report.intentIds[0]);
  const b = intents.get(first.report.intentIds[1]);
  if (!a || !b) return [];
  const pair = [a, b] as const;
  const protectedResources = await deps.protectedResources();
  const reasons = escalationReasons(first.report, pair, protectedResources);

  // ChangeSet `cs_<run>` belongs to Intent `int_<run>` (agent-do.ts finishRun).
  const csIds = pair.map((i) => `cs_${i.intentId.slice(4)}`);
  const [changeRow, changeSets, candidates, otherForks] = await deps.db.batch([
    deps.db
      .prepare(
        "SELECT goal, invariants_json, acceptance_criteria_json, updated_at FROM changes WHERE id = ?",
      )
      .bind(ctx.changeId),
    deps.db
      .prepare("SELECT id, intent_json FROM changesets WHERE id IN (?, ?) AND change_id = ?")
      .bind(csIds[0], csIds[1], ctx.changeId),
    deps.db
      .prepare(
        `SELECT COUNT(*) AS n,
           SUM(CASE WHEN status NOT IN (${INACTIVE_CANDIDATE_STATUSES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS active
         FROM candidates WHERE change_id = ?`,
      )
      .bind(...INACTIVE_CANDIDATE_STATUSES, ctx.changeId),
    deps.db
      .prepare(
        `SELECT COUNT(*) AS n FROM conflicts WHERE change_id = ? AND id != ?
           AND json_extract(fork_decision_json, '$.kind') = 'fork'`,
      )
      .bind(ctx.changeId, conflictId),
  ]);
  const change = changeRow?.results?.[0] as
    | {
        goal: string;
        invariants_json: string;
        acceptance_criteria_json: string;
        updated_at: string;
      }
    | undefined;
  if (!change) return [];
  const csRows = (changeSets?.results ?? []) as { id: string; intent_json: string }[];
  const changeSetOf = (id: string): ReviewSide["changeSet"] => {
    const row = csRows.find((r) => r.id === id);
    if (!row) return null;
    const published = (
      JSON.parse(row.intent_json) as { changeSet?: { diffStat?: unknown; files?: unknown } }
    ).changeSet;
    return {
      changeSetId: id,
      diffStat: typeof published?.diffStat === "string" ? published.diffStat : "",
      files: Array.isArray(published?.files)
        ? published.files.filter((f): f is string => typeof f === "string")
        : [],
    };
  };
  const counts = candidates?.results?.[0] as { n: number; active: number | null } | undefined;
  const sideOf = (intent: Intent, i: 0 | 1): ReviewSide => ({
    intent,
    taskKey: first.sides[i]?.taskKey ?? "",
    title: first.sides[i]?.title ?? "",
    changeSet: changeSetOf(csIds[i] ?? ""),
  });
  const sides = [sideOf(a, 0), sideOf(b, 1)] as const;
  const facts = {
    bothSidesHaveChangeSets: sides.every((s) => s.changeSet !== null),
    forked: (counts?.n ?? 0) > 0,
  };

  const runTier = async (tier: ReviewTier, prior?: PriorReview): Promise<TierResult> => {
    const now = deps.now();
    const current = await load(deps.db, conflictId);
    if (!current || !REVIEWABLE.includes(current.row.state)) return { kind: "skipped" };
    const packet = buildReviewPacket({
      conflictId,
      projectId: ctx.projectId,
      changeId: ctx.changeId,
      canonicalGeneration: ctx.baseGeneration,
      now,
      change: {
        goal: change.goal,
        acceptanceCriteria: JSON.parse(change.acceptance_criteria_json) as string[],
        invariants: JSON.parse(change.invariants_json) as string[],
        updatedAt: change.updated_at,
      },
      report: current.report,
      sides,
      protectedResources,
      ...(prior ? { prior } : {}),
    });
    const messages = reviewMessages(packet);
    const refuse = async (reason: string): Promise<TierResult> => {
      await writeRecord(deps.db, conflictId, tier, { status: "refused", at: now, reason });
      deps.metric({
        blobs: ["conflict_review", tier, "refused", reason],
        doubles: [0],
        indexes: [ctx.projectId],
      });
      return { kind: "refused" };
    };

    // Admission (section 44): Change budget, then the tier slot and the day cap. The monthly
    // Anthropic budget admits the call itself (meteredComplete).
    const spend = await changeSpend(deps.db, ctx.changeId);
    const budget = checkReviewBudget({
      changeBudgetUsd: spend.budgetUsd,
      spentUsd: spend.spentUsd,
      estimateUsd: costEstimateUsd(tier, estimateTokens(messages.system + messages.user)),
    });
    if (!budget.ok) return refuse(budget.reason);
    if (!(await reserve(deps.db, conflictId, tier, now))) return { kind: "skipped" };
    const day = today(now);
    if (!(await takeQuota(deps.db, day, USAGE_COUNTER.agentCalls, AGENT_DAILY_CALL_CAP)))
      return refuse("daily_model_calls");

    const hash = await packetHash(packet);
    await deps
      .storePacket(
        `context/${ctx.projectId}/${ctx.changeId}/conflicts/${conflictId}/${hash}.json`,
        packet,
      )
      .catch(() => undefined);

    let result: CompletionResult;
    try {
      result = await deps.callModel({
        tier,
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
        maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS[tier],
        metadata: { kind: "conflict_review", conflictId, tier },
      });
    } catch (error) {
      const kind = error instanceof ModelCallError ? error.kind : "transient";
      await writeRecord(deps.db, conflictId, tier, {
        status: "failed",
        at: deps.now(),
        reason: kind,
        provider: "anthropic",
        packetHash: hash,
      });
      deps.metric({
        blobs: ["conflict_review", tier, "failed", kind],
        doubles: [0],
        indexes: [ctx.projectId],
      });
      return { kind: "call_failed" };
    }

    const usage = {
      provider: result.provider,
      model: result.model,
      packetHash: hash,
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      escalationReasons: reasons,
    };
    const parsed = parseReviewOutput(result.content);
    if (!parsed.ok) {
      const record: ConflictReviewRecord = {
        status: "done",
        at: deps.now(),
        reason: `${parsed.reason}: ${parsed.detail}`,
        verdict: null,
        ...usage,
      };
      await finish(deps, ctx, current, tier, record, null, null);
      return { kind: "invalid_output" };
    }

    const { verdict, rationale, citations } = parsed.output;
    const checked = checkCitations(parsed.output, packet, conflictId);
    const effect = applyVerdict(
      {
        state: current.row.state,
        recommendedAction: current.row.recommended_action,
        report: current.report,
      },
      { verdict, support: checked.support, concrete: checked.concrete },
      facts,
    );
    // Sonnet's verdict on a conflict that goes to Opus is recorded but not applied.
    const deferred =
      deps.allowOpus && tier === "sonnet" && shouldEscalate(reasons, { kind: "reviewed", effect });
    const record: ConflictReviewRecord = {
      status: "done",
      at: deps.now(),
      verdict,
      rationale,
      citations,
      support: checked.support,
      citationErrors: checked.citationErrors,
      outcome: effect.outcome,
      ...(deferred ? { deferred: true } : {}),
      ...usage,
    };
    const challenge =
      !deferred &&
      effect.applied &&
      effect.state === "confirmed" &&
      current.row.state === "suspected"
        ? challengeFor(current, pair, rationale, citations, effect.recommendedAction)
        : null;
    // Same rule as declareIntentAndDetect: forks planned by other conflicts hold two slots each.
    const plannedForks = (otherForks?.results?.[0] as { n: number } | undefined)?.n ?? 0;
    const activeCandidates = Math.max(counts?.active ?? 0, plannedForks * 2);
    await finish(
      deps,
      ctx,
      current,
      tier,
      record,
      deferred ? null : effect,
      challenge,
      activeCandidates,
    );
    return { kind: "reviewed", effect, record };
  };

  const ran: ReviewTier[] = [];
  const sonnet = await runTier("sonnet");
  if (sonnet.kind === "refused" || sonnet.kind === "skipped") return ran;
  ran.push("sonnet");
  const firstReview: FirstReview = sonnet;
  // Opus off (ADR 0021): escalation caps at Sonnet, whose verdict was applied above.
  if (!deps.allowOpus || !shouldEscalate(reasons, firstReview)) return ran;
  const prior: PriorReview =
    sonnet.kind === "reviewed"
      ? {
          tier: "sonnet",
          verdict: sonnet.record.verdict ?? null,
          rationale: sonnet.record.rationale ?? "",
          support: sonnet.record.support ?? null,
        }
      : {
          tier: "sonnet",
          verdict: null,
          rationale: "The output did not match the contract.",
          support: null,
        };
  const opus = await runTier("opus", prior);
  if (opus.kind !== "refused" && opus.kind !== "skipped") ran.push("opus");
  return ran;
}

/**
 * Records one finished review: the slot record, the applied effect (if any) with a fresh fork
 * decision, the Decision Receipt, a Challenge for a model-confirmed conflict, and
 * `conflict.reviewed`. The row update is conditional on this tier's reservation and the state the
 * review read, so a concurrent change wins and this review only records itself.
 */
async function finish(
  deps: ReviewDeps,
  ctx: ChangeContext,
  current: Loaded,
  tier: ReviewTier,
  record: ConflictReviewRecord,
  effect: ReviewEffect | null,
  challenge: Challenge | null,
  activeCandidates = 0,
) {
  const before = current.row.state;
  const state = effect?.state ?? before;
  const action = effect?.recommendedAction ?? current.row.recommended_action;
  let challengeId: string | null = null;
  if (challenge && (await deps.createChallenge(challenge).catch(() => false))) {
    challengeId = challenge.challengeId;
  }
  const changed = state !== before || action !== current.row.recommended_action;
  const review: ConflictReview = {
    ...current.review,
    state,
    recommendedAction: action,
    // `decidedBy` names who set the current state: the tier only when its verdict changed it.
    ...(changed ? { decidedBy: tier } : {}),
    ...(effect?.attention ? { attention: effect.attention } : {}),
    reviews: { ...current.review.reviews, [tier]: record },
  };
  // A supported rationale explains the conflict to a human, also when it changed nothing.
  if (
    record.support === "supported" &&
    record.rationale &&
    (effect?.applied || !review.rationale)
  ) {
    review.rationale = record.rationale;
  }
  const fork = forkDecision(
    { ...current.report, state, recommendedAction: action },
    { activeCandidates },
  );
  const receipt: ConflictReviewReceipt = {
    decisionType: "CONFLICT_REVIEW",
    conflictId: current.row.id,
    changeId: ctx.changeId,
    decidedBy: "rules",
    selectedTier: tier,
    provider: record.provider ?? "",
    model: record.model ?? "",
    escalationReasons: (record.escalationReasons ?? []) as EscalationReason[],
    verdict: record.verdict ?? null,
    support: record.support ?? null,
    citations: record.citations ?? [],
    citationErrors: record.citationErrors ?? [],
    outcome: record.deferred ? "deferred_to_opus" : (record.outcome ?? "invalid_output"),
    stateBefore: before,
    stateAfter: state,
    costUsd: record.costUsd ?? 0,
    inputTokens: record.inputTokens ?? 0,
    outputTokens: record.outputTokens ?? 0,
    createdAt: record.at,
  };
  const laterTask = current.sides[1]?.taskId ?? current.sides[0]?.taskId ?? "";
  const [updated] = await deps.db.batch([
    deps.db
      .prepare(
        `UPDATE conflicts SET state = ?, recommended_action = ?, review_json = ?, fork_decision_json = ?,
           challenge_id = COALESCE(challenge_id, ?), updated_at = ?
         WHERE id = ? AND state = ? AND recommended_action = ?
           AND json_extract(review_json, '$.reviews.${tier}.status') = 'reserved'`,
      )
      .bind(
        state,
        action,
        JSON.stringify(review),
        JSON.stringify(fork),
        challengeId,
        record.at,
        current.row.id,
        before,
        current.row.recommended_action,
      ),
    deps.db
      .prepare(
        `INSERT OR IGNORE INTO decision_receipts (id, task_id, agent_id, decision_type, decided_by, selected_tier, receipt_json, created_at)
         VALUES (?, ?, ?, 'CONFLICT_REVIEW', 'rules', ?, ?, ?)`,
      )
      .bind(
        `rcpt_cfr_${current.row.id.slice(4)}_${tier}`,
        laterTask,
        ACTOR.id,
        tier,
        JSON.stringify(receipt),
        record.at,
      ),
  ]);
  if ((updated?.meta.changes ?? 0) === 0) {
    // State moved under the review: keep only the record, never the effect.
    await writeRecord(deps.db, current.row.id, tier, { ...record, outcome: "not_reviewable" });
  }
  deps.metric({
    blobs: ["conflict_review", tier, record.verdict ?? "invalid_output", receipt.outcome],
    doubles: [receipt.costUsd, receipt.inputTokens, receipt.outputTokens],
    indexes: [ctx.projectId],
  });
  await deps
    .emit([
      await changeEvent(
        ctx,
        "conflict.reviewed",
        {
          conflictId: current.row.id,
          tier,
          verdict: record.verdict ?? null,
          support: record.support ?? null,
          outcome: receipt.outcome,
          state,
          recommendedAction: action,
          attention: effect?.attention ?? null,
          citations: record.citations ?? [],
          decidedBy: tier,
          reason: `${tier}: ${record.verdict ?? "invalid output"} (${receipt.outcome})`,
        },
        {
          taskId: laterTask,
          resource: qualify(ctx, current.report.resource),
          actor: ACTOR,
          key: `${current.row.id}:${tier}`,
        },
      ),
    ])
    .catch(() => undefined);
}

/** Reviews each conflict of a job with real bindings. Never throws: a review is advisory work. */
export async function runConflictReviews(env: Env, job: ConflictReviewJob) {
  const ns = env.RESOURCE_SHARD as DurableObjectNamespace<ResourceShardDO>;
  const shard = () =>
    ns.get(ns.idFromName(shardKey(job.ctx.projectId, `change:${job.ctx.changeId}`)));
  const scope = {
    projectId: job.ctx.projectId,
    changeId: job.ctx.changeId,
    projectSlug: job.ctx.projectSlug,
    canonicalGeneration: job.ctx.baseGeneration,
  };
  // One policy read per run, shared by every conflict the run reviews.
  let guards: Promise<string[]> | undefined;
  const deps: ReviewDeps = {
    db: env.DB,
    now: () => new Date().toISOString(),
    protectedResources: () => {
      guards ??= readProtectedResources(env.DB, job.ctx.projectId);
      return guards;
    },
    intents: async (changeId) => (await shard().detectionInputs(changeId)).intents,
    createChallenge: async (challenge) =>
      (await shard().createChallenge({ ...scope, challenge })).ok,
    emit: (events) => appendChangeEvents(env.RESOURCE_SHARD, job.ctx, events),
    callModel: (req) =>
      meteredComplete(
        { db: env.DB, budgetUsd: anthropicMonthlyBudgetUsd(env.ANTHROPIC_MONTHLY_BUDGET_USD) },
        {
          accountId: env.AI_ACCOUNT_ID,
          gatewayId: env.AI_GATEWAY_ID,
          apiKey: env.ANTHROPIC_API_KEY,
          workspaceId: env.ANTHROPIC_WORKSPACE_ID,
          allowOpus: opusAllowed(env.ALLOW_OPUS),
          timeoutMs: 90_000,
        },
        req,
      ),
    allowOpus: opusAllowed(env.ALLOW_OPUS),
    storePacket: async (key, packet) => {
      await env.EVIDENCE.put(key, JSON.stringify(packet), {
        httpMetadata: { contentType: "application/json" },
      });
    },
    metric: (point) => env.METRICS.writeDataPoint(point),
  };
  for (const conflictId of job.conflictIds) {
    try {
      const ran = await reviewConflict(deps, job.ctx, conflictId);
      console.warn(JSON.stringify({ event: "agent.conflict_reviewed", conflictId, tiers: ran }));
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "agent.conflict_review_failed",
          conflictId,
          message: String(error).slice(0, 200),
        }),
      );
    }
  }
}
