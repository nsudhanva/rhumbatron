import { z } from "zod";
import { CanonicalGeneration, Id, SemanticResource, Timestamp } from "./common.ts";

/** Initial Event types. Dot-separated. Events are facts, never commands. */
export const EVENT_TYPES = [
  "project.created",
  "change.created",
  "change.compiled",
  "change.cancelled",
  /** A Change reached `completed` after promotion: no live app, or its release finished. */
  "change.completed",
  /** A Change reached `failed` after promotion: its release did not deploy or never started. */
  "change.failed",
  "task.created",
  "task.ready",
  "task.assigned",
  "task.started",
  "task.completed",
  "task.failed",
  "claim.acquired",
  "claim.renewed",
  "claim.released",
  "claim.expired",
  /** Advisory Claims (ADR 0015): another agent holds a live Claim; the requester ran anyway. */
  "claim.contended",
  "intent.declared",
  "intent.changed",
  "challenge.created",
  "challenge.resolved",
  /** A model review (Sonnet, then Opus on escalation) of one semantic conflict (P9-05, P9-06). */
  "conflict.reviewed",
  "changeset.proposed",
  "changeset.accepted",
  "changeset.rejected",
  "candidate.forked",
  "candidate.composed",
  "candidate.stale",
  "candidate.rebase_requested",
  "verification.started",
  "verification.check.completed",
  "verification.completed",
  "preview.ready",
  "approval.requested",
  "approval.granted",
  "approval.rejected",
  "canonical.promotion.requested",
  "canonical.advanced",
  "artifact.promoted",
  "build.started",
  "build.completed",
  "deployment.started",
  "deployment.completed",
  /** A release did not deploy: no bundle, or the production pointer did not move (ADR 0020). */
  "deployment.failed",
  /** A release deployed, but its smoke check did not pass (sections 21.3, 42.10). */
  "release.smoke_failed",
  "test.failed",
  "security.check.failed",
  "performance.check.failed",
  "agent.woken",
  "agent.slept",
  "agent.escalated",
  "model.route.decided",
] as const;

export const EventType = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof EventType>;

export const Actor = z.object({
  kind: z.enum(["user", "agent", "system"]),
  id: Id,
});
export type Actor = z.infer<typeof Actor>;

/**
 * Envelope for every Event. `eventId` is generated before publication and
 * reused on retry. Payloads must not contain secrets or private reasoning.
 */
export const eventEnvelope = <T extends z.ZodType>(payload: T) =>
  z.object({
    eventId: Id,
    eventType: EventType,
    eventVersion: z.number().int().positive(),
    tenantId: Id,
    projectId: Id,
    changeId: Id.optional(),
    taskId: Id.optional(),
    actor: Actor,
    resource: SemanticResource.optional(),
    canonicalGeneration: CanonicalGeneration,
    causedBy: Id.optional(),
    correlationId: Id,
    timestamp: Timestamp,
    payload,
  });

export const AnyEventEnvelope = eventEnvelope(z.unknown());
export type EventEnvelope<T = unknown> = Omit<z.infer<typeof AnyEventEnvelope>, "payload"> & {
  payload: T;
};
