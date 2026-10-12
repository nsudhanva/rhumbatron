import { z } from "zod";
import { CanonicalGeneration, Id, ModelTier, Timestamp } from "./common.ts";
import { RequestWaitSummary } from "./first-come.ts";
import { ChangeReview, type ChangeStatus } from "./project.ts";
import { ProjectRole } from "./roles.ts";

/**
 * `GET /v1/projects/:projectId/board` (ADR 0028): the Project's requests as cards in columns, and
 * the people with their request counts. One D1 batch, bounded to the newest 100 Changes.
 */

export const BoardColumn = z.enum([
  "proposed",
  "needs_answer",
  "building",
  "checking",
  "shipped",
  "not_built",
]);
export type BoardColumn = z.infer<typeof BoardColumn>;

/** The column of each Change status. Every status has exactly one column. */
export const BOARD_COLUMN_OF: Readonly<Record<ChangeStatus, BoardColumn>> = {
  proposed: "proposed",
  needs_input: "needs_answer",
  awaiting_choice: "needs_answer",
  created: "building",
  queued: "building",
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
};

export const boardColumn = (status: ChangeStatus): BoardColumn => BOARD_COLUMN_OF[status];

/** Changes the Board reads, newest first. */
export const BOARD_CHANGE_LIMIT = 100;
/** Cards shown in each of the `shipped` and `not_built` columns, newest first. */
export const BOARD_CLOSED_COLUMN_LIMIT = 20;

export const BoardPerson = z.object({
  userId: Id,
  name: z.string().nullable(),
  /** Null for a requester who left the Project. */
  role: ProjectRole.nullable(),
  isYou: z.boolean(),
  /** Counts over the newest 100 Changes. `active` is `needs_answer`, `building`, and `checking`. */
  counts: z.object({
    proposed: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    shipped: z.number().int().nonnegative(),
    notBuilt: z.number().int().nonnegative(),
  }),
});
export type BoardPerson = z.infer<typeof BoardPerson>;

export const BoardAgent = z.object({
  agentId: Id,
  taskTitle: z.string(),
  tier: ModelTier.nullable(),
  state: z.enum(["running", "waiting", "done", "failed"]),
});
export type BoardAgent = z.infer<typeof BoardAgent>;

export const BoardCard = z.object({
  changeId: Id,
  title: z.string(),
  goal: z.string(),
  status: z.string(),
  column: BoardColumn,
  requester: z.object({
    userId: Id,
    name: z.string().nullable(),
    role: ProjectRole.nullable(),
    isYou: z.boolean(),
  }),
  tasks: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }),
  agents: z.array(BoardAgent),
  review: ChangeReview,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  /** The Canonical Generation that the Change promoted, else null. */
  generation: CanonicalGeneration.nullable(),
  /** Set while the Change is `awaiting_choice` or `queued` (ADR 0032). */
  waiting: RequestWaitSummary.nullable().optional(),
});
export type BoardCard = z.infer<typeof BoardCard>;

export const BoardResponse = z.object({
  people: z.array(BoardPerson),
  cards: z.array(BoardCard),
  /** True when the caller may include or decline a proposed request. */
  canReview: z.boolean(),
});
export type BoardResponse = z.infer<typeof BoardResponse>;
