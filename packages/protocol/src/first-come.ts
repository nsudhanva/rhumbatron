import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { ChangeStatus, PersonRef } from "./project.ts";
import { can, type ProjectRole } from "./roles.ts";

/**
 * First-come conflicts between requests of different people (ADR 0032). The earlier request keeps
 * working. The later, conflicting request waits, and the earlier requester chooses: keep their own
 * version, or apply the later request after theirs. Pure rules shared by the API and the
 * integration Worker; the D1 table `request_choices` holds the durable state.
 */

/** Days the later request waits for a choice. After them, the earlier version stays. */
export const CHOICE_DAYS = 7;

/** What the earlier requester can choose. */
export const FirstComeChoice = z.enum(["keep_mine", "apply_theirs"]);
export type FirstComeChoice = z.infer<typeof FirstComeChoice>;

/**
 * The stored result of one wait. `expired`: no choice within 7 days. `moot`: the earlier request
 * ended without a build before anybody chose, so the later request plans at once.
 */
export const RequestWaitChoice = z.enum(["keep_mine", "apply_theirs", "expired", "moot"]);
export type RequestWaitChoice = z.infer<typeof RequestWaitChoice>;

/** The short form on a Board card: who the request waits for, and why. */
export const RequestWaitSummary = z.object({
  /** `choosing`: waits for the earlier requester. `after_first`: waits for the earlier request. */
  state: z.enum(["choosing", "after_first"]),
  firstChangeId: Id,
  firstTitle: z.string(),
  firstRequester: PersonRef,
});
export type RequestWaitSummary = z.infer<typeof RequestWaitSummary>;

/** One wait, as `GET /v1/changes/:changeId/request-waits` returns it. */
export const RequestWait = z.object({
  id: Id,
  firstChangeId: Id,
  firstTitle: z.string(),
  firstRequester: PersonRef,
  laterChangeId: Id,
  laterTitle: z.string(),
  laterGoal: z.string(),
  laterRequester: PersonRef,
  /** Up to 3 conflicting criterion pairs, as text. */
  conflicts: z.array(z.object({ first: z.string(), later: z.string(), why: z.string() })).max(3),
  choice: RequestWaitChoice.nullable(),
  chosenAt: Timestamp.nullable(),
  askedAt: Timestamp,
  /** When the wait ends without a choice. */
  expiresAt: Timestamp,
  /** Current status of the later request. */
  laterStatus: ChangeStatus,
  /** True only for the earlier requester while the choice is open. */
  canChoose: z.boolean(),
});
export type RequestWait = z.infer<typeof RequestWait>;

/** `POST /v1/changes/:changeId/choose`, where `:changeId` is the waiting (later) request. */
export const ChooseRequest = z.object({ choice: FirstComeChoice }).strict();
export type ChooseRequest = z.infer<typeof ChooseRequest>;

/** Result of a choice. A repeat of the same choice returns `repeated: true`. */
export const ChooseOutcome = z.discriminatedUnion("result", [
  z.object({
    result: z.literal("recorded"),
    changeId: Id,
    choice: RequestWaitChoice,
    status: ChangeStatus,
    repeated: z.boolean(),
  }),
  z.object({
    result: z.literal("refused"),
    reason: z.enum(["not_found", "not_waiting", "already_chosen"]),
    detail: z.string(),
  }),
]);
export type ChooseOutcome = z.infer<typeof ChooseOutcome>;

/**
 * Who decides a compared pair of requests, from the review and the two requesters. No role, rank,
 * or model preference takes part.
 *
 * - `none`: independent or compatible; both requests go on.
 * - `follow`: the later request builds on what the earlier request creates. It waits (`queued`)
 *   and plans on the tree that has the earlier work. Nobody chooses: the later request is
 *   applied after the earlier one.
 * - `duplicate`: a cited duplicate; the later requester gets a question.
 * - `ask_requester`: the review could not confirm compatibility; the later requester gets a question.
 * - `same_requester`: one person asked twice; the later request replaces the earlier one.
 * - `first_come`: different people; the earlier request keeps working, and its requester chooses.
 */
export type ConflictPolicy =
  | "none"
  | "follow"
  | "duplicate"
  | "ask_requester"
  | "same_requester"
  | "first_come";

export function conflictPolicy(input: {
  verdict: "independent" | "compatible" | "builds_on" | "conflicting" | "duplicate";
  supported: boolean;
  earlierRequesterUserId: string;
  laterRequesterUserId: string;
}): ConflictPolicy {
  if (input.verdict === "independent" || input.verdict === "compatible") return "none";
  if (!input.supported) return "ask_requester";
  if (input.verdict === "builds_on") return "follow";
  if (input.verdict === "duplicate") return "duplicate";
  return input.earlierRequesterUserId === input.laterRequesterUserId
    ? "same_requester"
    : "first_come";
}

/** Statuses after which an earlier request can never ship more code. */
const ENDED_UNBUILT = new Set(["cancelled", "failed", "not_selected", "declined"]);
const ENDED = new Set([...ENDED_UNBUILT, "completed"]);

/** The next step for a waiting later request. */
export type FirstComeStep =
  /** The later request does not wait any more (it ended or plans). */
  | "none"
  /** Nobody chose yet; keep waiting for the earlier requester. */
  | "wait_choice"
  /** No choice within 7 days: record `expired`, and the later request ends as not built. */
  | "expire"
  /** The earlier request ended without a build before a choice: record `moot` and plan now. */
  | "moot"
  /** `keep_mine` or `expired` is recorded: the later request ends as not built. */
  | "end_kept"
  /** `apply_theirs` is recorded and the earlier request is in flight: the later one is `queued`. */
  | "queue"
  /** `queued`: the earlier request is still in flight. */
  | "wait_first"
  /** The earlier request promoted or ended: the later request plans on the current tree. */
  | "resume";

/**
 * Deterministic, so the API command, the end of the earlier request, and the waiting workflow can
 * each run it and reach the same step. "Ended" means a promoted Candidate or a terminal status.
 */
export function firstComeStep(input: {
  laterStatus: string;
  choice: RequestWaitChoice | null;
  firstStatus: string | null;
  firstPromoted: boolean;
  askedAt: string;
  now: number;
}): FirstComeStep {
  if (input.laterStatus !== "awaiting_choice" && input.laterStatus !== "queued") return "none";
  if (input.choice === "keep_mine" || input.choice === "expired") return "end_kept";
  const first = input.firstStatus ?? "cancelled";
  const firstDone = input.firstPromoted || ENDED.has(first);
  if (input.choice === null) {
    if (!input.firstPromoted && ENDED_UNBUILT.has(first)) return "moot";
    if (input.now - Date.parse(input.askedAt) >= CHOICE_DAYS * 86_400_000) return "expire";
    return "wait_choice";
  }
  if (input.choice === "moot" || firstDone) return "resume";
  return input.laterStatus === "awaiting_choice" ? "queue" : "wait_first";
}

/**
 * Only the earlier requester chooses, while they still belong to the Project and the choice is
 * open. Admins and the later requester never choose.
 */
export function canChooseFirstCome(input: {
  callerUserId: string;
  askedUserId: string;
  callerRole: ProjectRole | null;
  choice: RequestWaitChoice | null;
}): boolean {
  return (
    input.choice === null &&
    input.callerUserId === input.askedUserId &&
    can(input.callerRole, "change.manageOwn")
  );
}
