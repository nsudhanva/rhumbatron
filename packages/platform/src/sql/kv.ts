import type { Database } from "bun:sqlite";

/**
 * A read-heavy key-value namespace in a table of the platform database. It has the KV client
 * surface the code uses: `get` (text or JSON), `put` with an optional TTL, `delete` and `list`.
 */
export class KeyValueStore {
  constructor(
    private readonly db: Database,
    private readonly namespace: string,
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS platform_kv (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, metadata TEXT, expires_at INTEGER, PRIMARY KEY (namespace, key)) WITHOUT ROWID",
    );
  }

  async get<T = string>(
    key: string,
    options?: "text" | "json" | { type?: "text" | "json"; cacheTtl?: number },
  ): Promise<T | null> {
    const type = typeof options === "string" ? options : (options?.type ?? "text");
    const row = this.db
      .query(
        "SELECT value FROM platform_kv WHERE namespace = ? AND key = ? AND (expires_at IS NULL OR expires_at > ?)",
      )
      .get(this.namespace, key, Date.now()) as { value: string } | null;
    if (!row) return null;
    return (type === "json" ? JSON.parse(row.value) : row.value) as T;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; expiration?: number; metadata?: unknown },
  ): Promise<void> {
    const expires = options?.expirationTtl
      ? Date.now() + options.expirationTtl * 1000
      : options?.expiration
        ? options.expiration * 1000
        : null;
    this.db
      .query(
        "INSERT INTO platform_kv (namespace, key, value, metadata, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires_at = excluded.expires_at",
      )
      .run(
        this.namespace,
        key,
        value,
        options?.metadata === undefined ? null : JSON.stringify(options.metadata),
        expires,
      );
  }

  async delete(key: string): Promise<void> {
    this.db
      .query("DELETE FROM platform_kv WHERE namespace = ? AND key = ?")
      .run(this.namespace, key);
  }

  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<{
    keys: { name: string; expiration?: number }[];
    list_complete: boolean;
    cursor?: string | undefined;
  }> {
    const limit = options.limit ?? 1000;
    const rows = this.db
      .query(
        "SELECT key, expires_at FROM platform_kv WHERE namespace = ? AND key >= ? AND key > ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ?",
      )
      .all(this.namespace, options.prefix ?? "", options.cursor ?? "", Date.now(), limit + 1) as {
      key: string;
      expires_at: number | null;
    }[];
    const matching = rows.filter((r) => r.key.startsWith(options.prefix ?? ""));
    const page = matching.slice(0, limit);
    const complete = matching.length <= limit;
    return {
      keys: page.map((r) => ({
        name: r.key,
        ...(r.expires_at ? { expiration: Math.floor(r.expires_at / 1000) } : {}),
      })),
      list_complete: complete,
      ...(complete ? {} : { cursor: page.at(-1)?.key }),
    };
  }
}
