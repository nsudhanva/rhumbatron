import { deserialize, serialize } from "bun:jsc";
import { Database } from "bun:sqlite";
import { log } from "../log.ts";

/**
 * Durable workflows by replay. An instance runs its `run(event, step)` from the start each time it
 * wakes. A completed `step.do` returns its stored result instead of running again, so a step
 * runs to completion at most once per success. `step.sleep` and `step.waitForEvent` store a wake
 * condition and suspend the run. A timer or a matching `sendEvent` resumes it. Instances, steps
 * and events persist in SQLite, so a restart resumes every running or waiting instance.
 */

export type Duration = number | string;

export type StepConfig = {
  retries?: { limit: number; delay: Duration; backoff?: "constant" | "linear" | "exponential" };
  timeout?: Duration;
};

export type WorkflowStep = {
  do<T>(
    name: string,
    configOrFn: StepConfig | (() => Promise<T>),
    fn?: () => Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: Duration): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: Duration },
  ): Promise<{ payload: T; timestamp: Date; type: string }>;
};

export type WorkflowEvent<P> = { payload: P; timestamp: Date; instanceId: string };

type Runnable = { run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<unknown> };
// biome-ignore lint/suspicious/noExplicitAny: entrypoint classes take their own env types.
export type WorkflowClass = new (ctx: any, env: any) => Runnable;

export type InstanceStatus =
  | "queued"
  | "running"
  | "waiting"
  | "complete"
  | "errored"
  | "terminated";

const DEFAULT_RETRIES = { limit: 5, delay: 10_000, backoff: "exponential" as const };
const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Parses "10 seconds", "5 minutes", "1 day" or milliseconds. */
function durationMs(value: Duration): number {
  if (typeof value === "number") return value;
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|millisecond|second|minute|hour|day|week)s?\s*$/i.exec(
    value,
  );
  if (!match) throw new Error(`Invalid duration: ${value}`);
  const n = Number(match[1]);
  const unit = (match[2] as string).toLowerCase();
  const factor = {
    ms: 1,
    millisecond: 1,
    second: 1000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
  }[unit] as number;
  return n * factor;
}

/**
 * One execution of an instance. A step that must wait calls `suspend`: it records the earliest
 * wake time and returns a promise that never settles, so workflow code (even in a try/catch)
 * never sees the suspension. The run then stops at the next await.
 */
class RunContext {
  wakeAt: number | null | undefined = undefined;
  readonly inFlight = new Set<Promise<unknown>>();
  #signal!: () => void;
  readonly suspended = new Promise<"suspended">((resolve) => {
    this.#signal = () => resolve("suspended");
  });

  suspend(wakeAt: number | null): Promise<never> {
    if (
      this.wakeAt === undefined ||
      (wakeAt !== null && (this.wakeAt === null || wakeAt < this.wakeAt))
    )
      this.wakeAt = wakeAt;
    this.#signal();
    return new Promise<never>(() => {});
  }

  track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    p.finally(() => this.inFlight.delete(p)).catch(() => {});
    return p;
  }
}

function encode(value: unknown): Uint8Array {
  return new Uint8Array(serialize(value === undefined ? null : value));
}

function decode<T>(blob: Uint8Array | null): T {
  return (blob ? deserialize(blob) : undefined) as T;
}

export class WorkflowEngine {
  readonly #db: Database;
  readonly #classes = new Map<string, { cls: WorkflowClass; env: () => unknown }>();
  readonly #running = new Set<string>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #rerun = new Set<string>();

  constructor(path: string) {
    this.#db = new Database(path, { create: true });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run(`CREATE TABLE IF NOT EXISTS wf_instances (
      workflow TEXT NOT NULL, id TEXT NOT NULL, status TEXT NOT NULL, params BLOB, output BLOB, error TEXT,
      wake_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (workflow, id))`);
    this.#db.run(`CREATE TABLE IF NOT EXISTS wf_steps (
      workflow TEXT NOT NULL, id TEXT NOT NULL, step TEXT NOT NULL, status TEXT NOT NULL, output BLOB, error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, wake_at INTEGER, wait_type TEXT, PRIMARY KEY (workflow, id, step))`);
    this.#db.run(`CREATE TABLE IF NOT EXISTS wf_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, workflow TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL,
      payload BLOB, at INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0)`);
  }

  register(workflow: string, cls: WorkflowClass, env: () => unknown): void {
    this.#classes.set(workflow, { cls, env });
  }

  binding(workflow: string): WorkflowBinding {
    return new WorkflowBinding(this, workflow);
  }

  /** Resumes every instance that was running or waiting. Call once at start. */
  resume(): void {
    const rows = this.#db
      .query(
        "SELECT workflow, id, wake_at FROM wf_instances WHERE status IN ('queued', 'running', 'waiting')",
      )
      .all() as {
      workflow: string;
      id: string;
      wake_at: number | null;
    }[];
    for (const row of rows) {
      if (row.wake_at) this.wakeAt(row.workflow, row.id, row.wake_at);
      else this.kick(row.workflow, row.id);
    }
    log.info("workflows.resumed", { instances: rows.length });
  }

  create(workflow: string, id: string, params: unknown): void {
    if (!this.#classes.has(workflow)) throw new Error(`Unknown workflow ${workflow}`);
    const now = Date.now();
    try {
      this.#db
        .query(
          "INSERT INTO wf_instances (workflow, id, status, params, created_at, updated_at) VALUES (?, ?, 'queued', ?, ?, ?)",
        )
        .run(workflow, id, encode(params), now, now);
    } catch {
      throw new Error(`Workflow instance ${id} already exists`);
    }
    this.kick(workflow, id);
  }

  exists(workflow: string, id: string): boolean {
    return (
      this.#db
        .query("SELECT 1 FROM wf_instances WHERE workflow = ? AND id = ?")
        .get(workflow, id) !== null
    );
  }

  status(
    workflow: string,
    id: string,
  ): {
    status: InstanceStatus | "unknown";
    output?: unknown;
    error?: { name: string; message: string };
  } {
    const row = this.#db
      .query("SELECT status, output, error FROM wf_instances WHERE workflow = ? AND id = ?")
      .get(workflow, id) as {
      status: InstanceStatus;
      output: Uint8Array | null;
      error: string | null;
    } | null;
    if (!row) return { status: "unknown" };
    return {
      status: row.status,
      ...(row.output ? { output: decode(row.output) } : {}),
      ...(row.error ? { error: { name: "Error", message: row.error } } : {}),
    };
  }

  sendEvent(workflow: string, id: string, type: string, payload: unknown): void {
    this.#db
      .query("INSERT INTO wf_events (workflow, id, type, payload, at) VALUES (?, ?, ?, ?, ?)")
      .run(workflow, id, type, encode(payload), Date.now());
    const row = this.#db
      .query("SELECT status FROM wf_instances WHERE workflow = ? AND id = ?")
      .get(workflow, id) as { status: string } | null;
    if (row?.status === "waiting") this.kick(workflow, id);
  }

  terminate(workflow: string, id: string): void {
    this.setStatus(workflow, id, "terminated", { error: "terminated" });
    const key = `${workflow}/${id}`;
    const timer = this.#timers.get(key);
    if (timer) clearTimeout(timer);
  }

  private setStatus(
    workflow: string,
    id: string,
    status: InstanceStatus,
    extra: { output?: unknown; error?: string; wakeAt?: number | null } = {},
  ): void {
    this.#db
      .query(
        "UPDATE wf_instances SET status = ?, output = COALESCE(?, output), error = ?, wake_at = ?, updated_at = ? WHERE workflow = ? AND id = ?",
      )
      .run(
        status,
        extra.output === undefined ? null : encode(extra.output),
        extra.error ?? null,
        extra.wakeAt ?? null,
        Date.now(),
        workflow,
        id,
      );
  }

  private wakeAt(workflow: string, id: string, at: number): void {
    const key = `${workflow}/${id}`;
    const existing = this.#timers.get(key);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, at - Date.now());
    this.#timers.set(
      key,
      setTimeout(
        () => {
          this.#timers.delete(key);
          if (Date.now() < at - 5) this.wakeAt(workflow, id, at);
          else this.kick(workflow, id);
        },
        Math.min(delay, 2_147_000_000),
      ),
    );
  }

  /** Runs the instance now, or once more after the current run when one is in progress. */
  private kick(workflow: string, id: string): void {
    const key = `${workflow}/${id}`;
    if (this.#running.has(key)) {
      this.#rerun.add(key);
      return;
    }
    this.#running.add(key);
    void this.execute(workflow, id).finally(() => {
      this.#running.delete(key);
      if (this.#rerun.delete(key)) this.kick(workflow, id);
    });
  }

  private async execute(workflow: string, id: string): Promise<void> {
    const instance = this.#db
      .query("SELECT status, params, created_at FROM wf_instances WHERE workflow = ? AND id = ?")
      .get(workflow, id) as {
      status: InstanceStatus;
      params: Uint8Array | null;
      created_at: number;
    } | null;
    if (!instance || !["queued", "running", "waiting"].includes(instance.status)) return;
    const spec = this.#classes.get(workflow);
    if (!spec) return;
    this.setStatus(workflow, id, "running");
    const counts = new Map<string, number>();
    const keyOf = (name: string) => {
      const n = counts.get(name) ?? 0;
      counts.set(name, n + 1);
      return n === 0 ? name : `${name}#${n}`;
    };
    const ctx = new RunContext();
    const step: WorkflowStep = {
      do: async <T>(
        name: string,
        configOrFn: StepConfig | (() => Promise<T>),
        maybeFn?: () => Promise<T>,
      ) => {
        const config = typeof configOrFn === "function" ? {} : configOrFn;
        const fn = (typeof configOrFn === "function" ? configOrFn : maybeFn) as () => Promise<T>;
        return ctx.track(this.runStep(ctx, workflow, id, keyOf(name), config, fn));
      },
      sleep: async (name, duration) =>
        this.sleepStep(ctx, workflow, id, keyOf(name), Date.now() + durationMs(duration)),
      sleepUntil: async (name, timestamp) =>
        this.sleepStep(
          ctx,
          workflow,
          id,
          keyOf(name),
          typeof timestamp === "number" ? timestamp : timestamp.getTime(),
        ),
      waitForEvent: async (name, options) =>
        this.waitStep(
          ctx,
          workflow,
          id,
          keyOf(name),
          options.type,
          options.timeout ? durationMs(options.timeout) : 24 * 3_600_000,
        ),
    };
    try {
      const entry = new spec.cls({ waitUntil: () => {} }, spec.env());
      const outcome = await Promise.race([
        entry
          .run(
            {
              payload: decode(instance.params),
              timestamp: new Date(instance.created_at),
              instanceId: id,
            },
            step,
          )
          .then((output) => ({ output })),
        ctx.suspended,
      ]);
      if (outcome === "suspended") {
        // Let steps that are still running store their results before the instance parks.
        await Promise.allSettled([...ctx.inFlight]);
        const wakeAt = ctx.wakeAt ?? null;
        this.setStatus(workflow, id, "waiting", { wakeAt });
        if (wakeAt !== null) this.wakeAt(workflow, id, wakeAt);
        return;
      }
      this.setStatus(workflow, id, "complete", { output: outcome.output });
      log.info("workflow.complete", { workflow, id });
    } catch (error) {
      this.setStatus(workflow, id, "errored", {
        error: String((error as Error)?.message ?? error).slice(0, 1000),
      });
      log.error("workflow.errored", { workflow, id, error: String(error).slice(0, 500) });
    }
  }

  private stepRow(workflow: string, id: string, key: string) {
    return this.#db
      .query(
        "SELECT status, output, error, attempts, wake_at FROM wf_steps WHERE workflow = ? AND id = ? AND step = ?",
      )
      .get(workflow, id, key) as {
      status: "done" | "failed" | "waiting";
      output: Uint8Array | null;
      error: string | null;
      attempts: number;
      wake_at: number | null;
    } | null;
  }

  private saveStep(
    workflow: string,
    id: string,
    key: string,
    values: {
      status: string;
      output?: unknown;
      error?: string;
      attempts?: number;
      wakeAt?: number | null;
      waitType?: string | null;
    },
  ): void {
    this.#db
      .query(
        `INSERT INTO wf_steps (workflow, id, step, status, output, error, attempts, wake_at, wait_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workflow, id, step) DO UPDATE SET status = excluded.status, output = excluded.output, error = excluded.error,
         attempts = excluded.attempts, wake_at = excluded.wake_at, wait_type = excluded.wait_type`,
      )
      .run(
        workflow,
        id,
        key,
        values.status,
        values.output === undefined ? null : encode(values.output),
        values.error ?? null,
        values.attempts ?? 0,
        values.wakeAt ?? null,
        values.waitType ?? null,
      );
  }

  private async runStep<T>(
    ctx: RunContext,
    workflow: string,
    id: string,
    key: string,
    config: StepConfig,
    fn: () => Promise<T>,
  ): Promise<T> {
    const row = this.stepRow(workflow, id, key);
    if (row?.status === "done") return decode<T>(row.output);
    if (row?.status === "failed") throw new Error(row.error ?? "step failed");
    if (row?.status === "waiting" && row.wake_at && row.wake_at > Date.now())
      return ctx.suspend(row.wake_at);
    const retries = config.retries ?? DEFAULT_RETRIES;
    const timeoutMs = config.timeout ? durationMs(config.timeout) : DEFAULT_TIMEOUT_MS;
    const attempt = (row?.attempts ?? 0) + 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Step "${key}" timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        }),
      ]);
      this.saveStep(workflow, id, key, { status: "done", output, attempts: attempt });
      return output;
    } catch (error) {
      const message = String((error as Error)?.message ?? error).slice(0, 1000);
      const nonRetryable = (error as Error)?.name === "NonRetryableError";
      if (nonRetryable || attempt > retries.limit) {
        this.saveStep(workflow, id, key, { status: "failed", error: message, attempts: attempt });
        throw error;
      }
      const base = durationMs(retries.delay);
      const factor =
        retries.backoff === "exponential"
          ? 2 ** (attempt - 1)
          : retries.backoff === "linear"
            ? attempt
            : 1;
      const wakeAt = Date.now() + base * factor;
      this.saveStep(workflow, id, key, {
        status: "waiting",
        error: message,
        attempts: attempt,
        wakeAt,
      });
      log.warn("workflow.step_retry", {
        workflow,
        id,
        step: key,
        attempt,
        error: message.slice(0, 200),
      });
      return ctx.suspend(wakeAt);
    } finally {
      clearTimeout(timer);
    }
  }

  private async sleepStep(
    ctx: RunContext,
    workflow: string,
    id: string,
    key: string,
    until: number,
  ): Promise<void> {
    const row = this.stepRow(workflow, id, key);
    if (row?.status === "done") return;
    const wakeAt = row?.wake_at ?? until;
    if (Date.now() >= wakeAt) {
      this.saveStep(workflow, id, key, { status: "done" });
      return;
    }
    if (!row) this.saveStep(workflow, id, key, { status: "waiting", wakeAt });
    return ctx.suspend(wakeAt);
  }

  private async waitStep<T>(
    ctx: RunContext,
    workflow: string,
    id: string,
    key: string,
    type: string,
    timeoutMs: number,
  ): Promise<{ payload: T; timestamp: Date; type: string }> {
    const row = this.stepRow(workflow, id, key);
    if (row?.status === "done") return decode(row.output);
    if (row?.status === "failed") throw new Error(row.error ?? "waitForEvent failed");
    const deadline = row?.wake_at ?? Date.now() + timeoutMs;
    const event = this.#db
      .query(
        "SELECT seq, payload, at FROM wf_events WHERE workflow = ? AND id = ? AND type = ? AND consumed = 0 ORDER BY seq LIMIT 1",
      )
      .get(workflow, id, type) as { seq: number; payload: Uint8Array | null; at: number } | null;
    if (event) {
      const output = { payload: decode<T>(event.payload), timestamp: new Date(event.at), type };
      this.#db.transaction(() => {
        this.#db.query("UPDATE wf_events SET consumed = 1 WHERE seq = ?").run(event.seq);
        this.saveStep(workflow, id, key, { status: "done", output });
      })();
      return output;
    }
    if (Date.now() >= deadline) {
      const message = `waitForEvent "${key}" timed out waiting for "${type}"`;
      this.saveStep(workflow, id, key, { status: "failed", error: message });
      throw new Error(message);
    }
    if (!row)
      this.saveStep(workflow, id, key, { status: "waiting", wakeAt: deadline, waitType: type });
    return ctx.suspend(deadline);
  }
}

/** The binding the code holds: `create`, `get`, and an instance handle. */
export class WorkflowBinding {
  constructor(
    private readonly engine: WorkflowEngine,
    readonly name: string,
  ) {}

  async create(options: { id?: string; params?: unknown } = {}): Promise<WorkflowInstance> {
    const id = options.id ?? crypto.randomUUID();
    this.engine.create(this.name, id, options.params ?? {});
    return new WorkflowInstance(this.engine, this.name, id);
  }

  async createBatch(batch: { id?: string; params?: unknown }[]): Promise<WorkflowInstance[]> {
    return Promise.all(batch.map((b) => this.create(b)));
  }

  async get(id: string): Promise<WorkflowInstance> {
    if (!this.engine.exists(this.name, id)) throw new Error(`Workflow instance ${id} not found`);
    return new WorkflowInstance(this.engine, this.name, id);
  }
}

export class WorkflowInstance {
  constructor(
    private readonly engine: WorkflowEngine,
    private readonly workflow: string,
    readonly id: string,
  ) {}

  async status() {
    return this.engine.status(this.workflow, this.id);
  }

  async sendEvent(event: { type: string; payload?: unknown }): Promise<void> {
    this.engine.sendEvent(this.workflow, this.id, event.type, event.payload ?? null);
  }

  async terminate(): Promise<void> {
    this.engine.terminate(this.workflow, this.id);
  }

  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async restart(): Promise<void> {
    throw new Error("restart is not supported");
  }
}
