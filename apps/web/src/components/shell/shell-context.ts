import { useAuth } from "@clerk/tanstack-react-start";
import { useQuery } from "@tanstack/react-query";
import { type LinkOptions, useParams, useRouterState } from "@tanstack/react-router";
import { getCandidate, getChange, getProject } from "../../lib/api";
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
  costs: "Costs",
} as const;

export type ProjectPage = keyof typeof PROJECT_PAGES;

/** Link to a project-scoped page. */
export function projectPageLink(projectId: string, page: ProjectPage): LinkOptions {
  return { to: `/projects/$projectId/${page}`, params: { projectId } } as LinkOptions;
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
  /** Route-derived breadcrumbs, before any page-appended crumbs. */
  trail: Crumb[];
};

/**
 * Derives the Project / Change / Candidate in context from route params. Labels come from the
 * same React Query keys and server functions the pages use, so on those pages the data is
 * shared from the cache rather than fetched twice.
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
  const projectId = params.projectId ?? change.data?.projectId ?? candidate.data?.projectId;
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId ?? "" }),
    enabled: signedIn && !!projectId,
  });

  const section = sectionFor(routeId);

  const trail: Crumb[] = [{ label: "Projects", link: { to: "/" } }];
  if (projectId) {
    trail.push({
      label: project.data?.name ?? "Project",
      link: { to: "/projects/$projectId", params: { projectId } },
    });
  }
  if (changeId) {
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
    trail,
  };
}
