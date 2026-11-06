// Bindings of this service. services/core/src/main.ts builds them (services/apps for apps).
interface __BaseEnv_Env {
  EVIDENCE: R2Bucket;
  DB: D1Database;
  LOADER: WorkerLoader;
  ENVIRONMENT: "local";
  SERVICE_NAME: "rhumbatron-apps";
  APPS_DOMAIN: "localhost";
  APP_DATA: DurableObjectNamespace<import("./platform/workerd").AppDataDO>;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./platform/workerd");
    durableNamespaces: "AppDataDO";
  }
  interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
declare module "*.txt" {
  const value: string;
  export default value;
}
declare module "*.html" {
  const value: string;
  export default value;
}
declare module "*.sql" {
  const value: string;
  export default value;
}
declare module "*.bin" {
  const value: ArrayBuffer;
  export default value;
}
declare module "*.wasm" {
  const value: WebAssembly.Module;
  export default value;
}
declare module "*.wasm?module" {
  const value: WebAssembly.Module;
  export default value;
}
