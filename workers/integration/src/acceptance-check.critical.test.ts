// Acceptance check citations (ADR 0026). Invariants: a `met` counts only with a
// quote that code finds in a patch or composed file the model received; removed patch lines and
// short quotes prove nothing; code already in the base can be cited from the composed file;
// malformed output (wrong criterion count) is invalid; only all-met passes.

import { describe, expect, it } from "vitest";
import {
  acceptanceOutcome,
  acceptanceSource,
  citationValid,
  composedFileOrder,
  judgeAcceptance,
  validateAcceptance,
} from "./acceptance-check.ts";
import { KEEP_PREFIX } from "./kept-criteria.ts";

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
  const source = acceptanceSource({ text: PATCH, truncated: false }, []);

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
    const files = acceptanceSource(null, [
      { path: "src/a.ts", text: "export const kanban = true;\n" },
    ]);
    expect(citationValid(files, { path: "src/a.ts", quote: "export const kanban" })).toBe(true);
  });

  it("meets a criterion with unchanged composed code the patch does not show", () => {
    // This Change touched only the stylesheet; the counter page came from an earlier Change.
    const patch = [
      "diff --git a/public/style.css b/public/style.css",
      "--- a/public/style.css",
      "+++ b/public/style.css",
      "@@ -1 +1 @@",
      "-h1 { color: black; }",
      "+h1 { color: navy; }",
      "",
    ].join("\n");
    const indexHtml = [
      "<!doctype html>",
      '<link rel="stylesheet" href="/style.css">',
      "<h1>Team counter</h1>",
      '<output id="count">0</output>',
      '<button id="dec">-</button><button id="inc">+</button>',
      '<script type="module" src="./counter.js"></script>',
    ].join("\n");
    const tree = [
      "public/index.html",
      "public/style.css",
      "public/counter.js",
      "src/app.ts",
      "README.md",
    ];
    expect(composedFileOrder(tree, ["public/style.css"], indexHtml)).toEqual([
      "public/style.css",
      "public/index.html",
      "public/counter.js",
      "src/app.ts",
    ]);
    const read = acceptanceSource({ text: patch, truncated: false }, [
      { path: "public/style.css", text: "h1 { color: navy; }\n" },
      { path: "public/index.html", text: indexHtml },
    ]);
    const criteria = ["Home page shows heading 'Team counter' with a count and + and - buttons"];
    const met = validateAcceptance(
      {
        results: [
          {
            criterion: 1,
            status: "met",
            citations: [{ path: "public/index.html", quote: "<h1>Team counter</h1>" }],
          },
        ],
      },
      criteria,
      read,
    );
    expect(met?.[0]?.status).toBe("met");
    expect(acceptanceOutcome(met ?? [])).toMatchObject({ status: "pass" });
    // The patch alone cannot support the same citation: the rule "met needs a valid quote" holds.
    const patchOnly = acceptanceSource({ text: patch, truncated: false }, []);
    expect(
      citationValid(patchOnly, { path: "public/index.html", quote: "<h1>Team counter</h1>" }),
    ).toBe(false);
    // A removed patch line stays invalid even though the composed file shares its path.
    expect(citationValid(read, { path: "public/style.css", quote: "h1 { color: black; }" })).toBe(
      false,
    );
  });

  it("puts the patch first and cuts composed files at the cap, marked truncated", () => {
    const read = acceptanceSource(
      { text: PATCH, truncated: false },
      [{ path: "src/big.ts", text: "const line = 1;\n".repeat(200) }],
      PATCH.length + 400,
    );
    expect(read.files[0]?.kind).toBe("patch");
    const last = read.files.at(-1);
    expect(last).toMatchObject({ kind: "file", path: "src/big.ts", truncated: true });
    expect(read.truncated).toBe(true);
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

  it("reads a missing criterion as unclear and a repeated one as invalid", () => {
    const criteria = ["A", "B"];
    expect(
      validateAcceptance({ results: [{ criterion: 1, status: "not_met" }] }, criteria, source),
    ).toEqual([
      { criterion: "A", status: "not_met", citations: [] },
      { criterion: "B", status: "unclear", citations: [] },
    ]);
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

  it("reads a citation's `text` field as its quote", () => {
    const quote = "export function CalendarView()";
    expect(
      validateAcceptance(
        {
          results: [
            { criterion: 1, status: "met", citations: [{ path: "src/calendar.tsx", text: quote }] },
          ],
        },
        ["A"],
        source,
      ),
    ).toEqual([
      { criterion: "A", status: "met", citations: [{ path: "src/calendar.tsx", quote }] },
    ]);
  });

  it("passes with unclear kept criteria, but never with a kept criterion that is not met", () => {
    const own = { criterion: "A", status: "met" as const, citations: [] };
    const keep = (status: "unclear" | "not_met") => ({
      criterion: `${KEEP_PREFIX}Search filters the list`,
      status,
      citations: [],
    });
    expect(acceptanceOutcome([own, keep("unclear")])).toMatchObject({ status: "pass" });
    expect(acceptanceOutcome([own, keep("not_met")])).toMatchObject({ status: "fail" });
    expect(
      acceptanceOutcome([{ ...own, status: "unclear" as const }, keep("unclear")]),
    ).toMatchObject({ status: "fail" });
  });

  it("asks Sonnet about criteria Haiku left unclear, and only then", async () => {
    const src = {
      files: [{ path: "src/calendar.tsx", kind: "patch" as const, text: PATCH }],
      truncated: false,
    };
    const call = (results: unknown[]) =>
      ({
        toolCalls: [
          { function: { name: "record_acceptance", arguments: JSON.stringify({ results }) } },
        ],
        model: "m",
        tier: "haiku",
        inputTokens: 1,
        outputTokens: 1,
        costUsd: 0.01,
        gatewayLogId: null,
      }) as never;
    const quote = { path: "src/calendar.tsx", quote: "export function CalendarView()" };
    const tiers: string[] = [];
    const judged = await judgeAcceptance(["A calendar view exists", "B"], src, async (req) => {
      tiers.push(req.tier);
      return req.tier === "haiku"
        ? call([
            { criterion: 1, status: "unclear" },
            { criterion: 2, status: "not_met" },
          ])
        : call([
            { criterion: 1, status: "met", citations: [quote] },
            { criterion: 2, status: "met", citations: [quote] },
          ]);
    });
    expect(tiers).toEqual(["haiku", "sonnet"]);
    // Sonnet decides only what Haiku left unclear.
    expect(judged).toMatchObject({
      kind: "judged",
      results: [{ status: "met" }, { status: "not_met" }],
    });
    tiers.length = 0;
    await judgeAcceptance([`${KEEP_PREFIX}Kept thing`], src, async (req) => {
      tiers.push(req.tier);
      return call([{ criterion: 1, status: "unclear" }]);
    });
    expect(tiers).toEqual(["haiku"]);
  });
});
