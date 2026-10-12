import { z } from "zod";

/**
 * Pure read-model logic for ProjectViewDO.
 * No I/O. The web app can import `detectGap` and the message schemas later.
 */

export const MAX_RECENT_EVENTS = 50;

const Id = z.string().min(1);

/**
 * A small list item: an id plus a status. `label` is optional display text. `changeId` links a
 * Task or Agent item to its Change, so a client can tell which Change a delta touches.
 */
const ViewItem = z.object({
  id: Id,
  status: z.string().min(1),
  label: z.string().optional(),
  changeId: Id.optional(),
});
type ViewItem = z.infer<typeof ViewItem>;

export const RecentEvent = z.object({
  eventId: Id,
  eventType: Id,
  timestamp: z.iso.datetime(),
  summary: z.string(),
});
export type RecentEvent = z.infer<typeof RecentEvent>;

const CostSummary = z.object({
  spentUsd: z.number().nonnegative(),
  budgetUsd: z.number().nonnegative(),
});

export const ProjectViewSnapshot = z.object({
  project: z.object({ id: Id, name: z.string() }),
  canonicalGeneration: z.number().int().nonnegative(),
  activeChanges: z.array(ViewItem),
  activeTasks: z.array(ViewItem),
  activeAgents: z.array(ViewItem),
  candidateSummary: z.array(ViewItem),
  verificationSummary: z.array(ViewItem),
  costSummary: CostSummary,
  /** Newest first. At most MAX_RECENT_EVENTS entries. */
  recentEvents: z.array(RecentEvent).max(MAX_RECENT_EVENTS),
});
export type ProjectViewSnapshot = z.infer<typeof ProjectViewSnapshot>;

/** The list fields that hold ViewItems. */
const LIST_KEYS = [
  "activeChanges",
  "activeTasks",
  "activeAgents",
  "candidateSummary",
  "verificationSummary",
] as const;

const Items = z.array(ViewItem).optional();
const Ids = z.array(Id).optional();

/** A typed partial update. Every field is optional. */
export const ProjectViewDelta = z.object({
  canonicalGeneration: z.number().int().nonnegative().optional(),
  costSummary: CostSummary.partial().optional(),
  /** Insert items by id, or merge into an existing item (omitted fields keep their value). */
  upsert: z
    .object({
      activeChanges: Items,
      activeTasks: Items,
      activeAgents: Items,
      candidateSummary: Items,
      verificationSummary: Items,
    })
    .optional(),
  /** Remove items by id. */
  remove: z
    .object({
      activeChanges: Ids,
      activeTasks: Ids,
      activeAgents: Ids,
      candidateSummary: Ids,
      verificationSummary: Ids,
    })
    .optional(),
  /** One important event to add to the head of `recentEvents`. */
  appendEvent: RecentEvent.optional(),
});
export type ProjectViewDelta = z.infer<typeof ProjectViewDelta>;

export function emptySnapshot(input: {
  projectId: string;
  name: string;
  canonicalGeneration: number;
}): ProjectViewSnapshot {
  return ProjectViewSnapshot.parse({
    project: { id: input.projectId, name: input.name },
    canonicalGeneration: input.canonicalGeneration,
    activeChanges: [],
    activeTasks: [],
    activeAgents: [],
    candidateSummary: [],
    verificationSummary: [],
    costSummary: { spentUsd: 0, budgetUsd: 0 },
    recentEvents: [],
  });
}

function upsertItems(list: ViewItem[], incoming: ViewItem[]): ViewItem[] {
  const next = [...list];
  for (const item of incoming) {
    const index = next.findIndex((existing) => existing.id === item.id);
    const existing = next[index];
    if (existing) next[index] = { ...existing, ...item };
    else next.push(item);
  }
  return next;
}

/**
 * Returns a new snapshot. Order within one delta: upsert, then remove, so a removal wins.
 * An upsert merges into an existing item, so a status-only update keeps the item's label.
 * An event whose `eventId` is already in `recentEvents` is ignored (duplicate delivery).
 */
export function applyDelta(
  snapshot: ProjectViewSnapshot,
  delta: ProjectViewDelta,
): ProjectViewSnapshot {
  const next: ProjectViewSnapshot = { ...snapshot };

  if (delta.canonicalGeneration !== undefined) next.canonicalGeneration = delta.canonicalGeneration;
  if (delta.costSummary) {
    next.costSummary = {
      spentUsd: delta.costSummary.spentUsd ?? snapshot.costSummary.spentUsd,
      budgetUsd: delta.costSummary.budgetUsd ?? snapshot.costSummary.budgetUsd,
    };
  }

  for (const key of LIST_KEYS) {
    let list = snapshot[key];
    const upserts = delta.upsert?.[key];
    const removals = delta.remove?.[key];
    if (upserts) list = upsertItems(list, upserts);
    if (removals) {
      const removed = new Set(removals);
      list = list.filter((item) => !removed.has(item.id));
    }
    next[key] = list;
  }

  const event = delta.appendEvent;
  if (event && !snapshot.recentEvents.some((e) => e.eventId === event.eventId)) {
    next.recentEvents = [event, ...snapshot.recentEvents].slice(0, MAX_RECENT_EVENTS);
  }

  return next;
}

/** Client protocol: compare the last sequence seen with an incoming one. */
export function detectGap(lastSeen: number, incoming: number): "ok" | "gap" | "duplicate" {
  if (incoming <= lastSeen) return "duplicate";
  if (incoming === lastSeen + 1) return "ok";
  return "gap";
}

export type SnapshotMessage = {
  type: "snapshot";
  sequence: number;
  project: ProjectViewSnapshot;
};
export type DeltaMessage = {
  type: "delta";
  sequence: number;
  changes: ProjectViewDelta;
};

/** A client can send this to ask for a fresh snapshot, for example after a sequence gap. */
export const ClientMessage = z.object({ type: z.literal("snapshot.request") });
export type ClientMessage = z.infer<typeof ClientMessage>;

export const snapshotMessage = (
  sequence: number,
  project: ProjectViewSnapshot,
): SnapshotMessage => ({ type: "snapshot", sequence, project });

export const deltaMessage = (sequence: number, changes: ProjectViewDelta): DeltaMessage => ({
  type: "delta",
  sequence,
  changes,
});
