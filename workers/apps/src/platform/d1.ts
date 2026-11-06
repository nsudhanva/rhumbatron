import { type CoreLink, coreFetch, expectOk } from "./core.ts";

/**
 * D1Database over HTTP to the core service (`POST /internal/d1`, services/apps/CONTRACT.md).
 * Covers prepare/bind/all/first/run/raw and batch. Params must be JSON values; booleans become
 * 1 or 0 and undefined becomes null, as D1 binds them. Blob params are not supported.
 */

type Statement = { sql: string; params: unknown[] };

function param(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    throw new Error("D1 over HTTP does not bind blobs.");
  }
  return value;
}

async function send<T>(link: CoreLink, statements: Statement[], batch: boolean): Promise<T> {
  const response = await coreFetch(link, "/internal/d1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ statements, batch }),
  });
  return (await (await expectOk(response, "D1")).json()) as T;
}

class HttpStatement {
  constructor(
    private readonly link: CoreLink,
    readonly statement: Statement,
  ) {}

  bind(...values: unknown[]): HttpStatement {
    return new HttpStatement(this.link, { sql: this.statement.sql, params: values.map(param) });
  }

  all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return send<D1Result<T>>(this.link, [this.statement], false);
  }

  run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const row = (await this.all<Record<string, unknown>>()).results[0];
    if (!row) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: ${column}`);
    return (row[column] ?? null) as T;
  }

  /** Rows as arrays, in the column order of the JSON objects the core returns. */
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const rows = (await this.all<Record<string, unknown>>()).results;
    const values = rows.map((row) => Object.values(row) as T);
    if (!options?.columnNames) return values;
    return [Object.keys(rows[0] ?? {}) as T, ...values];
  }
}

export class HttpD1 {
  constructor(private readonly link: CoreLink) {}

  prepare(sql: string): HttpStatement {
    return new HttpStatement(this.link, { sql, params: [] });
  }

  /** One transaction on the core side: all statements commit or none do. */
  batch<T = unknown>(statements: HttpStatement[]): Promise<D1Result<T>[]> {
    return send<D1Result<T>[]>(
      this.link,
      statements.map((s) => s.statement),
      true,
    );
  }
}
