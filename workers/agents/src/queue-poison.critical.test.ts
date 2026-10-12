// Poison command. A wake that keeps failing must be retried a
// bounded number of times and then reach the dead-letter Queue, so the consumer must never ack a
// failure. A wake that cannot succeed (malformed or stale) must be acked, not retried forever.
// The bound itself is Queue consumer configuration: scripts/inject/dead-letter.critical.test.ts.
import { beforeEach, describe, expect, it, vi } from "vitest";

const handleWake = vi.hoisted(() => vi.fn<(env: unknown, body: unknown) => Promise<string>>());

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {
    env: unknown;
    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));
vi.mock("./wake-consumer.ts", () => ({ handleWake }));
vi.mock("./sandbox-smoke.ts", () => ({ sandboxSmoke: vi.fn() }));
vi.mock("./agent-do.ts", () => ({ AgentDO: class {} }));

const { default: Agents } = await import("./index.ts");

function message(body: unknown) {
  return { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
}

async function consume(...messages: ReturnType<typeof message>[]) {
  const worker = new (
    Agents as unknown as new (
      ctx: unknown,
      env: unknown,
    ) => {
      queue(batch: unknown): Promise<void>;
    }
  )({}, {});
  await worker.queue({ messages });
}

beforeEach(() => {
  handleWake.mockReset();
  // The consumer logs each failure; keep test output clean.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("agent wake consumer under a poison command", () => {
  it("retries a failing command with a delay and never acks it", async () => {
    handleWake.mockRejectedValue(new Error("D1 unavailable"));
    const poison = message({ commandId: "cmd_poison" });
    await consume(poison);
    expect(poison.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(poison.ack).not.toHaveBeenCalled();
  });

  it("isolates the poison message: the rest of the batch is still acked", async () => {
    handleWake.mockImplementation(async (_env, body) => {
      if ((body as { commandId: string }).commandId === "cmd_poison") throw new Error("boom");
      return "woken";
    });
    const good = message({ commandId: "cmd_good" });
    const poison = message({ commandId: "cmd_poison" });
    const after = message({ commandId: "cmd_after" });
    await consume(good, poison, after);
    expect(good.ack).toHaveBeenCalledOnce();
    expect(after.ack).toHaveBeenCalledOnce();
    expect(poison.retry).toHaveBeenCalledOnce();
    expect(poison.ack).not.toHaveBeenCalled();
  });

  it("acks invalid, stale, and duplicate wakes, which a retry cannot fix", async () => {
    for (const outcome of ["invalid", "stale", "duplicate"]) {
      handleWake.mockResolvedValueOnce(outcome);
      const m = message({ commandId: `cmd_${outcome}` });
      await consume(m);
      expect(m.ack).toHaveBeenCalledOnce();
      expect(m.retry).not.toHaveBeenCalled();
    }
  });
});
