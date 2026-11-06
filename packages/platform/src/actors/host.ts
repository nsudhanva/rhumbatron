import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";
import { ActorStorage } from "./storage.ts";
import type { PairSocket, WebSocketRequestResponsePair } from "./websocket.ts";

/**
 * The actor host. It runs keyed single-writer actors with the Durable Object programming model:
 * one instance per ID, one SQLite file per instance, persisted alarms with retries, input gates
 * (`blockConcurrencyWhile`), RPC through stubs, and hibernatable WebSockets. One process owns
 * every actor, so single-writer holds without a lease.
 */

// biome-ignore lint/suspicious/noExplicitAny: actor classes take their own env types.
export type ActorClass = new (ctx: ActorState, env: any) => ActorInstance;
type ActorInstance = {
  fetch?(request: Request): Promise<Response> | Response;
  alarm?(info: { retryCount: number; isRetry: boolean }): Promise<void> | void;
  webSocketMessage?(ws: PairSocket, message: string | ArrayBuffer): Promise<void> | void;
  webSocketClose?(
    ws: PairSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> | void;
  webSocketError?(ws: PairSocket, error: unknown): Promise<void> | void;
};

const MAX_TIMER_MS = 2_147_000_000;
const ALARM_RETRIES = 6;

export class ActorId {
  constructor(
    readonly hex: string,
    readonly name?: string,
  ) {}
  toString(): string {
    return this.hex;
  }
  equals(other: ActorId): boolean {
    return other?.hex === this.hex;
  }
}

function hexOf(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

type Entry = {
  instance: ActorInstance | null;
  state: ActorState;
  ready: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  alarmRetries: number;
};

export class ActorState {
  readonly storage: ActorStorage;
  readonly props = {};
  #gate: Promise<unknown> = Promise.resolve();
  #sockets = new Map<PairSocket, string[]>();
  #autoResponse: WebSocketRequestResponsePair | null = null;
  #autoResponseAt = new Map<PairSocket, Date>();

  constructor(
    readonly id: ActorId,
    path: string,
    onAlarm: (at: number | null) => void,
    readonly exports: Record<string, unknown>,
    private readonly track: (p: Promise<unknown>) => void,
    private readonly onSocket: {
      message(ws: PairSocket, data: string | ArrayBuffer): Promise<void>;
      close(ws: PairSocket, code: number, reason: string): Promise<void>;
    },
  ) {
    this.storage = new ActorStorage(path, onAlarm);
  }

  blockConcurrencyWhile<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.#gate.then(() => fn());
    this.#gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Resolves once no `blockConcurrencyWhile` callback is running. */
  async opened(): Promise<void> {
    let gate: Promise<unknown>;
    do {
      gate = this.#gate;
      await gate;
    } while (gate !== this.#gate);
  }

  waitUntil(promise: Promise<unknown>): void {
    this.track(promise);
  }

  abort(reason?: string): void {
    log.warn("actor.abort", { id: this.id.hex, reason });
  }

  /** Takes the server end. Its messages and its close go to the actor's handlers. */
  acceptWebSocket(ws: PairSocket, tags: string[] = []): void {
    this.#sockets.set(ws, tags);
    ws.sink = (data) => {
      this.track(this.onSocket.message(ws, data));
    };
    ws.onClose = (code, reason) => {
      this.track(this.onSocket.close(ws, code, reason));
    };
  }

  getWebSockets(tag?: string): PairSocket[] {
    return [...this.#sockets]
      .filter(([ws, tags]) => ws.readyState === 1 && (tag === undefined || tags.includes(tag)))
      .map(([ws]) => ws);
  }

  getTags(ws: PairSocket): string[] {
    return this.#sockets.get(ws) ?? [];
  }

  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void {
    this.#autoResponse = pair ?? null;
  }

  getWebSocketAutoResponse(): WebSocketRequestResponsePair | null {
    return this.#autoResponse;
  }

  getWebSocketAutoResponseTimestamp(ws: PairSocket): Date | null {
    return this.#autoResponseAt.get(ws) ?? null;
  }

  setHibernatableWebSocketEventTimeout(): void {}
  getHibernatableWebSocketEventTimeout(): number | null {
    return null;
  }

  /** Answers the auto-response ping without waking the actor. True when it answered. */
  autoRespond(ws: PairSocket, message: string | ArrayBuffer): boolean {
    if (
      this.#autoResponse &&
      typeof message === "string" &&
      message === this.#autoResponse.request
    ) {
      this.#autoResponseAt.set(ws, new Date());
      ws.send(this.#autoResponse.response);
      return true;
    }
    return false;
  }

  forget(ws: PairSocket): void {
    this.#sockets.delete(ws);
    this.#autoResponseAt.delete(ws);
  }

  get facets(): never {
    throw new Error("Actor facets are not supported by this host");
  }
}

export class ActorSystem {
  readonly #dir: string;
  readonly #registry: Database;
  readonly #classes = new Map<
    string,
    { cls: ActorClass; env: () => unknown; exports: () => Record<string, unknown> }
  >();
  readonly #entries = new Map<string, Entry>();
  readonly #pending = new Set<Promise<unknown>>();
  readonly #namespaces = new Map<string, ActorNamespace>();

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "actors");
    mkdirSync(this.#dir, { recursive: true });
    this.#registry = new Database(join(this.#dir, "registry.sqlite"), { create: true });
    this.#registry.run("PRAGMA journal_mode = WAL");
    this.#registry.run(
      "CREATE TABLE IF NOT EXISTS actors (class TEXT NOT NULL, hex TEXT NOT NULL, name TEXT, alarm_at INTEGER, PRIMARY KEY (class, hex))",
    );
  }

  /** Registers a class. `env` and `exports` are read lazily: envs reference namespaces. */
  register(
    className: string,
    cls: ActorClass,
    env: () => unknown,
    exports: () => Record<string, unknown> = () => ({}),
  ): void {
    this.#classes.set(className, { cls, env, exports });
  }

  namespace(className: string): ActorNamespace {
    const existing = this.#namespaces.get(className);
    if (existing) return existing;
    const ns = new ActorNamespace(this, className);
    this.#namespaces.set(className, ns);
    return ns;
  }

  /** Re-arms every stored alarm. Call once at start, after all classes are registered. */
  resumeAlarms(): void {
    const rows = this.#registry
      .query("SELECT class, hex, name, alarm_at FROM actors WHERE alarm_at IS NOT NULL")
      .all() as {
      class: string;
      hex: string;
      name: string | null;
      alarm_at: number;
    }[];
    for (const row of rows) {
      if (!this.#classes.has(row.class)) continue;
      const entry = this.entry(row.class, new ActorId(row.hex, row.name ?? undefined));
      this.arm(row.class, row.hex, entry, row.alarm_at);
    }
    log.info("actors.resumed", { alarms: rows.length });
  }

  /** Waits for every `waitUntil` promise. Used at shutdown. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  track(promise: Promise<unknown>): void {
    const p = promise.catch((error) => log.error("actor.waitUntil", { error: String(error) }));
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  }

  entry(className: string, id: ActorId): Entry {
    const key = `${className}/${id.hex}`;
    const existing = this.#entries.get(key);
    if (existing) return existing;
    const spec = this.#classes.get(className);
    if (!spec) throw new Error(`Unknown actor class ${className}`);
    const dir = join(this.#dir, className);
    mkdirSync(dir, { recursive: true });
    this.#registry
      .query(
        "INSERT INTO actors (class, hex, name) VALUES (?, ?, ?) ON CONFLICT (class, hex) DO UPDATE SET name = COALESCE(actors.name, excluded.name)",
      )
      .run(className, id.hex, id.name ?? null);
    const entry: Entry = {
      instance: null,
      state: null as unknown as ActorState,
      ready: Promise.resolve(),
      timer: null,
      alarmRetries: 0,
    };
    entry.state = new ActorState(
      id,
      join(dir, `${id.hex}.sqlite`),
      (at) => this.arm(className, id.hex, entry, at),
      new Proxy({}, { get: (_t, name) => spec.exports()[String(name)] }),
      (p) => this.track(p),
      {
        message: (ws, data) => this.socketMessage(className, id, ws, data),
        close: (ws, code, reason) => this.socketClose(className, id, ws, code, reason),
      },
    );
    this.#entries.set(key, entry);
    entry.ready = (async () => {
      entry.instance = new spec.cls(entry.state, spec.env());
      await entry.state.opened();
    })();
    entry.ready.catch((error) => {
      log.error("actor.construct", { className, id: id.hex, error: String(error) });
      this.#entries.delete(key);
    });
    return entry;
  }

  async call<T>(
    className: string,
    id: ActorId,
    fn: (instance: ActorInstance) => Promise<T> | T,
  ): Promise<T> {
    const entry = this.entry(className, id);
    await entry.ready;
    await entry.state.opened();
    return fn(entry.instance as ActorInstance);
  }

  private arm(className: string, hex: string, entry: Entry, at: number | null): void {
    this.#registry
      .query("UPDATE actors SET alarm_at = ? WHERE class = ? AND hex = ?")
      .run(at, className, hex);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (at === null) return;
    const delay = Math.max(0, at - Date.now());
    entry.timer = setTimeout(
      () => {
        entry.timer = null;
        if (delay > MAX_TIMER_MS) {
          this.arm(className, hex, entry, at);
          return;
        }
        void this.fire(className, hex, entry, at);
      },
      Math.min(delay, MAX_TIMER_MS),
    );
  }

  private async fire(className: string, hex: string, entry: Entry, at: number): Promise<void> {
    await entry.ready;
    await entry.state.opened();
    if (entry.state.storage.alarmAt() !== at) return;
    entry.state.storage.sql.exec("DELETE FROM __rt_alarm");
    this.#registry
      .query("UPDATE actors SET alarm_at = NULL WHERE class = ? AND hex = ?")
      .run(className, hex);
    const retryCount = entry.alarmRetries;
    try {
      await entry.instance?.alarm?.({ retryCount, isRetry: retryCount > 0 });
      entry.alarmRetries = 0;
    } catch (error) {
      log.error("actor.alarm", { className, id: hex, retryCount, error: String(error) });
      if (retryCount < ALARM_RETRIES && entry.state.storage.alarmAt() === null) {
        entry.alarmRetries = retryCount + 1;
        await entry.state.storage.setAlarm(Date.now() + 2 ** retryCount * 1000);
      } else {
        entry.alarmRetries = 0;
      }
    }
  }

  /** Delivers a message from a real socket to the actor that accepted the server end. */
  async socketMessage(
    className: string,
    id: ActorId,
    server: PairSocket,
    data: string | ArrayBuffer,
  ): Promise<void> {
    await this.call(className, id, async (actor) => {
      const entry = this.entry(className, id);
      if (entry.state.autoRespond(server, data)) return;
      await actor.webSocketMessage?.(server, data);
    });
  }

  async socketClose(
    className: string,
    id: ActorId,
    server: PairSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    await this.call(className, id, async (actor) => {
      this.entry(className, id).state.forget(server);
      await actor.webSocketClose?.(server, code, reason, true);
    });
  }
}

/** Clones an RPC value the way Workers RPC does. Values that cannot be cloned pass as they are. */
function rpcClone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}

export class ActorNamespace {
  constructor(
    private readonly system: ActorSystem,
    readonly className: string,
  ) {}

  idFromName(name: string): ActorId {
    return new ActorId(hexOf(`${this.className}:${name}`), name);
  }

  idFromString(hex: string): ActorId {
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError("Invalid actor ID");
    return new ActorId(hex);
  }

  newUniqueId(): ActorId {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return new ActorId(Buffer.from(bytes).toString("hex"));
  }

  getByName(name: string): ActorStub {
    return this.get(this.idFromName(name));
  }

  get(id: ActorId): ActorStub {
    const system = this.system;
    const className = this.className;
    const target = {
      id,
      name: id.name,
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        system.call(className, id, async (actor) => {
          if (!actor.fetch) throw new Error(`${className} has no fetch handler`);
          return actor.fetch(
            input instanceof Request && !init
              ? input
              : new Request(String(input instanceof Request ? input.url : input), init ?? {}),
          );
        }),
      [Symbol.dispose]: () => {},
    };
    return new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop as keyof typeof t];
        if (prop === "then") return undefined;
        return (...args: unknown[]) =>
          system.call(className, id, async (actor) => {
            const method = (actor as Record<string | symbol, unknown>)[prop];
            if (typeof method !== "function") {
              if (args.length === 0) return rpcClone(method);
              throw new TypeError(`${className}.${String(prop)} is not a method`);
            }
            return rpcClone(await method.apply(actor, args.map(rpcClone)));
          });
      },
    }) as ActorStub;
  }
}

export type ActorStub = {
  id: ActorId;
  name?: string;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  // biome-ignore lint/suspicious/noExplicitAny: a stub exposes the actor's methods as async calls.
} & Record<string, any>;
