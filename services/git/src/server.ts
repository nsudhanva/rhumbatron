/**
 * Rhumbatron Git service. It replaces Cloudflare Artifacts on the single-host stack.
 *
 *   POST /api/<op>          JSON control API. Bearer GIT_ADMIN_TOKEN. For the core service only.
 *   /git/<name>.git/...     Git smart HTTP. Basic or Bearer auth with a minted repo token.
 *   GET  /healthz           Liveness.
 */
import { ServiceError, STATUS } from "./errors.ts";
import { isGitPath, serveGit } from "./smart-http.ts";
import { Store } from "./store.ts";
import { sameSecret } from "./tokens.ts";

function required(key: string, minLength: number) {
  const value = process.env[key] ?? "";
  if (value.length < minLength) {
    console.error(`${key} must be set and at least ${minLength} characters long`);
    process.exit(1);
  }
  return value;
}

const adminToken = required("GIT_ADMIN_TOKEN", 16);
const tokenSecret = required("GIT_TOKEN_SECRET", 32);
const root = process.env.GIT_ROOT || "/srv/git";
const port = Number(process.env.PORT ?? 8080);
const publicUrl = (process.env.GIT_PUBLIC_URL || "http://git:8080").replace(/\/+$/, "");
const namespace = process.env.GIT_NAMESPACE || "rhumbatron";

const store = new Store(root, tokenSecret, publicUrl, namespace);
await store.recover();

type Body = Record<string, unknown> & { name?: unknown; namespace?: unknown };
type Op = (body: Body) => unknown;

const json = (data: unknown, status = 200) => Response.json(data, { status });
const nullResult = () => new Response(null, { status: 200, headers: { "x-git-result": "null" } });

const ops: Record<string, Op> = {
  create: (b) => store.create(b.name, (b.opts ?? {}) as Parameters<Store["create"]>[1]),
  get: (b) => store.get(b.name),
  import: (b) => store.import(b as Parameters<Store["import"]>[0]),
  list: (b) => store.list((b.opts ?? {}) as Parameters<Store["list"]>[0]),
  delete: async (b) => ({ deleted: await store.delete(b.name) }),
  info: (b) => store.info(b.name),
  createToken: (b) => store.createToken(b.name, b.scope ?? "write", b.ttl ?? 86_400),
  listTokens: (b) => store.listTokens(b.name),
  revokeToken: (b) => ({ revoked: store.revokeToken(b.name, b.tokenOrId) }),
  readTree: (b) => store.readTree(b.name, b.hash),
  readCommit: (b) => store.readCommit(b.name, b.hash),
  log: (b) => store.log(b.name, (b.opts ?? {}) as Parameters<Store["log"]>[1]),
  fork: (b) => store.fork(b.name, b.target, (b.opts ?? {}) as Parameters<Store["fork"]>[2]),
};

async function api(req: Request, op: string): Promise<Response> {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !sameSecret(auth.slice(7), adminToken)) {
    return json({ error: { code: "UNAUTHORIZED", message: "admin token required" } }, 401);
  }
  if (req.method !== "POST")
    return json({ error: { code: "INVALID_INPUT", message: "POST only" } }, 405);
  let body: Body;
  try {
    body = ((await req.json()) ?? {}) as Body;
  } catch {
    return json({ error: { code: "INVALID_INPUT", message: "body must be JSON" } }, 400);
  }
  try {
    if (body.namespace !== undefined && body.namespace !== namespace) {
      throw new ServiceError("INVALID_INPUT", `unknown namespace: ${String(body.namespace)}`);
    }
    if (op === "readBlob") {
      const bytes = await store.readBlob(body.name, body.hash);
      return bytes
        ? new Response(bytes, { headers: { "content-type": "application/octet-stream" } })
        : nullResult();
    }
    if (op === "readFile") {
      const file = await store.readFile(
        body.name,
        (body.args ?? {}) as { ref?: unknown; path?: unknown },
      );
      return file
        ? new Response(file.bytes, { headers: { "content-type": file.type } })
        : nullResult();
    }
    const handler = ops[op];
    if (!handler)
      return json({ error: { code: "INVALID_INPUT", message: `unknown op: ${op}` } }, 404);
    return json(await handler(body));
  } catch (error) {
    if (error instanceof ServiceError) {
      return json({ error: { code: error.code, message: error.message } }, STATUS[error.code]);
    }
    console.error(
      JSON.stringify({ event: "git.api_failed", op, error: String(error).slice(0, 500) }),
    );
    return json({ error: { code: "INTERNAL_ERROR", message: "internal error" } }, 500);
  }
}

const server = Bun.serve({
  port,
  hostname: "0.0.0.0",
  // Pushes of a full repo; Artifacts caps a repo at 1 GB.
  maxRequestBodySize: 1024 * 1024 * 1024,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return json({ ok: true });
    if (url.pathname.startsWith("/api/")) return api(req, url.pathname.slice(5));
    if (isGitPath(url.pathname)) return serveGit(store, req);
    return new Response("not found\n", { status: 404 });
  },
  error(error) {
    console.error(
      JSON.stringify({ event: "git.request_failed", error: String(error).slice(0, 500) }),
    );
    return new Response("internal error\n", { status: 500 });
  },
});

process.stdout.write(`${JSON.stringify({ event: "git.listening", port: server.port, root })}\n`);
