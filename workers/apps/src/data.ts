import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

/**
 * Per-app persistent storage (P16-09, ADR 0020). An app gets one `DATA` binding: a small string
 * key-value store. The binding is a router entrypoint whose `props.storeName` the router sets; the
 * app cannot name another store. Each store is one SQLite-backed `AppDataDO`, so data survives
 * isolate restarts, new versions, and rollbacks. Production and each preview have separate stores.
 *
 * Chosen over Durable Object facets: apps stay plain fetch Workers (no Durable Object class to
 * export), and app requests that do not touch storage never go through a Durable Object.
 */

const DATA_LIMITS = {
  keyChars: 512,
  valueBytes: 128 * 1024,
  keys: 10_000,
  listPage: 1000,
} as const;

export class AppDataDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
    );
  }

  get(key: string): string | null {
    const row = this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)
      .toArray()[0];
    return row?.value ?? null;
  }

  put(key: string, value: string): void {
    const exists = this.ctx.storage.sql.exec("SELECT 1 FROM kv WHERE key = ?", key).toArray();
    if (exists.length === 0) {
      const count = this.ctx.storage.sql
        .exec<{ n: number }>("SELECT COUNT(*) AS n FROM kv")
        .one().n;
      if (count >= DATA_LIMITS.keys) throw new Error(`store is full (${DATA_LIMITS.keys} keys)`);
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
      key,
      value,
      Date.now(),
    );
  }

  delete(key: string): boolean {
    return this.ctx.storage.sql.exec("DELETE FROM kv WHERE key = ?", key).rowsWritten > 0;
  }

  list(prefix: string, limit: number): { key: string; value: string }[] {
    return this.ctx.storage.sql
      .exec<{ key: string; value: string }>(
        "SELECT key, value FROM kv WHERE substr(key, 1, ?) = ? ORDER BY key LIMIT ?",
        prefix.length,
        prefix,
        limit,
      )
      .toArray();
  }

  /** App removal (milestone D): deletes the whole store. */
  async wipe(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

function checkKey(key: unknown): string {
  if (typeof key !== "string" || key.length === 0 || key.length > DATA_LIMITS.keyChars) {
    throw new Error(`key must be a string of 1 to ${DATA_LIMITS.keyChars} characters`);
  }
  return key;
}

/** The `DATA` binding that an app sees: get, put, delete, list. Values are strings (use JSON). */
export class AppData extends WorkerEntrypoint<Env, { storeName: string }> {
  private store() {
    const ns = this.env.APP_DATA as DurableObjectNamespace<AppDataDO>;
    return ns.get(ns.idFromName(this.ctx.props.storeName));
  }

  async get(key: string): Promise<string | null> {
    return this.store().get(checkKey(key));
  }

  async put(key: string, value: string): Promise<void> {
    if (typeof value !== "string") throw new Error("value must be a string");
    if (new TextEncoder().encode(value).length > DATA_LIMITS.valueBytes) {
      throw new Error(`value is larger than ${DATA_LIMITS.valueBytes} bytes`);
    }
    await this.store().put(checkKey(key), value);
  }

  async delete(key: string): Promise<boolean> {
    return this.store().delete(checkKey(key));
  }

  async list(options: { prefix?: string; limit?: number } = {}) {
    const prefix = typeof options.prefix === "string" ? options.prefix : "";
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), DATA_LIMITS.listPage);
    return this.store().list(prefix, limit);
  }
}
