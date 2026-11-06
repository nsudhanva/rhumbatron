import type {
  AppBuildInput,
  AppBuildResult,
  AppCheckInput,
  AppCheckResult,
  AppProbeInput,
  AppProbeResult,
} from "../../packages/protocol/src/app.ts";

/**
 * Fetch-only client for the apps host's internal RPC listener (services/apps/CONTRACT.md). It has
 * the methods the integration Worker calls on `env.APPS`, so the core service can pass it as
 * `env.APPS`.
 *
 *   const APPS = createAppsClient({ url: "http://apps:8789", token: process.env.INTERNAL_TOKEN });
 */
export type AppsClient = {
  build(input: AppBuildInput): Promise<AppBuildResult>;
  probe(input: AppProbeInput): Promise<AppProbeResult>;
  wipeData(storeNames: string[]): Promise<{ wiped: number }>;
  check(input: AppCheckInput): Promise<AppCheckResult>;
};

export type AppsClientOptions = {
  /** Base URL of the internal listener. Default `http://apps:8789`. */
  url?: string;
  token: string;
  fetch?: typeof fetch;
};

export function createAppsClient(options: AppsClientOptions): AppsClient {
  const base = (options.url ?? "http://apps:8789").replace(/\/+$/, "");
  const send = options.fetch ?? fetch;
  async function call<T>(entrypoint: string, method: string, args: unknown[]): Promise<T> {
    const response = await send(`${base}/rpc/${entrypoint}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {}
      throw new Error(`apps ${entrypoint}.${method}: ${response.status} ${message.slice(0, 500)}`);
    }
    return JSON.parse(text) as T;
  }
  return {
    build: (input) => call("AppBuilder", "build", [input]),
    probe: (input) => call("AppBuilder", "probe", [input]),
    wipeData: (storeNames) => call("AppBuilder", "wipeData", [storeNames]),
    check: (input) => call("AppBuilder", "check", [input]),
  };
}
