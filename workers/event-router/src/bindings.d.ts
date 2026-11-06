// Bindings of this service. services/core/src/main.ts builds them (services/apps for apps).
interface __BaseEnv_Env {
  EVIDENCE: R2Bucket;
  DB: D1Database;
  EVENT_METRICS: AnalyticsEngineDataset;
  AGENT_WAKEUPS: Queue;
  INTEGRATION_COMMANDS: Queue;
  INDEXING: Queue;
  AI: Ai;
  ENVIRONMENT: "local";
  SERVICE_NAME: "rhumbatron-event-router";
  PROJECT_VIEW: DurableObjectNamespace /* ProjectViewDO from rhumbatron-coordinator */;
  RESOURCE_SHARD: DurableObjectNamespace /* ResourceShardDO from rhumbatron-coordinator */;
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
