import { useAuth } from "@clerk/tanstack-react-start";
import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { type LinkOptions, useParams, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import {
  type ChangeSummary,
  getCandidate,
  getChange,
  getProject,
  listChanges,
} from "../../lib/api";
import { changeLabel } from "../../lib/format";
import type { Crumb } from "./page-meta";

/**
 * Project-scoped pages at `/projects/$projectId/<slug>`. The shell adds their name to the
 * breadcrumb (Projects / <project> / <page name>) and marks them in the sidebar, so the pages
 * themselves do not set a page name.
 */
export const PROJECT_PAGES = {
  board: "Board",
  graph: "Product Graph",
  agents: "Agents",
  events: "Events",
  verification: "Verification",
  workspace: "Workspace",
  code: "Code",
  versions: "Versions",
  costs: "Costs",
  settings: "Settings",
} as const;

export type ProjectPage = keyof typeof PROJECT_PAGES;

/** Link to a project-scoped page. */
export function projectPageLink(projectId: string, page: ProjectPage): LinkOptions {
  return { to: `/projects/$projectId/${page}`, params: { projectId } } as LinkOptions;
}

/** The Changes list: the section on the Project overview. */
export function changesLink(projectId: string): LinkOptions {
  return { to: "/projects/$projectId", params: { projectId }, hash: "changes" } as LinkOptions;
}

/** Which top-level destination the current route belongs to (drives the sidebar marker). */
export type ShellSection =
  | "projects"
  | "overview"
  | "changes"
  | "flight"
  | "candidates"
  | "admin"
  | ProjectPage
  | "other";

/** Route IDs of pathless-parent routes (`projects_.$projectId.x`) carry a trailing "_" per segment. */
function sectionFor(routeId: string | undefined): ShellSection {
  const path = routeId?.replace(/_(?=\/|$)/g, "") ?? "";
  if (path === "/") return "projects";
  if (path === "/admin" || path.startsWith("/admin/")) return "admin";
  if (path === "/projects/$projectId") return "overview";
  if (path.startsWith("/changes/") && path.endsWith("/flight")) return "flight";
  if (path.startsWith("/changes/$changeId")) return "changes";
  if (path.startsWith("/candidates/$candidateId") || path.startsWith("/compare/$changeId")) {
    return "candidates";
  }
  const match = /^\/projects\/\$projectId\/([^/]+)/.exec(path);
  const slug = match?.[1];
  if (slug && Object.hasOwn(PROJECT_PAGES, slug)) return slug as ProjectPage;
  return "other";
}

function isProjectPage(section: ShellSection): section is ProjectPage {
  return Object.hasOwn(PROJECT_PAGES, section);
}

export type ShellContext = {
  section: ShellSection;
  projectId?: string | undefined;
  projectName?: string | undefined;
  changeId?: string | undefined;
  candidateId?: string | undefined;
  /** Short title of the Change in context, once it loads. */
  changeTitle?: string | undefined;
  /** Full goal of the Change in context, for tooltips. */
  changeGoal?: string | undefined;
  /**
   * The route names a Change or Candidate whose Project is still loading, and no earlier
   * Project can stand in. The sidebar shows skeleton rows for the Project pages.
   */
  resolving: boolean;
  /** Newest Change of the Project when no Change is in context (Flight Control, Candidates). */
  latestChange?: Pick<ChangeSummary, "id" | "goal" | "title"> | undefined;
  /** True once the Project's Changes list loaded and it is empty. */
  noChanges: boolean;
  /** Route-derived breadcrumbs, before any page-appended crumbs. */
  trail: Crumb[];
  /**
   * Tab title "<Page> · <Project or Change> · Rhumbatron" (the name joins once it loads), or
   * undefined where the route's own `head` title stays (design, sign-in).
   */
  title: string | undefined;
};

/** Name of the page in the tab title, by section; candidates splits into Candidate and Compare. */
function pageName(section: ShellSection, routeId: string | undefined): string | undefined {
  switch (section) {
    case "projects":
      return "Projects";
    case "overview":
      return "Overview";
    case "changes":
      return "Change";
    case "flight":
      return "Flight Control";
    case "candidates":
      return routeId?.startsWith("/compare/") ? "Compare" : "Candidate";
    case "admin":
    case "other":
      return undefined;
    default:
      return PROJECT_PAGES[section];
  }
}

function documentTitle(
  section: ShellSection,
  routeId: string | undefined,
  projectName: string | undefined,
  changeTitle: string | undefined,
): string | undefined {
  const page = pageName(section, routeId);
  if (!page) return undefined;
  // Pages of one Change name the Change; Project pages name the Project.
  const scoped =
    section === "changes" || section === "flight" || section === "candidates"
      ? changeTitle
      : section === "projects"
        ? undefined
        : projectName;
  return [page, scoped, "Rhumbatron"].filter(Boolean).join(" · ");
}

/**
 * The crumb of a sub-view, derived from the route and its search like the rest of the trail, so
 * the server renders it and the header keeps its height after hydration (a client-only crumb
 * wraps the header onto another line on a phone and moves the page down).
 */
function subViewTrail(
  routeId: string | undefined,
  search: Record<string, unknown>,
  changes: ChangeSummary[] | undefined,
): Crumb[] {
  switch (routeId) {
    case "/compare/$changeId":
      return [{ label: "Compare" }];
    case "/changes_/$changeId/flight":
      return [{ label: "Flight Control" }];
    case "/projects_/$projectId/events":
      return typeof search.change === "string" ? [{ label: search.change, mono: true }] : [];
    case "/projects_/$projectId/graph": {
      // The same choice as the Product Graph page: the requested Change, else the newest one.
      const list = changes ?? [];
      const requested = list.find((c) => c.id === search.changeId);
      const selected = requested ?? list[0];
      const zoom = selected ? (search.zoom ?? "change") : "project";
      return zoom === "change" && selected
        ? [{ label: changeLabel(selected) }]
        : [{ label: "All Changes" }];
    }
    default:
      return [];
  }
}

/** The Project of a Change, from a Changes list already in the query cache. No request. */
function cachedProjectOf(queryClient: QueryClient, changeId: string | undefined) {
  if (!changeId) return undefined;
  for (const [key, data] of queryClient.getQueriesData<ChangeSummary[]>({
    queryKey: ["changes"],
  })) {
    if (Array.isArray(data) && data.some((c) => c.id === changeId)) {
      const projectId = key[1];
      if (typeof projectId === "string") return projectId;
    }
  }
  return undefined;
}

/**
 * Derives the Project / Change / Candidate in context from route params. Labels come from the
 * same React Query keys and server functions the pages use, so on those pages the data is
 * shared from the cache rather than fetched twice.
 *
 * Inside a Change or Candidate the Project comes from the loaded record. Until it loads, the
 * Project of a cached Changes list, or else the Project open just before, stands in, so the
 * sidebar stays usable while the page loads.
 */
export function useShellContext(): ShellContext {
  const params = useParams({ strict: false }) as {
    projectId?: string;
    changeId?: string;
    candidateId?: string;
  };
  const routeId = useRouterState({ select: (s) => s.matches.at(-1)?.routeId });
  const search = useRouterState({ select: (s) => s.matches.at(-1)?.search }) as
    | Record<string, unknown>
    | undefined;
  const { isSignedIn } = useAuth();
  const signedIn = isSignedIn === true;
  const queryClient = useQueryClient();

  const candidate = useQuery({
    queryKey: ["candidate", params.candidateId],
    queryFn: () => getCandidate({ data: params.candidateId ?? "" }),
    enabled: signedIn && !!params.candidateId,
  });
  const changeId = params.changeId ?? candidate.data?.changeId;
  const change = useQuery({
    queryKey: ["change", changeId],
    queryFn: () => getChange({ data: changeId ?? "" }),
    enabled: signedIn && !!changeId,
  });

  const resolvedProjectId =
    params.projectId ??
    change.data?.projectId ??
    candidate.data?.projectId ??
    cachedProjectOf(queryClient, changeId);
  const loadingRecord =
    signedIn &&
    !resolvedProjectId &&
    (!!params.changeId || !!params.candidateId) &&
    (change.isLoading || candidate.isLoading);

  // The last Project in context (client only: the shell stays mounted across navigation).
  const lastProjectId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (resolvedProjectId) lastProjectId.current = resolvedProjectId;
  }, [resolvedProjectId]);
  const projectId = resolvedProjectId ?? (loadingRecord ? lastProjectId.current : undefined);

  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId ?? "" }),
    enabled: signedIn && !!projectId,
  });
  // Flight Control and Candidates open the newest Change when no Change is in context.
  const changes = useQuery({
    queryKey: ["changes", projectId],
    queryFn: () => listChanges({ data: projectId ?? "" }),
    enabled: signedIn && !!projectId && !changeId,
    staleTime: 30_000,
  });
  const latest = changes.data?.[0];

  const section = sectionFor(routeId);

  // The admin pages set their own trail (components/admin/admin-page.tsx); it does not start at
  // Projects, and a non-admin sees only "Not found".
  const trail: Crumb[] = section === "admin" ? [] : [{ label: "Projects", link: { to: "/" } }];
  if (projectId) {
    trail.push({
      label: project.data?.name ?? "Project",
      link: { to: "/projects/$projectId", params: { projectId } },
    });
  }
  if (changeId) {
    if (projectId) trail.push({ label: "Changes", link: changesLink(projectId) });
    trail.push({
      label: change.data ? changeLabel(change.data) : "Change",
      link: { to: "/changes/$changeId", params: { changeId } },
    });
  }
  if (params.candidateId) {
    trail.push({ label: params.candidateId, mono: true });
  }
  if (projectId && isProjectPage(section)) {
    trail.push({ label: PROJECT_PAGES[section], link: projectPageLink(projectId, section) });
  }
  trail.push(...subViewTrail(routeId, search ?? {}, changes.data));

  return {
    section,
    projectId,
    projectName: project.data?.name,
    changeId,
    candidateId: params.candidateId,
    changeTitle: change.data ? changeLabel(change.data) : undefined,
    changeGoal: change.data?.goal,
    resolving: loadingRecord && !projectId,
    latestChange: latest
      ? { id: latest.id, goal: latest.goal, title: latest.title ?? null }
      : undefined,
    noChanges: changes.data?.length === 0,
    trail,
    title: documentTitle(
      section,
      routeId,
      project.data?.name,
      change.data ? changeLabel(change.data) : undefined,
    ),
  };
}
