/**
 * The `cloudflare:workers` module as this platform provides it. Application code and the Agents
 * SDK import their base classes from that specifier; `preload.ts` maps it here.
 * `env` and `exports` are the merged bindings and classes of every service in the process.
 */

export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}

export class RpcTarget {}

const registry: { env: Record<string, unknown>; exports: Record<string, unknown> } = {
  env: {},
  exports: {},
};

/** Called by the core composition root once every binding exists. */
export function setProcessBindings(
  env: Record<string, unknown>,
  exports: Record<string, unknown>,
): void {
  registry.env = env;
  registry.exports = exports;
}

export const env: Record<string, unknown> = new Proxy(
  {},
  { get: (_t, key) => registry.env[String(key)], has: (_t, key) => String(key) in registry.env },
);
export const exports: Record<string, unknown> = new Proxy(
  {},
  { get: (_t, key) => registry.exports[String(key)] },
);

export const tracing = {
  startActiveSpan<T>(_name: string, fn: (span: { setAttribute(): void; end(): void }) => T): T {
    return fn({ setAttribute() {}, end() {} });
  },
};

export function waitUntil(promise: Promise<unknown>): void {
  promise.catch((error) =>
    console.error(JSON.stringify({ level: "error", event: "waitUntil", error: String(error) })),
  );
}
