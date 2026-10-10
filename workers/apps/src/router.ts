import { parseAppHost } from "@rhumbatron/protocol";
import { serveAsset } from "./assets.ts";
import { decodeModules } from "./bundle.ts";
import { appRequestHeaders, appResponseHeaders } from "./cookies.ts";
import {
  buildingPage,
  emptyPage,
  errorPage,
  failedPage,
  limitPage,
  notFoundPage,
  removedPage,
} from "./pages.ts";
import { cachedDeployments, selectDeployment } from "./pointer.ts";
import { loadBundle } from "./store.ts";

/**
 * The apps router (P16-04, P16-05; ADR 0020). One Worker serves every app on
 * `<label>.rhumbatron.com` (prod only). Per request:
 *
 * 1. Host to app: `parseAppHost`. Reserved and malformed hosts get a plain 404.
 * 2. Pointer: D1 `app_deployments`, cached in the isolate for 10 s.
 * 3. Static assets first (as Workers static assets do), then the app as a Dynamic Worker with
 *    `LOADER.get("<project>@<commit>")`. The code comes from the R2 bundle on a cold load only.
 *
 * Security defaults: no network (`globalOutbound: null`), CPU and subrequest limits per request,
 * and no Rhumbatron binding. The app's env has only ASSETS and DATA, both router entrypoints whose
 * props the router sets. The router strips foreign cookies in and Domain cookies out (cookies.ts).
 */

/** Per-request limits for app code. A hit throws in the app; the router answers 503. */
const APP_LIMITS = { cpuMs: 50, subRequests: 20 } as const;

export async function routeAppRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  /** `fresh`: read the pointer from D1, not the isolate cache (release smoke probes). */
  options: { fresh?: boolean } = {},
): Promise<Response> {
  // Dev has no APPS_DOMAIN (and no route): nothing is served.
  const domain: string | undefined = env.APPS_DOMAIN;
  if (!domain) return notFoundPage();
  const host = parseAppHost(new URL(request.url).hostname, domain);
  if (host.kind !== "production" && host.kind !== "preview") return notFoundPage();

  const selection = selectDeployment(
    host,
    await cachedDeployments(env.DB, host, Date.now(), options.fresh === true),
  );
  if (selection.kind === "not_found") return notFoundPage();
  if (selection.kind === "removed") return removedPage();
  if (selection.kind === "building") return buildingPage();
  if (selection.kind === "empty") return emptyPage();
  if (selection.kind === "failed") return failedPage(selection.reason);

  const bundle = await loadBundle(env.EVIDENCE, selection.bundleKey);
  if (!bundle) return failedPage("the stored bundle is missing");

  const appRequest = new Request(request, { headers: appRequestHeaders(request.headers) });
  if (!bundle.assetConfig.runWorkerFirst) {
    const asset = await serveAsset(env.EVIDENCE, selection.bundleKey, bundle, appRequest);
    if (asset) return asset;
  }

  const worker = env.LOADER.get(selection.loaderId, () => ({
    compatibilityDate: bundle.compatibilityDate,
    compatibilityFlags: bundle.compatibilityFlags,
    mainModule: bundle.mainModule,
    modules: decodeModules(bundle.modules),
    globalOutbound: null,
    limits: APP_LIMITS,
    env: {
      ASSETS: ctx.exports.AppAssets({ props: { bundleKey: selection.bundleKey } }),
      DATA: ctx.exports.AppData({ props: { storeName: selection.storeName } }),
    },
  }));

  let response: Response;
  try {
    response = await worker.getEntrypoint(undefined, { limits: APP_LIMITS }).fetch(appRequest);
  } catch (error) {
    const message = String(error);
    console.warn(
      JSON.stringify({
        event: "app.error",
        app: selection.loaderId,
        message: message.slice(0, 200),
      }),
    );
    return /limit|exceeded/i.test(message) ? limitPage() : errorPage();
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: appResponseHeaders(response.headers),
  });
}
