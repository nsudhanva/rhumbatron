// Bindings of this service. services/core/src/main.ts builds them (services/apps for apps).
interface __BaseEnv_Env {
  EVIDENCE: R2Bucket;
  DB: D1Database;
  MEMORY: VectorizeIndex;
  METRICS: AnalyticsEngineDataset;
  ARTIFACTS: Artifacts;
  AI: Ai;
  ENVIRONMENT: "local";
  SERVICE_NAME: "rhumbatron-indexer";
  PROJECT_ROOT: DurableObjectNamespace /* ProjectRootDO from rhumbatron-coordinator */;
}
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
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
