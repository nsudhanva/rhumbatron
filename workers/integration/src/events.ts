import type { ResourceShardDO } from "@rhumbatron/coordinator";
import { shardKey } from "@rhumbatron/coordinator/shard-key";
import type { EventEnvelope, EventType } from "@rhumbatron/protocol";

/** Context shared by every event of one Change. */
export type ChangeContext = {
  projectId: string;
  orgId: string;
  projectSlug: string;
  changeId: string;
  baseGeneration: number;
};

/** Stable event ID from its identity, so a retried step republishes the same event. */
export async function stableEventId(...parts: string[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join("\u0000"));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `evt_${[...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Qualifies a plan-relative resource with the Project, for example `project:acme-shop:cart`. */
export const qualify = (ctx: ChangeContext, resource: string) =>
  `project:${ctx.projectSlug}:${resource}`;

export async function changeEvent<T>(
  ctx: ChangeContext,
  eventType: EventType,
  payload: T,
  extra: { taskId?: string; resource?: string; actor?: EventEnvelope["actor"] } = {},
): Promise<EventEnvelope<T>> {
  return {
    eventId: await stableEventId(ctx.changeId, eventType, extra.taskId ?? ""),
    eventType,
    eventVersion: 1,
    tenantId: ctx.orgId,
    projectId: ctx.projectId,
    changeId: ctx.changeId,
    ...(extra.taskId ? { taskId: extra.taskId } : {}),
    ...(extra.resource ? { resource: extra.resource } : {}),
    actor: extra.actor ?? { kind: "system", id: "change-workflow" },
    canonicalGeneration: ctx.baseGeneration,
    correlationId: ctx.changeId,
    timestamp: new Date().toISOString(),
    payload,
  };
}

/**
 * Change events go to the ResourceShardDO that owns `change:<id>`, which keeps ProjectRootDO cold
 * (AGENTS.md section 13.1). The shard outbox publishes to K2 and dedupes on event ID.
 */
export async function appendChangeEvents(
  shards: DurableObjectNamespace,
  ctx: ChangeContext,
  events: EventEnvelope[],
) {
  if (events.length === 0) return;
  const ns = shards as DurableObjectNamespace<ResourceShardDO>;
  const shard = ns.get(ns.idFromName(shardKey(ctx.projectId, `change:${ctx.changeId}`)));
  await shard.appendEvents(events);
}
