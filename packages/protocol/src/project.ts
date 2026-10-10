import { z } from "zod";
import { CanonicalGeneration, Id, RiskTier, Timestamp } from "./common.ts";

/** URL-safe Project slug, for example `acme-shop`. */
export const Slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case");
export type Slug = z.infer<typeof Slug>;

/** Pointer to the accepted source state (AGENTS.md section 29.1). */
export const CanonicalRef = z.object({
  provider: z.literal("cloudflare-artifacts"),
  artifactRef: z.string(),
  generation: CanonicalGeneration,
  treeSha: z.string(),
});
export type CanonicalRef = z.infer<typeof CanonicalRef>;

export const ProjectPolicies = z.object({
  maxCostUsdPerChange: z.number().nonnegative(),
  humanGateRiskTiers: z.array(RiskTier),
  networkPolicy: z.string(),
  modelPolicyVersion: z.string(),
});
export type ProjectPolicies = z.infer<typeof ProjectPolicies>;

export const ProjectStatus = z.enum(["active", "archived"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** AGENTS.md section 15.1. */
export const Project = z.object({
  id: Id,
  orgId: Id,
  name: z.string().min(1).max(120),
  slug: Slug,
  status: ProjectStatus,
  canonical: CanonicalRef,
  policies: ProjectPolicies,
  /** The caller's role, when the route knows the caller (docs/plans/phase-17a-shared-projects.md). */
  role: z.enum(["owner", "collaborator"]).optional(),
});
export type Project = z.infer<typeof Project>;

/** Who asked for a Change. Rank orders requesters for the priority_wins policy: 0 is the owner. */
export const Requester = z.object({
  userId: Id,
  name: z.string().nullable(),
  rank: z.number().int().nonnegative().nullable(),
  isYou: z.boolean(),
});
export type Requester = z.infer<typeof Requester>;

/** How a request ended up after the cross-request conflict check (phase 17a, decisions S-09..S-12). */
export const RequestOutcome = z.object({
  kind: z.enum(["selected", "partially_selected", "not_selected", "replaces", "overridden"]),
  reason: z.string().nullable(),
  winnerChangeId: Id.nullable(),
  decidedBy: z.string().nullable(),
});
export type RequestOutcome = z.infer<typeof RequestOutcome>;

export const ChangeStatus = z.enum([
  "created",
  "compiling",
  "running",
  "verifying",
  "awaiting_approval",
  "promoting",
  "releasing",
  "completed",
  "cancelled",
  "failed",
  "budget_blocked",
  /** Source could not merge after two bounded rebase reruns. */
  "blocked",
  /** A conflicting request lost to a higher-priority request (docs/plans/phase-17a-shared-projects.md). */
  "not_selected",
  /** A conflicting request waits for the Project owner to decide. */
  "awaiting_owner",
]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

/** Release target after promotion. Canary rollout is deferred (AGENTS.md section 11.5). */
export const RolloutPolicy = z.object({
  target: z.enum(["preview", "production"]),
});
export type RolloutPolicy = z.infer<typeof RolloutPolicy>;

/** AGENTS.md section 15.2. */
export const Change = z.object({
  id: Id,
  projectId: Id,
  goal: z.string().min(1).max(4000),
  acceptanceCriteria: z.array(z.string()),
  invariants: z.array(z.string()),
  status: ChangeStatus,
  baseGeneration: CanonicalGeneration,
  workGraphRef: z.string().optional(),
  budgetUsd: z.number().nonnegative(),
  rolloutPolicy: RolloutPolicy,
});
export type Change = z.infer<typeof Change>;

/** `GET /v1/changes/:changeId`: the Change plus its planned risk tier and record times. */
export const ChangeDetail = Change.extend({
  /** Persisted planning failure or blocked work reason; null when none is recorded. */
  blockedReason: z.string().nullable().optional(),
  /** Set by the Root Planner when it compiles the Work Graph; null before. */
  riskTier: RiskTier.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  requester: Requester.nullable().optional(),
  outcome: RequestOutcome.nullable().optional(),
  supersedesChangeId: Id.nullable().optional(),
});
export type ChangeDetail = z.infer<typeof ChangeDetail>;

/**
 * `POST /v1/changes/:changeId/budget` request (section 44 rule 5: a person raises the budget).
 * The new budget can only be equal or higher; the same cap as Change creation applies.
 */
export const RaiseBudgetRequest = z.object({
  budgetUsd: z.number().positive().max(100),
});
export type RaiseBudgetRequest = z.infer<typeof RaiseBudgetRequest>;

/** Result of a person's cancel or budget raise on one Change. A repeat returns `repeated: true`. */
export const ChangeCommandOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("recorded"),
    changeId: Id,
    changeStatus: ChangeStatus,
    budgetUsd: z.number().nonnegative(),
    repeated: z.boolean(),
    /** Tasks woken again after a budget raise. Empty for a cancel. */
    dispatchedTaskIds: z.array(Id),
  }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(["not_found", "change_closed", "not_cancellable", "budget_lower"]),
    detail: z.string(),
  }),
]);
export type ChangeCommandOutcome = z.infer<typeof ChangeCommandOutcome>;

/**
 * `POST /v1/projects` request: a name and a slug. Every Project starts from an empty repository
 * (one commit with a `.gitignore`); agents build the app from nothing. Unknown keys, such as the
 * retired `template`, are ignored.
 */
export const CreateProjectRequest = z.object({
  name: Project.shape.name,
  slug: Slug,
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

/** `POST /v1/projects/:projectId/changes` request. `clientRequestId` makes retries idempotent. */
export const CreateChangeRequest = z.object({
  goal: Change.shape.goal,
  budgetUsd: z.number().positive().max(100).default(3),
  clientRequestId: Id.optional(),
  /** false skips the Root Planner, for example in smoke checks that must not spend model calls. */
  startPlanning: z.boolean().default(true),
});
export type CreateChangeRequest = z.infer<typeof CreateChangeRequest>;
