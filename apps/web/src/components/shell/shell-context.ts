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
import { truncate } from "../../lib/format";
import type { Crumb } from "./page-meta";

/**
 * Project-scoped pages at `/projects/$projectId/<slug>`. The shell adds their name to the
 * breadcrumb (Projects / <project> / <page name>) and marks them in the sidebar, so the pages
 * themselves do not set a page name.
 */
export const PROJECT_PAGES = {
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
  | ProjectPage
  | "other";

/**
 * Sections whose page reads the Product View / Systems View choice (AGENTS.md 38.7). The header
 * shows the view toggle only there. A page that starts to read `useViewMode` adds its section.
 */
export const VIEW_SECTIONS: ReadonlySet<ShellSection> = new Set<ShellSection>(["events"]);

/** Route IDs of pathless-parent routes (`projects_.$projectId.x`) carry a trailing "_" per segment. */
function sectionFor(routeId: string | undefined): ShellSection {
  const path = routeId?.replace(/_(?=\/|$)/g, "") ?? "";
  if (path === "/") return "projects";
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
  /** Goal of the Change in context, once it loads. */
  changeGoal?: string | undefined;
  /**
   * The route names a Change or Candidate whose Project is still loading, and no earlier
   * Project can stand in. The sidebar shows skeleton rows for the Project pages.
   */
  resolving: boolean;
  /** Newest Change of the Project when no Change is in context (Flight Control, Candidates). */
  latestChange?: Pick<ChangeSummary, "id" | "goal"> | undefined;
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
  changeGoal: string | undefined,
): string | undefined {
  const page = pageName(section, routeId);
  if (!page) return undefined;
  // Pages of one Change name the Change; Project pages name the Project.
  const scoped =
    section === "changes" || section === "flight" || section === "candidates"
      ? changeGoal && truncate(changeGoal, 48)
      : section === "projects"
        ? undefined
        : projectName;
  return [page, scoped, "Rhumbatron"].filter(Boolean).join(" · ");
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

  const trail: Crumb[] = [{ label: "Projects", link: { to: "/" } }];
  if (projectId) {
    trail.push({
      label: project.data?.name ?? "Project",
      link: { to: "/projects/$projectId", params: { projectId } },
    });
  }
  if (changeId) {
    if (projectId) trail.push({ label: "Changes", link: changesLink(projectId) });
    trail.push({
      label: change.data ? truncate(change.data.goal, 44) : "Change",
      link: { to: "/changes/$changeId", params: { changeId } },
    });
  }
  if (params.candidateId) {
    trail.push({ label: params.candidateId, mono: true });
  }
  if (projectId && isProjectPage(section)) {
    trail.push({ label: PROJECT_PAGES[section], link: projectPageLink(projectId, section) });
  }
  // A static crumb belongs here, not in `usePageMeta`: the server renders it, so the header
  // does not grow after hydration (a client-only crumb shifted /design by 27px at 412px wide).
  if (routeId === "/design") trail.push({ label: "Design reference" });

  return {
    section,
    projectId,
    projectName: project.data?.name,
    changeId,
    candidateId: params.candidateId,
    changeGoal: change.data?.goal,
    resolving: loadingRecord && !projectId,
    latestChange: latest ? { id: latest.id, goal: latest.goal } : undefined,
    noChanges: changes.data?.length === 0,
    trail,
    title: documentTitle(section, routeId, project.data?.name, change.data?.goal),
  };
}
