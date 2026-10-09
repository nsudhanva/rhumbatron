import { z } from "zod";
import { Id, ModelTier, Timestamp } from "./common.ts";
import { Actor } from "./event.ts";

/**
 * Activity read models (AGENTS.md sections 16.1, 39, 41): the per-Project and per-Change event
 * feed, the Claims feed, live run progress, and Project stats. All are eventually consistent read
 * projections; never use them for a release safety decision (section 59).
 */

/** Scalar payload fields the feed keeps. Never a full payload, never reasoning or secrets. */
export const FeedData = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type FeedData = z.infer<typeof FeedData>;

/** One recorded event. `seq` is the feed position: unique, strictly increasing in record order. */
export const FeedEvent = z.object({
  seq: z.number().int().positive(),
  eventId: Id,
  /** A section 17.2 type. Kept as a string so an older reader tolerates a newer type. */
  eventType: z.string().min(1),
  eventVersion: z.number().int().positive(),
  occurredAt: Timestamp,
  recordedAt: Timestamp,
  actor: Actor,
  changeId: Id.nullable(),
  taskId: Id.nullable(),
  candidateId: Id.nullable(),
  resource: z.string().nullable(),
  summary: z.string(),
  data: FeedData,
});
export type FeedEvent = z.infer<typeof FeedEvent>;

export const FEED_DEFAULT_LIMIT = 50;
export const FEED_MAX_LIMIT = 100;

/**
 * Feed cursor. No cursor: the newest `limit` events. `after`: events with a larger `seq`, the
 * oldest of them first, so a reader that repeats `after = nextAfter` while `hasMore` sees every
 * event exactly once. `before`: older events, for paging back.
 */
export const FeedQuery = z
  .object({
    after: z.coerce.number().int().nonnegative().optional(),
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(FEED_MAX_LIMIT).default(FEED_DEFAULT_LIMIT),
  })
  .refine((q) => q.after === undefined || q.before === undefined, {
    message: "Use either after or before, not both",
  });
export type FeedQuery = z.infer<typeof FeedQuery>;

/** Events newest first. `nextAfter` is the cursor for newer events; `nextBefore` for older ones. */
export const FeedPage = z.object({
  events: z.array(FeedEvent),
  /** More events exist in the requested direction (newer with `after`, older otherwise). */
  hasMore: z.boolean(),
  nextAfter: z.number().int().nonnegative(),
  nextBefore: z.number().int().positive().nullable(),
});
export type FeedPage = z.infer<typeof FeedPage>;

/** How to read one page: compare `seq` with `value` (if any), order, and rows to take. */
export type FeedPlan = {
  op: ">" | "<" | null;
  value: number | null;
  order: "ASC" | "DESC";
  /** `limit + 1`: the extra row only tells whether more exist. */
  take: number;
};

export function planFeedQuery(query: FeedQuery): FeedPlan {
  const take = query.limit + 1;
  if (query.after !== undefined) return { op: ">", value: query.after, order: "ASC", take };
  if (query.before !== undefined) return { op: "<", value: query.before, order: "DESC", take };
  return { op: null, value: null, order: "DESC", take };
}

/**
 * Builds the page from rows read with `planFeedQuery` (in the plan's order). With `after`, the
 * page holds the OLDEST `limit` newer rows: taking the newest would skip the rows between.
 */
export function toFeedPage<T extends { seq: number }>(
  rows: readonly T[],
  query: FeedQuery,
): { events: T[]; hasMore: boolean; nextAfter: number; nextBefore: number | null } {
  const hasMore = rows.length > query.limit;
  const kept = rows.slice(0, query.limit);
  const events = query.after !== undefined ? [...kept].reverse() : kept;
  const newest = events[0]?.seq;
  const oldest = events.at(-1)?.seq;
  return {
    events,
    hasMore,
    nextAfter: Math.max(newest ?? 0, query.after ?? 0),
    nextBefore: oldest ?? query.before ?? null,
  };
}

export const ClaimAction = z.enum(["acquired", "renewed", "released", "expired", "contended"]);
export type ClaimAction = z.infer<typeof ClaimAction>;

/** One Claim lifecycle or advisory contention fact, from the `claim.*` events of a Change. */
export const ClaimFact = z.object({
  seq: z.number().int().positive(),
  eventId: Id,
  action: ClaimAction,
  claimId: Id,
  /** The contender for `contended`; the owner for lifecycle facts. */
  agentId: Id,
  /** Holder recorded by `claim.contended`. Absent in older feed projections. */
  heldByAgentId: Id.optional(),
  resource: z.string(),
  leaseExpiresAt: Timestamp.nullable(),
  occurredAt: Timestamp,
});
export type ClaimFact = z.infer<typeof ClaimFact>;

/** The last known state of one Claim. `active` with a past lease is reported as `expired`. */
export const ClaimState = z.object({
  claimId: Id,
  agentId: Id,
  resource: z.string(),
  status: z.enum(["active", "released", "expired"]),
  leaseExpiresAt: Timestamp.nullable(),
  acquiredAt: Timestamp.nullable(),
  updatedAt: Timestamp,
});
export type ClaimState = z.infer<typeof ClaimState>;

export const ChangeClaims = z.object({
  /** Oldest first. At most the newest CLAIM_FEED_LIMIT facts. */
  facts: z.array(ClaimFact),
  claims: z.array(ClaimState),
  truncated: z.boolean(),
});
export type ChangeClaims = z.infer<typeof ChangeClaims>;

/** Folds Claim facts (oldest first) into the last known state per Claim. Pure. */
export function foldClaims(facts: readonly ClaimFact[], now: number): ClaimState[] {
  const byId = new Map<string, ClaimState>();
  for (const fact of facts) {
    // Contention records an attempted Claim, not a lease change. In particular, do not
    // create a holder state when a truncated or cross-Change feed lacks lifecycle facts.
    if (fact.action === "contended") continue;
    const prior = byId.get(fact.claimId);
    const status =
      fact.action === "released" ? "released" : fact.action === "expired" ? "expired" : "active";
    byId.set(fact.claimId, {
      claimId: fact.claimId,
      agentId: fact.agentId,
      resource: fact.resource,
      status,
      leaseExpiresAt: fact.leaseExpiresAt ?? prior?.leaseExpiresAt ?? null,
      acquiredAt: fact.action === "acquired" ? fact.occurredAt : (prior?.acquiredAt ?? null),
      updatedAt: fact.occurredAt,
    });
  }
  return [...byId.values()].map((claim) => {
    const lease = claim.leaseExpiresAt ? Date.parse(claim.leaseExpiresAt) : Number.NaN;
    // The shard emits `claim.expired` lazily; a lapsed lease is already not held.
    return claim.status === "active" && !Number.isNaN(lease) && lease <= now
      ? { ...claim, status: "expired" as const }
      : claim;
  });
}

/** Live progress of one running Task attempt (written once per model call). */
export const RunProgress = z.object({
  taskId: Id,
  attempt: z.number().int().positive(),
  tier: ModelTier,
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** The last tool step, for example `read_file src/cart.ts`. Null before the first tool call. */
  lastStep: z.string().nullable(),
  startedAt: Timestamp,
  progressAt: Timestamp.nullable(),
});
export type RunProgress = z.infer<typeof RunProgress>;

/** `GET /v1/projects/:projectId/stats`. Counts cover every Change of the Project. */
export const ProjectStats = z.object({
  changes: z.object({ total: z.number().int(), active: z.number().int() }),
  candidates: z.object({
    total: z.number().int(),
    verified: z.number().int(),
    promoted: z.number().int(),
    rejected: z.number().int(),
  }),
  model: z.object({
    runs: z.number().int(),
    running: z.number().int(),
    calls: z.number().int(),
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    costUsd: z.number().nonnegative(),
  }),
  events: z.object({ latestSeq: z.number().int().nonnegative() }),
});
export type ProjectStats = z.infer<typeof ProjectStats>;
