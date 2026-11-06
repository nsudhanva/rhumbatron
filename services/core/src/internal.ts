import type { ObjectBucket } from "../../../packages/platform/src/objects/bucket.ts";
import type { SqlDatabase } from "../../../packages/platform/src/sql/database.ts";

/**
 * The internal API on its own port, for the apps service only. Caddy does not route to it.
 * Every request carries `Authorization: Bearer <INTERNAL_TOKEN>`.
 *
 *   POST /internal/d1                       { statements: [{ sql, params }], batch }
 *   GET|PUT|HEAD|DELETE /internal/r2/object/<key>   metadata in `x-r2-meta` (JSON)
 *   GET /internal/r2/list?prefix=&cursor=&limit=&delimiter=
 */
export function internalRoutes(deps: { db: SqlDatabase; evidence: ObjectBucket; token: string }) {
  const expected = `Bearer ${deps.token}`;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return Response.json({ ok: true });
    if (request.headers.get("authorization") !== expected)
      return new Response("Unauthorized", { status: 401 });
    try {
      if (url.pathname === "/internal/d1" && request.method === "POST") {
        const body = (await request.json()) as {
          statements: { sql: string; params?: unknown[] }[];
          batch?: boolean;
        };
        const statements = body.statements.map((s) =>
          deps.db.prepare(s.sql).bind(...(s.params ?? [])),
        );
        if (body.batch) return Response.json(await deps.db.batch(statements));
        const [first] = statements;
        if (!first) return Response.json({ error: "no statement" }, { status: 400 });
        return Response.json(await first.all());
      }
      if (url.pathname === "/internal/r2/list") {
        const limit = url.searchParams.get("limit");
        const options: { prefix?: string; cursor?: string; delimiter?: string; limit?: number } =
          {};
        for (const key of ["prefix", "cursor", "delimiter"] as const) {
          const value = url.searchParams.get(key);
          if (value) options[key] = value;
        }
        if (limit) options.limit = Number(limit);
        const listed = await deps.evidence.list(options);
        return Response.json(listed);
      }
      if (url.pathname.startsWith("/internal/r2/object/")) {
        const key = decodeURIComponent(url.pathname.slice("/internal/r2/object/".length));
        // Header values are ASCII: other characters travel as \uXXXX escapes inside the JSON.
        const metaHeader = (o: {
          key: string;
          httpMetadata: unknown;
          customMetadata: unknown;
          size: number;
          etag: string;
          uploaded: Date;
        }) =>
          JSON.stringify({
            key: o.key,
            httpMetadata: o.httpMetadata,
            customMetadata: o.customMetadata,
            size: o.size,
            etag: o.etag,
            uploaded: o.uploaded.toISOString(),
          }).replace(
            /[\u007f-\uffff]/g,
            (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
          );
        if (request.method === "GET" || request.method === "HEAD") {
          if (request.method === "HEAD") {
            const head = await deps.evidence.head(key);
            if (!head) return new Response(null, { status: 404 });
            return new Response(null, { headers: { "x-r2-meta": metaHeader(head) } });
          }
          const object = await deps.evidence.get(key);
          if (!object) return new Response(null, { status: 404 });
          return new Response(await object.bytes(), {
            headers: { "x-r2-meta": metaHeader(object) },
          });
        }
        if (request.method === "PUT") {
          const meta = JSON.parse(request.headers.get("x-r2-meta") ?? "{}") as {
            httpMetadata?: Record<string, string>;
            customMetadata?: Record<string, string>;
          };
          const stored = await deps.evidence.put(
            key,
            new Uint8Array(await request.arrayBuffer()),
            meta,
          );
          return new Response(null, { status: 200, headers: { "x-r2-meta": metaHeader(stored) } });
        }
        if (request.method === "DELETE") {
          await deps.evidence.delete(key);
          return new Response(null, { status: 204 });
        }
      }
      return new Response("Not Found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String((error as Error).message ?? error) }, { status: 500 });
    }
  };
}
