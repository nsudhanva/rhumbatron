import { deserialize, serialize } from "bun:jsc";
import { Database, type SQLQueryBindings } from "bun:sqlite";

/**
 * Actor storage over one SQLite file per actor. It has the Durable Object storage surface the
 * code uses: synchronous `sql.exec`, `transactionSync`, an async `transaction`, the async and
 * synchronous key-value APIs, and one alarm. Key-value rows and the alarm live in tables with a
 * `__rt_` prefix, so the actor's own schema never sees them.
 */

type Value = string | number | bigint | ArrayBuffer | null;

export class SqlCursor<T extends Record<string, Value>> implements Iterable<T> {
  readonly columnNames: string[];
  readonly rowsRead: number;
  readonly rowsWritten: number;
  #rows: T[];
  #index = 0;

  constructor(rows: T[], columnNames: string[], rowsWritten: number) {
    this.#rows = rows;
    this.columnNames = columnNames;
    this.rowsRead = rows.length;
    this.rowsWritten = rowsWritten;
  }

  next(): IteratorResult<T> {
    const row = this.#rows[this.#index++];
    return row === undefined ? { done: true, value: undefined } : { done: false, value: row };
  }

  toArray(): T[] {
    const rest = this.#rows.slice(this.#index);
    this.#index = this.#rows.length;
    return rest;
  }

  one(): T {
    const rest = this.toArray();
    if (rest.length !== 1) {
      throw new Error(
        rest.length === 0
          ? "Expected exactly one result from SQL query, but got no results."
          : "Expected exactly one result from SQL query, but got multiple results.",
      );
    }
    return rest[0] as T;
  }

  *raw<R extends Value[]>(): IterableIterator<R> {
    for (const row of this.toArray()) yield this.columnNames.map((c) => row[c]) as R;
  }

  [Symbol.iterator](): Iterator<T> {
    return this;
  }
}

/** True when the query holds more than one statement (a migration script, for example). */
function isScript(query: string): boolean {
  const body = query
    .replace(/--[^\n]*/g, "")
    .replace(/'(?:[^']|'')*'/g, "''")
    .trim()
    .replace(/;+\s*$/, "");
  return body.includes(";");
}

function bind(values: unknown[]): SQLQueryBindings[] {
  return values.map((v) => {
    if (v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return v as SQLQueryBindings;
  });
}

function toBuffers<T>(row: Record<string, unknown>): T {
  for (const key in row) {
    const value = row[key];
    if (value instanceof Uint8Array) {
      row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
  }
  return row as T;
}

export class SqlStorage {
  constructor(private readonly db: Database) {}

  exec<T extends Record<string, Value>>(query: string, ...bindings: unknown[]): SqlCursor<T> {
    if (bindings.length === 0 && isScript(query)) {
      const before = this.db.query("SELECT total_changes() AS n").get() as { n: number };
      this.db.run(query);
      const after = this.db.query("SELECT total_changes() AS n").get() as { n: number };
      return new SqlCursor<T>([], [], after.n - before.n);
    }
    const statement = this.db.query(query);
    const rows = statement.all(...bind(bindings)) as Record<string, unknown>[];
    const changes = (this.db.query("SELECT changes() AS n").get() as { n: number }).n;
    const isRead =
      /^\s*(SELECT|WITH|PRAGMA|EXPLAIN|VALUES)\b/i.test(query) &&
      !/\b(INSERT|UPDATE|DELETE)\b/i.test(query);
    return new SqlCursor<T>(
      rows.map((r) => toBuffers<T>(r)),
      statement.columnNames,
      isRead ? 0 : changes,
    );
  }

  get databaseSize(): number {
    const row = this.db
      .query("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()")
      .get() as { size: number };
    return row.size;
  }
}

export type ListOptions = {
  start?: string;
  startAfter?: string;
  end?: string;
  prefix?: string;
  reverse?: boolean;
  limit?: number;
};

/** Called when the actor sets or deletes its alarm, so the host can arm a timer. */
export type AlarmListener = (at: number | null) => void;

export class ActorStorage {
  readonly sql: SqlStorage;
  readonly kv: SyncKv;
  #db: Database;
  #onAlarm: AlarmListener;
  #txDepth = 0;

  constructor(path: string, onAlarm: AlarmListener) {
    this.#db = new Database(path, { create: true, strict: false });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run("PRAGMA synchronous = NORMAL");
    this.#db.run("PRAGMA foreign_keys = ON");
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS __rt_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL) WITHOUT ROWID",
    );
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS __rt_alarm (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)",
    );
    this.sql = new SqlStorage(this.#db);
    this.kv = new SyncKv(this.#db);
    this.#onAlarm = onAlarm;
  }

  /** The stored alarm time, read by the host at start. */
  alarmAt(): number | null {
    const row = this.#db.query("SELECT at FROM __rt_alarm WHERE id = 1").get() as {
      at: number;
    } | null;
    return row?.at ?? null;
  }

  transactionSync<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  /** Runs `fn` in a savepoint. It rolls back and rethrows when `fn` rejects. */
  async transaction<T>(fn: (txn: ActorStorage) => Promise<T>): Promise<T> {
    const name = `rt_tx_${++this.#txDepth}`;
    this.#db.run(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      this.#db.run(`RELEASE ${name}`);
      return result;
    } catch (error) {
      this.#db.run(`ROLLBACK TO ${name}`);
      this.#db.run(`RELEASE ${name}`);
      throw error;
    } finally {
      this.#txDepth--;
    }
  }

  async get<T = unknown>(keys: string | string[]): Promise<T | Map<string, T> | undefined> {
    if (Array.isArray(keys)) {
      const out = new Map<string, T>();
      for (const key of keys) {
        const value = this.kv.get<T>(key);
        if (value !== undefined) out.set(key, value);
      }
      return out;
    }
    return this.kv.get<T>(keys);
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.kv.put(keyOrEntries, value);
      return;
    }
    this.transactionSync(() => {
      for (const [key, v] of Object.entries(keyOrEntries)) this.kv.put(key, v);
    });
  }

  async delete(keys: string | string[]): Promise<boolean | number> {
    if (Array.isArray(keys)) {
      let n = 0;
      for (const key of keys) if (this.kv.delete(key)) n++;
      return n;
    }
    return this.kv.delete(keys);
  }

  async list<T = unknown>(options: ListOptions = {}): Promise<Map<string, T>> {
    return new Map(this.kv.list<T>(options));
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt();
  }

  async setAlarm(scheduled: number | Date): Promise<void> {
    const at = typeof scheduled === "number" ? scheduled : scheduled.getTime();
    this.#db
      .query(
        "INSERT INTO __rt_alarm (id, at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at",
      )
      .run(at);
    this.#onAlarm(at);
  }

  async deleteAlarm(): Promise<void> {
    this.#db.run("DELETE FROM __rt_alarm");
    this.#onAlarm(null);
  }

  /** Drops every table, key and the alarm. The file stays, empty. */
  async deleteAll(): Promise<void> {
    const tables = this.#db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    this.#db.run("PRAGMA foreign_keys = OFF");
    this.transactionSync(() => {
      for (const { name } of tables) {
        if (name === "__rt_kv" || name === "__rt_alarm") this.#db.run(`DELETE FROM "${name}"`);
        else this.#db.run(`DROP TABLE IF EXISTS "${name}"`);
      }
    });
    this.#db.run("PRAGMA foreign_keys = ON");
    this.#onAlarm(null);
  }

  async sync(): Promise<void> {}

  close(): void {
    this.#db.close();
  }
}

/** The synchronous key-value API (`ctx.storage.kv`). Values are structured-cloned. */
export class SyncKv {
  constructor(private readonly db: Database) {}

  get<T = unknown>(key: string): T | undefined {
    const row = this.db.query("SELECT value FROM __rt_kv WHERE key = ?").get(key) as {
      value: Uint8Array;
    } | null;
    return row ? (deserialize(row.value) as T) : undefined;
  }

  put<T>(key: string, value: T): void {
    this.db
      .query(
        "INSERT INTO __rt_kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, new Uint8Array(serialize(value)));
  }

  delete(key: string): boolean {
    return this.db.query("DELETE FROM __rt_kv WHERE key = ?").run(key).changes > 0;
  }

  *list<T = unknown>(options: ListOptions = {}): IterableIterator<[string, T]> {
    const where: string[] = [];
    const args: string[] = [];
    if (options.prefix !== undefined) {
      where.push("key >= ? AND key < ?");
      args.push(options.prefix, `${options.prefix}￿`);
    }
    if (options.start !== undefined) {
      where.push("key >= ?");
      args.push(options.start);
    }
    if (options.startAfter !== undefined) {
      where.push("key > ?");
      args.push(options.startAfter);
    }
    if (options.end !== undefined) {
      where.push("key < ?");
      args.push(options.end);
    }
    const sql = `SELECT key, value FROM __rt_kv ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY key ${options.reverse ? "DESC" : "ASC"} ${options.limit ? `LIMIT ${Number(options.limit)}` : ""}`;
    for (const row of this.db.query(sql).all(...args) as { key: string; value: Uint8Array }[]) {
      yield [row.key, deserialize(row.value) as T];
    }
  }
}
