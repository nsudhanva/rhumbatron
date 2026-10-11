import type { QueryClient } from "@tanstack/react-query";
import {
  getChangeClaims,
  getChangeProgress,
  getConflicts,
  getDeadLetters,
  getProjectApp,
  getRequestConflicts,
  listCandidateEvidence,
  listCandidates,
  listChangeSets,
  listTasks,
} from "../../lib/api";
import { loadChange, prefetch, prefetchFeed } from "../../lib/ssr-data";

/**
 * Server-rendered data of the Change page and Flight Control (lib/ssr-data.ts). The query keys
 * and server functions equal the ones of routes/changes.$changeId.tsx and
 * components/flight/use-flight-data.ts, which share one cache.
 */

/** Recorded events of the Change read on first load; both pages read the same first page. */
export const CHANGE_FEED_INITIAL = 100;

/** Reads the Change, its Tasks, conflicts, Candidates with Evidence, Claims, ChangeSets and events. */
export async function preloadChange(queryClient: QueryClient, changeId: string) {
  await Promise.allSettled([
    loadChange(queryClient, changeId).then((change) =>
      Promise.all([
        prefetch(queryClient, ["dead-letters", change.projectId, changeId], () =>
          getDeadLetters({ data: { projectId: change.projectId, changeId } }),
        ),
        ["releasing", "completed"].includes(change.status)
          ? prefetch(queryClient, ["project-app", change.projectId], () =>
              getProjectApp({ data: change.projectId }),
            )
          : undefined,
      ]),
    ),
    queryClient
      .ensureQueryData({
        queryKey: ["tasks", changeId],
        queryFn: () => listTasks({ data: changeId }),
      })
      .then((tasks) =>
        tasks.some((t) => t.runs.at(-1)?.status === "running")
          ? prefetch(queryClient, ["change-progress", changeId], () =>
              getChangeProgress({ data: changeId }),
            )
          : undefined,
      ),
    queryClient
      .ensureQueryData({
        queryKey: ["candidates", changeId],
        queryFn: () => listCandidates({ data: changeId }),
      })
      .then((candidates) =>
        Promise.all(
          candidates.map((c) =>
            prefetch(queryClient, ["candidate-evidence", c.id], () =>
              listCandidateEvidence({ data: c.id }),
            ),
          ),
        ),
      ),
    prefetch(queryClient, ["conflicts", changeId], () => getConflicts({ data: changeId })),
    prefetch(queryClient, ["request-conflicts", changeId], () =>
      getRequestConflicts({ data: changeId }),
    ),
    prefetch(queryClient, ["change-claims", changeId], () => getChangeClaims({ data: changeId })),
    prefetch(queryClient, ["changesets", changeId], () => listChangeSets({ data: changeId })),
    prefetchFeed(queryClient, { kind: "change", changeId }, CHANGE_FEED_INITIAL),
  ]);
}
