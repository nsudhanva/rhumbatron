import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  WorkflowEntrypoint: class {
    constructor(
      _ctx: unknown,
      protected env: Env,
    ) {}
  },
}));
vi.mock("./dispatch.ts", () => ({ dispatchReadyTasks: vi.fn() }));
vi.mock("./code-store.ts", () => ({ readTreeFiles: vi.fn() }));
vi.mock("./root-planner.ts", () => ({ planChangeResult: vi.fn() }));
vi.mock("./events.ts", () => ({
  changeEvent: vi.fn(async (_ctx, eventType, payload) => ({ eventType, payload })),
  appendChangeEvents: vi.fn(),
  qualify: vi.fn(),
}));

const { ChangeWorkflow } = await import("./change-workflow.ts");
const { planChangeResult } = await import("./root-planner.ts");
const { readTreeFiles } = await import("./code-store.ts");
const { appendChangeEvents } = await import("./events.ts");

function setup(cancelDuringPlanning = false) {
  let status = "created";
  let blockedReason: unknown = null;
  let treeSha = "a".repeat(40);
  const currentTree = "b".repeat(40);
  const errors = ["unknown task t9", "cycle t2", "duplicate t3", "invalid resource"];
  vi.mocked(planChangeResult).mockImplementation(async () => {
    if (cancelDuringPlanning) status = "cancelled";
    return { ok: false, errors };
  });
  vi.mocked(readTreeFiles).mockResolvedValue(["package.json", "src/app.ts"]);
  const steps: string[] = [];
  const env = Object.assign({} as Env, {
    DB: {
      prepare(sql: string) {
        let values: unknown[] = [];
        const statement = {
          bind(...args: unknown[]) {
            values = args;
            return statement;
          },
          async first() {
            if (sql.includes("JOIN projects")) {
              return {
                id: "chg_1",
                project_id: "proj_1",
                goal: "Add wishlists",
                status,
                base_generation: 0,
                budget_usd: 3,
                org_id: "org_1",
                slug: "acme",
                name: "Acme",
              };
            }
            return { status };
          },
          async run() {
            if (sql.includes("SET status = 'compiling'")) {
              status = "compiling";
              // Promotion can finish after the Workflow's load step was cached.
              treeSha = currentTree;
            }
            if (sql.includes("SET status = 'failed'") && status === "compiling") {
              status = "failed";
              blockedReason = values[0];
            }
          },
        };
        return statement;
      },
    },
    PROJECT_ROOT: {
      idFromName: (name: string) => name,
      get: () => ({
        admit: async () => 1,
        release: async () => undefined,
        getCanonical: async () => ({ treeSha, artifactRef: "artifacts://proj_1@main" }),
      }),
    },
  });
  const step = {
    async do(name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) {
      steps.push(name);
      const run = callback ?? (configOrCallback as () => Promise<unknown>);
      // Step outputs lose class identity and must contain all failure details as plain data.
      const value = await run();
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
  } as Parameters<InstanceType<typeof ChangeWorkflow>["run"]>[1];
  const event = { payload: { changeId: "chg_1" } } as Parameters<
    InstanceType<typeof ChangeWorkflow>["run"]
  >[0];
  return {
    run: () => new ChangeWorkflow({} as ExecutionContext, env).run(event, step),
    state: () => ({ status, blockedReason }),
    errors,
    steps,
    env,
    currentTree,
  };
}

describe("planning failure through the Workflow step boundary", () => {
  it("stores all validation reasons and emits change.failed after serialized step output", async () => {
    vi.clearAllMocks();
    const test = setup();
    expect(await test.run()).toEqual({ failed: true, reason: test.errors });
    const reason = `Planning failed: ${test.errors.join("; ")}`;
    expect(test.state()).toEqual({ status: "failed", blockedReason: reason });
    expect(appendChangeEvents).toHaveBeenCalledWith(undefined, expect.anything(), [
      {
        eventType: "change.failed",
        payload: { status: "failed", phase: "planning", reason, errors: test.errors },
      },
    ]);
    expect(readTreeFiles).toHaveBeenCalledWith(test.env, "proj_1", test.currentTree);
    expect(planChangeResult).toHaveBeenCalledWith(
      expect.objectContaining({ files: ["package.json", "src/app.ts"] }),
      expect.any(Function),
      expect.anything(),
    );
    expect(test.steps).not.toContain("persist work graph");
    expect(test.steps).not.toContain("dispatch ready tasks");
  });

  it("lets a cancellation win without recording a planning failure", async () => {
    vi.clearAllMocks();
    const test = setup(true);
    expect(await test.run()).toEqual({ cancelled: true });
    expect(test.state()).toEqual({ status: "cancelled", blockedReason: null });
    expect(appendChangeEvents).not.toHaveBeenCalled();
  });
});
