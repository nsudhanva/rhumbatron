import type { QueryClient } from "@tanstack/react-query";
import { isBlocked } from "./access";
import {
  type CandidateDetail,
  type ChangeDetail,
  type FeedPage,
  getCandidate,
  getChange,
  getProject,
  listChangeEvents,
  listChanges,
  listProjectEvents,
} from "./api";
import { getMe, ME_KEY, type Me } from "./api-budget";

/**
 * Server-rendered page data (docs/architecture/tech-stack.md, "Server-rendered data").
 *
 * A signed-in page's route `loader` reads the page's primary data into the router's QueryClient
 * on the server. TanStack Router's SSR query integration (router.tsx) dehydrates the cache into
 * the HTML, so the first paint shows the content, and the components' `useQuery` calls (same
 * query keys and server functions) start from that data instead of a skeleton.
 *
 * On the client the loaders do nothing: a client-side navigation renders at once and the
 * components fetch as before (no extra reads on hover preloads).
 *
 * The query keys and functions here must stay equal to the ones the components use. Every read
 * finishes before the render starts: a read that finished later would reach the client before
 * hydration and make the client render differ from the server HTML.
 */
export async function loadOnServer(
  queryClient: QueryClient,
  load: () => Promise<unknown>,
): Promise<void> {
  if (typeof window !== "undefined") return;
  // A pending or declined account sees only the access gate: no page reads at all.
  if (isBlocked(signedInUser(queryClient)?.accessStatus)) return;
  try {
    await load();
  } catch {
    // The query keeps its error; the page reads it again on the client.
  }
  // A read that failed early can leave sibling reads running. The render waits for them, so the
  // server render and the hydration see the same cache (router.tsx sends only finished data).
  await Promise.allSettled(
    queryClient
      .getQueryCache()
      .findAll({ fetchStatus: "fetching" })
      .map((query) => query.promise),
  );
}

/**
 * Reads `GET /v1/me` into the cache before any page loader runs (the root route's `beforeLoad`).
 * The access gate, the Admin link and the admin pages read it from there. Server only.
 */
export async function loadSignedInUser(queryClient: QueryClient): Promise<void> {
  if (typeof window !== "undefined") return;
  await prefetch(queryClient, ME_KEY, () => getMe());
}

/** The signed-in user from the cache; undefined when signed out or not read yet. */
function signedInUser(queryClient: QueryClient): Me | undefined {
  return queryClient.getQueryData<Me>(ME_KEY);
}

/**
 * `loadOnServer` for an admin page: the reads run only for a platform admin, so a non-admin's
 * server render calls no admin route and sees "Not found" (components/admin/admin-page.tsx).
 */
export function loadForAdmin(
  queryClient: QueryClient,
  load: () => Promise<unknown>,
): Promise<void> {
  return loadOnServer(queryClient, () =>
    signedInUser(queryClient)?.platformAdmin ? load() : Promise.resolve(),
  );
}

/**
 * Reads one query into the cache. It never throws: a failed read stays in the cache as an error.
 * For a signed-out visitor every read fails at once, before any API call (lib/api.ts `call`).
 */
export function prefetch(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  queryFn: () => Promise<unknown>,
) {
  return queryClient.prefetchQuery({ queryKey, queryFn });
}

/** The shell's reads of one Project (breadcrumb name, sidebar "for:" lines). */
export function prefetchProjectShell(queryClient: QueryClient, projectId: string) {
  return Promise.all([
    prefetch(queryClient, ["project", projectId], () => getProject({ data: projectId })),
    prefetch(queryClient, ["changes", projectId], () => listChanges({ data: projectId })),
  ]);
}

/** The Change and its Project, as the shell and the Change pages read them. */
export async function loadChange(
  queryClient: QueryClient,
  changeId: string,
): Promise<ChangeDetail> {
  const change = await queryClient.ensureQueryData({
    queryKey: ["change", changeId],
    queryFn: () => getChange({ data: changeId }),
  });
  await prefetch(queryClient, ["project", change.projectId], () =>
    getProject({ data: change.projectId }),
  );
  return change;
}

/** The Candidate, its Change and its Project, as the shell and the Candidate page read them. */
export async function loadCandidate(
  queryClient: QueryClient,
  candidateId: string,
): Promise<CandidateDetail> {
  const candidate = await queryClient.ensureQueryData({
    queryKey: ["candidate", candidateId],
    queryFn: () => getCandidate({ data: candidateId }),
  });
  await loadChange(queryClient, candidate.changeId);
  return candidate;
}

/** Query key of the first page of a recorded event feed (components/project/use-event-feed.ts). */
export function feedKey(
  scope: { kind: "project"; projectId: string } | { kind: "change"; changeId: string },
  limit: number,
) {
  return scope.kind === "project"
    ? (["event-feed", "project", scope.projectId, limit] as const)
    : (["event-feed", "change", scope.changeId, limit] as const);
}

/** Reads the newest `limit` events of a feed into the cache, for `useEventFeed` to start from. */
export function prefetchFeed(
  queryClient: QueryClient,
  scope: { kind: "project"; projectId: string } | { kind: "change"; changeId: string },
  limit: number,
) {
  return prefetch(
    queryClient,
    feedKey(scope, limit),
    (): Promise<FeedPage> =>
      scope.kind === "project"
        ? listProjectEvents({ data: { projectId: scope.projectId, limit } })
        : listChangeEvents({ data: { changeId: scope.changeId, limit } }),
  );
}
