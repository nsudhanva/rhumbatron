import { z } from "zod";

/**
 * Project roles and the permission matrix (docs/architecture/shared-projects.md, ADR 0028).
 * The API enforces `can`; the web hides what a role cannot do with the same function.
 * A role decides who may act. It never decides between two requests (ADR 0025).
 */

export const ProjectRole = z.enum(["owner", "admin", "member", "viewer"]);
export type ProjectRole = z.infer<typeof ProjectRole>;

/** Roles an invitation or a role change can give. One owner per Project; nobody assigns it. */
export const AssignableRole = z.enum(["admin", "member", "viewer"]);
export type AssignableRole = z.infer<typeof AssignableRole>;

/** Display order only (`project_members.rank`). No decision reads it. */
export const ROLE_RANK: Readonly<Record<ProjectRole, number>> = {
  owner: 0,
  admin: 5,
  member: 10,
  viewer: 30,
};

export type ProjectAction =
  /** Open the Project and read its pages. */
  | "project.read"
  /** Submit a request (create a Change). A member's request can need review (`needsReview`). */
  | "change.create"
  /** Answer, withdraw, or cancel a request that the caller made. */
  | "change.manageOwn"
  /** Answer or cancel the request of another person. */
  | "change.manageAny"
  /** Include or decline a `proposed` request. */
  | "change.review"
  | "change.raiseBudget"
  | "candidate.compose"
  | "candidate.approve"
  | "candidate.promote"
  | "app.publish"
  | "app.remove"
  | "app.rollback"
  | "deadLetter.resolve"
  | "release.injectFailure"
  | "code.edit"
  | "project.provision"
  | "project.runChecks"
  /** Invite people, and change the role of or remove a member or a viewer. */
  | "people.manage"
  /** Make an admin, change the role of an admin, or remove an admin. */
  | "admins.manage"
  /** Name, default budget, member request review. */
  | "settings.edit"
  | "project.delete"
  | "project.leave";

const ALL: readonly ProjectRole[] = ["owner", "admin", "member", "viewer"];
const CONTRIBUTORS: readonly ProjectRole[] = ["owner", "admin", "member"];
const MANAGERS: readonly ProjectRole[] = ["owner", "admin"];
const OWNER: readonly ProjectRole[] = ["owner"];

/** The one permission matrix. Each action lists the roles that may take it. */
export const PERMISSIONS: Readonly<Record<ProjectAction, readonly ProjectRole[]>> = {
  "project.read": ALL,
  "change.create": CONTRIBUTORS,
  "change.manageOwn": CONTRIBUTORS,
  "change.manageAny": MANAGERS,
  "change.review": MANAGERS,
  "change.raiseBudget": MANAGERS,
  "candidate.compose": MANAGERS,
  "candidate.approve": MANAGERS,
  "candidate.promote": MANAGERS,
  "app.publish": MANAGERS,
  "app.remove": MANAGERS,
  "app.rollback": MANAGERS,
  "deadLetter.resolve": MANAGERS,
  "release.injectFailure": MANAGERS,
  "code.edit": MANAGERS,
  "project.provision": MANAGERS,
  "project.runChecks": MANAGERS,
  "people.manage": MANAGERS,
  "admins.manage": OWNER,
  "settings.edit": MANAGERS,
  "project.delete": OWNER,
  "project.leave": ["admin", "member", "viewer"],
};

/** True when `role` may take `action`. A null role (no access) may take nothing. */
export function can(role: ProjectRole | null | undefined, action: ProjectAction): boolean {
  return !!role && PERMISSIONS[action].includes(role);
}

/**
 * True when a request by `role` starts as `proposed` and waits for an owner or admin. Only a
 * member's request does, and only while the Project setting `memberRequestReview` is on.
 */
export function needsReview(role: ProjectRole, memberRequestReview: boolean): boolean {
  return role === "member" && memberRequestReview;
}

/** True when `actor` may invite a person with `role`. Only the owner invites an admin. */
export function canInvite(actor: ProjectRole | null, role: AssignableRole): boolean {
  return can(actor, role === "admin" ? "admins.manage" : "people.manage");
}

/**
 * True when `actor` may move a member from `from` to `to`. The owner row never changes. A change
 * that makes or unmakes an admin needs `admins.manage` (the owner).
 */
export function canChangeRole(
  actor: ProjectRole | null,
  from: ProjectRole,
  to: AssignableRole,
): boolean {
  if (from === "owner") return false;
  return can(actor, from === "admin" || to === "admin" ? "admins.manage" : "people.manage");
}

/** True when `actor` may remove another member with role `target`. Never the owner. */
export function canRemoveMember(actor: ProjectRole | null, target: ProjectRole): boolean {
  if (target === "owner") return false;
  return can(actor, target === "admin" ? "admins.manage" : "people.manage");
}

/** The text of a 403: "Only the project owner can …" or "Only the project owner or an admin can …". */
export function deniedMessage(action: ProjectAction, verb: string): string {
  const who = PERMISSIONS[action].includes("admin")
    ? "the project owner or an admin"
    : "the project owner";
  return `Only ${who} can ${verb}.`;
}

/** One member in `GET /v1/projects/:projectId/members`. `email` only for owner/admin callers and self. */
export const MemberView = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  role: ProjectRole,
  joinedAt: z.string(),
  isYou: z.boolean(),
});
export type MemberView = z.infer<typeof MemberView>;

/** A pending invitation. Listed only for callers who may manage people. */
export const InvitationView = z.object({
  id: z.string(),
  email: z.string(),
  role: AssignableRole,
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type InvitationView = z.infer<typeof InvitationView>;

/** `GET /v1/projects/:projectId/members`. `role` is the caller's role. */
export const MembersResponse = z.object({
  role: ProjectRole,
  members: z.array(MemberView),
  invitations: z.array(InvitationView),
});
export type MembersResponse = z.infer<typeof MembersResponse>;

/** `POST /v1/projects/:projectId/invitations` request. The role defaults to `member`. */
export const InviteRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: AssignableRole.default("member"),
});
export type InviteRequest = z.infer<typeof InviteRequest>;

/** `PATCH /v1/projects/:projectId/members/:userId` request. */
export const ChangeRoleRequest = z.object({ role: AssignableRole });
export type ChangeRoleRequest = z.infer<typeof ChangeRoleRequest>;
