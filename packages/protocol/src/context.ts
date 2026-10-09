import { z } from "zod";
import { CanonicalGeneration, Id, Timestamp } from "./common.ts";

/**
 * Context Packet (AGENTS.md section 27). Built by deterministic code before the first model call;
 * a model never chooses its own scope. Every item carries provenance (section 27.5), so two
 * agents with the same snapshot hash had the same inputs.
 */

export const ContextSource = z.enum([
  "change",
  "task",
  "dependency_intent",
  "dependency_changeset",
  "nearby_intent",
  "prior_failure",
  "policy",
  "file",
  "symbol",
  "product_graph",
  /** Conflict review packets (P9-05): typed Intent fields, ChangeSet stats, detector signals. */
  "intent",
  "changeset",
  "conflict_signal",
  "conflict_review",
]);
export type ContextSource = z.infer<typeof ContextSource>;

export const ContextItem = z.object({
  itemId: Id,
  source: ContextSource,
  /** Version of the source when captured, for example a run ID, a commit, or a row timestamp. */
  sourceVersion: z.string(),
  capturedAt: Timestamp,
  title: z.string(),
  body: z.string(),
});
export type ContextItem = z.infer<typeof ContextItem>;

export const ContextPacket = z.object({
  packetVersion: z.literal(1),
  projectId: Id,
  changeId: Id,
  taskId: Id,
  canonicalGeneration: CanonicalGeneration,
  /** Fixed by application code: the model cannot widen them. */
  allowedTools: z.array(z.string()),
  relevantResources: z.array(z.string()),
  items: z.array(ContextItem),
  budget: z.object({
    maxModelCalls: z.number().int().nonnegative(),
    budgetUsd: z.number().nonnegative(),
  }),
  tokenEstimate: z.number().int().nonnegative(),
});
export type ContextPacket = z.infer<typeof ContextPacket>;
