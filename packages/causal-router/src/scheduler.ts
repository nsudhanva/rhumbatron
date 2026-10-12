// Exact Work Graph scheduling (P5-04). Pure; unknown dependencies are never done.
import type { TaskStatus } from "@rhumbatron/protocol";

export type GraphTask = { id: string; status: TaskStatus; dependsOn: readonly string[] };

function depsDone(task: GraphTask, status: ReadonlyMap<string, TaskStatus>): boolean {
  return task.dependsOn.every((dep) => status.get(dep) === "completed");
}

/** Pending Tasks whose dependencies are all completed, in input order. */
export function readyTaskIds(tasks: readonly GraphTask[]): string[] {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  return tasks.filter((t) => t.status === "pending" && depsDone(t, status)).map((t) => t.id);
}

/** Direct dependents of a just-completed Task that became ready. The input status may be stale. */
export function newlyReadyAfter(completedTaskId: string, tasks: readonly GraphTask[]): string[] {
  const status = new Map(tasks.map((t) => [t.id, t.status]));
  status.set(completedTaskId, "completed");
  return tasks
    .filter(
      (t) => t.status === "pending" && t.dependsOn.includes(completedTaskId) && depsDone(t, status),
    )
    .map((t) => t.id);
}

/** Pending transitive dependents of a failed Task; they can never become ready. */
export function blockedByFailure(failedTaskId: string, tasks: readonly GraphTask[]): string[] {
  const dead = new Set([failedTaskId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const t of tasks) {
      if (!dead.has(t.id) && t.dependsOn.some((d) => dead.has(d))) {
        dead.add(t.id);
        grew = true;
      }
    }
  }
  return tasks
    .filter((t) => t.id !== failedTaskId && dead.has(t.id) && t.status === "pending")
    .map((t) => t.id);
}
