import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import type { ServerConfig } from "./config.ts";
import { containerName, containerSpec, SANDBOX_LABEL, validSandboxId } from "./spec.ts";

/** An error with an HTTP status. `name` reaches the client, which rethrows it under that name. */
export class SandboxError extends Error {
  constructor(
    readonly status: number,
    message: string,
    name = "SandboxError",
  ) {
    super(message);
    this.name = name;
  }
}

export type Entry = {
  id: string;
  container: Docker.Container;
  ip: string;
  idleMs: number;
  lastUsed: number;
  inflight: number;
  env: Record<string, string>;
};

export type ExecResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  duration: number;
  timestamp: string;
};

type RawRun = { exitCode: number; stdout: Buffer; stderr: Buffer; duration: number };

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROCESS_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const PROC_DIR = "/tmp/.sbx-proc";
/** Raw bytes per writeFile exec: base64 of this stays below the 128 KiB argument limit. */
const WRITE_CHUNK = 48 * 1024;

const statusOf = (error: unknown) => (error as { statusCode?: number } | null)?.statusCode;

/** Validates and flattens an env map for Docker exec. Undefined values are skipped. */
function envList(env: unknown): string[] {
  if (env === undefined || env === null) return [];
  if (typeof env !== "object") throw new SandboxError(400, "env must be an object");
  const out: string[] = [];
  for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
    if (value === undefined) continue;
    if (!ENV_KEY.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new SandboxError(400, `invalid env entry ${key}`);
    }
    out.push(`${key}=${value}`);
  }
  return out;
}

const procFile = (processId: string) => {
  if (!PROCESS_ID.test(processId)) throw new SandboxError(400, "invalid process id");
  return `${PROC_DIR}/${processId}`;
};

/** Owns the live sandbox containers: create-or-get, exec, files, processes, idle sweep. */
export class Sandboxes {
  private readonly live = new Map<string, Entry>();
  private readonly starting = new Map<string, Promise<Entry>>();

  constructor(
    private readonly docker: Docker,
    private readonly cfg: ServerConfig,
  ) {}

  get liveCount() {
    return this.live.size + this.starting.size;
  }

  /** Removes every container with the sandbox label. Runs at boot: no sandbox survives a restart. */
  async removeOrphans(): Promise<number> {
    const found = await this.docker.listContainers({
      all: true,
      filters: { label: [SANDBOX_LABEL] },
    });
    await Promise.all(
      found.map((c) =>
        this.docker
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => {}),
      ),
    );
    return found.length;
  }

  /** Stops (removes) sandboxes idle longer than their idle time. A removed sandbox loses its disk. */
  async sweep(now = Date.now()) {
    for (const entry of [...this.live.values()]) {
      if (entry.inflight > 0 || now - entry.lastUsed < entry.idleMs) continue;
      this.live.delete(entry.id);
      await entry.container.remove({ force: true }).catch(() => {});
      log("sandbox.slept", { id: entry.id });
    }
  }

  /** Create-or-get. Throws `ContainerUnavailableError` when `SANDBOX_MAX` sandboxes are live. */
  async ensure(id: string, idleMs?: number): Promise<Entry> {
    if (!validSandboxId(id)) throw new SandboxError(400, "invalid sandbox id");
    const entry = this.live.get(id);
    if (entry) {
      entry.lastUsed = Date.now();
      if (idleMs !== undefined) entry.idleMs = idleMs;
      return entry;
    }
    const pending = this.starting.get(id);
    if (pending) return pending;
    if (this.liveCount >= this.cfg.maxLive) {
      throw new SandboxError(
        503,
        `maximum number of running container instances (${this.cfg.maxLive}) reached`,
        "ContainerUnavailableError",
      );
    }
    const start = this.create(id, idleMs ?? this.cfg.idleMs).finally(() =>
      this.starting.delete(id),
    );
    this.starting.set(id, start);
    return start;
  }

  private async create(id: string, idleMs: number): Promise<Entry> {
    // A container left by a failed start or a sweep in progress holds the name.
    await this.docker
      .getContainer(containerName(id))
      .remove({ force: true })
      .catch(() => {});
    const container = await this.docker.createContainer(containerSpec(this.cfg, id));
    try {
      await container.start();
      const info = await container.inspect();
      const ip = info.NetworkSettings.Networks[this.cfg.network]?.IPAddress;
      if (!ip) throw new Error(`sandbox has no address on ${this.cfg.network}`);
      const entry: Entry = {
        id,
        container,
        ip,
        idleMs,
        lastUsed: Date.now(),
        inflight: 0,
        env: {},
      };
      this.live.set(id, entry);
      log("sandbox.started", { id });
      return entry;
    } catch (error) {
      await container.remove({ force: true }).catch(() => {});
      throw error;
    }
  }

  /** Runs `fn` on a live sandbox. A container that vanished is recreated once. */
  async use<T>(id: string, fn: (entry: Entry) => Promise<T>, idleMs?: number): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const entry = await this.ensure(id, idleMs);
      entry.inflight++;
      try {
        return await fn(entry);
      } catch (error) {
        const status = statusOf(error);
        if (attempt === 0 && (status === 404 || status === 409)) {
          this.live.delete(id);
          await entry.container.remove({ force: true }).catch(() => {});
          continue;
        }
        throw error;
      } finally {
        entry.inflight--;
        entry.lastUsed = Date.now();
      }
    }
  }

  async destroy(id: string) {
    if (!validSandboxId(id)) throw new SandboxError(400, "invalid sandbox id");
    const entry = this.live.get(id);
    this.live.delete(id);
    await (entry?.container ?? this.docker.getContainer(containerName(id)))
      .remove({ force: true })
      .catch((error) => {
        if (statusOf(error) !== 404) throw error;
      });
    log("sandbox.destroyed", { id });
  }

  setEnv(entry: Entry, env: unknown) {
    for (const item of envList(env)) {
      const at = item.indexOf("=");
      entry.env[item.slice(0, at)] = item.slice(at + 1);
    }
  }

  /** One `docker exec` as root in the container, with buffered, capped output. */
  private async run(
    entry: Entry,
    cmd: string[],
    opts: { cwd?: string; env?: string[]; timeoutMs?: number } = {},
  ): Promise<RawRun> {
    const timeoutMs = Math.min(opts.timeoutMs ?? this.cfg.execMaxMs, this.cfg.execMaxMs);
    const started = Date.now();
    const exec = await entry.container.exec({
      Cmd: ["timeout", "-s", "KILL", `${Math.max(1, timeoutMs) / 1000}s`, ...cmd],
      AttachStdout: true,
      AttachStderr: true,
      User: "0:0",
      WorkingDir: opts.cwd ?? "/workspace",
      Env: [...envList(entry.env), ...(opts.env ?? [])],
    });
    const stream = await exec.start({ hijack: false, stdin: false });
    const out = capture(this.cfg.outputMaxBytes);
    const err = capture(this.cfg.outputMaxBytes);
    entry.container.modem.demuxStream(stream, out.sink, err.sink);
    await new Promise<void>((resolve, reject) => {
      const guard = setTimeout(() => {
        stream.destroy();
        resolve();
      }, timeoutMs + 10_000);
      stream.on("end", () => {
        clearTimeout(guard);
        resolve();
      });
      stream.on("close", () => {
        clearTimeout(guard);
        resolve();
      });
      stream.on("error", (e) => {
        clearTimeout(guard);
        reject(e);
      });
    });
    // The demux sinks emit on a later tick.
    await new Promise((resolve) => setImmediate(resolve));
    const duration = Date.now() - started;
    const info = await exec.inspect();
    if (info.Running || (info.ExitCode === 137 && duration >= timeoutMs)) {
      throw new SandboxError(504, `Command timed out after ${timeoutMs}ms`, "CommandTimeoutError");
    }
    return {
      exitCode: info.ExitCode ?? -1,
      stdout: out.bytes(),
      stderr: err.bytes(),
      duration,
    };
  }

  async exec(
    entry: Entry,
    input: { command: string; cwd?: string; env?: unknown; timeout?: number },
  ): Promise<ExecResult> {
    const timestamp = new Date().toISOString();
    const r = await this.run(entry, ["bash", "-c", input.command], {
      ...(input.cwd ? { cwd: input.cwd } : {}),
      env: envList(input.env),
      ...(input.timeout ? { timeoutMs: input.timeout } : {}),
    });
    return {
      success: r.exitCode === 0,
      exitCode: r.exitCode,
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      command: input.command,
      duration: r.duration,
      timestamp,
    };
  }

  async readFile(entry: Entry, path: string) {
    checkPath(path);
    const r = await this.run(entry, [
      "sh",
      "-c",
      's=$(stat -c %s -- "$1" 2>/dev/null) || exit 3; [ -f "$1" ] || exit 5; [ "$s" -le "$2" ] || exit 4; base64 -w0 -- "$1"',
      "sh",
      path,
      String(this.cfg.fileMaxBytes),
    ]);
    if (r.exitCode === 3)
      throw new SandboxError(404, `File not found: ${path}`, "FileNotFoundError");
    if (r.exitCode === 5) throw new SandboxError(400, `Not a file: ${path}`);
    if (r.exitCode === 4) throw new SandboxError(413, `File too large: ${path}`);
    if (r.exitCode !== 0) throw new SandboxError(500, `readFile failed: ${r.stderr.toString()}`);
    const bytes = Buffer.from(r.stdout.toString("ascii"), "base64");
    let text: string | null = null;
    if (!bytes.includes(0)) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
    }
    return {
      success: true,
      path,
      content: text ?? bytes.toString("base64"),
      encoding: text === null ? ("base64" as const) : ("utf-8" as const),
      isBinary: text === null,
      size: bytes.length,
      timestamp: new Date().toISOString(),
      exitCode: 0,
    };
  }

  async writeFile(entry: Entry, path: string, content: string, encoding?: string) {
    checkPath(path);
    const bytes =
      encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf8");
    if (bytes.length > this.cfg.fileMaxBytes) throw new SandboxError(413, "content too large");
    const tmp = `${path}.sbx-${crypto.randomUUID().slice(0, 8)}.tmp`;
    for (let at = 0; at === 0 || at < bytes.length; at += WRITE_CHUNK) {
      const chunk = bytes.subarray(at, at + WRITE_CHUNK).toString("base64");
      const op = at === 0 ? ">" : ">>";
      const r = await this.run(entry, [
        "sh",
        "-c",
        `printf %s "$2" | base64 -d ${op} "$1"`,
        "sh",
        tmp,
        chunk,
      ]);
      if (r.exitCode !== 0) {
        await this.run(entry, ["rm", "-f", "--", tmp]).catch(() => {});
        throw new SandboxError(500, `writeFile failed: ${r.stderr.toString().slice(0, 300)}`);
      }
    }
    const r = await this.run(entry, ["mv", "-f", "--", tmp, path]);
    if (r.exitCode !== 0) {
      throw new SandboxError(500, `writeFile failed: ${r.stderr.toString().slice(0, 300)}`);
    }
    return { success: true, path, timestamp: new Date().toISOString(), exitCode: 0 };
  }

  /** Starts a detached process group. Its output goes to files under /tmp/.sbx-proc. */
  async startProcess(
    entry: Entry,
    input: { command: string; cwd?: string; env?: unknown; processId?: string },
  ) {
    const id = input.processId ?? `proc-${crypto.randomUUID().slice(0, 12)}`;
    const file = procFile(id);
    const script = [
      `mkdir -p ${PROC_DIR} && chmod 700 ${PROC_DIR}`,
      'rm -f "$1.pid" "$1.exit"',
      // setsid: the wrapper leads its own process group, so a kill reaches every child.
      `setsid bash -c 'echo $$ > "$0.pid"; cd "$1" || exit 1; bash -c "$2" > "$0.out" 2> "$0.err" < /dev/null; echo $? > "$0.exit"' "$1" "$2" "$3" > /dev/null 2>&1 < /dev/null &`,
      'for i in $(seq 1 100); do [ -s "$1.pid" ] && break; sleep 0.02; done',
      'cat "$1.pid"',
    ].join("\n");
    const r = await this.run(
      entry,
      ["bash", "-c", script, "bash", file, input.cwd ?? "/workspace", input.command],
      { env: envList(input.env) },
    );
    const pid = Number(r.stdout.toString().trim());
    if (r.exitCode !== 0 || !Number.isInteger(pid) || pid <= 0) {
      throw new SandboxError(500, `startProcess failed: ${r.stderr.toString().slice(0, 300)}`);
    }
    return {
      id,
      pid,
      command: input.command,
      status: "running",
      startTime: new Date().toISOString(),
    };
  }

  async processStatus(entry: Entry, processId: string) {
    const file = procFile(processId);
    const r = await this.run(entry, [
      "sh",
      "-c",
      '[ -f "$1.pid" ] || exit 3; if kill -0 "$(cat "$1.pid")" 2>/dev/null; then echo running; elif [ -f "$1.exit" ]; then echo "completed $(cat "$1.exit")"; else echo killed; fi',
      "sh",
      file,
    ]);
    if (r.exitCode === 3) throw new SandboxError(404, `Process not found: ${processId}`);
    const [status = "error", code] = r.stdout.toString().trim().split(" ");
    const exitCode = code === undefined ? undefined : Number(code);
    return {
      id: processId,
      status: status === "completed" && exitCode !== 0 ? "failed" : status,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
  }

  async processLogs(entry: Entry, processId: string) {
    const file = procFile(processId);
    const r = await this.run(entry, [
      "sh",
      "-c",
      '[ -f "$1.out" ] || exit 3; cat "$1.out"; cat "$1.err" >&2',
      "sh",
      file,
    ]);
    if (r.exitCode === 3) throw new SandboxError(404, `Process not found: ${processId}`);
    return {
      success: true,
      processId,
      stdout: r.stdout.toString("utf8"),
      stderr: r.stderr.toString("utf8"),
      timestamp: new Date().toISOString(),
    };
  }

  /** TERM to the process group, KILL after two seconds. Throws when the ID is unknown. */
  async killProcess(entry: Entry, processId: string) {
    const file = procFile(processId);
    const r = await this.run(entry, [
      "bash",
      "-c",
      '[ -f "$1.pid" ] || exit 3; p=$(cat "$1.pid"); kill -TERM -- "-$p" 2>/dev/null; for i in $(seq 1 10); do kill -0 -- "-$p" 2>/dev/null || break; sleep 0.2; done; kill -KILL -- "-$p" 2>/dev/null; rm -f "$1.pid"',
      "bash",
      file,
    ]);
    if (r.exitCode === 3) throw new SandboxError(404, `Process not found: ${processId}`);
    return { success: true, processId, timestamp: new Date().toISOString() };
  }

  /** Proxies one HTTP request to `port` on the sandbox's address. */
  async fetchPort(entry: Entry, port: number, pathAndQuery: string, req: Request) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new SandboxError(400, "invalid port");
    }
    const headers = new Headers(req.headers);
    for (const h of HOP_HEADERS) headers.delete(h);
    headers.set("host", `localhost:${port}`);
    const body =
      req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const upstream = await fetch(`http://${entry.ip}:${port}${pathAndQuery}`, {
      method: req.method,
      headers,
      ...(body ? { body } : {}),
      redirect: "manual",
    });
    const out = new Headers(upstream.headers);
    // fetch decodes the body; the decoded body has another length and no encoding.
    out.delete("content-encoding");
    out.delete("content-length");
    for (const h of HOP_HEADERS) out.delete(h);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  }
}

const HOP_HEADERS = [
  "authorization",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-sandbox-sleep-after",
];

function checkPath(path: unknown): asserts path is string {
  if (typeof path !== "string" || path === "" || path.includes("\0") || path.length > 4096) {
    throw new SandboxError(400, "invalid path");
  }
}

/** A stream sink that keeps the first `max` bytes. */
function capture(max: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  const sink = new PassThrough();
  sink.on("data", (chunk: Buffer) => {
    if (size >= max) return;
    const part = chunk.subarray(0, max - size);
    chunks.push(part);
    size += part.length;
  });
  return { sink, bytes: () => Buffer.concat(chunks) };
}

export function log(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...fields })}\n`);
}
