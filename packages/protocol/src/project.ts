import { z } from "zod";
import { BudgetScope, ChangeBudget } from "./budget.ts";
import { MAX_TITLE_CHARS } from "./change-title.ts";
import { CanonicalGeneration, Id, RiskTier, Timestamp } from "./common.ts";
import { ProjectRole } from "./roles.ts";

/** URL-safe Project slug, for example `acme-shop`. */
export const Slug = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "slug must be lowercase kebab-case");
export type Slug = z.infer<typeof Slug>;

/** Pointer to the accepted source state. */
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

/** One software product managed by Rhumbatron. */
export const Project = z.object({
  id: Id,
  orgId: Id,
  name: z.string().min(1).max(120),
  slug: Slug,
  status: ProjectStatus,
  canonical: CanonicalRef,
  policies: ProjectPolicies,
  /** The caller's role, when the route knows the caller (docs/architecture/shared-projects.md). */
  role: ProjectRole.optional(),
});
export type Project = z.infer<typeof Project>;

/**
 * Who asked for a Change. `rank` is the rank of the requester's role when the request was made
 * (`ROLE_RANK`), and `role` is the requester's current role (null after they left). Display only:
 * no build decision reads either.
 */
export const Requester = z.object({
  userId: Id,
  name: z.string().nullable(),
  rank: z.number().int().nonnegative().nullable(),
  role: ProjectRole.nullable().optional(),
  isYou: z.boolean(),
});
export type Requester = z.infer<typeof Requester>;

/**
 * How a request ended up after the intake gate and the cross-request check
 * (docs/architecture/shared-projects.md). `duplicate`: the request closed as a duplicate of
 * `winnerChangeId`, or of the current app when that is null. `declined`: an owner or admin
 * declined the proposed request; `reason` is the decline reason. `follows`: the first requester
 * chose to apply this request after their own request `winnerChangeId` (ADR 0032).
 */
export const RequestOutcome = z.object({
  kind: z.enum([
    "selected",
    "partially_selected",
    "not_selected",
    "replaces",
    "duplicate",
    "declined",
    "follows",
  ]),
  reason: z.string().nullable(),
  winnerChangeId: Id.nullable(),
  decidedBy: z.string().nullable(),
});
export type RequestOutcome = z.infer<typeof RequestOutcome>;

export const ChangeStatus = z.enum([
  /** A member's request waits for an owner or admin to include it. No workflow, no model call. */
  "proposed",
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
  /** A conflicting request lost to the request the system arbiter chose (shared-projects.md). */
  "not_selected",
  /** The request is unclear, a duplicate, or conflicts: the workflow waits for an answer. */
  "needs_input",
  /** An owner or admin declined the proposed request. Terminal. */
  "declined",
  /**
   * The request conflicts with an earlier request of another person. It waits for that person to
   * choose: keep their version, or apply this request after theirs (ADR 0032). No planning spend.
   */
  "awaiting_choice",
  /** The first requester chose "apply theirs": the request plans after the earlier request ends. */
  "queued",
]);
export type ChangeStatus = z.infer<typeof ChangeStatus>;

/** A person in a response: user ID and display name (null when unknown). */
export const PersonRef = z.object({ userId: Id, name: z.string().nullable() });
export type PersonRef = z.infer<typeof PersonRef>;

/**
 * Review of a request (ADR 0028). `not_needed`: the request went straight to the system.
 * `proposed`: it waits for an owner or admin. `included` or `declined`: who decided and when;
 * `reason` is the decline reason.
 */
export const ChangeReview = z.object({
  state: z.enum(["not_needed", "proposed", "included", "declined"]),
  decidedBy: PersonRef.nullable(),
  decidedAt: Timestamp.nullable(),
  reason: z.string().nullable(),
});
export type ChangeReview = z.infer<typeof ChangeReview>;

/** `POST /v1/changes/:changeId/decline` request. */
export const DeclineChangeRequest = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type DeclineChangeRequest = z.infer<typeof DeclineChangeRequest>;

/**
 * Result of an include or a decline. A repeat of the same decision returns `repeated: true`;
 * any other status is `refused` with `not_proposed`.
 */
export const ReviewChangeOutcome = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("recorded"),
    changeId: Id,
    status: ChangeStatus,
    repeated: z.boolean(),
  }),
  z.object({
    result: z.literal("refused"),
    reason: z.enum(["not_found", "not_proposed"]),
    detail: z.string(),
  }),
]);
export type ReviewChangeOutcome = z.infer<typeof ReviewChangeOutcome>;

/**
 * One question of a clarification. Each question asks one thing and has its own answer.
 * `options` lists 2 to 4 distinct readings when the system found them; the person picks one or
 * writes something else.
 */
export const ChangeQuestion = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(300)).max(4).optional(),
});
export type ChangeQuestion = z.infer<typeof ChangeQuestion>;

/**
 * Why a Change is `needs_input` (docs/architecture/shared-projects.md). `relatedChangeId` names the
 * duplicate or conflicting Change; null for an unclear request or a duplicate of the current app.
 * `round` is 1 to 3: after the third answer the Change plans without another question.
 */
export const ChangeClarification = z.object({
  kind: z.enum(["unclear", "duplicate", "conflict"]),
  summary: z.string().max(2000),
  questions: z.array(ChangeQuestion).max(3),
  relatedChangeId: Id.nullable(),
  relatedGoal: z.string().nullable(),
  /** Short title of the related Change. The API adds it on read; the stored JSON has none. */
  relatedTitle: z.string().nullable().optional(),
  askedAt: Timestamp,
  round: z.number().int().min(1).max(3),
});
export type ChangeClarification = z.infer<typeof ChangeClarification>;

/**
 * `POST /v1/changes/:changeId/clarify`. The requester or the Project owner answers the questions,
 * asks the system to plan without more questions this round, or withdraws the request.
 */
export const ClarifyChangeRequest = z.union([
  z
    .object({
      answers: z
        .array(
          z.object({
            questionId: z.string().min(1).max(64),
            text: z.string().trim().min(1).max(2000),
          }),
        )
        .min(1)
        .max(3),
    })
    .strict(),
  z.object({ action: z.literal("proceed_anyway") }).strict(),
  z.object({ action: z.literal("withdraw") }).strict(),
]);
export type ClarifyChangeRequest = z.infer<typeof ClarifyChangeRequest>;

/** Result of one clarification command. A repeat of the same answer returns `repeated: true`. */
export const ClarifyChangeOutcome = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("recorded"),
    changeId: Id,
    changeStatus: ChangeStatus,
    action: z.enum(["answers", "proceed_anyway", "withdraw"]),
    round: z.number().int().min(1).max(3),
    repeated: z.boolean(),
  }),
  z.object({
    status: z.literal("refused"),
    reason: z.enum(["not_found", "not_waiting", "unknown_question"]),
    detail: z.string(),
  }),
]);
export type ClarifyChangeOutcome = z.infer<typeof ClarifyChangeOutcome>;

/** Release target after promotion. Canary rollout is deferred. */
export const RolloutPolicy = z.object({
  target: z.enum(["preview", "production"]),
});
export type RolloutPolicy = z.infer<typeof RolloutPolicy>;

/** One user goal that must change the software. */
export const Change = z.object({
  id: Id,
  projectId: Id,
  goal: z.string().min(1).max(4000),
  /** Short display title: the Root Planner's title, else `fallbackTitle(goal)` (change-title.ts). */
  title: z.string().min(1).max(MAX_TITLE_CHARS),
  acceptanceCriteria: z.array(z.string()),
  invariants: z.array(z.string()),
  status: ChangeStatus,
  baseGeneration: CanonicalGeneration,
  workGraphRef: z.string().optional(),
  budgetUsd: z.number().nonnegative(),
  rolloutPolicy: RolloutPolicy,
  review: ChangeReview.optional(),
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
  /** Set while the Change is `needs_input`; null otherwise. */
  clarification: ChangeClarification.nullable().optional(),
  /** Small product details the Root Planner decided (plain sentences); empty before planning. */
  assumptions: z.array(z.string()).optional(),
  /** Which budget the Change draws on, its spend, and the budget that stopped it (ADR 0030). */
  budget: ChangeBudget.optional(),
});
export type ChangeDetail = z.infer<typeof ChangeDetail>;

/**
 * `POST /v1/changes/:changeId/budget` request (a person raises the budget).
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
  /** The Change cap of scope `change`. Left out: the Project default. Ignored for other scopes. */
  budgetUsd: z.number().positive().max(100).default(3),
  /** Which budget pays (ADR 0030). `project` and `account` need that monthly budget set. */
  budgetScope: BudgetScope.default("change"),
  clientRequestId: Id.optional(),
  /** false skips the Root Planner, for example in smoke checks that must not spend model calls. */
  startPlanning: z.boolean().default(true),
});
export type CreateChangeRequest = z.infer<typeof CreateChangeRequest>;
