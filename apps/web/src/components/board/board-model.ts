import { BOARD_COLUMN_OF, ROLE_RANK } from "@rhumbatron/protocol";
import {
  BOARD_COLUMNS,
  type BoardCard,
  type BoardColumn,
  type BoardPerson,
  type ProjectBoard,
} from "../../lib/api-board";

/**
 * Board model: the API's people and cards arranged as lanes (one per person, or one for every
 * stage) by columns. Pure functions, so the optimistic include and decline reuse them.
 */

export const COLUMN_LABEL: Record<BoardColumn, string> = {
  proposed: "Proposed",
  needs_answer: "Needs answer",
  building: "Building",
  checking: "Checking",
  shipped: "Shipped",
  not_built: "Not built",
};

/** One sentence on what would appear in an empty column (DESIGN.md 8.5). */
export const COLUMN_EMPTY: Record<BoardColumn, string> = {
  proposed: "No request waits for review.",
  needs_answer: "No request waits for an answer.",
  building: "Nothing is building.",
  checking: "Nothing is being checked.",
  shipped: "Nothing shipped yet.",
  not_built: "No request ended unbuilt.",
};

export type BoardView = "person" | "stage";

export type Lane = {
  key: string;
  /** Null in the "By stage" view: one lane without a person header. */
  person: BoardPerson | null;
  cells: Record<BoardColumn, BoardCard[]>;
};

function emptyCells(): Record<BoardColumn, BoardCard[]> {
  return Object.fromEntries(BOARD_COLUMNS.map((c) => [c, []])) as unknown as Record<
    BoardColumn,
    BoardCard[]
  >;
}

/** Newest first inside a cell. */
const byNewest = (a: BoardCard, b: BoardCard) => b.updatedAt.localeCompare(a.updatedAt);

/**
 * Lanes for the view. "By person" has a lane for every person in the Project (you first), plus
 * one for a requester who left; `person` filters to one lane. "By stage" has one lane.
 */
export function boardLanes(board: ProjectBoard, view: BoardView, person: string | null): Lane[] {
  const cards = person ? board.cards.filter((c) => c.requester.userId === person) : board.cards;
  if (view === "stage") {
    const cells = emptyCells();
    for (const card of cards) cells[card.column].push(card);
    for (const column of BOARD_COLUMNS) cells[column].sort(byNewest);
    return [{ key: "all", person: null, cells }];
  }
  const people = new Map<string, BoardPerson>();
  for (const p of board.people) people.set(p.userId, p);
  for (const card of board.cards) {
    if (people.has(card.requester.userId)) continue;
    people.set(card.requester.userId, {
      ...card.requester,
      counts: { proposed: 0, active: 0, shipped: 0, notBuilt: 0 },
    });
  }
  const lanes = new Map<string, Lane>();
  for (const p of people.values()) {
    if (person && p.userId !== person) continue;
    lanes.set(p.userId, { key: p.userId, person: p, cells: emptyCells() });
  }
  for (const card of cards) lanes.get(card.requester.userId)?.cells[card.column].push(card);
  for (const lane of lanes.values()) {
    for (const column of BOARD_COLUMNS) lane.cells[column].sort(byNewest);
  }
  // You first, then by role (owner, admins, members, viewers), people who left last.
  const rank = (lane: Lane) =>
    lane.person?.isYou ? -1 : lane.person?.role ? ROLE_RANK[lane.person.role] : 100;
  return [...lanes.values()].sort((a, b) => rank(a) - rank(b));
}

/** Cards per column across the lanes shown. */
export function columnCounts(lanes: Lane[]): Record<BoardColumn, number> {
  const counts = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, 0])) as Record<
    BoardColumn,
    number
  >;
  for (const lane of lanes) for (const c of BOARD_COLUMNS) counts[c] += lane.cells[c].length;
  return counts;
}

/** A person's name as the Board shows it. */
export function personName(p: { name: string | null; isYou: boolean }) {
  return p.isYou ? "You" : (p.name ?? "Someone");
}

/** The optimistic board after an include or a decline (the API confirms or the cache rolls back). */
export function applyReview(
  board: ProjectBoard,
  changeId: string,
  decision: { kind: "include" } | { kind: "decline"; reason: string | null; by: string | null },
): ProjectBoard {
  const now = new Date().toISOString();
  return {
    ...board,
    cards: board.cards.map((card) => {
      if (card.changeId !== changeId || card.column !== "proposed") return card;
      return decision.kind === "include"
        ? {
            ...card,
            status: "created",
            column: BOARD_COLUMN_OF.created,
            updatedAt: now,
            review: { ...card.review, state: "included", decidedAt: now },
          }
        : {
            ...card,
            status: "declined",
            column: BOARD_COLUMN_OF.declined,
            updatedAt: now,
            review: {
              state: "declined",
              decidedBy: decision.by ? { userId: "", name: decision.by } : null,
              decidedAt: now,
              reason: decision.reason,
            },
          };
    }),
  };
}
