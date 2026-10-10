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
});
export type Project = z.infer<typeof Project>;

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
  /** Set by the Root Planner when it compiles the Work Graph; null before. */
  riskTier: RiskTier.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
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

/** `POST /v1/projects` request. */
/** Source templates a Project can start from (AGENTS.md section 54). */
export const ProjectTemplate = z.enum(["empty", "acme-shop"]);
export type ProjectTemplate = z.infer<typeof ProjectTemplate>;

export const CreateProjectRequest = z.object({
  name: Project.shape.name,
  slug: Slug,
  template: ProjectTemplate.default("empty"),
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
