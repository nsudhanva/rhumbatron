import { ChangeSetIntent } from "@rhumbatron/protocol";

/**
 * Stacked workspaces (AGENTS.md sections 26 `dependOn`, 29.2, 33). A Task with dependencies starts
 * from canonical plus its dependencies' published ChangeSets, not from bare canonical, so it
 * extends their source instead of re-creating it. Pure: callers load the rows.
 */

/** One dependency ChangeSet merged into a workspace before the agent's first edit. */
export type StackSource = {
  changeSetId: string;
  taskId: string;
  /** Artifacts fork that holds the ChangeSet commit. */
  fork: string;
  commit: string;
  /** Files that differ from the canonical base in that commit. */
  files: string[];
};

/** A `changesets` row joined to the Task whose run published it. */
export type ChangeSetRowForStack = {
  id: string;
  task_id: string;
  intent_json: string;
  created_at: string;
};

export type DependencyEdge = { task_id: string; depends_on_task_id: string };

const SHA = /^[0-9a-f]{40}$/;
const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * The ChangeSets a Task's workspace stacks on: every Task it depends on, transitively, that
 * published source, in topological order (dependencies first). Ties break on ChangeSet creation
 * time, then Task ID, so a restore after Sandbox loss repeats the same merges (section 42.5).
 * Intent-only dependencies (no committed source) are walked through but merge nothing. When a Task
 * has several ChangeSets, the latest one counts. Throws on a stored fork or commit that is not
 * safe to pass to git.
 */
export function stackFor(
  taskId: string,
  edges: readonly DependencyEdge[],
  rows: readonly ChangeSetRowForStack[],
): StackSource[] {
  const parents = new Map<string, string[]>();
  for (const e of edges) {
    parents.set(e.task_id, [...(parents.get(e.task_id) ?? []), e.depends_on_task_id]);
  }
  const closure = new Set<string>();
  const queue = [...(parents.get(taskId) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (next === taskId || closure.has(next)) continue;
    closure.add(next);
    queue.push(...(parents.get(next) ?? []));
  }

  const published = new Map<string, StackSource & { createdAt: string }>();
  const sorted = [...rows].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
  );
  for (const row of sorted) {
    if (!closure.has(row.task_id)) continue;
    const parsed = ChangeSetIntent.safeParse(JSON.parse(row.intent_json));
    const cs = parsed.success ? parsed.data.changeSet : undefined;
    if (!cs) continue;
    if (!SHA.test(cs.commit) || !REPO_NAME.test(cs.fork)) {
      throw new Error(`ChangeSet ${row.id} has an invalid fork or commit`);
    }
    published.set(row.task_id, {
      changeSetId: row.id,
      taskId: row.task_id,
      fork: cs.fork,
      commit: cs.commit,
      files: cs.files,
      createdAt: row.created_at,
    });
  }

  // Kahn's algorithm over the dependency closure; the ready Task with the earliest key goes first.
  const sortKey = (id: string) => `${published.get(id)?.createdAt ?? ""}\u0000${id}`;
  const pending = new Map(
    [...closure].map((id) => [id, (parents.get(id) ?? []).filter((p) => closure.has(p))]),
  );
  const done = new Set<string>();
  const order: string[] = [];
  while (pending.size > 0) {
    const ready = [...pending.keys()]
      .filter((id) => (pending.get(id) ?? []).every((p) => done.has(p)))
      .sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
    // A validated Work Graph has no cycle; fall back to key order rather than loop.
    const next =
      ready[0] ?? [...pending.keys()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))[0];
    if (next === undefined) break;
    pending.delete(next);
    done.add(next);
    order.push(next);
  }
  return order.flatMap((id) => {
    const source = published.get(id);
    if (!source) return [];
    const { createdAt: _, ...rest } = source;
    return [rest];
  });
}
