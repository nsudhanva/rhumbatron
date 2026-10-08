import type { ProjectViewDO } from "@rhumbatron/coordinator";
import { AnyEventEnvelope, type EventEnvelope } from "@rhumbatron/protocol";

/**
 * Pure event -> ProjectView mapping (AGENTS.md sections 13.3 and 17). No I/O.
 * Summaries never include payload content, only the event type, resource, and actor.
 */

export type ProjectViewDelta = Parameters<ProjectViewDO["applyDelta"]>[0];

const decoder = new TextDecoder();

/**
 * Decodes one K2 record body (standard base64 of the JSON envelope).
 * Returns null for any record that is not a valid envelope. The caller skips and logs it.
 */
export function decodeEnvelope(contentBase64: string): EventEnvelope | null {
  try {
    const binary = atob(contentBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed = AnyEventEnvelope.safeParse(JSON.parse(decoder.decode(bytes)));
    return parsed.success ? (parsed.data as EventEnvelope) : null;
  } catch {
    return null;
  }
}

/** Groups events by project. Keeps first-seen project order and per-project arrival order. */
export function groupByProject(events: EventEnvelope[]): [string, EventEnvelope[]][] {
  const groups = new Map<string, EventEnvelope[]>();
  for (const event of events) {
    const group = groups.get(event.projectId);
    if (group) group.push(event);
    else groups.set(event.projectId, [event]);
  }
  return [...groups];
}

function summarize(event: EventEnvelope): string {
  const resource = event.resource ? ` on ${event.resource}` : "";
  return `${event.eventType}${resource} by ${event.actor.kind}:${event.actor.id}`;
}

function generationOf(event: EventEnvelope): number | undefined {
  if (event.eventType !== "canonical.advanced") return undefined;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const generation = (payload as { toGeneration?: unknown }).toGeneration;
  return typeof generation === "number" && Number.isInteger(generation) && generation >= 0
    ? generation
    : undefined;
}

/**
 * Builds ONE delta for all events of one project in one batch. The view accepts a single
 * `appendEvent` per delta, so the appended event is the newest `canonical.advanced` event when
 * the group has one, else the newest event. The summary notes how many other events it covers.
 * The generation is the highest `toGeneration` in the group, so out-of-order delivery cannot
 * move it backward within one batch.
 */
export function toViewDelta(events: EventEnvelope[]): ProjectViewDelta {
  if (events.length === 0) return {};
  const byTime = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || 0);
  const advanced = byTime.filter((event) => generationOf(event) !== undefined);
  const chosen = advanced.at(-1) ?? byTime.at(-1);
  if (!chosen) return {};

  const others = events.length - 1;
  const summary = others > 0 ? `${summarize(chosen)} (+${others} more)` : summarize(chosen);
  const delta: ProjectViewDelta = {
    appendEvent: {
      eventId: chosen.eventId,
      eventType: chosen.eventType,
      timestamp: new Date(chosen.timestamp).toISOString(),
      summary,
    },
  };
  const generations = advanced.map((event) => generationOf(event) ?? 0);
  if (generations.length > 0) delta.canonicalGeneration = Math.max(...generations);
  return delta;
}

/**
 * Subrequest cap: take at most `remaining` project groups. The rest are deferred, which the
 * caller must release and nack so K2 redelivers them (section 42.1 and rule 50).
 */
export function planProjects<T>(
  groups: readonly T[],
  remaining: number,
): { selected: T[]; deferred: T[] } {
  const cap = Math.max(0, Math.floor(remaining));
  return { selected: groups.slice(0, cap), deferred: groups.slice(cap) };
}
