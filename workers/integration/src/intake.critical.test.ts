// Intake gate (ADR 0025): citations, the cascade rule that one cheap model never stops a request,
// and the order-swapped Sonnet agreement. Models are scripted; the rules and validators are real.
import type { CompletionResult, DecisionModel, DecisionRequest } from "@rhumbatron/model-router";
import { describe, expect, it } from "vitest";
import {
  buildPacket,
  duplicateDecision,
  lacksObject,
  retrieveRelated,
  reviewIntake,
  validateCoverage,
  validateInterpretations,
} from "./intake.ts";
import { type RelatedItem, summarizeCanonical, UNKNOWN_CANONICAL } from "./intake-context.ts";

const c1: RelatedItem = {
  changeId: "chg_c1",
  goal: "gta6 mission planner, calendar of missions, each day has a kanban list",
  status: "running",
  items: [
    {
      id: "chg_c1:goal",
      text: "gta6 mission planner, calendar of missions, each day has a kanban list",
    },
    { id: "chg_c1:c1", text: "Each calendar day shows a kanban list with todo, doing and done" },
    { id: "chg_c1:c2", text: "Missions can be dragged between kanban columns" },
  ],
};
const recipes: RelatedItem = {
  changeId: "chg_r",
  goal: "Recipe search",
  status: "completed",
  items: [{ id: "chg_r:goal", text: "Recipe search" }],
};

function reply(name: string, args: unknown, costUsd = 0.01): CompletionResult {
  const toolCalls = [
    { id: "x", type: "function" as const, function: { name, arguments: JSON.stringify(args) } },
  ];
  return {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    tier: "sonnet",
    content: null,
    toolCalls,
    message: { role: "assistant", content: null, tool_calls: toolCalls },
    finishReason: "tool_use",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd,
    latencyMs: 1,
    gatewayLogId: null,
  };
}

/** Clef-flash stub: a fixed choice per question with the given probability. */
function clef(choices: Record<string, [string, number]>): DecisionModel {
  return {
    async decide(req: DecisionRequest) {
      return req.questions.map((q) => {
        const [choice, p] = choices[q.id] ?? [q.options[0] as string, 0.5];
        const probabilities: Record<string, number> = Object.fromEntries(
          q.options.map((o) => [o, o === choice ? p : (1 - p) / (q.options.length - 1)]),
        );
        return { questionId: q.id, choice, probabilities, abstained: false };
      });
    },
  };
}

const covered = (verdict: string, quote = "Each calendar day shows a kanban list") =>
  reply("coverage_review", {
    items: [{ itemId: "chg_c1", verdict, quotes: [{ sourceId: "chg_c1:c1", quote }] }],
  });

async function review(options: {
  request: string;
  clef: DecisionModel | null;
  replies: Record<string, CompletionResult[]>;
  targets?: RelatedItem[];
}) {
  const calls: string[] = [];
  const packet = buildPacket(options.request, options.targets ?? [c1], UNKNOWN_CANONICAL);
  const outcome = await reviewIntake(
    {
      changeId: "chg_c2",
      request: options.request,
      packet,
      retrieval: {
        method: "tokens",
        reranked: false,
        scores: [],
        related: options.targets ?? [c1],
      },
    },
    {
      clef: options.clef,
      canSpend: () => true,
      complete: async (req) => {
        const name = req.tools?.[0]?.function.name ?? "";
        calls.push(name);
        const next = options.replies[name]?.shift();
        if (!next) throw Error(`unexpected ${name}`);
        return next;
      },
    },
  );
  return { outcome, calls };
}

describe("intake duplicate cascade", () => {
  it("stops the C2 'Add kanban feature' request as a duplicate only when Clef and both Sonnet orders agree", async () => {
    const { outcome, calls } = await review({
      request: "Add kanban feature",
      clef: clef({ item_0: ["already_covered", 0.8] }),
      replies: { coverage_review: [covered("already_covered"), covered("duplicate")] },
    });
    expect(calls).toEqual(["coverage_review", "coverage_review"]);
    expect(outcome.decision).toBe("ask");
    expect(outcome.clarification).toMatchObject({ kind: "duplicate", relatedChangeId: "chg_c1" });
    expect(outcome.clarification?.questions[0]?.text).toContain(
      '"Each calendar day shows a kanban list"',
    );
    expect(outcome.costUsd).toBeCloseTo(0.02);
  });

  it("names the related goal once: a quote of the goal itself is not repeated", async () => {
    const goal = c1.goal;
    const quoted = reply("coverage_review", {
      items: [
        {
          itemId: "chg_c1",
          verdict: "duplicate",
          quotes: [
            { sourceId: "chg_c1:goal", quote: goal },
            { sourceId: "chg_c1:c1", quote: "Each calendar day shows a kanban list" },
          ],
        },
      ],
    });
    const { outcome } = await review({
      request: "Add kanban feature",
      clef: clef({ item_0: ["already_covered", 0.8] }),
      replies: { coverage_review: [covered("already_covered"), quoted] },
    });
    expect(outcome.clarification?.questions[0]?.text).toBe(
      `This looks covered by "${goal}": "Each calendar day shows a kanban list". What is different in your request?`,
    );
  });

  it("never stops a request on Clef alone: both Sonnet orders disagree, so it plans", async () => {
    const { outcome } = await review({
      request: "Add a weekly budget chart to the mission planner with totals per crew member",
      clef: clef({ item_0: ["duplicate", 0.99], buildable: ["buildable", 0.95] }),
      replies: { coverage_review: [covered("extends"), covered("unrelated")] },
    });
    expect(outcome).toMatchObject({ decision: "plan", clarification: null });
    expect(duplicateDecision("duplicate", undefined, undefined)).toBe("none");
  });

  it("asks what is different when only one Sonnet order finds it covered", async () => {
    const { outcome } = await review({
      request: "Add kanban columns to each day of the planner",
      clef: clef({ item_0: ["extends", 0.6] }),
      replies: { coverage_review: [covered("already_covered"), covered("extends")] },
    });
    expect(outcome.clarification).toMatchObject({ kind: "unclear", relatedChangeId: "chg_c1" });
  });

  it("drops an invented quote: a covered verdict without packet text counts for nothing", async () => {
    const fake = covered("duplicate", "kanban board with swimlanes per crew");
    const { outcome } = await review({
      request: "Add kanban swimlanes per crew member to the planner board",
      clef: clef({ item_0: ["duplicate", 0.9], buildable: ["buildable", 0.95] }),
      replies: {
        coverage_review: [fake, covered("duplicate", "kanban board with swimlanes per crew")],
      },
    });
    expect(outcome.decision).toBe("plan");
    const packet = buildPacket("x", [c1, recipes], UNKNOWN_CANONICAL);
    // A quote from another target's source is not a citation of this target.
    expect(
      validateCoverage(
        {
          items: [
            {
              itemId: "chg_r",
              verdict: "duplicate",
              quotes: [{ sourceId: "chg_c1:c1", quote: "kanban list" }],
            },
          ],
        },
        packet,
      ),
    ).toEqual({ chg_r: { verdict: "unsupported", quotes: [] } });
    expect(
      validateCoverage({ items: [{ itemId: "chg_x", verdict: "unrelated", quotes: [] }] }, packet),
    ).toBeNull();
  });

  it("lets Clef clear an unrelated pair (P >= 0.9) without any Sonnet coverage call", async () => {
    const { outcome, calls } = await review({
      request: "Recipe search by ingredient with a fuzzy match",
      clef: clef({ item_0: ["unrelated", 0.95], buildable: ["buildable", 0.92] }),
      replies: {},
    });
    expect(calls).toEqual([]);
    expect(outcome).toMatchObject({ decision: "plan", costUsd: 0 });
  });
});

describe("intake clarity cascade", () => {
  it("asks by rule when the goal names no object, before any Clef score counts", async () => {
    expect(lacksObject("build the kanban")).toBe(true);
    expect(lacksObject("Add kanban feature")).toBe(true);
    expect(lacksObject("Add dark mode to the settings page")).toBe(false);
    const { outcome } = await review({
      request: "build the app",
      clef: clef({ buildable: ["buildable", 0.99] }),
      replies: {
        list_interpretations: [
          reply("list_interpretations", { interpretations: [], decisions: [] }),
        ],
      },
      targets: [],
    });
    expect(outcome.clarification).toMatchObject({ kind: "unclear" });
  });

  it("asks with distinct readings as options only when their quotes are in the request", async () => {
    const request = "Show a calendar of missions with reminders";
    const readings = (quote: string) =>
      reply("list_interpretations", {
        interpretations: [
          { summary: "Email reminders before each mission", goalQuote: quote },
          { summary: "In-app reminder badges on the calendar", goalQuote: quote },
        ],
        decisions: ["How far ahead a reminder fires"],
      });
    const asked = await review({
      request,
      clef: clef({ buildable: ["buildable", 0.6] }),
      replies: { list_interpretations: [readings("with reminders")] },
      targets: [],
    });
    expect(asked.outcome.clarification?.questions[0]).toMatchObject({
      options: ["Email reminders before each mission", "In-app reminder badges on the calendar"],
    });
    const invented = await review({
      request,
      clef: clef({ buildable: ["buildable", 0.6] }),
      replies: { list_interpretations: [readings("with push notifications")] },
      targets: [],
    });
    expect(invented.outcome.decision).toBe("plan");
    expect(validateInterpretations({ interpretations: "x" }, request)).toBeNull();
  });

  it("plans a clear request (Clef >= 0.9) with no Sonnet call and asks on Clef <= 0.4", async () => {
    const request = "Add a dark mode toggle to the settings page that persists per user";
    const clear = await review({
      request,
      clef: clef({ buildable: ["buildable", 0.93] }),
      replies: {},
      targets: [],
    });
    expect(clear.calls).toEqual([]);
    expect(clear.outcome.decision).toBe("plan");
    const vague = await review({
      request,
      clef: clef({ buildable: ["needs_detail", 0.8] }),
      replies: {
        list_interpretations: [
          reply("list_interpretations", { interpretations: [], decisions: [] }),
        ],
      },
      targets: [],
    });
    expect(vague.outcome.decision).toBe("ask");
  });
});

describe("intake retrieval", () => {
  it("shortlists by cosine >= 0.55, lets the reranker order, and falls back to shared words", async () => {
    const vectors: Record<string, number[]> = { q: [1, 0], a: [0.9, 0.1], b: [0, 1] };
    const ai = {
      async run(model: string, input: { text?: string[] }) {
        if (model.includes("reranker")) return { response: [{ id: 0, score: 0.9 }] };
        return { data: (input.text ?? []).map((_, i) => [vectors.q, vectors.a, vectors.b][i]) };
      },
    };
    const found = await retrieveRelated(ai, "kanban", [c1, recipes]);
    expect(found).toMatchObject({ method: "embedding", related: [c1] });
    const fallback = await retrieveRelated(
      { run: async () => Promise.reject(Error("down")) },
      "Add kanban feature",
      [recipes, c1],
    );
    expect(fallback).toMatchObject({ method: "tokens", related: [c1] });
  });

  it("summarizes the current app from paths and dependency names", () => {
    expect(summarizeCanonical(["package.json", "src/app.tsx"], ["react", "hono"])).toMatchObject({
      empty: false,
      stack: ["hono", "jsx", "react"],
    });
    expect(summarizeCanonical([".gitignore"]).empty).toBe(true);
    expect(summarizeCanonical(null).known).toBe(false);
  });
});
