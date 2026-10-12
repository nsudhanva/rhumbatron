// The permission matrix (ADR 0028) is a security boundary: the API enforces `can` and the web
// hides what a role cannot do. This test spells out the whole matrix, so any change to a role's
// permissions is a visible change here.
import { describe, expect, it } from "vitest";
import { BOARD_COLUMN_OF, boardColumn } from "./board.ts";
import { ChangeStatus } from "./project.ts";
import {
  AssignableRole,
  can,
  canChangeRole,
  canInvite,
  canRemoveMember,
  deniedMessage,
  needsReview,
  PERMISSIONS,
  type ProjectAction,
  ProjectRole,
} from "./roles.ts";

/** owner, admin, member, viewer. */
const EXPECTED: Record<ProjectAction, [boolean, boolean, boolean, boolean]> = {
  "project.read": [true, true, true, true],
  "change.create": [true, true, true, false],
  "change.manageOwn": [true, true, true, false],
  "change.manageAny": [true, true, false, false],
  "change.review": [true, true, false, false],
  "change.raiseBudget": [true, true, false, false],
  "candidate.compose": [true, true, false, false],
  "candidate.approve": [true, true, false, false],
  "candidate.promote": [true, true, false, false],
  "app.publish": [true, true, false, false],
  "app.remove": [true, true, false, false],
  "app.rollback": [true, true, false, false],
  "deadLetter.resolve": [true, true, false, false],
  "release.injectFailure": [true, true, false, false],
  "code.edit": [true, true, false, false],
  "project.provision": [true, true, false, false],
  "project.runChecks": [true, true, false, false],
  "people.manage": [true, true, false, false],
  "admins.manage": [true, false, false, false],
  "settings.edit": [true, true, false, false],
  "project.delete": [true, false, false, false],
  "project.leave": [false, true, true, true],
};

describe("permission matrix", () => {
  it("covers every action and gives each role exactly the expected permissions", () => {
    expect(Object.keys(PERMISSIONS).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [action, row] of Object.entries(EXPECTED) as [ProjectAction, boolean[]][]) {
      ProjectRole.options.forEach((role, i) => {
        expect({ action, role, allowed: can(role, action) }).toEqual({
          action,
          role,
          allowed: row[i],
        });
      });
    }
  });

  it("gives a caller without a role nothing", () => {
    for (const action of Object.keys(EXPECTED) as ProjectAction[]) {
      expect(can(null, action)).toBe(false);
      expect(can(undefined, action)).toBe(false);
    }
  });

  it("lets only the owner invite, promote, demote, or remove an admin", () => {
    for (const role of AssignableRole.options) {
      expect(canInvite("owner", role)).toBe(true);
      expect(canInvite("admin", role)).toBe(role !== "admin");
      expect(canInvite("member", role)).toBe(false);
      expect(canInvite("viewer", role)).toBe(false);
    }
    expect(canChangeRole("admin", "member", "viewer")).toBe(true);
    expect(canChangeRole("admin", "viewer", "member")).toBe(true);
    expect(canChangeRole("admin", "member", "admin")).toBe(false);
    expect(canChangeRole("admin", "admin", "member")).toBe(false);
    expect(canChangeRole("owner", "member", "admin")).toBe(true);
    expect(canChangeRole("owner", "admin", "viewer")).toBe(true);
    expect(canChangeRole("member", "viewer", "member")).toBe(false);
    expect(canRemoveMember("admin", "member")).toBe(true);
    expect(canRemoveMember("admin", "admin")).toBe(false);
    expect(canRemoveMember("owner", "admin")).toBe(true);
    expect(canRemoveMember("member", "viewer")).toBe(false);
  });

  it("never assigns, changes, or removes the owner", () => {
    expect(AssignableRole.options).not.toContain("owner");
    for (const role of AssignableRole.options)
      expect(canChangeRole("owner", "owner", role)).toBe(false);
    expect(canRemoveMember("owner", "owner")).toBe(false);
  });

  it("names who may act in a refusal", () => {
    expect(deniedMessage("project.delete", "remove the project")).toBe(
      "Only the project owner can remove the project.",
    );
    expect(deniedMessage("candidate.promote", "promote a Candidate")).toBe(
      "Only the project owner or an admin can promote a Candidate.",
    );
  });
});

describe("review gate", () => {
  it("sends a member's request to review while the setting is on, and nobody else's", () => {
    expect(needsReview("member", true)).toBe(true);
    expect(needsReview("member", false)).toBe(false);
    for (const role of ["owner", "admin"] as const) {
      expect(needsReview(role, true)).toBe(false);
      expect(needsReview(role, false)).toBe(false);
    }
  });
});

describe("board columns", () => {
  it("maps every Change status to its column", () => {
    expect(Object.keys(BOARD_COLUMN_OF).sort()).toEqual([...ChangeStatus.options].sort());
    const columns = Object.fromEntries(ChangeStatus.options.map((s) => [s, boardColumn(s)]));
    expect(columns).toEqual({
      proposed: "proposed",
      needs_input: "needs_answer",
      created: "building",
      compiling: "building",
      running: "building",
      budget_blocked: "building",
      blocked: "building",
      verifying: "checking",
      awaiting_approval: "checking",
      promoting: "checking",
      releasing: "checking",
      completed: "shipped",
      declined: "not_built",
      not_selected: "not_built",
      cancelled: "not_built",
      failed: "not_built",
    });
  });
});
