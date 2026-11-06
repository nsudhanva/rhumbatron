// Secrets and settings from the environment. services/core/src/config.ts reads them (compose.yaml).
interface Env {
  /** Anthropic API key (organization-level) for Claude through the AI Gateway (ADR 0021). */
  ANTHROPIC_API_KEY: string;
  /** Sent as `anthropic-workspace-id` on every Anthropic request. Not a secret. */
  ANTHROPIC_WORKSPACE_ID: string;
  /** Anthropic API base URL. Default https://api.anthropic.com. */
  ANTHROPIC_BASE_URL?: string;
  /** This environment's Anthropic budget in USD per calendar month (ADR 0021). Default 10. */
  ANTHROPIC_MONTHLY_BUDGET_USD?: string;
  /** "true" enables Opus; otherwise the opus tier runs on Sonnet (ADR 0021). */
  ALLOW_OPUS?: string;
  /** Sandbox seconds per calendar month on the usage meter. Compose sets 72000; the fallback is 36000. */
  SANDBOX_MONTHLY_SECONDS?: string;
}
