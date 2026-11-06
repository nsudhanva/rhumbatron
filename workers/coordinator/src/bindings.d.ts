// Bindings of this service. services/core/src/main.ts builds them (services/apps for apps).
interface __BaseEnv_Env {
  ENVIRONMENT: "local";
  SERVICE_NAME: "rhumbatron-coordinator";
  PROJECT_ROOT: DurableObjectNamespace<import("./index").ProjectRootDO>;
  RESOURCE_SHARD: DurableObjectNamespace<import("./index").ResourceShardDO>;
  PROJECT_VIEW: DurableObjectNamespace<import("./index").ProjectViewDO>;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
    durableNamespaces: "ProjectRootDO" | "ResourceShardDO" | "ProjectViewDO";
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
