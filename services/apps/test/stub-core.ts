/**
 * Test stand-in for the core service's internal API (services/apps/CONTRACT.md): D1 on an
 * in-memory SQLite, R2 in a Map. Only for services/apps/test/verify.ts.
 *
 *   INTERNAL_TOKEN=... bun services/apps/test/stub-core.ts
 */
import { Database, type SQLQueryBindings } from "bun:sqlite";

const token = process.env.INTERNAL_TOKEN ?? "";
const db = new Database(":memory:");
db.exec(`CREATE TABLE app_deployments (
  project_id TEXT NOT NULL, slug TEXT NOT NULL, channel TEXT NOT NULL, commit_sha TEXT,
  generation INTEGER, bundle_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready', 'failed', 'removed')),
  failure_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, channel))`);

type Meta = {
  size: number;
  etag: string;
  uploaded: string;
  httpMetadata: unknown;
  customMetadata: unknown;
};
const objects = new Map<string, { body: ArrayBuffer; meta: Meta }>();
let d1Calls = 0;

const headerJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

function run(sql: string, params: unknown[]) {
  const started = performance.now();
  const statement = db.query(sql);
  const results = statement.all(...(params as SQLQueryBindings[]));
  const info = db.query("SELECT changes() AS c, last_insert_rowid() AS r").get() as {
    c: number;
    r: number;
  };
  const write = !/^\s*select/i.test(sql);
  return {
    results,
    success: true,
    meta: {
      changes: write ? info.c : 0,
      last_row_id: info.r,
      duration: performance.now() - started,
      rows_read: results.length,
      rows_written: write ? info.c : 0,
    },
  };
}

Bun.serve({
  port: Number(process.env.PORT ?? 8790),
  async fetch(request) {
    if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    const url = new URL(request.url);
    if (url.pathname === "/test/stats") return Response.json({ d1Calls, objects: objects.size });
    if (url.pathname === "/internal/d1" && request.method === "POST") {
      d1Calls++;
      const body = (await request.json()) as {
        statements: { sql: string; params: unknown[] }[];
        batch: boolean;
      };
      try {
        if (!body.batch) {
          const [one] = body.statements;
          if (!one) return Response.json({ error: "no statement" }, { status: 400 });
          return Response.json(run(one.sql, one.params));
        }
        return Response.json(
          db.transaction(() => body.statements.map((s) => run(s.sql, s.params)))(),
        );
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 });
      }
    }
    if (url.pathname === "/internal/r2/list") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? 1000);
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const page = keys.slice(0, limit);
      return Response.json({
        objects: page.map((key) => ({ key, ...objects.get(key)?.meta })),
        truncated: keys.length > limit,
        ...(keys.length > limit ? { cursor: page.at(-1) } : {}),
        delimitedPrefixes: [],
      });
    }
    const prefix = "/internal/r2/object/";
    if (url.pathname.startsWith(prefix)) {
      const key = decodeURIComponent(url.pathname.slice(prefix.length));
      const hit = objects.get(key);
      if (request.method === "PUT") {
        const body = await request.arrayBuffer();
        const sent = JSON.parse(request.headers.get("x-r2-meta") ?? "{}");
        const meta: Meta = {
          size: body.byteLength,
          etag: new Bun.CryptoHasher("md5").update(body).digest("hex"),
          uploaded: new Date().toISOString(),
          httpMetadata: sent.httpMetadata ?? {},
          customMetadata: sent.customMetadata ?? {},
        };
        objects.set(key, { body, meta });
        return new Response(null, { headers: { "x-r2-meta": headerJson({ key, ...meta }) } });
      }
      if (request.method === "DELETE") {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      if (!hit) return new Response(null, { status: 404 });
      const headers = { "x-r2-meta": headerJson({ key, ...hit.meta }) };
      return new Response(request.method === "HEAD" ? null : hit.body, { headers });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
console.log("stub core listening");
