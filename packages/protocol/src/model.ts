import { z } from "zod";
import { Complexity, Id, ModelTier, RiskTier, Timestamp } from "./common.ts";

/** Routing input for one meaningful reasoning step. */
export const RouteRequest = z.object({
  taskKind: z.string().min(1),
  complexity: Complexity,
  riskTier: RiskTier,
  affectedFiles: z.number().int().nonnegative(),
  affectedResources: z.array(z.string()),
  attempt: z.number().int().positive(),
  priorFailureKinds: z.array(z.string()),
  hasDesignConflict: z.boolean(),
  touchesAuthorization: z.boolean(),
  touchesBilling: z.boolean(),
  touchesMigration: z.boolean(),
  destructiveMigration: z.boolean(),
  contextTokensEstimate: z.number().int().nonnegative(),
  expectedToolCalls: z.number().int().nonnegative(),
  budgetRemainingUsd: z.number().nonnegative(),
});
export type RouteRequest = z.infer<typeof RouteRequest>;

export const RouteDecision = z.object({
  selectedTier: ModelTier,
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  maxOutputTokens: z.number().int().positive(),
  maxAttemptsAtTier: z.number().int().positive(),
  escalateOn: z.array(z.string()),
});
export type RouteDecision = z.infer<typeof RouteDecision>;

/** Structured record of a model route. Never contains private reasoning. */
export const DecisionReceipt = z.object({
  decisionType: z.literal("MODEL_ROUTE"),
  taskId: Id,
  agentId: Id,
  decidedBy: z.enum(["rules", "clef"]),
  selectedTier: ModelTier,
  selectedModels: z.array(z.string()),
  /** The tier the rules or Clef chose when policy lowered it (ADR 0021: Opus off). */
  requestedTier: ModelTier.optional(),
  downgradeReason: z.literal("opus_disabled").optional(),
  reasons: z.array(z.string()),
  signals: z.record(z.string(), z.unknown()),
  escalateOn: z.array(z.string()),
  createdAt: Timestamp,
});
export type DecisionReceipt = z.infer<typeof DecisionReceipt>;
