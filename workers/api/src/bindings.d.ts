// Bindings of this service. services/core/src/main.ts builds them (services/apps for apps).
interface __BaseEnv_Env {
  EVIDENCE: R2Bucket;
  DB: D1Database;
  INTEGRATION_COMMANDS: Queue;
  AGENT_WAKEUPS: Queue;
  ENVIRONMENT: "local";
  SERVICE_NAME: "rhumbatron-api";
  CLERK_AUTHORIZED_PARTIES: "http://localhost:5173";
  CLERK_ALLOW_MISSING_AZP: "true";
  PLATFORM_ADMIN_USER_IDS: "[]";
  PROJECT_ROOT: DurableObjectNamespace /* ProjectRootDO from rhumbatron-coordinator */;
  PROJECT_VIEW: DurableObjectNamespace /* ProjectViewDO from rhumbatron-coordinator */;
  AGENTS: Fetcher /* rhumbatron-agents */;
  INTEGRATION: Fetcher /* rhumbatron-integration */;
  CHANGE_WORKFLOW: Workflow /* ChangeWorkflow from rhumbatron-integration */;
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
