import { createHash, timingSafeEqual } from "node:crypto";
import Docker from "dockerode";
import { loadConfig } from "./config.ts";
import { type Entry, log, SandboxError, Sandboxes } from "./sandboxes.ts";
import { parseCreateBody } from "./spec.ts";

/**
 * sandboxd: one isolated container per sandbox ID, through the Docker Engine API behind a
 * socket proxy. Every route except /healthz needs `Authorization: Bearer $SANDBOXD_TOKEN`.
 */

const cfg = loadConfig();
const url = new URL(cfg.dockerHost.replace(/^tcp:/, "http:"));
const docker = new Docker({ host: url.hostname, port: Number(url.port || 2375), protocol: "http" });
const sandboxes = new Sandboxes(docker, cfg);

const digest = (s: string) => createHash("sha256").update(s).digest();
const tokenDigest = digest(cfg.token);
const authorized = (req: Request) => {
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(given), tokenDigest);
};

const json = (body: unknown, status = 200) => Response.json(body, { status });
/** sandboxd's own errors carry `x-sandboxd-error`, so a proxied app response is never mistaken. */
const fail = (error: unknown) => {
  const known = error instanceof SandboxError;
  if (!known) {
    const status = (error as { statusCode?: number } | null)?.statusCode;
    log("sandboxd.error", { error: String(error).slice(0, 500), status });
  }
  return Response.json(
    {
      error: String(known ? error.message : error).slice(0, 500),
      name: known ? error.name : "SandboxError",
    },
    { status: known ? error.status : 502, headers: { "x-sandboxd-error": "1" } },
  );
};

const readJson = async (req: Request): Promise<Record<string, unknown>> => {
  const text = await req.text();
  if (!text) return {};
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
  } catch {}
  throw new SandboxError(400, "body must be a JSON object");
};

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string") throw new SandboxError(400, `${name} must be a string`);
  return v;
};
const optStr = (v: unknown, name: string) => (v === undefined ? undefined : str(v, name));
const optNum = (v: unknown, name: string) => {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new SandboxError(400, `${name} must be a positive number`);
  }
  return v;
};

const ROUTE = /^\/v1\/sandboxes\/([^/]+)(?:\/(.*))?$/;

async function route(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  const { pathname, search } = new URL(req.url);
  if (pathname === "/healthz") {
    return json({ ok: true, live: sandboxes.liveCount, max: cfg.maxLive });
  }
  if (!authorized(req)) return json({ error: "unauthorized" }, 401);
  const m = ROUTE.exec(pathname);
  if (!m) return json({ error: "not found" }, 404);
  const id = decodeURIComponent(m[1] ?? "");
  const rest = m[2] ?? "";
  const method = req.method;
  // Commands and previews can outlast Bun's idle timeout.
  server.timeout(req, 0);
  const sleepAfter = req.headers.get("x-sandbox-sleep-after") ?? undefined;
  const idle = parseCreateBody({ sleepAfter }, cfg.idleMs).idleMs;
  const use = <T>(fn: (entry: Entry) => Promise<T>) => sandboxes.use(id, fn, idle);

  if (rest === "" && method === "DELETE") {
    await sandboxes.destroy(id);
    return json({ success: true });
  }
  if (rest === "" && method === "POST") {
    const body = await readJson(req);
    const { idleMs } = parseCreateBody({ sleepAfter, ...body }, cfg.idleMs);
    const entry = await sandboxes.ensure(id, idleMs);
    return json({ id: entry.id, status: "running" });
  }

  const port = /^ports\/(\d+)\/fetch(\/.*)?$/.exec(rest);
  if (port) {
    return use((e) => sandboxes.fetchPort(e, Number(port[1]), `${port[2] ?? "/"}${search}`, req));
  }
  const proc = /^processes\/([^/]+)(\/logs)?$/.exec(rest);
  if (proc) {
    const pid = decodeURIComponent(proc[1] ?? "");
    if (proc[2] && method === "GET") {
      return json(await use((e) => sandboxes.processLogs(e, pid)));
    }
    if (method === "GET") return json(await use((e) => sandboxes.processStatus(e, pid)));
    if (method === "DELETE") {
      return json(await use((e) => sandboxes.killProcess(e, pid)));
    }
  }
  if (method !== "POST" && method !== "PUT") return json({ error: "not found" }, 404);
  const body = await readJson(req);
  switch (rest) {
    case "exec": {
      const cwd = optStr(body.cwd, "cwd");
      const timeout = optNum(body.timeout, "timeout");
      const command = str(body.command, "command");
      return json(
        await use((e) =>
          sandboxes.exec(e, {
            command,
            env: body.env,
            ...(cwd ? { cwd } : {}),
            ...(timeout ? { timeout } : {}),
          }),
        ),
      );
    }
    case "files/read":
      return json(await use((e) => sandboxes.readFile(e, str(body.path, "path"))));
    case "files/write":
      return json(
        await use((e) =>
          sandboxes.writeFile(
            e,
            str(body.path, "path"),
            str(body.content, "content"),
            optStr(body.encoding, "encoding"),
          ),
        ),
      );
    case "processes": {
      const cwd = optStr(body.cwd, "cwd");
      const processId = optStr(body.processId, "processId");
      const command = str(body.command, "command");
      return json(
        await use((e) =>
          sandboxes.startProcess(e, {
            command,
            env: body.env,
            ...(cwd ? { cwd } : {}),
            ...(processId ? { processId } : {}),
          }),
        ),
      );
    }
    case "env":
      await use(async (e) => sandboxes.setEnv(e, body.envVars));
      return json({ success: true });
    default:
      return json({ error: "not found" }, 404);
  }
}

// The socket proxy can start after sandboxd: retry the boot sweep for up to a minute.
for (let attempt = 1; ; attempt++) {
  try {
    log("sandboxd.orphans_removed", { count: await sandboxes.removeOrphans() });
    break;
  } catch (error) {
    if (attempt >= 30) throw error;
    await Bun.sleep(2000);
  }
}
setInterval(() => {
  sandboxes.sweep().catch((error) => log("sandboxd.sweep_failed", { error: String(error) }));
}, 10_000);

const server = Bun.serve({
  port: cfg.port,
  hostname: "0.0.0.0",
  maxRequestBodySize: 32 * 1024 * 1024,
  fetch: (req, srv) => route(req, srv).catch(fail),
});
log("sandboxd.listening", { port: server.port, max: cfg.maxLive, runtime: cfg.runtime });
