// Sibling selection (ADR 0026). Invariants: no selection while a sibling still verifies; exactly one
// run claims the selection, and a retry by the claimant is safe; ranking is promotable, then
// criteria met, then fewer gaps, then more passing checks; a tie only resolves through a judge
// verdict whose citations validate, anything else goes to a person. Acceptance gates auto-promotion,
// never promotability: a shortfall or a gap holds the winner for a person with the reason.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

vi.mock("./events.ts", () => ({
  changeEvent: async (_ctx: unknown, eventType: string, payload: unknown) => ({
    eventType,
    payload,
  }),
  appendChangeEvents: vi.fn(),
}));

const {
  acceptanceShortfall,
  applySelection,
  holdForAcceptance,
  prepareSelection,
  rankCandidates,
  validateJudgeVerdict,
} = await import("./candidate-selection.ts");
const { appendChangeEvents } = await import("./events.ts");

const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");
const T = "2026-10-11T00:00:00.000Z";

const entry = (
  candidateId: string,
  over: Partial<Parameters<typeof rankCandidates>[0][number]> = {},
) => ({
  candidateId,
  promotable: true,
  criteriaMet: 3,
  criteriaTotal: 3,
  gaps: 0,
  passingChecks: 5,
  ...over,
});

describe("rankCandidates", () => {
  it("orders by promotable, criteria met, gaps, then passing checks", () => {
    expect(rankCandidates([entry("a", { promotable: false, criteriaMet: 9 }), entry("b")])).toEqual(
      {
        kind: "winner",
        winner: "b",
      },
    );
    expect(rankCandidates([entry("a", { criteriaMet: 2 }), entry("b")])).toEqual({
      kind: "winner",
      winner: "b",
    });
    expect(rankCandidates([entry("a", { gaps: 1 }), entry("b", { passingChecks: 1 })])).toEqual({
      kind: "winner",
      winner: "b",
    });
    expect(rankCandidates([entry("a", { passingChecks: 6 }), entry("b")])).toEqual({
      kind: "winner",
      winner: "a",
    });
    expect(rankCandidates([entry("b"), entry("a"), entry("c", { gaps: 2 })])).toEqual({
      kind: "tie",
      tied: ["a", "b"],
    });
    expect(rankCandidates([entry("a", { promotable: false })])).toEqual({ kind: "none" });
  });
});

describe("validateJudgeVerdict", () => {
  const snapshot = {
    projectId: "proj_1",
    candidates: [
      { candidateId: "cand_a", evidence: [{ evidenceId: "ev_a_unit", candidateId: "cand_a" }] },
      { candidateId: "cand_b", evidence: [{ evidenceId: "ev_b_unit", candidateId: "cand_b" }] },
    ],
  };
  const raw = (over: Record<string, unknown>) => ({
    verdict: "prefer_candidate",
    candidateId: "cand_a",
    rationale: "Faster unit run",
    citations: ["ev_a_unit", "ev_b_unit"],
    ...over,
  });

  it("accepts a preference that cites Evidence of the snapshot", () => {
    expect(validateJudgeVerdict(raw({}), snapshot)).toMatchObject({
      verdict: "prefer_candidate",
      candidateId: "cand_a",
    });
  });

  it.each([
    ["an invented Evidence ID", raw({ citations: ["ev_x"] })],
    ["no citation of the preferred Candidate", raw({ citations: ["ev_b_unit"] })],
    ["a Candidate outside the tie", raw({ candidateId: "cand_z" })],
    ["needs_more_evidence", raw({ verdict: "needs_more_evidence" })],
    ["reject_candidate", raw({ verdict: "reject_candidate" })],
    ["a verdict outside the vocabulary", raw({ verdict: "ship_it" })],
    ["no tool output", null],
  ])("escalates to a person on %s", (_name, output) => {
    expect(validateJudgeVerdict(output, snapshot).verdict).toBe("escalate_to_human");
  });
});

function harness() {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  db.exec(`INSERT INTO projects (id, org_id, name, slug, status, created_at, updated_at)
    VALUES ('proj_1', 'org_1', 'Planner', 'planner', 'active', '${T}', '${T}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, risk_tier, budget_usd, created_by, created_at, updated_at)
    VALUES ('chg_1', 'proj_1', 'Calendar with a kanban per day', 'verifying', 0, 'low', 3, 'user_1', '${T}', '${T}');
    INSERT INTO tasks (id, change_id, kind, status, created_at, updated_at)
    VALUES ('tsk_1', 'chg_1', 'implement', 'completed', '${T}', '${T}');`);
  const plan = (id: string) =>
    JSON.stringify({
      candidateId: id,
      checks: [
        {
          checkId: "build",
          kind: "build",
          reason: "r",
          command: "bun run typecheck",
          timeoutMs: 120000,
          required: true,
          expected: { kind: "exit_code", code: 0 },
          evidenceOutput: ["report.json"],
        },
      ],
      requiredCheckIds: ["build"],
      humanApprovalRequired: false,
      policyVersion: "policy-1",
    });
  const addCandidate = (id: string, status: string, at: string, criteriaMet: number) => {
    db.prepare(`INSERT INTO candidates (id, change_id, base_generation, status, change_set_ids_json, plan_json,
        acceptance_json, created_at, updated_at) VALUES (?, 'chg_1', 0, ?, '[]', ?, ?, ?, ?)`).run(
      id,
      status,
      plan(id),
      JSON.stringify(
        ["calendar", "kanban", "persist"].map((criterion, i) => ({
          criterion,
          status: i < criteriaMet ? "met" : "not_met",
          citations: i < criteriaMet ? [{ path: "src/a.tsx", quote: "export function A()" }] : [],
        })),
      ),
      at,
      at,
    );
    db.prepare(`INSERT INTO evidence_index (id, candidate_id, kind, status, summary, content_hash, created_at,
        check_id, coverage, started_at, completed_at) VALUES (?, ?, 'build', 'pass', 'ok', 'h', ?, 'build',
        'checked_supported', ?, ?)`).run(`ev_${id}_build`, id, T, T, T);
  };
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) },
    }),
  });
  const env = {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: ReturnType<typeof statement>[]) => {
        const out = [];
        for (const s of statements) out.push(await s.run());
        return out;
      },
    },
  } as unknown as Env;
  return { db, env, addCandidate };
}

describe("single selector on D1", () => {
  // Seen on prod: a repair added a Candidate after the group was decided, and nobody selected it.
  it("starts a new round when a Candidate joins a decided group", async () => {
    const h = harness();
    try {
      h.addCandidate("cand_a", "rejected", "2026-10-11T00:00:01.000Z", 1);
      h.addCandidate("cand_b", "rejected", "2026-10-11T00:00:02.000Z", 2);
      h.db.exec(
        `UPDATE candidates SET selection_json = '{"status":"decided","winnerCandidateId":"cand_b"}'`,
      );
      h.addCandidate("cand_c", "verified", "2026-10-11T00:00:03.000Z", 3);
      const prep = await prepareSelection(h.env.DB, "cand_c");
      expect(prep.kind).toBe("ranked");
      if (prep.kind !== "ranked") return;
      expect(prep.anchorId).toBe("cand_c");
      expect(prep.ranking).toMatchObject({ kind: "winner", winner: "cand_c" });
    } finally {
      h.db.close();
    }
  });

  it("waits for a verifying sibling, then lets exactly one run select; a retry is safe", async () => {
    const h = harness();
    try {
      h.addCandidate("cand_a", "verified", "2026-10-11T00:00:01.000Z", 2);
      h.addCandidate("cand_b", "verifying", "2026-10-11T00:00:02.000Z", 3);
      expect(await prepareSelection(h.env.DB, "cand_a")).toEqual({
        kind: "waiting",
        pending: ["cand_b"],
      });

      h.db.exec("UPDATE candidates SET status = 'verified' WHERE id = 'cand_b'");
      const [a, b] = await Promise.all([
        prepareSelection(h.env.DB, "cand_a"),
        prepareSelection(h.env.DB, "cand_b"),
      ]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(["not_mine", "ranked"]);
      const claimant = a.kind === "ranked" ? "cand_a" : "cand_b";
      // The claimant's retry still proceeds; the other run still does not.
      const retry = await prepareSelection(h.env.DB, claimant);
      expect(retry.kind).toBe("ranked");
      if (retry.kind !== "ranked") return;
      expect(retry.ranking).toEqual({ kind: "winner", winner: "cand_b" });

      const result = await applySelection(h.env, retry, null);
      expect(result).toMatchObject({ winner: "cand_b", escalated: false });
      const rows = h.db
        .prepare("SELECT id, status, status_reason, selection_json FROM candidates ORDER BY id")
        .all() as {
        id: string;
        status: string;
        status_reason: string | null;
        selection_json: string;
      }[];
      expect(rows[0]).toMatchObject({
        id: "cand_a",
        status: "rejected",
        status_reason: "Lost to cand_b: met 3 of 3 criteria, this met 2 of 3.",
      });
      expect(rows[1]).toMatchObject({ id: "cand_b", status: "verified" });
      expect(JSON.parse(rows[1]?.selection_json ?? "{}")).toMatchObject({
        status: "decided",
        winnerCandidateId: "cand_b",
      });
      expect(
        h.db.prepare("SELECT decision_type FROM decision_receipts WHERE task_id = 'tsk_1'").get(),
      ).toEqual({ decision_type: "CANDIDATE_SELECTION" });
      expect(vi.mocked(appendChangeEvents).mock.calls.at(-1)?.[2]).toEqual([
        expect.objectContaining({ eventType: "candidate.selected" }),
      ]);

      // A decided selection is never claimed again, and applying it twice changes nothing.
      expect((await prepareSelection(h.env.DB, claimant)).kind).toBe("not_mine");
      await applySelection(h.env, retry, null);
      expect(h.db.prepare("SELECT COUNT(*) AS n FROM decision_receipts").get()).toEqual({ n: 1 });
    } finally {
      h.db.close();
    }
  });

  it("a tie without a valid judge verdict escalates to a person", async () => {
    const h = harness();
    try {
      h.addCandidate("cand_a", "verified", "2026-10-11T00:00:01.000Z", 3);
      h.addCandidate("cand_b", "verified", "2026-10-11T00:00:02.000Z", 3);
      const prep = await prepareSelection(h.env.DB, "cand_b");
      expect(prep.kind).toBe("ranked");
      if (prep.kind !== "ranked") return;
      expect(prep.ranking).toEqual({ kind: "tie", tied: ["cand_a", "cand_b"] });
      const result = await applySelection(h.env, prep, {
        decision: {
          verdict: "escalate_to_human",
          reason: "judge returned needs_more_evidence",
          modelVerdict: "needs_more_evidence",
          rationale: null,
        },
        call: null,
      });
      expect(result).toMatchObject({ winner: null, escalated: true });
      expect(h.db.prepare("SELECT status FROM changes").get()).toEqual({
        status: "awaiting_approval",
      });
      expect(
        h.db.prepare("SELECT status FROM candidates WHERE status = 'verified'").all(),
      ).toHaveLength(2);
    } finally {
      h.db.close();
    }
  });
});

describe("acceptance gates auto-promotion, not promotability", () => {
  const plan = {
    checks: [{ kind: "acceptance" }],
  } as unknown as Parameters<typeof acceptanceShortfall>[0]["plan"];
  const results = [
    { criterion: "calendar view", status: "not_met" as const, citations: [] },
    { criterion: "kanban per day", status: "met" as const, citations: [] },
    { criterion: "saved per day", status: "met" as const, citations: [] },
  ];

  it("lets a full pass and a plan without the check go on", () => {
    const pass = { status: "pass" as const, coverage: "checked_supported" as const, summary: "" };
    expect(
      acceptanceShortfall({ plan, latest: pass, acceptance: results, siblings: true }),
    ).toBeNull();
    expect(
      acceptanceShortfall({
        plan: { checks: [] },
        latest: undefined,
        acceptance: null,
        siblings: false,
      }),
    ).toBeNull();
  });

  it("states a shortfall and treats a gap as a reason to ask a person", () => {
    expect(
      acceptanceShortfall({
        plan,
        latest: { status: "fail", coverage: "checked_supported", summary: "2 of 3" },
        acceptance: results,
        siblings: true,
      }),
    ).toBe(
      "Best candidate meets 2 of 3 criteria; not met: calendar view. Approve to ship it or cancel the change.",
    );
    expect(
      acceptanceShortfall({
        plan,
        latest: { status: "error", coverage: "not_checked", summary: "No result (runner: x)" },
        acceptance: null,
        siblings: false,
      }),
    ).toContain("The candidate has no acceptance result (No result).");
    expect(
      acceptanceShortfall({ plan, latest: undefined, acceptance: null, siblings: false }),
    ).toContain("the check did not run");
  });

  it("holds a verified Candidate: plan gains the human gate, Change awaits approval", async () => {
    const h = harness();
    try {
      h.addCandidate("cand_a", "verified", "2026-10-11T00:00:01.000Z", 2);
      h.db.exec(`UPDATE candidates SET plan_json = json_set(plan_json, '$.checks[1]',
        json('{"checkId":"acceptance","kind":"acceptance","reason":"r","procedure":"p","timeoutMs":180000,"required":false,"expected":{"kind":"procedure","description":"d"},"evidenceOutput":["report.json"]}'));
        INSERT INTO evidence_index (id, candidate_id, kind, status, summary, content_hash, created_at,
          check_id, coverage, started_at, completed_at) VALUES ('ev_a_acc', 'cand_a', 'acceptance',
          'fail', '2 of 3', 'h', '${T}', 'acceptance', 'checked_supported', '${T}', '${T}');`);
      const reason = await holdForAcceptance(h.env, "cand_a");
      expect(reason).toContain("meets 2 of 3 criteria; not met: persist");
      const row = h.db.prepare("SELECT status, status_reason, plan_json FROM candidates").get() as {
        status: string;
        status_reason: string;
        plan_json: string;
      };
      expect(row.status).toBe("verified");
      expect(row.status_reason).toBe(reason);
      expect(JSON.parse(row.plan_json).humanApprovalRequired).toBe(true);
      expect(h.db.prepare("SELECT status FROM changes").get()).toEqual({
        status: "awaiting_approval",
      });
    } finally {
      h.db.close();
    }
  });
});
