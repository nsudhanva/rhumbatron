import { describe, expect, it } from "vitest";
import { CHOICE_DAYS, canChooseFirstCome, conflictPolicy, firstComeStep } from "./first-come.ts";

const asked = "2026-10-01T00:00:00Z";
const day = 86_400_000;
const at = (days: number) => Date.parse(asked) + days * day;

describe("who decides a conflict between two requests", () => {
  const pair = (
    verdict: "independent" | "compatible" | "conflicting" | "duplicate",
    supported: boolean,
    later = "bob",
  ) =>
    conflictPolicy({
      verdict,
      supported,
      earlierRequesterUserId: "alice",
      laterRequesterUserId: later,
    });
  it("asks the earlier requester when two people conflict", () => {
    expect(pair("conflicting", true)).toBe("first_come");
  });
  it("lets the same person's later request replace the earlier one", () => {
    expect(pair("conflicting", true, "alice")).toBe("same_requester");
  });
  it("asks the later requester for an unsupported review or a duplicate, and leaves the rest", () => {
    expect(pair("conflicting", false)).toBe("ask_requester");
    expect(pair("conflicting", false, "alice")).toBe("ask_requester");
    expect(pair("duplicate", true)).toBe("duplicate");
    expect(pair("independent", true)).toBe("none");
    expect(pair("compatible", true)).toBe("none");
  });
});

describe("only the earlier requester chooses", () => {
  const choose = (
    callerUserId: string,
    callerRole: "owner" | "admin" | "member" | "viewer" | null,
  ) => canChooseFirstCome({ callerUserId, askedUserId: "alice", callerRole, choice: null });
  it("allows the earlier requester and refuses admins, owners, and the later requester", () => {
    expect(choose("alice", "member")).toBe(true);
    expect(choose("alice", "admin")).toBe(true);
    expect(choose("owner-user", "owner")).toBe(false);
    expect(choose("admin-user", "admin")).toBe(false);
    expect(choose("bob", "member")).toBe(false);
  });
  it("refuses a requester who left or a choice that is already made", () => {
    expect(choose("alice", null)).toBe(false);
    expect(
      canChooseFirstCome({
        callerUserId: "alice",
        askedUserId: "alice",
        callerRole: "member",
        choice: "keep_mine",
      }),
    ).toBe(false);
  });
});

describe("the later request plans only after the earlier one ends", () => {
  const step = (input: Partial<Parameters<typeof firstComeStep>[0]>) =>
    firstComeStep({
      laterStatus: "awaiting_choice",
      choice: null,
      firstStatus: "running",
      firstPromoted: false,
      askedAt: asked,
      now: at(1),
      ...input,
    });
  it("waits for the choice, then expires after the limit", () => {
    expect(step({})).toBe("wait_choice");
    expect(step({ firstStatus: "completed" })).toBe("wait_choice");
    expect(step({ now: at(CHOICE_DAYS) })).toBe("expire");
  });
  it("queues after apply theirs while the earlier request runs, and resumes when it promotes or ends", () => {
    expect(step({ choice: "apply_theirs" })).toBe("queue");
    expect(step({ choice: "apply_theirs", laterStatus: "queued" })).toBe("wait_first");
    expect(step({ choice: "apply_theirs", laterStatus: "queued", firstStatus: "releasing" })).toBe(
      "wait_first",
    );
    expect(step({ choice: "apply_theirs", laterStatus: "queued", firstPromoted: true })).toBe(
      "resume",
    );
    for (const firstStatus of ["completed", "failed", "cancelled", "not_selected"])
      expect(step({ choice: "apply_theirs", laterStatus: "queued", firstStatus })).toBe("resume");
    expect(step({ choice: "apply_theirs", firstStatus: "completed" })).toBe("resume");
  });
  it("ends the later request after keep mine or expiry, whatever the earlier request does", () => {
    expect(step({ choice: "keep_mine" })).toBe("end_kept");
    expect(step({ choice: "expired", laterStatus: "queued" })).toBe("end_kept");
  });
  it("makes the question moot when the earlier request ends unbuilt before a choice", () => {
    for (const firstStatus of ["cancelled", "failed", "not_selected", "declined"])
      expect(step({ firstStatus })).toBe("moot");
    // A promoted earlier request that failed its release still changed the app: keep asking.
    expect(step({ firstStatus: "failed", firstPromoted: true })).toBe("wait_choice");
    expect(step({ choice: "moot" })).toBe("resume");
  });
  it("does nothing for a later request that no longer waits", () => {
    for (const laterStatus of ["compiling", "running", "not_selected", "cancelled"])
      expect(step({ laterStatus, choice: "apply_theirs", firstStatus: "completed" })).toBe("none");
  });
});
