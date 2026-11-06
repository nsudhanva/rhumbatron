# workerd config for the apps host (services/apps/README.md). Schema: workerd.capnp in
# cloudflare/workerd at the pinned version (v1.20261008.1).
#
#   8788  public:   app hosts *.rhumbatron.localhost (Caddy routes here)
#   8789  internal: POST /rpc/<Entrypoint>/<method> for the core service (not routed by Caddy)

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "apps", worker = .appsWorker),
    # D1 and R2 shims call the core service through this binding only.
    (name = "core", external = (address = "core:8790", http = ())),
    # Public Internet for the platform Worker: the bundle builder fetches npm packages.
    # "public" excludes private ranges, so global fetch cannot reach core or other containers.
    (name = "internet", network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))),
    (name = "do-storage", disk = (path = "/data/do", writable = true)),
  ],
  sockets = [
    (name = "public", address = "*:8788", http = (), service = "apps"),
    (name = "internal", address = "*:8789", http = (),
     service = (name = "apps", entrypoint = "RpcGateway")),
  ],
);

const appsWorker :Workerd.Worker = (
  modules = [
    (name = "worker.js", esModule = embed "dist/worker.js"),
    (name = "esbuild.wasm", wasm = embed "dist/esbuild.wasm"),
  ],
  # nodejs_compat (needed by @cloudflare/worker-bundler) is on by default from 2026-08-04.
  compatibilityDate = "2026-10-08",
  bindings = [
    (name = "APPS_DOMAIN", fromEnvironment = "APPS_DOMAIN"),
    (name = "ENVIRONMENT", fromEnvironment = "ENVIRONMENT"),
    (name = "SERVICE_NAME", text = "rhumbatron-apps"),
    (name = "INTERNAL_TOKEN", fromEnvironment = "INTERNAL_TOKEN"),
    (name = "CORE", service = "core"),
    (name = "LOADER", workerLoader = (id = "apps")),
    (name = "APP_DATA", durableObjectNamespace = "AppDataDO"),
  ],
  # Apps loaded through LOADER set `globalOutbound: null` (router.ts, checker.ts): no network.
  globalOutbound = "internet",
  durableObjectNamespaces = [
    (className = "AppDataDO", uniqueKey = "rhumbatron-apps-AppDataDO", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "do-storage"),
);
