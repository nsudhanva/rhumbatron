/**
 * The sandboxd client. It has no dependencies (fetch only) and matches the subset of
 * `@cloudflare/sandbox` that Rhumbatron uses, so the `@cloudflare/sandbox` import can resolve
 * to this module. `binding` is `{ baseUrl, token }`.
 */

export type SandboxBinding = { baseUrl: string; token: string };

export type SandboxOptions = {
  /** Idle time before the sandbox stops: "30s", "2m", "1h", or seconds. Capped by sandboxd. */
  sleepAfter?: string | number;
  /** Accepted for compatibility. sandboxd always stops an idle sandbox. */
  keepAlive?: boolean;
};

export type ExecOptions = {
  timeout?: number;
  env?: Record<string, string | undefined>;
  cwd?: string;
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

export type ReadFileResult = {
  success: boolean;
  path: string;
  content: string;
  timestamp: string;
  exitCode?: number;
  encoding?: "utf-8" | "base64";
  isBinary?: boolean;
  size?: number;
};

export type WriteFileResult = {
  success: boolean;
  path: string;
  timestamp: string;
  exitCode?: number;
};

export type ProcessOptions = ExecOptions & { processId?: string };

export type ProcessStatus = "starting" | "running" | "completed" | "failed" | "killed" | "error";

export type ProcessLogsResult = {
  success: boolean;
  processId: string;
  stdout: string;
  stderr: string;
  timestamp: string;
};

export type WaitForPortOptions = {
  mode?: "http" | "tcp";
  path?: string;
  status?: number | { min: number; max: number };
  timeout?: number;
  interval?: number;
};

export type Process = {
  readonly id: string;
  readonly pid?: number;
  readonly command: string;
  readonly status: ProcessStatus;
  readonly startTime: Date;
  kill(signal?: string): Promise<void>;
  getStatus(): Promise<ProcessStatus>;
  getLogs(): Promise<{ stdout: string; stderr: string }>;
  waitForPort(port: number, options?: WaitForPortOptions): Promise<void>;
};

const SANDBOXD_ERROR = "x-sandboxd-error";

function isBinding(value: unknown): value is SandboxBinding {
  const b = value as Partial<SandboxBinding> | null;
  return typeof b?.baseUrl === "string" && typeof b?.token === "string";
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class Sandbox {
  readonly id: string;
  private readonly base: string;
  private readonly token: string;
  private readonly sleepAfter: string | undefined;

  constructor(binding: SandboxBinding, id: string, options: SandboxOptions = {}) {
    this.id = id;
    this.base = `${binding.baseUrl.replace(/\/+$/, "")}/v1/sandboxes/${encodeURIComponent(id)}`;
    this.token = binding.token;
    this.sleepAfter = options.sleepAfter === undefined ? undefined : String(options.sleepAfter);
  }

  private headers(extra?: ConstructorParameters<typeof Headers>[0]) {
    const h = new Headers(extra);
    h.set("authorization", `Bearer ${this.token}`);
    if (this.sleepAfter) h.set("x-sandbox-sleep-after", this.sleepAfter);
    return h;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers(
        body === undefined ? undefined : { "content-type": "application/json" },
      ),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { error: text };
    }
    if (!res.ok) {
      const e = (data ?? {}) as { error?: string; name?: string };
      const error = new Error(e.error ?? `sandboxd ${res.status}`);
      error.name = e.name ?? "SandboxError";
      throw error;
    }
    return data as T;
  }

  /** Runs a shell command (bash -c) as root in the sandbox. Default cwd: /workspace. */
  exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    return this.call("POST", "/exec", { command, ...options });
  }

  readFile(path: string, _options?: { encoding?: string }): Promise<ReadFileResult> {
    return this.call("POST", "/files/read", { path });
  }

  writeFile(
    path: string,
    content: string,
    options: { encoding?: string } = {},
  ): Promise<WriteFileResult> {
    return this.call("POST", "/files/write", { path, content, encoding: options.encoding });
  }

  async startProcess(command: string, options: ProcessOptions = {}): Promise<Process> {
    const started = await this.call<{ id: string; pid: number; startTime: string }>(
      "POST",
      "/processes",
      { command, ...options },
    );
    const id = started.id;
    return {
      id,
      pid: started.pid,
      command,
      status: "running",
      startTime: new Date(started.startTime),
      kill: async () => {
        await this.killProcess(id);
      },
      getStatus: () => this.processStatus(id),
      getLogs: () => this.getProcessLogs(id),
      waitForPort: (port, opts) => this.waitForPort(id, port, opts),
    };
  }

  async killProcess(processId: string, _signal?: string): Promise<void> {
    await this.call("DELETE", `/processes/${encodeURIComponent(processId)}`);
  }

  getProcessLogs(processId: string): Promise<ProcessLogsResult> {
    return this.call("GET", `/processes/${encodeURIComponent(processId)}/logs`);
  }

  private async processStatus(processId: string): Promise<ProcessStatus> {
    const r = await this.call<{ status: ProcessStatus }>(
      "GET",
      `/processes/${encodeURIComponent(processId)}`,
    );
    return r.status;
  }

  /** Polls the port over HTTP until it answers in the status range, the process ends, or timeout. */
  private async waitForPort(processId: string, port: number, opts: WaitForPortOptions = {}) {
    const deadline = Date.now() + (opts.timeout ?? Number.POSITIVE_INFINITY);
    const interval = opts.interval ?? 500;
    const range =
      typeof opts.status === "number"
        ? { min: opts.status, max: opts.status }
        : (opts.status ?? { min: 200, max: 399 });
    for (;;) {
      const status = await this.processStatus(processId);
      if (status !== "running") {
        const error = new Error(`process ${processId} exited (${status}) before port ${port}`);
        error.name = "ProcessExitedBeforeReadyError";
        throw error;
      }
      const res = await this.containerFetch(`http://localhost:${port}${opts.path ?? "/"}`, {}, port)
        .then((r) => {
          void r.body?.cancel();
          return r;
        })
        .catch(() => null);
      if (res && !res.headers.has(SANDBOXD_ERROR)) {
        if (opts.mode === "tcp" || (res.status >= range.min && res.status <= range.max)) return;
      }
      if (Date.now() + interval > deadline) {
        const error = new Error(`port ${port} not ready after ${opts.timeout}ms`);
        error.name = "ProcessReadyTimeoutError";
        throw error;
      }
      await sleep(interval);
    }
  }

  /**
   * Sends one HTTP request to `port` inside the sandbox. Accepts the SDK's signatures:
   * (request, port?), (url, init?, port?), (url, port?).
   */
  async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number,
  ): Promise<Response> {
    const init = typeof portOrInit === "object" ? portOrInit : undefined;
    const request =
      requestOrUrl instanceof Request ? requestOrUrl : new Request(String(requestOrUrl), init);
    const url = new URL(request.url);
    const port =
      portParam ?? (typeof portOrInit === "number" ? portOrInit : Number(url.port || 3000));
    const headers = this.headers(request.headers);
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    return fetch(`${this.base}/ports/${port}/fetch${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(hasBody ? { body: await request.arrayBuffer() } : {}),
      redirect: "manual",
    });
  }

  /** Environment variables for later commands and processes of this sandbox. */
  async setEnvVars(envVars: Record<string, string | undefined>): Promise<void> {
    await this.call("PUT", "/env", { envVars });
  }

  /** Removes the container and its disk. The next call starts a fresh sandbox. */
  async destroy(): Promise<void> {
    await this.call("DELETE", "");
  }
}

/** The client for sandbox `id`. `binding` must be `{ baseUrl, token }`. */
export function getSandbox(binding: unknown, id: string, options?: SandboxOptions): Sandbox {
  if (!isBinding(binding)) throw new Error("getSandbox: binding must be { baseUrl, token }");
  return new Sandbox(binding, id, options);
}
