// Run the workflow and the real Evidence gate against SQLite. Only execution and platform
// boundaries are faked: a runtime GET failure must reject before any canonical decision.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppProbeInput } from "@rhumbatron/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(
      _ctx: unknown,
      protected env: Env,
    ) {}
  },
}));
vi.mock("./candidate-sandbox.ts", () => ({
  candidateFork: (id: string) => `candidate-${id}`,
  forkCandidate: async (_env: Env, _project: string, id: string) => `candidate-${id}`,
  composeCandidate: async () => ({
    ok: true,
    commit: "2".repeat(40),
    tree: "3".repeat(40),
    merged: ["cs_1"],
  }),
  reserveSandbox: async () => true,
  settleSandbox: async () => {},
  removeCandidateDir: async () => {},
  runCandidateCheck: async () => ({
    exitCode: 0,
    output: "1 pass\n0 fail\n",
    timedOut: false,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  }),
  runContractCheck: async () => ({
    base: { exitCode: 0, output: '{"routes":[]}', timedOut: false },
    candidate: {
      exitCode: 0,
      output: '{"routes":["GET /api/recipes","POST /api/recipes","GET /api/recipes/:id"]}',
      timedOut: false,
    },
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  }),
}));
vi.mock("./code-store.ts", () => ({ storeTreeCode: vi.fn() }));
vi.mock("./events.ts", () => ({
  changeEvent: async (_ctx: unknown, eventType: string, payload: unknown) => ({
    eventType,
    payload,
  }),
  appendChangeEvents: vi.fn(),
}));
vi.mock("./promotion.ts", () => ({ promoteCandidate: vi.fn(), markCandidateStale: vi.fn() }));
vi.mock("./recompose.ts", () => ({
  recomposeQuietly: vi.fn(async () => ({ status: "recomposed", candidateId: "cand_next" })),
}));
vi.mock("./app-release.ts", async (original) => {
  const actual = await original<typeof import("./app-release.ts")>();
  return { ...actual, publishPreview: vi.fn() };
});

const { CandidateVerificationWorkflow } = await import("./verification-workflow.ts");
const { publishPreview, probeApp } = await import("./app-release.ts");
const { promoteCandidate } = await import("./promotion.ts");
const { appendChangeEvents } = await import("./events.ts");
const { recomposeQuietly } = await import("./recompose.ts");
const P = "proj_1111";
const C = "cand_0123abcd";
const COMMIT = "2".repeat(40);
const T = "2026-10-10T00:00:00.000Z";
const MIGRATIONS = join(import.meta.dirname, "../../../migrations/d1");

function harness(
  options: {
    apps?: boolean;
    unreachable?: boolean;
    status?: number;
    publication?: string;
    appStatus?: string;
    noTable?: boolean;
    /** The event router marks the Candidate stale just before this step runs. */
    staleAt?: string;
    initialStatus?: string;
  } = {},
) {
  vi.clearAllMocks();
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
  }
  db.exec(`INSERT INTO projects (id, org_id, name, slug, status, created_at, updated_at)
    VALUES ('${P}', 'org_1', 'Recipes', 'recipes', 'active', '${T}', '${T}');
    INSERT INTO changes (id, project_id, goal, status, base_generation, risk_tier, budget_usd, created_by, created_at, updated_at)
    VALUES ('chg_1', '${P}', 'Add recipes', 'verifying', 0, 'low', 3, 'user_1', '${T}', '${T}');
    INSERT INTO candidates (id, change_id, base_generation, status, change_set_ids_json, created_at, updated_at)
    VALUES ('${C}', 'chg_1', 0, '${options.initialStatus ?? "composing"}', '["cs_1"]', '${T}', '${T}');`);
  db.prepare(`INSERT INTO changesets (id, change_id, agent_id, base_generation, intent_json, status, created_at)
    VALUES ('cs_1', 'chg_1', 'agent_1', 0, ?, 'accepted', ?)`).run(
    JSON.stringify({
      summary: "Add recipes",
      expectedContractChanges: ["GET /api/recipes", "POST /api/recipes", "GET /api/recipes/:id"],
      changeSet: {
        fork: "task-1",
        commit: COMMIT,
        baseCommit: "1".repeat(40),
        diffStat: "",
        files: ["src/app.ts"],
      },
    }),
    T,
  );
  if (options.appStatus !== "missing") {
    db.prepare(`INSERT INTO app_deployments (project_id, slug, channel, status, created_at, updated_at)
      VALUES (?, 'recipes', 'production', ?, ?, ?)`).run(P, options.appStatus ?? "ready", T, T);
  }
  const statement = (sql: string, params: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(sql, next),
    first: async () => db.prepare(sql).get(...(params as never[])) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(params as never[])) }),
    run: async () => ({
      meta: { changes: Number(db.prepare(sql).run(...(params as never[])).changes) },
    }),
  });
  const objects = new Map<string, string>();
  const steps: string[] = [];
  const probe = vi.fn(async (input: AppProbeInput) => {
    // A production probe would be healthy and must never hide the broken Candidate.
    if (!input.previewId) return { status: 200, body: "[]" };
    if (options.unreachable) throw new Error("preview unavailable");
    return { status: input.path === "/api/recipes" ? (options.status ?? 500) : 200, body: "[]" };
  });
  const env = {
    DB: {
      prepare: (sql: string) => statement(sql),
      batch: async (statements: ReturnType<typeof statement>[]) =>
        Promise.all(statements.map((s) => s.all())),
    },
    EVIDENCE: {
      put: async (key: string, value: string) => {
        objects.set(key, value);
      },
      get: async (key: string) => {
        if (options.noTable && key.endsWith("contract/stdout.txt")) return null;
        const value = objects.get(key);
        return value === undefined
          ? null
          : { text: async () => value, json: async () => JSON.parse(value) };
      },
    },
    ARTIFACTS: { get: async () => ({ [Symbol.dispose]() {} }) },
    PROJECT_ROOT: {
      idFromName: (id: string) => id,
      get: () => ({
        getCanonical: async () => ({
          generation: 0,
          treeSha: "1".repeat(40),
          artifactRef: `artifacts://${P}@${"1".repeat(40)}`,
        }),
      }),
    },
    ...(options.apps === false ? {} : { APPS: { probe } }),
  } as unknown as Env;
  vi.mocked(publishPreview).mockImplementation(async () => {
    expect(db.prepare("SELECT status FROM candidates").get()?.status).toBe("verifying");
    if (options.publication === "throw") throw new Error("builder unavailable");
    if (options.publication === "limit") return { status: "limit" };
    if (options.appStatus === "missing") return { status: "no_app" };
    db.prepare(`INSERT INTO app_deployments (project_id, slug, channel, commit_sha, bundle_key, status, candidate_id, change_id, created_at, updated_at)
      VALUES (?, 'recipes', 'preview:0123abcd', ?, 'app-previews/bundle', 'ready', ?, 'chg_1', ?, ?)`).run(
      P,
      options.publication === "wrong_commit" ? "4".repeat(40) : COMMIT,
      C,
      T,
      T,
    );
    return { status: "current" };
  });
  const step = {
    async do(name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) {
      steps.push(name);
      if (name === options.staleAt) db.exec("UPDATE candidates SET status = 'stale'");
      const value = await (callback ?? (configOrCallback as () => Promise<unknown>))();
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
  } as Parameters<InstanceType<typeof CandidateVerificationWorkflow>["run"]>[1];
  const event = { payload: { candidateId: C } } as Parameters<
    InstanceType<typeof CandidateVerificationWorkflow>["run"]
  >[0];
  return {
    db,
    steps,
    probe,
    env,
    run: () => new CandidateVerificationWorkflow({} as ExecutionContext, env).run(event, step),
    candidate: () => db.prepare("SELECT status, status_reason, plan_json FROM candidates").get(),
    smoke: () => db.prepare("SELECT * FROM evidence_index WHERE check_id = 'preview-smoke'").get(),
  };
}

afterEach(() => vi.useRealTimers());

describe("required preview smoke before promotion", () => {
  it("rejects a 500 GET route even though build, unit, and contract pass", async () => {
    const h = harness();
    try {
      expect(await h.run()).toMatchObject({ status: "rejected", promotable: false });
      expect(h.candidate()).toMatchObject({
        status: "rejected",
        status_reason: "Preview check failed: GET /api/recipes returned 500.",
      });
      expect(h.smoke()).toMatchObject({
        kind: "smoke",
        status: "fail",
        coverage: "checked_supported",
      });
      expect(h.steps.indexOf("publish preview")).toBeLessThan(
        h.steps.indexOf("check preview-smoke"),
      );
      expect(h.steps.indexOf("check preview-smoke")).toBeLessThan(
        h.steps.indexOf("gate required checks"),
      );
      expect(h.steps).not.toContain("check canonical");
      expect(promoteCandidate).not.toHaveBeenCalled();
      expect(h.probe.mock.calls.map(([input]) => input)).toEqual([
        { label: "recipes", previewId: "0123abcd", path: "/" },
        { label: "recipes", previewId: "0123abcd", path: "/api/recipes" },
      ]);
      expect(appendChangeEvents).toHaveBeenCalledWith(undefined, expect.anything(), [
        expect.objectContaining({
          eventType: "verification.completed",
          payload: expect.objectContaining({
            reason: "Preview check failed: GET /api/recipes returned 500.",
          }),
        }),
      ]);
    } finally {
      h.db.close();
    }
  });

  it("an unreachable preview records not_checked and blocks promotion", async () => {
    const h = harness({ unreachable: true });
    try {
      expect(await h.run()).toMatchObject({ status: "rejected", promotable: false });
      expect(h.smoke()).toMatchObject({ status: "error", coverage: "not_checked" });
      expect(promoteCandidate).not.toHaveBeenCalled();
    } finally {
      h.db.close();
    }
  });

  it.each(["throw", "limit", "wrong_commit"])(
    "publication %s is a gap, with no production fallback",
    async (publication) => {
      const h = harness({ publication });
      try {
        expect(await h.run()).toMatchObject({ status: "rejected", promotable: false });
        expect(h.smoke()).toMatchObject({ coverage: "not_checked" });
        expect(h.probe).not.toHaveBeenCalled();
      } finally {
        h.db.close();
      }
    },
  );

  it("requires smoke for an app awaiting its first deployment", async () => {
    const h = harness({ appStatus: "missing" });
    try {
      expect(await h.run()).toMatchObject({ status: "rejected", promotable: false });
      expect(h.smoke()).toMatchObject({ coverage: "not_checked" });
    } finally {
      h.db.close();
    }
  });

  it("a missing contract report cannot silently reduce smoke to the home page", async () => {
    const h = harness({ noTable: true });
    try {
      expect(await h.run()).toMatchObject({ status: "rejected", promotable: false });
      expect(h.smoke()).toMatchObject({ coverage: "not_checked" });
      expect(h.probe).not.toHaveBeenCalled();
    } finally {
      h.db.close();
    }
  });

  it.each([{ apps: false }, { appStatus: "removed" }])(
    "dev without APPS or a removed app has no required preview smoke: %j",
    async (options) => {
      const h = harness(options);
      try {
        await h.run();
        expect(h.candidate()?.status).toBe("verified");
        expect(JSON.parse(h.candidate()?.plan_json as string).requiredCheckIds).not.toContain(
          "preview-smoke",
        );
        expect(h.smoke()).toBeUndefined();
        expect(publishPreview).not.toHaveBeenCalled();
      } finally {
        h.db.close();
      }
    },
  );

  it("a supported smoke pass allows the Candidate to verify", async () => {
    const h = harness({ status: 200 });
    try {
      await h.run();
      expect(h.candidate()?.status).toBe("verified");
      expect(h.smoke()).toMatchObject({ status: "pass", coverage: "checked_supported" });
    } finally {
      h.db.close();
    }
  });

  it("a hanging APPS RPC times out as not_checked within ten seconds", async () => {
    const h = harness();
    vi.useFakeTimers();
    try {
      h.probe.mockImplementation(() => new Promise(() => {}));
      const pending = probeApp(
        h.env,
        "recipes",
        [{ name: "home", path: "/", expect: "page" }],
        "0123abcd",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toMatchObject([
        { status: null, ok: false, detail: expect.stringContaining("timed out") },
      ]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      h.db.close();
    }
  });
});

describe("a Candidate the event router marks stale", () => {
  it("mid-check: the run halts and composes it again instead of leaving the Change verifying", async () => {
    const h = harness({ staleAt: "check contract", status: 200 });
    try {
      expect(await h.run()).toMatchObject({
        skipped: "candidate_final",
        recomposed: { status: "recomposed" },
      });
      expect(recomposeQuietly).toHaveBeenCalledWith(h.env, C);
      expect(h.steps).toContain("recompose if stale");
      expect(h.steps).not.toContain("gate required checks");
    } finally {
      h.db.close();
    }
  });

  it("before the run starts: the load step composes it again", async () => {
    const h = harness({ initialStatus: "stale" });
    try {
      expect(await h.run()).toMatchObject({
        skipped: "stale",
        recomposed: { status: "recomposed" },
      });
      expect(recomposeQuietly).toHaveBeenCalledWith(h.env, C);
    } finally {
      h.db.close();
    }
  });

  it("a rejected Candidate halts without recomposition", async () => {
    const h = harness({ staleAt: "check contract", status: 200 });
    try {
      h.steps.length = 0;
      await new CandidateVerificationWorkflow({} as ExecutionContext, h.env).run(
        { payload: { candidateId: C } } as Parameters<
          InstanceType<typeof CandidateVerificationWorkflow>["run"]
        >[0],
        {
          async do(name: string, a: unknown, b?: () => Promise<unknown>) {
            if (name === "check contract") h.db.exec("UPDATE candidates SET status = 'rejected'");
            const value = await (b ?? (a as () => Promise<unknown>))();
            return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
          },
        } as Parameters<InstanceType<typeof CandidateVerificationWorkflow>["run"]>[1],
      );
      expect(recomposeQuietly).not.toHaveBeenCalled();
    } finally {
      h.db.close();
    }
  });
});
