import type { ProjectViewDO } from "@rhumbatron/coordinator";
import { AnyEventEnvelope, type EventEnvelope } from "@rhumbatron/protocol";

/**
 * Pure event -> ProjectView mapping. No I/O.
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

/** Status after each lifecycle event. `null` removes the item from the active list. */
type StatusMap = Partial<Record<EventEnvelope["eventType"], string | null>>;

const TASK_STATUS: StatusMap = {
  "task.created": "pending",
  "task.ready": "ready",
  "task.assigned": "assigned",
  "task.started": "running",
  "task.completed": null,
  "task.failed": "failed",
};

const CHANGE_STATUS: StatusMap = {
  "change.created": "created",
  // Request review (ADR 0028): a member's request waits, then starts or ends.
  "change.proposed": "proposed",
  "change.included": "created",
  "change.declined": null,
  "change.compiled": "running",
  "verification.started": "verifying",
  // Complementary Tasks integrate: the dependent Task re-runs before any Candidate composes.
  "conflict.integrated": "running",
  // The D1 row is authoritative (integration change-status.ts); these mirror its unambiguous steps.
  "approval.requested": "awaiting_approval",
  "canonical.promotion.requested": "promoting",
  // A live app's ReleaseWorkflow started; promotion without one ends with change.completed.
  "build.started": "releasing",
  "change.cancelled": null,
  "change.completed": null,
  "change.failed": null,
};

/**
 * Intake and request-check events carry the resulting status in their payload: a question to the
 * requester shows the Change as `needs_input` until the answer arrives.
 */
function changeStatusOf(event: EventEnvelope): string | null | undefined {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (event.eventType) {
    case "change.intake.reviewed":
      return payload.decision === "ask" ? "needs_input" : "compiling";
    case "change.clarification.answered":
      return payload.action === "withdraw" ? null : "compiling";
    case "conflict.reviewed":
      return event.taskId === undefined && payload.status === "needs_input"
        ? "needs_input"
        : undefined;
    default:
      return CHANGE_STATUS[event.eventType];
  }
}

/** An Agent sleeps when its Task ends. */
const AGENT_STATUS: StatusMap = {
  "agent.woken": "awake",
  "task.started": "working",
  "task.completed": null,
  "task.failed": null,
  "agent.slept": null,
};

type ListName = "activeChanges" | "activeTasks" | "activeAgents";
type Latest = Map<string, { status: string | null; changeId?: string }>;

/** Last status per item id. Events must arrive in time order, so the newest event wins. */
function latestStatuses(events: EventEnvelope[]): Record<ListName, Latest> {
  const lists: Record<ListName, Latest> = {
    activeChanges: new Map(),
    activeTasks: new Map(),
    activeAgents: new Map(),
  };
  const note = (
    list: ListName,
    id: string | undefined,
    status: string | null | undefined,
    changeId?: string,
  ) => {
    if (!id || status === undefined) return;
    lists[list].set(id, { status, ...(changeId ? { changeId } : {}) });
  };
  for (const event of events) {
    note("activeChanges", event.changeId, changeStatusOf(event));
    note("activeTasks", event.taskId, TASK_STATUS[event.eventType], event.changeId);
    if (event.actor.kind === "agent") {
      note("activeAgents", event.actor.id, AGENT_STATUS[event.eventType], event.changeId);
    }
  }
  return lists;
}

/** Adds upserts and removals for task, change, and agent lifecycle events to `delta`. */
function addLifecycle(delta: ProjectViewDelta, events: EventEnvelope[]) {
  const upsert: NonNullable<ProjectViewDelta["upsert"]> = {};
  const remove: NonNullable<ProjectViewDelta["remove"]> = {};
  for (const [list, latest] of Object.entries(latestStatuses(events)) as [ListName, Latest][]) {
    const items = [];
    const ids = [];
    for (const [id, { status, changeId }] of latest) {
      if (status === null) ids.push(id);
      else items.push({ id, status, ...(changeId ? { changeId } : {}) });
    }
    if (items.length > 0) upsert[list] = items;
    if (ids.length > 0) remove[list] = ids;
  }
  if (Object.keys(upsert).length > 0) delta.upsert = upsert;
  if (Object.keys(remove).length > 0) delta.remove = remove;
}

/**
 * Builds ONE delta for all events of one project in one batch. The view accepts a single
 * `appendEvent` per delta, so the appended event is the newest `canonical.advanced` event when
 * the group has one, else the newest event. The summary notes how many other events it covers.
 * The generation is the highest `toGeneration` in the group, so out-of-order delivery cannot
 * move it backward within one batch. Task, Change, and Agent lifecycle events also update the
 * active lists; within one batch the newest event per item wins. Statuses never come from payloads.
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
  addLifecycle(delta, byTime);
  return delta;
}

/**
 * Subrequest cap: take at most `remaining` project groups. The rest are deferred, which the
 * caller must release and nack so K2 redelivers them.
 */
export function planProjects<T>(
  groups: readonly T[],
  remaining: number,
): { selected: T[]; deferred: T[] } {
  const cap = Math.max(0, Math.floor(remaining));
  return { selected: groups.slice(0, cap), deferred: groups.slice(cap) };
}
