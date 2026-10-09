import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { Actor } from "./event.ts";
import { RelativeResource } from "./work-graph.ts";

/**
 * Typed coordination state (AGENTS.md sections 26 and 32). Agents coordinate through these
 * records, never through free-form chat. Semantic resources are plan-relative
 * (`wishlist:membership`) or absolute (`project:acme:wishlist:membership`).
 */

export const ChangeKind = z.enum(["add", "modify", "remove"]);
export type ChangeKind = z.infer<typeof ChangeKind>;

/** One expected API, event, schema, or symbol contract change. */
export const ContractChange = z.object({
  /** Normalized target, for example `POST /v1/wishlists/:param/members` or `WishlistService.share`. */
  target: z.string().min(1).max(300),
  kind: ChangeKind,
  /** Normalized shape signature. Two changes with equal shapes agree; unknown when absent. */
  shape: z.string().max(2000).optional(),
  description: z.string().max(2000),
});
export type ContractChange = z.infer<typeof ContractChange>;

/** How a data entity stores state. `append_only` and the mutable models have different semantics. */
export const DataModel = z.enum([
  "mutable_table",
  "append_only",
  "key_value",
  "document",
  "unspecified",
]);
export type DataModel = z.infer<typeof DataModel>;

/** One expected table, column, or stored-data change. */
export const DataChange = z.object({
  /** Normalized entity name, for example `wishlist_members`. */
  entity: z.string().min(1).max(200),
  kind: ChangeKind,
  model: DataModel,
  description: z.string().max(2000),
});
export type DataChange = z.infer<typeof DataChange>;

/** What an agent plans to change (section 26.1). */
export const Intent = z.object({
  intentId: Id,
  taskId: Id,
  agentId: Id,
  summary: z.string().min(1).max(2000),
  semanticResources: z.array(RelativeResource).max(10),
  expectedFiles: z.array(z.string().min(1).max(300)).max(50),
  expectedSymbols: z.array(z.string().min(1).max(300)).max(50),
  expectedContractChanges: z.array(ContractChange).max(20),
  expectedDataChanges: z.array(DataChange).max(20),
  expectedSideEffects: z.array(z.string().max(500)).max(20),
  assumptions: z.array(z.string().max(500)).max(20),
  createdAt: Timestamp,
});
export type Intent = z.infer<typeof Intent>;

export const ChallengeKind = z.enum([
  "contract_conflict",
  "data_semantics_conflict",
  "security_conflict",
  "invariant_risk",
  "performance_risk",
  "dependency_conflict",
  "design_alternative",
]);
export type ChallengeKind = z.infer<typeof ChallengeKind>;

/** A typed objection to an Intent or ChangeSet (section 26.2). */
export const Challenge = z.object({
  challengeId: Id,
  sourceAgentId: Id,
  targetIntentId: Id.optional(),
  targetChangeSetId: Id.optional(),
  semanticResource: RelativeResource,
  kind: ChallengeKind,
  summary: z.string().min(1).max(2000),
  evidenceRefs: z.array(Id).max(20),
  proposedResolution: z.string().max(2000).optional(),
});
export type Challenge = z.infer<typeof Challenge>;

/** How a Challenge ended. `forked` means Candidates were created so evidence can decide. */
export const ChallengeResolution = z.object({
  outcome: z.enum(["upheld", "dismissed", "forked", "withdrawn"]),
  summary: z.string().min(1).max(2000),
  resolvedBy: Actor,
});
export type ChallengeResolution = z.infer<typeof ChallengeResolution>;

/** Conflict lifecycle (section 32.2). */
export const ConflictState = z.enum([
  "none",
  "suspected",
  "confirmed",
  "fork_required",
  "resolved",
]);
export type ConflictState = z.infer<typeof ConflictState>;

export const ConflictSignalKind = z.enum([
  "resource_overlap",
  "file_overlap",
  "contract_conflict",
  "contract_overlap",
  "data_model_conflict",
  "data_overlap",
  "assumption_conflict",
  "invariant_reference",
]);
export type ConflictSignalKind = z.infer<typeof ConflictSignalKind>;

/** `benign` can be dismissed, `soft` needs review, `hard` is a confirmed semantic conflict. */
export const ConflictSeverity = z.enum(["benign", "soft", "hard"]);
export type ConflictSeverity = z.infer<typeof ConflictSeverity>;

export const ConflictSignal = z.object({
  kind: ConflictSignalKind,
  severity: ConflictSeverity,
  detail: z.string().max(2000),
  /** Pointers into the Intents, for example `intent:<intentId>:data:0`. */
  evidenceRefs: z.array(z.string().max(300)),
});
export type ConflictSignal = z.infer<typeof ConflictSignal>;

export const ConflictAction = z.enum(["dismiss", "review", "fork_candidates"]);
export type ConflictAction = z.infer<typeof ConflictAction>;

/** Deterministic first-pass result for one pair of Intents (section 32.3). */
export const ConflictReport = z.object({
  /** Sorted pair: `intentIds[0] < intentIds[1]`. */
  intentIds: z.tuple([Id, Id]),
  /** The most specific shared resource, or the first resource of `intentIds[0]` when none is shared. */
  resource: RelativeResource,
  signals: z.array(ConflictSignal),
  state: ConflictState,
  recommendedAction: ConflictAction,
});
export type ConflictReport = z.infer<typeof ConflictReport>;
