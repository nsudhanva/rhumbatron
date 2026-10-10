/**
 * Runaway-alarm guard for every Durable Object that sets its own alarm (AGENTS.md sections 7, 44).
 * Cloudflare has no hard spend cap, and an alarm that reschedules itself with no stop condition
 * bills requests, duration, and storage rows without limit. Three hard bounds apply:
 *   1. No pending work: no alarm. The caller passes `dueAt = null` and the alarm is deleted.
 *   2. A reschedule from inside `alarm()` is never sooner than MIN_ALARM_DELAY_MS. When an alarm
 *      made no progress, the floor doubles per idle fire up to MAX_STALL_DELAY_MS.
 *   3. At most DAILY_ALARM_CAP fires per object per UTC day. Past the cap nothing is rescheduled,
 *      an error is logged, and the next RPC write on a later day schedules again.
 * One more rule keeps alarms from superseding each other. Only one `alarm()` runs at a time, so an
 * RPC write that sets the alarm while the handler awaits I/O queues a second invocation; the
 * handler's own reschedule then overrides it, and Cloudflare reports it as `clientDisconnected`
 * (outcome `canceled`). While an alarm is in flight an RPC write therefore defers: the handler
 * reads pending work again when it ends, so the deferred work is still scheduled.
 * The decision functions are pure, so they are unit tested; `AlarmGuard` applies them.
 */

export const MIN_ALARM_DELAY_MS = 1_000;
export const MAX_STALL_DELAY_MS = 5 * 60_000;
/** Normal use is well below 100 fires per object per day (one per publish batch or lease expiry). */
export const DAILY_ALARM_CAP = 2_000;

export type GuardState = {
  /** UTC day (YYYY-MM-DD) of `fired`. */
  day: string;
  /** Alarm fires on `day`. */
  fired: number;
  /** Consecutive fires that made no progress. */
  stalled: number;
};

export type AlarmPlan =
  | { action: "defer" }
  | { action: "delete" }
  | { action: "set"; at: number }
  | { action: "capped"; fired: number };

export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Counts one alarm fire. A new UTC day starts the count again. */
export function countFire(state: GuardState, now: number): GuardState {
  const day = utcDay(now);
  return { ...state, day, fired: state.day === day ? state.fired + 1 : 1 };
}

/** Floor for a reschedule from inside `alarm()`: 1 s, then doubling per idle fire, capped. */
export function rescheduleFloorMs(stalled: number): number {
  return Math.min(MIN_ALARM_DELAY_MS * 2 ** Math.max(0, stalled), MAX_STALL_DELAY_MS);
}

/**
 * Decides the next alarm. `fromAlarm` is set when the caller is the alarm handler itself, the only
 * place a self-perpetuating loop can form; an RPC write keeps its immediate cadence. `inFlight` is
 * set while an alarm handler runs: an RPC write then defers to the handler's own reschedule.
 */
export function planAlarm(
  dueAt: number | null,
  now: number,
  state: GuardState,
  fromAlarm: boolean,
  cap = DAILY_ALARM_CAP,
  inFlight = false,
): AlarmPlan {
  if (inFlight && !fromAlarm) return { action: "defer" };
  if (dueAt === null) return { action: "delete" };
  if (state.day === utcDay(now) && state.fired >= cap) {
    return { action: "capped", fired: state.fired };
  }
  const floor = fromAlarm ? now + rescheduleFloorMs(state.stalled) : now;
  return { action: "set", at: Math.max(dueAt, floor) };
}

type GuardRow = { day: string; fired: number; stalled: number };

/** Applies the plan on one Durable Object. State lives in its own SQLite table. */
export class AlarmGuard {
  /** In memory: an alarm handler of this instance is running. Eviction ends the handler too. */
  private inFlight = false;

  constructor(
    private readonly sql: SqlStorage,
    private readonly storage: DurableObjectStorage,
    private readonly owner: string,
  ) {}

  /** Creates the guard table. Call it from the object's schema migration. */
  migrate() {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS alarm_guard (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        day TEXT NOT NULL,
        fired INTEGER NOT NULL,
        stalled INTEGER NOT NULL
      );
    `);
  }

  private read(): GuardState {
    const row = this.sql
      .exec<GuardRow>("SELECT day, fired, stalled FROM alarm_guard WHERE id = 1")
      .toArray()[0];
    return row ?? { day: "", fired: 0, stalled: 0 };
  }

  private write(state: GuardState) {
    this.sql.exec(
      `INSERT INTO alarm_guard (id, day, fired, stalled) VALUES (1, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET day = excluded.day, fired = excluded.fired, stalled = excluded.stalled`,
      state.day,
      state.fired,
      state.stalled,
    );
  }

  /** Counts the fire before any work that can throw, so every fire is counted. */
  private countFire(now: number) {
    this.write(countFire(this.read(), now));
  }

  /**
   * Runs one alarm fire: counts it, defers RPC reschedules while `work` runs, then sets the next
   * alarm from `dueAt()` read after the work, also when the work throws. `work` returns true when
   * it made progress. Use it as the whole body of `alarm()`.
   */
  async run(work: (now: number) => Promise<boolean>, dueAt: () => number | null) {
    const now = Date.now();
    this.countFire(now);
    this.inFlight = true;
    let progressed = false;
    try {
      progressed = await work(now);
    } finally {
      this.inFlight = false;
      await this.schedule(dueAt(), Date.now(), progressed);
    }
  }

  /**
   * For objects whose alarm a framework owns (Agents SDK `schedule`): counts one self-scheduled
   * callback against the daily cap. False, with an error log, once the cap is reached.
   */
  admitSchedule(now: number, callback: string): boolean {
    const state = this.read();
    if (planAlarm(now, now, state, false).action === "capped") {
      console.error(
        JSON.stringify({
          event: "alarm.daily_cap_reached",
          owner: this.owner,
          callback,
          fired: state.fired,
          cap: DAILY_ALARM_CAP,
        }),
      );
      return false;
    }
    this.write(countFire(state, now));
    return true;
  }

  /**
   * Sets, moves, or deletes the alarm. `progressed` is given only by `run()`: true when the fire
   * did useful work (published, expired), false when work stayed due without progress.
   */
  async schedule(dueAt: number | null, now: number, progressed?: boolean) {
    const fromAlarm = progressed !== undefined;
    let state = this.read();
    if (fromAlarm) {
      state = { ...state, stalled: progressed ? 0 : state.stalled + 1 };
      this.write(state);
    }
    const plan = planAlarm(dueAt, now, state, fromAlarm, DAILY_ALARM_CAP, this.inFlight);
    if (plan.action === "defer") return;
    if (plan.action === "set") {
      await this.storage.setAlarm(plan.at);
      return;
    }
    await this.storage.deleteAlarm();
    if (plan.action === "capped") {
      console.error(
        JSON.stringify({
          event: "alarm.daily_cap_reached",
          owner: this.owner,
          fired: plan.fired,
          cap: DAILY_ALARM_CAP,
          dueAt,
        }),
      );
    }
  }
}
