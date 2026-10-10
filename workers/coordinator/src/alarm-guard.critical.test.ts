import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  AlarmGuard,
  countFire,
  DAILY_ALARM_CAP,
  type GuardState,
  MAX_STALL_DELAY_MS,
  MIN_ALARM_DELAY_MS,
  planAlarm,
  rescheduleFloorMs,
} from "./alarm-guard.ts";

const now = Date.parse("2026-10-09T12:00:00Z");
const fresh: GuardState = { day: "2026-10-09", fired: 1, stalled: 0 };

describe("alarm guard", () => {
  it("deletes the alarm when no work is pending", () => {
    expect(planAlarm(null, now, fresh, true)).toEqual({ action: "delete" });
  });

  it("never reschedules from alarm() sooner than the minimum delay", () => {
    expect(planAlarm(now - 5_000, now, fresh, true)).toEqual({
      action: "set",
      at: now + MIN_ALARM_DELAY_MS,
    });
  });

  it("keeps a later due time unchanged, and an RPC write keeps its immediate cadence", () => {
    expect(planAlarm(now + 60_000, now, fresh, true)).toEqual({ action: "set", at: now + 60_000 });
    expect(planAlarm(now - 5_000, now, fresh, false)).toEqual({ action: "set", at: now });
  });

  it("backs off exponentially on fires without progress, capped", () => {
    expect([0, 1, 2, 3].map(rescheduleFloorMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(rescheduleFloorMs(40)).toBe(MAX_STALL_DELAY_MS);
    expect(planAlarm(now, now, { ...fresh, stalled: 3 }, true)).toEqual({
      action: "set",
      at: now + 8_000,
    });
  });

  it("stops rescheduling at the daily cap, even with work pending", () => {
    const capped = { ...fresh, fired: DAILY_ALARM_CAP };
    expect(planAlarm(now, now, capped, true)).toEqual({
      action: "capped",
      fired: DAILY_ALARM_CAP,
    });
    expect(planAlarm(now, now, capped, false).action).toBe("capped");
  });

  it("defers an RPC write while an alarm is in flight, so it cannot queue a superseded alarm", () => {
    expect(planAlarm(now - 5_000, now, fresh, false, DAILY_ALARM_CAP, true)).toEqual({
      action: "defer",
    });
    expect(planAlarm(null, now, fresh, false, DAILY_ALARM_CAP, true)).toEqual({ action: "defer" });
    // The handler's own reschedule is never deferred.
    expect(planAlarm(now, now, fresh, true, DAILY_ALARM_CAP, true)).toEqual({
      action: "set",
      at: now + MIN_ALARM_DELAY_MS,
    });
  });

  it("counts fires per UTC day and starts again on a new day", () => {
    expect(countFire(fresh, now)).toMatchObject({ day: "2026-10-09", fired: 2 });
    const tomorrow = Date.parse("2026-10-10T00:00:01Z");
    const next = countFire({ ...fresh, fired: DAILY_ALARM_CAP }, tomorrow);
    expect(next).toMatchObject({ day: "2026-10-10", fired: 1 });
    expect(planAlarm(tomorrow, tomorrow, next, true).action).toBe("set");
  });

  it("bounds a loop that always has work due: it stops at the cap within the day", () => {
    const start = Date.parse("2026-10-09T00:00:00Z");
    let state: GuardState = { day: "", fired: 0, stalled: 0 };
    let t = start;
    let fires = 0;
    while (fires <= DAILY_ALARM_CAP) {
      state = countFire(state, t);
      fires += 1;
      const plan = planAlarm(t, t, state, true);
      if (plan.action !== "set") break;
      expect(plan.at - t).toBeGreaterThanOrEqual(MIN_ALARM_DELAY_MS);
      t = plan.at;
    }
    expect(fires).toBe(DAILY_ALARM_CAP);
    expect(t - start).toBeLessThan(86_400_000);
  });
});

/** SqlStorage over node:sqlite, plus a storage stub that records alarm writes. */
function fakeObject() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec: (query: string, ...params: unknown[]) => {
      const statement = db.prepare(query);
      if (statement.columns().length > 0) {
        const rows = statement.all(...(params as never[]));
        return { toArray: () => rows };
      }
      statement.run(...(params as never[]));
      return { toArray: () => [] };
    },
  } as unknown as SqlStorage;
  const writes: (number | null)[] = [];
  const storage = {
    setAlarm: async (at: number) => void writes.push(at),
    deleteAlarm: async () => void writes.push(null),
  } as unknown as DurableObjectStorage;
  return { sql, storage, writes };
}

describe("AlarmGuard.run", () => {
  it("writes the alarm once per fire: an RPC write during the fire defers to the handler", async () => {
    const { sql, storage, writes } = fakeObject();
    const guard = new AlarmGuard(sql, storage, "test");
    guard.migrate();
    let due: number | null = null;
    await guard.run(
      async () => {
        // An RPC write lands while the handler awaits I/O: new work is due now.
        due = Date.now();
        await guard.schedule(due, Date.now());
        expect(writes).toEqual([]);
        return true;
      },
      () => due,
    );
    // One write, from the handler, at least the minimum delay out: no second queued alarm.
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBeGreaterThanOrEqual((due ?? 0) + MIN_ALARM_DELAY_MS - 5);

    // After the fire an RPC write keeps its immediate cadence again.
    await guard.schedule(Date.now(), Date.now());
    expect(writes).toHaveLength(2);
  });

  it("still reschedules pending work when the fire throws", async () => {
    const { sql, storage, writes } = fakeObject();
    const guard = new AlarmGuard(sql, storage, "test");
    guard.migrate();
    const due = Date.now();
    await expect(
      guard.run(
        async () => {
          throw new Error("boom");
        },
        () => due,
      ),
    ).rejects.toThrow("boom");
    expect(writes).toHaveLength(1);
    await guard.schedule(null, Date.now());
    expect(writes).toEqual([writes[0], null]);
  });
});
