import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeSummary, FeedEvent, TaskDetail } from "../../lib/api";
import { listProjectEvents } from "../../lib/api";
import { getTimelineTasks, TIMELINE_TASK_BATCH, type TimelineTasks } from "../../lib/api-timeline";
import { isClarifyEvent, LIVE_CHANGE_STATUSES, MARKER_EVENT_TYPES } from "./timeline-model";

/**
 * Data for the Project execution timeline, read through existing API routes and kept current
 * with as few D1 reads as possible (AGENTS.md 7.3, 58):
 *
 * - Tasks: `GET /v1/changes/:id/tasks` per Change, batched in one browser request. A finished
 *   Change is read once more after its status changes, then never again. Changes in flight are
 *   re-read at most every `TASK_MIN_INTERVAL_MS` on a live signal.
 * - Markers: the Project event feed. The first read pages back from the newest event until it
 *   reaches the oldest listed Change or `MAX_BACKFILL_PAGES`; later reads take only events after
 *   the newest `seq` seen. Only marker event types are kept in memory.
 */

const PAGE = 100;
const MAX_BACKFILL_PAGES = 8;
const MAX_FORWARD_PAGES = 5;
const TASK_MIN_INTERVAL_MS = 4_000;

type TaskEntry = { tasks: TaskDetail[] } | { error: string };
type Loaded = { status: string; done: number; total: number };

const keepEvent = (e: FeedEvent) =>
  MARKER_EVENT_TYPES.has(e.eventType) || isClarifyEvent(e.eventType);

/** Cache key of the Tasks a route loader read on the server (lib/ssr-data.ts). */
export const timelineTasksKey = (projectId: string) => ["timeline-tasks", projectId] as const;

/**
 * Tasks per Change, re-read only where something can have changed. When the route loader read
 * the Tasks on the server, the timeline starts from them (and its rows have their final height).
 */
export function useTimelineTasks(projectId: string, changes: ChangeSummary[] | undefined) {
  const queryClient = useQueryClient();
  const [seed] = useState(() => {
    const read = queryClient.getQueryData<TimelineTasks>(timelineTasksKey(projectId));
    const entries = new Map<string, TaskEntry>();
    const seen = new Map<string, Loaded>();
    for (const c of changes ?? []) {
      const entry = read?.[c.id];
      if (!entry || !("tasks" in entry)) continue;
      entries.set(c.id, entry);
      seen.set(c.id, { status: c.status, done: c.completedCount, total: c.taskCount });
    }
    return { entries, seen };
  });
  const [tasks, setTasks] = useState<ReadonlyMap<string, TaskEntry>>(seed.entries);
  const loaded = useRef(seed.seen);
  const state = useRef({ busy: false, again: false, lastLive: 0 });
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const [error, setError] = useState<string | null>(null);

  const sync = useCallback(async (includeLive: boolean) => {
    const s = state.current;
    if (s.busy) {
      s.again = s.again || includeLive;
      return;
    }
    const list = changesRef.current;
    if (!list) return;
    const now = Date.now();
    const liveDue = includeLive && now - s.lastLive >= TASK_MIN_INTERVAL_MS;
    const ids = list
      .filter((c) => {
        const seen = loaded.current.get(c.id);
        if (!seen) return true;
        if (
          seen.status !== c.status ||
          seen.done !== c.completedCount ||
          seen.total !== c.taskCount
        ) {
          return true;
        }
        return liveDue && LIVE_CHANGE_STATUSES.has(c.status);
      })
      .map((c) => c.id);
    if (ids.length === 0) return;
    if (liveDue) s.lastLive = now;
    s.busy = true;
    try {
      for (let i = 0; i < ids.length; i += TIMELINE_TASK_BATCH) {
        const batch = ids.slice(i, i + TIMELINE_TASK_BATCH);
        const result = await getTimelineTasks({ data: batch });
        const snapshot = new Map((changesRef.current ?? []).map((c) => [c.id, c]));
        for (const id of batch) {
          const c = snapshot.get(id);
          const entry = result[id];
          if (c && entry && "tasks" in entry) {
            loaded.current.set(id, {
              status: c.status,
              done: c.completedCount,
              total: c.taskCount,
            });
          }
        }
        setTasks((prev) => {
          const next = new Map(prev);
          for (const [id, entry] of Object.entries(result)) {
            // Keep the last good read when a refresh fails.
            if ("error" in entry && next.has(id) && "tasks" in (next.get(id) as TaskEntry))
              continue;
            next.set(id, entry);
          }
          return next;
        });
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      s.busy = false;
      if (s.again) {
        const live = s.again;
        s.again = false;
        void sync(live);
      }
    }
  }, []);

  // New Changes, a new status or a Task count change: read what changed.
  const signature = changes
    ?.map((c) => `${c.id}:${c.status}:${c.completedCount}:${c.taskCount}`)
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is the trigger
  useEffect(() => {
    void sync(false);
  }, [signature, sync]);

  const refresh = useCallback(() => void sync(true), [sync]);
  return { tasks, error, refresh };
}

/** Marker events of the Project, newest first. */
export function useTimelineEvents(projectId: string, oldestAt: number | null) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** True when the backfill stopped at its page cap before the oldest Change. */
  const [truncated, setTruncated] = useState(false);
  const state = useRef({ cursor: -1, busy: false, again: false, project: projectId });
  const oldestRef = useRef(oldestAt);
  oldestRef.current = oldestAt;

  const merge = useCallback((incoming: FeedEvent[]) => {
    const kept = incoming.filter(keepEvent);
    if (kept.length === 0) return;
    setEvents((prev) => {
      const bySeq = new Map(prev.map((e) => [e.seq, e]));
      for (const e of kept) bySeq.set(e.seq, e);
      return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
    });
  }, []);

  const run = useCallback(async () => {
    const s = state.current;
    if (s.busy) {
      s.again = true;
      return;
    }
    s.busy = true;
    const stale = () => s !== state.current;
    try {
      do {
        s.again = false;
        if (s.cursor < 0) {
          let page = await listProjectEvents({ data: { projectId: s.project, limit: PAGE } });
          if (stale()) return;
          s.cursor = page.nextAfter;
          merge(page.events);
          let pages = 1;
          const reached = () => {
            const oldest = page.events.at(-1);
            const limit = oldestRef.current;
            return !!oldest && limit !== null && Date.parse(oldest.occurredAt) < limit;
          };
          while (page.hasMore && page.nextBefore !== null && !reached()) {
            if (pages >= MAX_BACKFILL_PAGES) {
              setTruncated(true);
              break;
            }
            page = await listProjectEvents({
              data: { projectId: s.project, before: page.nextBefore, limit: PAGE },
            });
            if (stale()) return;
            merge(page.events);
            pages += 1;
          }
        } else {
          for (let i = 0; i < MAX_FORWARD_PAGES; i += 1) {
            const page = await listProjectEvents({
              data: { projectId: s.project, after: s.cursor, limit: PAGE },
            });
            if (stale()) return;
            s.cursor = page.nextAfter;
            merge(page.events);
            if (!page.hasMore) break;
          }
        }
        setError(null);
      } while (s.again);
    } catch (e) {
      if (!stale()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      s.busy = false;
      if (!stale()) setLoading(false);
    }
  }, [merge]);

  // The first read waits for the Change list, so the backfill knows where to stop.
  const ready = oldestAt !== null;
  useEffect(() => {
    if (!ready) return;
    state.current = { cursor: -1, busy: false, again: false, project: projectId };
    setEvents([]);
    setLoading(true);
    setTruncated(false);
    void run();
  }, [projectId, ready, run]);

  const refresh = useCallback(() => {
    if (state.current.cursor >= 0) void run();
  }, [run]);
  return { events, loading, error, truncated, refresh };
}
