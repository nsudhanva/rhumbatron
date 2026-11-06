import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.ts";

/**
 * The product database: one SQLite file, opened once by the core service. It has the D1 client
 * surface the code uses (`prepare().bind().all()/first()/run()/raw()`, `batch()`, `exec()`), so
 * the SQLite-dialect queries and the migrations run unchanged.
 */

type Meta = {
  duration: number;
  changes: number;
  last_row_id: number;
  rows_read: number;
  rows_written: number;
  changed_db: boolean;
  size_after: number;
};

export type SqlResult<T = Record<string, unknown>> = { results: T[]; success: true; meta: Meta };

function bind(values: unknown[]): SQLQueryBindings[] {
  return values.map((v) => {
    if (v === undefined)
      throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return v as SQLQueryBindings;
  });
}

function isWrite(sql: string): boolean {
  return !/^\s*(SELECT|WITH\s[\s\S]*?\bSELECT\b(?![\s\S]*\b(INSERT|UPDATE|DELETE)\b)|PRAGMA|EXPLAIN|VALUES)\b/i.test(
    sql,
  );
}

export class SqlStatement {
  constructor(
    private readonly db: SqlDatabase,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new SqlStatement(this.db, this.sql, values);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const { results } = this.db.execute<Record<string, unknown>>(this);
    const row = results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.db.execute<T>(this);
  }

  async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return this.db.execute<T>(this);
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const { rows, columns } = this.db.executeRaw(this);
    return (options?.columnNames ? [columns, ...rows] : rows) as T[];
  }
}

export class SqlDatabase {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: false });
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run("PRAGMA synchronous = NORMAL");
    this.#db.run("PRAGMA foreign_keys = ON");
    this.#db.run("PRAGMA busy_timeout = 5000");
  }

  prepare(sql: string): SqlStatement {
    return new SqlStatement(this, sql);
  }

  /** Runs every statement in one transaction. One failure rolls all of them back. */
  async batch<T = Record<string, unknown>>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    return this.#db.transaction(() => statements.map((s) => this.execute<T>(s)))();
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    const count = sql.split(";").filter((s) => s.trim()).length;
    this.#db.run(sql);
    return { count, duration: performance.now() - started };
  }

  execute<T>(statement: SqlStatement): SqlResult<T> {
    const started = performance.now();
    try {
      const query = this.#db.query(statement.sql);
      const rows = query.all(...bind(statement.params)) as T[];
      const write = isWrite(statement.sql);
      const info = write
        ? (this.#db.query("SELECT changes() AS c, last_insert_rowid() AS id").get() as {
            c: number;
            id: number;
          })
        : { c: 0, id: 0 };
      return {
        results: rows,
        success: true,
        meta: {
          duration: performance.now() - started,
          changes: info.c,
          last_row_id: info.id,
          rows_read: rows.length,
          rows_written: info.c,
          changed_db: info.c > 0,
          size_after: 0,
        },
      };
    } catch (error) {
      throw new Error(`D1_ERROR: ${(error as Error).message}`, { cause: error });
    }
  }

  executeRaw(statement: SqlStatement): { rows: unknown[][]; columns: string[] } {
    const query = this.#db.query(statement.sql);
    const rows = query.values(...bind(statement.params)) as unknown[][];
    return { rows, columns: query.columnNames };
  }

  /** Applies every migration file not yet in `d1_migrations`, in name order. */
  migrate(dir: string): string[] {
    this.#db.run(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)",
    );
    const applied = new Set(
      (this.#db.query("SELECT name FROM d1_migrations").all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    const pending = readdirSync(dir)
      .filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f) && !applied.has(f))
      .sort();
    for (const name of pending) {
      const sql = readFileSync(join(dir, name), "utf8");
      this.#db.transaction(() => {
        this.#db.run(sql);
        this.#db.query("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
      })();
      log.info("db.migrated", { name });
    }
    return pending;
  }

  /** The raw handle, for platform tables (KV, vectors, metrics) in the same file. */
  get handle(): Database {
    return this.#db;
  }
}
