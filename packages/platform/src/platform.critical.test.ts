import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ActorState, ActorSystem } from "./actors/host.ts";
import { WebSocketPair } from "./actors/websocket.ts";
import { SqlDatabase } from "./sql/database.ts";
import { WorkflowEngine, type WorkflowEvent, type WorkflowStep } from "./workflows/engine.ts";

const dir = () => mkdtempSync(join(tmpdir(), "rt-platform-"));
const until = async (check: () => boolean | Promise<boolean>, ms = 5000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(20);
  }
};

class Counter {
  static constructed = 0;
  static alarms: string[] = [];
  constructor(readonly ctx: ActorState) {
    Counter.constructed++;
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS n (v INTEGER NOT NULL)");
    void ctx.blockConcurrencyWhile(async () => {
      await Bun.sleep(50);
      ctx.storage.sql.exec("INSERT INTO n (v) VALUES (0)");
    });
  }
  count(): number {
    return this.ctx.storage.sql.exec<{ c: number }>("SELECT count(*) AS c FROM n").one().c;
  }
  async remind(inMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + inMs);
  }
  alarm(): void {
    Counter.alarms.push(this.ctx.id.name ?? "?");
  }
}

describe("actor host", () => {
  test("one instance per name, and no call runs before the constructor's gate opens", async () => {
    const system = new ActorSystem(dir());
    system.register("Counter", Counter as never, () => ({}));
    const ns = system.namespace("Counter");
    Counter.constructed = 0;
    const [a, b] = await Promise.all([ns.getByName("x").count(), ns.getByName("x").count()]);
    expect(Counter.constructed).toBe(1);
    // The gated insert ran first, so both calls see its row.
    expect([a, b]).toEqual([1, 1]);
  });

  test("state and a pending alarm survive a restart", async () => {
    const data = dir();
    const first = new ActorSystem(data);
    first.register("Counter", Counter as never, () => ({}));
    await first.namespace("Counter").getByName("y").remind(300);
    Counter.alarms = [];

    const second = new ActorSystem(data);
    second.register("Counter", Counter as never, () => ({}));
    second.resumeAlarms();
    await until(() => Counter.alarms.includes("y"));
    expect(await second.namespace("Counter").getByName("y").count()).toBe(2);
  });
});

describe("workflow engine", () => {
  test("a completed step never runs again, even across a restart and inside try/catch", async () => {
    const path = join(dir(), "wf.sqlite");
    let runs = 0;
    class Flow {
      async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
        await step.do("once", async () => {
          runs++;
          return 1;
        });
        try {
          await step.sleep("pause", 200);
        } catch {
          return "suspension was caught";
        }
        return "done";
      }
    }
    const first = new WorkflowEngine(path);
    first.register("Flow", Flow as never, () => ({}));
    await first.binding("Flow").create({ id: "i1" });
    await until(
      async () => (await (await first.binding("Flow").get("i1")).status()).status === "waiting",
    );

    const second = new WorkflowEngine(path);
    second.register("Flow", Flow as never, () => ({}));
    second.resume();
    await until(
      async () => (await (await second.binding("Flow").get("i1")).status()).status === "complete",
    );
    expect((await (await second.binding("Flow").get("i1")).status()).output).toBe("done");
    expect(runs).toBe(1);
  });

  test("waitForEvent resumes on sendEvent and a duplicate ID is refused", async () => {
    const engine = new WorkflowEngine(join(dir(), "wf.sqlite"));
    class Wait {
      async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
        const got = await step.waitForEvent<{ n: number }>("answer", {
          type: "reply",
          timeout: "1 minute",
        });
        return got.payload.n;
      }
    }
    engine.register("Wait", Wait as never, () => ({}));
    const binding = engine.binding("Wait");
    await binding.create({ id: "w1" });
    await expect(binding.create({ id: "w1" })).rejects.toThrow();
    await until(async () => (await (await binding.get("w1")).status()).status === "waiting");
    await (await binding.get("w1")).sendEvent({ type: "reply", payload: { n: 7 } });
    await until(async () => (await (await binding.get("w1")).status()).status === "complete");
    expect((await (await binding.get("w1")).status()).output).toBe(7);
  });
});

describe("product database", () => {
  test("a batch is one transaction", async () => {
    const db = new SqlDatabase(join(dir(), "db.sqlite"));
    await db.exec("CREATE TABLE t (id TEXT PRIMARY KEY)");
    await expect(
      db.batch([
        db.prepare("INSERT INTO t VALUES (?)").bind("a"),
        db.prepare("INSERT INTO t VALUES (?)").bind("a"),
      ]),
    ).rejects.toThrow(/UNIQUE/);
    expect(await db.prepare("SELECT count(*) AS n FROM t").first<number>("n")).toBe(0);
    const run = await db.prepare("INSERT INTO t VALUES (?)").bind("b").run();
    expect(run.meta.changes).toBe(1);
  });
});

describe("socket pair", () => {
  test("data sent before the real socket attaches is delivered on attach", () => {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.send("snapshot");
    const got: unknown[] = [];
    client.sink = (d) => got.push(d);
    expect(got).toEqual(["snapshot"]);
  });
});
