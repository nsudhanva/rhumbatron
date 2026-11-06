/** Core configuration, read once from the environment. Compose sets every value. */

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

const anthropicBaseUrl = optional("ANTHROPIC_BASE_URL", "https://api.anthropic.com");

export const config = {
  port: Number(optional("PORT", "8787")),
  internalPort: Number(optional("INTERNAL_PORT", "8790")),
  dataDir: optional("DATA_DIR", "/data"),
  natsUrl: optional("NATS_URL", "nats://nats:4222"),
  webOrigin: optional("WEB_ORIGIN", "https://rhumbatron.localhost"),
  internalToken: required("INTERNAL_TOKEN"),
  objects: {
    endpoint: optional("S3_ENDPOINT", "http://objects:7070"),
    accessKeyId: required("S3_ACCESS_KEY"),
    secretAccessKey: required("S3_SECRET_KEY"),
    bucket: optional("S3_BUCKET", "rhumbatron-evidence"),
  },
  models: {
    embedUrl: optional("EMBED_URL", "http://embed:8080"),
    rerankUrl: optional("RERANK_URL", "http://rerank:8080"),
    anthropicBaseUrl,
    anthropicApiKey: optional("ANTHROPIC_API_KEY", ""),
    anthropicWorkspaceId: optional("ANTHROPIC_WORKSPACE_ID", ""),
    decisionModel: optional("DECISION_MODEL", "claude-haiku-5-5"),
  },
  git: {
    baseUrl: optional("GIT_URL", "http://git:8080"),
    adminToken: required("GIT_ADMIN_TOKEN"),
    namespace: optional("GIT_NAMESPACE", "rhumbatron"),
  },
  sandbox: {
    baseUrl: optional("SANDBOXD_URL", "http://sandboxd:7070"),
    token: required("SANDBOXD_TOKEN"),
  },
  apps: { rpcUrl: optional("APPS_RPC_URL", "http://apps:8789"), token: required("INTERNAL_TOKEN") },
  browserWsUrl: optional("BROWSER_WS_URL", "ws://browser:3000/"),
  /** Plain bindings the application code reads. */
  vars: {
    CLERK_SECRET_KEY: required("CLERK_SECRET_KEY"),
    CLERK_AUTHORIZED_PARTIES: optional("CLERK_AUTHORIZED_PARTIES", "https://rhumbatron.localhost"),
    CLERK_ALLOW_MISSING_AZP: optional("CLERK_ALLOW_MISSING_AZP", "false"),
    PLATFORM_ADMIN_USER_IDS: optional("PLATFORM_ADMIN_USER_IDS", "[]"),
    APPS_DOMAIN: optional("APPS_DOMAIN", "rhumbatron.localhost"),
    ANTHROPIC_API_KEY: optional("ANTHROPIC_API_KEY", ""),
    ANTHROPIC_WORKSPACE_ID: optional("ANTHROPIC_WORKSPACE_ID", ""),
    ANTHROPIC_BASE_URL: anthropicBaseUrl,
    ANTHROPIC_MONTHLY_BUDGET_USD: optional("ANTHROPIC_MONTHLY_BUDGET_USD", "100"),
    ALLOW_OPUS: optional("ALLOW_OPUS", "false"),
    SANDBOX_MONTHLY_SECONDS: optional("SANDBOX_MONTHLY_SECONDS", "72000"),
    BROWSER_DAILY_SECONDS: optional("BROWSER_DAILY_SECONDS", "3600"),
  },
};
