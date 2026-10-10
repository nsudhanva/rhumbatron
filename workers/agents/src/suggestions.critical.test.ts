// Suggestion pills: ranking follows Clef's probabilities, a refused or failed call shows nothing,
// and the result is cached per generation so a page view never calls Clef twice.
import type { DecisionModel } from "@rhumbatron/model-router";
import { describe, expect, it, vi } from "vitest";
import { EXTEND_GOALS, hasAppCode, rankOptions, START_GOALS, suggestGoals } from "./suggestions.ts";

describe("rankOptions", () => {
  it("orders by probability, ties in catalog order, top four", () => {
    const options = ["a", "b", "c", "d", "e"];
    expect(rankOptions(options, { c: 0.5, e: 0.3, a: 0.1, b: 0.1 })).toEqual(["c", "e", "a", "b"]);
  });

  it("returns nothing when the model gave no probabilities (abstain or refusal)", () => {
    expect(rankOptions(["a", "b"], {})).toEqual([]);
  });
});

describe("hasAppCode", () => {
  it("is false for an empty repository and true once code exists", () => {
    expect(hasAppCode([".gitignore"])).toBe(false);
    expect(hasAppCode([".gitignore", "src/worker.ts"])).toBe(true);
  });
});

type Row = { suggestions_json: string; created_at: string };

function fakeEnv(opts: { files: string[]; cache?: Row }) {
  const writes: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) {
          args = a;
          return stmt;
        },
        async first() {
          if (sql.includes("FROM projects")) return { name: "Wish Maadi", status: "active" };
          if (sql.includes("FROM goal_suggestions")) return opts.cache ?? null;
          return null;
        },
        async all() {
          return { results: [{ goal: "Make me a todo app" }] };
        },
        async run() {
          writes.push(args);
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  const canonical = { generation: 3, artifactRef: "artifacts://p@main", treeSha: "t".repeat(40) };
  const env = {
    DB: db,
    EVIDENCE: { get: async () => ({ json: async () => ({ files: opts.files }) }) },
    PROJECT_ROOT: { idFromName: () => "id", get: () => ({ getCanonical: async () => canonical }) },
    AI: {},
  } as unknown as Parameters<typeof suggestGoals>[0];
  return { env, writes };
}

describe("suggestGoals", () => {
  it("ranks the start catalog for an empty repository and caches the result", async () => {
    const { env, writes } = fakeEnv({ files: [".gitignore"] });
    const model: DecisionModel = {
      decide: vi.fn(async (req) => {
        const options = req.questions[0]?.options ?? [];
        expect(options).toEqual(START_GOALS);
        return [
          {
            questionId: "next_goal",
            choice: options[11] ?? null,
            probabilities: { [options[11] as string]: 0.6, [options[0] as string]: 0.2 },
            abstained: false,
          },
        ];
      }),
    };
    const out = await suggestGoals(env, "proj_x", model);
    expect(out.generation).toBe(3);
    expect(out.suggestions).toEqual([
      START_GOALS[11],
      START_GOALS[0],
      START_GOALS[1],
      START_GOALS[2],
    ]);
    expect(writes).toHaveLength(1);
  });

  it("serves a cache hit without calling the model", async () => {
    const { env } = fakeEnv({
      files: ["src/worker.ts"],
      cache: {
        suggestions_json: JSON.stringify([EXTEND_GOALS[0]]),
        created_at: new Date().toISOString(),
      },
    });
    const decide = vi.fn();
    const out = await suggestGoals(env, "proj_x", { decide });
    expect(decide).not.toHaveBeenCalled();
    expect(out.suggestions).toEqual([EXTEND_GOALS[0]]);
  });

  it("shows nothing when the call is refused or fails, and caches the empty list", async () => {
    const { env, writes } = fakeEnv({ files: ["src/worker.ts"] });
    const out = await suggestGoals(env, "proj_x", {
      decide: async () => {
        throw new Error("cap");
      },
    });
    expect(out.suggestions).toEqual([]);
    expect(writes[0]?.[2]).toBe("[]");
  });
});
