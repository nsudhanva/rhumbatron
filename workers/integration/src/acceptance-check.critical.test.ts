// Acceptance check citations (ADR 0026, AGENTS.md 34.4.2). Invariants: a `met` counts only with a
// quote that code finds in a file the model received; removed patch lines and short quotes prove
// nothing; malformed output (wrong criterion count) is invalid; only all-met passes.
import { describe, expect, it } from "vitest";
import {
  acceptanceOutcome,
  citationValid,
  sourceFromFiles,
  sourceFromPatch,
  validateAcceptance,
} from "./acceptance-check.ts";

const PATCH = [
  "diff --git a/src/calendar.tsx b/src/calendar.tsx",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/calendar.tsx",
  "@@ -0,0 +1,3 @@",
  "+export function CalendarView() {",
  '+  return <div className="calendar-grid">{days.map(renderDay)}</div>;',
  "+}",
  "diff --git a/src/board.tsx b/src/board.tsx",
  "--- a/src/board.tsx",
  "+++ b/src/board.tsx",
  "@@ -1,2 +1,2 @@",
  "-export const KanbanBoard = () => null;",
  "+export const Placeholder = () => null;",
  "",
].join("\n");

describe("acceptance citations", () => {
  const source = sourceFromPatch(PATCH);

  it("accepts an exact quote of an added line, with or without the + marker", () => {
    expect(
      citationValid(source, { path: "src/calendar.tsx", quote: "export function CalendarView()" }),
    ).toBe(true);
    expect(
      citationValid(source, {
        path: "src/calendar.tsx",
        quote: '+  return <div className="calendar-grid">',
      }),
    ).toBe(true);
  });

  it("rejects another path, an invented quote, a removed line, and a short quote", () => {
    expect(
      citationValid(source, { path: "src/other.tsx", quote: "export function CalendarView()" }),
    ).toBe(false);
    expect(
      citationValid(source, { path: "src/calendar.tsx", quote: "export function KanbanView()" }),
    ).toBe(false);
    expect(
      citationValid(source, { path: "src/board.tsx", quote: "export const KanbanBoard" }),
    ).toBe(false);
    expect(citationValid(source, { path: "src/calendar.tsx", quote: "div" })).toBe(false);
  });

  it("checks composed file text when no patch is stored", () => {
    const files = sourceFromFiles([{ path: "src/a.ts", text: "export const kanban = true;\n" }]);
    expect(citationValid(files, { path: "src/a.ts", quote: "export const kanban" })).toBe(true);
  });

  it("turns met without a valid citation into unclear, and fails unless every criterion is met", () => {
    const criteria = ["Shows a calendar of the month", "Each day has a kanban list"];
    const results = validateAcceptance(
      {
        results: [
          {
            criterion: 1,
            status: "met",
            citations: [{ path: "src/calendar.tsx", quote: "export function CalendarView()" }],
          },
          {
            criterion: 2,
            status: "met",
            citations: [{ path: "src/board.tsx", quote: "export const KanbanBoard" }],
          },
        ],
      },
      criteria,
      source,
    );
    expect(results?.map((r) => r.status)).toEqual(["met", "unclear"]);
    expect(results?.[1]?.citations).toEqual([]);
    const outcome = acceptanceOutcome(results ?? []);
    expect(outcome).toMatchObject({ status: "fail", coverage: "checked_supported" });
    expect(outcome.summary).toContain("1 of 2 criteria met");
    expect(outcome.summary).toContain("kanban list");

    const allMet = acceptanceOutcome([results?.[0] as NonNullable<typeof results>[number]]);
    expect(allMet).toMatchObject({ status: "pass", coverage: "checked_supported" });
  });

  it("is invalid when a criterion is missing or repeated", () => {
    const criteria = ["A", "B"];
    expect(
      validateAcceptance({ results: [{ criterion: 1, status: "not_met" }] }, criteria, source),
    ).toBeNull();
    expect(
      validateAcceptance(
        {
          results: [
            { criterion: 1, status: "not_met" },
            { criterion: 1, status: "not_met" },
          ],
        },
        criteria,
        source,
      ),
    ).toBeNull();
    expect(validateAcceptance({ verdict: "ok" }, criteria, source)).toBeNull();
  });
});
