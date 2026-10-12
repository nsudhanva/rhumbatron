import {
  type AssignableRole,
  canChangeRole,
  canInvite,
  needsReview as needsReviewFor,
  PERMISSIONS,
  type ProjectAction,
  type ProjectRole,
  can as protocolCan,
} from "@rhumbatron/protocol";
import { useQuery } from "@tanstack/react-query";
import { getProject } from "./api";

/**
 * Roles in the web: a thin layer over the one permission matrix in `@rhumbatron/protocol`
 * (packages/protocol/src/roles.ts), which the API enforces. The web only hides the controls a
 * role cannot use, so nobody sees a button that always fails.
 */
export type { AssignableRole, ProjectAction, ProjectRole };

export const ROLE_LABEL: Record<ProjectRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
};

/** What each assignable role can do, in one line (the invite form). */
export const ROLE_HINT: Record<AssignableRole, string> = {
  admin: "Reviews requests, ships work and manages people.",
  member: "Requests changes; an owner or admin can review them first.",
  viewer: "Reads the project only.",
};

const ASSIGNABLE: readonly AssignableRole[] = ["admin", "member", "viewer"];

/** A role from the API, or null while it loads, after leaving, or when the value is unknown. */
export function asRole(value: string | null | undefined): ProjectRole | null {
  return value && isRole(value) ? value : null;
}

/** Every role may read a Project, so that row of the matrix lists every role. */
function isRole(value: string): value is ProjectRole {
  return (PERMISSIONS["project.read"] as readonly string[]).includes(value);
}

/** `can` for a role as the API sends it (a string, or nothing while it loads). */
export function can(role: string | null | undefined, action: ProjectAction): boolean {
  return protocolCan(asRole(role), action);
}

/** True when a request by `role` waits for an owner or admin (a member, while review is on). */
export function needsReview(role: ProjectRole | null, memberRequestReview: boolean | undefined) {
  return !!role && needsReviewFor(role, memberRequestReview !== false);
}

/** The roles `actor` may give to a person who has `current` now; empty when none. */
export function assignableRoles(actor: ProjectRole | null, current: ProjectRole): AssignableRole[] {
  const options = ASSIGNABLE.filter((to) => to === current || canChangeRole(actor, current, to));
  // Only the current role left means the actor cannot change this person.
  return options.some((r) => r !== current) ? options : [];
}

/** The roles `actor` may invite with. */
export function invitableRoles(actor: ProjectRole | null): AssignableRole[] {
  return ASSIGNABLE.filter((role) => canInvite(actor, role));
}

/**
 * The caller's role in a Project, from the same `["project", id]` read the pages and the shell
 * use (no extra request when the page already read it). Null while it loads.
 */
export function useProjectRole(projectId: string | undefined): ProjectRole | null {
  const project = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject({ data: projectId ?? "" }),
    enabled: !!projectId,
  });
  return asRole(project.data?.role);
}
