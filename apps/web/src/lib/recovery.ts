/**
 * Recovered failures: one rule for every page that shows a Task attempt or a `task.failed` event.
 *
 * A failed attempt is not always a failed Task. The system retries, escalates, or rebases and
 * re-runs the same Task (for example after `dependency_merge_conflict`). So a failure reads as:
 *
 *   recovered  a later attempt of the same Task completed (or the Task completed)
 *              -> "Retried, recovered", attention (amber), never red
 *   retrying   a later attempt runs, or the Task is queued or running again
 *              -> "Failed, retrying", attention (amber)
 *   failed     nothing later recovered it -> "Fail", danger (red)
 *
 * Only `failed` is red. The rule reads data every page already has: the Task status and its
 * attempts (`task.runs`), or the `task.failed` and `task.completed` events of the feed. The words
 * and families live in the shared status vocabulary: `statusView(outcome)` (components/ui).
 */
export type FailureOutcome = "failed" | "retrying" | "recovered";

type Attempt = { attempt: number; status: string };

/** Task statuses that mean another attempt is queued or runs now (`retrying`: a folded lane). */
const AGAIN = new Set(["pending", "ready", "assigned", "running", "retrying"]);

/**
 * The outcome of the failed attempt `run` among all attempts of its Task. `taskStatus` is the
 * Task status at the same instant as `runs` (omit it when only the attempts are known).
 */
export function failureOutcome(
  run: Attempt,
  runs: readonly Attempt[],
  taskStatus?: string | null,
): FailureOutcome {
  let later = false;
  for (const r of runs) {
    if (r.attempt <= run.attempt) continue;
    if (r.status === "completed") return "recovered";
    if (r.status === "running") later = true;
  }
  if (taskStatus === "completed") return "recovered";
  if (taskStatus === "failed" || taskStatus === "cancelled" || taskStatus === "blocked") {
    return "failed";
  }
  return later || (taskStatus != null && AGAIN.has(taskStatus)) ? "retrying" : "failed";
}

type FeedFact = {
  eventId: string;
  eventType: string;
  taskId: string | null;
  occurredAt: string;
  seq?: number;
};

/** Feed order: the sequence number when both facts carry one, else the recorded time. */
const after = (a: FeedFact, b: FeedFact) =>
  typeof a.seq === "number" && typeof b.seq === "number"
    ? a.seq > b.seq
    : Date.parse(a.occurredAt) > Date.parse(b.occurredAt);

/**
 * Event IDs of `task.failed` events that a later `task.completed` of the same Task recovered.
 * Any order of `events` works (feeds are newest first).
 */
export function recoveredTaskFailures(events: readonly FeedFact[]): Set<string> {
  const completed = new Map<string, FeedFact>();
  for (const e of events) {
    if (e.eventType !== "task.completed" || !e.taskId) continue;
    const seen = completed.get(e.taskId);
    if (!seen || after(e, seen)) completed.set(e.taskId, e);
  }
  const out = new Set<string>();
  for (const e of events) {
    if (e.eventType !== "task.failed" || !e.taskId) continue;
    const done = completed.get(e.taskId);
    if (done && after(done, e)) out.add(e.eventId);
  }
  return out;
}
