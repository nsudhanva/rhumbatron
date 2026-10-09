import { z } from "zod";
import { CanonicalGeneration, Id, RiskTier } from "./common.ts";

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

/** `POST /v1/projects` request. */
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
