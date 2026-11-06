/**
 * Entry module of the apps Worker on self-hosted workerd (services/apps). It wires the platform:
 *
 *
 * - `DB` (D1) and `EVIDENCE` (R2) become HTTP shims to the core service through the `CORE`
 *   external-service binding (services/apps/CONTRACT.md). workerd has neither product.
 * - `RpcGateway` serves `POST /rpc/<Entrypoint>/<method>` on the internal listener, so the core
 *   service can call AppBuilder, AppChecker, and AppData without a service binding.
 *
 * Each entrypoint class is subclassed only to hand the base class the shimmed env. ctx.exports
 * resolves to these subclasses, so loopback calls (router to AppAssets, AppBuilder to AppChecker)
 * keep the shims.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import { AppAssets as BaseAppAssets } from "../assets.ts";
import { AppBuilder as BaseAppBuilder } from "../builder.ts";
import { AppChecker as BaseAppChecker } from "../checker.ts";
import { AppData as BaseAppData } from "../data.ts";
import { routeAppRequest } from "../router.ts";
import { HttpD1 } from "./d1.ts";
import { HttpR2 } from "./r2.ts";
import { handleRpc } from "./rpc.ts";

export { AppDataDO } from "../data.ts";

type WorkerdEnv = Omit<Env, "DB" | "EVIDENCE"> & {
  /** External service `core:8790`. */
  CORE: Fetcher;
  /** Bearer token for core calls and for RPC callers. From the container environment. */
  INTERNAL_TOKEN: string | null;
};

const shimmed = new WeakMap<object, Env>();

function platformEnv(raw: unknown): Env {
  const env = raw as WorkerdEnv;
  const hit = shimmed.get(env);
  if (hit) return hit;
  const link = { core: env.CORE, token: env.INTERNAL_TOKEN ?? "" };
  const out = {
    ...env,
    DB: new HttpD1(link) as unknown as D1Database,
    EVIDENCE: new HttpR2(link) as unknown as R2Bucket,
  } as Env;
  shimmed.set(env, out);
  return out;
}

export class AppAssets extends BaseAppAssets {
  constructor(ctx: ExecutionContext<{ bundleKey: string }>, env: Env) {
    super(ctx, platformEnv(env));
  }
}

export class AppBuilder extends BaseAppBuilder {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, platformEnv(env));
  }
}

export class AppChecker extends BaseAppChecker {
  constructor(ctx: ExecutionContext, env: Env) {
    super(ctx, platformEnv(env));
  }
}

export class AppData extends BaseAppData {
  constructor(ctx: ExecutionContext<{ storeName: string }>, env: Env) {
    super(ctx, platformEnv(env));
  }
}

/** Internal listener (port 8789). Caddy never routes to it. */
export class RpcGateway extends WorkerEntrypoint<WorkerdEnv> {
  override fetch(request: Request): Promise<Response> {
    return handleRpc(
      request,
      this.env.INTERNAL_TOKEN,
      this.ctx.exports as unknown as Parameters<typeof handleRpc>[2],
    );
  }
}

export default {
  fetch(request, env, ctx) {
    return routeAppRequest(request, platformEnv(env), ctx);
  },
} satisfies ExportedHandler<Env>;
