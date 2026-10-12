import type { AgentView, ChangeSummary } from "../../lib/api";
import { type DagFilter, EMPTY_FILTER, inTimeRange } from "../dag/model";

/**
 * Changes in scope of the agents graph. A module of its own, without the graph's React Flow
 * imports: the route loader (routes/projects_.$projectId.agents.tsx) runs in the router's main
 * chunk, and every page loads that chunk.
 */

/** At most this many Changes in scope, so the D1 reads stay small. */
export const MAX_CHANGES = 4;

/**
 * Changes in scope: the chosen Change, else Changes with listed agents active in the range, else
 * the newest Change. Person narrows every choice. At most MAX_CHANGES. The route loader reads
 * the Task and conflict lists of the same Changes on the server (`EMPTY_FILTER`).
 */
export function changesInScope(
  changes: ChangeSummary[],
  agents: AgentView[],
  filter: DagFilter = EMPTY_FILTER,
): ChangeSummary[] {
  const byPerson = changes.filter(
    (c) => filter.person === null || c.requester?.userId === filter.person,
  );
  if (filter.changeId) return byPerson.filter((c) => c.id === filter.changeId);
  const withAgents = new Set(
    agents.filter((a) => inTimeRange(a.lastActiveAt, filter.range)).map((a) => a.task.changeId),
  );
  const active = byPerson.filter((c) => withAgents.has(c.id));
  const inRange = byPerson.filter((c) => inTimeRange(c.createdAt, filter.range));
  return (active.length > 0 ? active : inRange.slice(0, 1)).slice(0, MAX_CHANGES);
}
