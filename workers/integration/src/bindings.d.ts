// Bindings of this service. services/core/src/main.ts builds them (services/apps for apps).
interface __BaseEnv_Env {
  CONFIG: KVNamespace;
  EVIDENCE: R2Bucket;
  DB: D1Database;
  AGENT_WAKEUPS: Queue;
  VERIFICATION_COMMANDS: Queue;
  RELEASE_COMMANDS: Queue;
  ARTIFACTS: Artifacts;
  BROWSER: BrowserRun;
  AI: Ai;
  ENVIRONMENT: "local";
  SERVICE_NAME: "rhumbatron-integration";
  RESOURCE_SHARD: DurableObjectNamespace /* ResourceShardDO from rhumbatron-coordinator */;
  PROJECT_ROOT: DurableObjectNamespace /* ProjectRootDO from rhumbatron-coordinator */;
  PROJECT_VIEW: DurableObjectNamespace /* ProjectViewDO from rhumbatron-coordinator */;
  AGENT: DurableObjectNamespace /* AgentDO from rhumbatron-agents */;
  SANDBOX: DurableObjectNamespace /* Sandbox from rhumbatron-sandbox */;
  CHANGE_WORKFLOW: Workflow<Parameters<import("./index").ChangeWorkflow["run"]>[0]["payload"]>;
  CANDIDATE_WORKFLOW: Workflow<
    Parameters<import("./index").CandidateVerificationWorkflow["run"]>[0]["payload"]
  >;
  RELEASE_WORKFLOW: Workflow<Parameters<import("./index").ReleaseWorkflow["run"]>[0]["payload"]>;
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
