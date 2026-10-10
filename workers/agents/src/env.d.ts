// Secrets and Terraform-only vars are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/agents/.dev.vars. Remote: Terraform secret_text or plain_text binding.
interface Env {
  /** Anthropic API key (organization-level) for Claude through the AI Gateway (ADR 0021). */
  ANTHROPIC_API_KEY: string;
  /** Sent as `anthropic-workspace-id` on every Anthropic request. Not a secret. */
  ANTHROPIC_WORKSPACE_ID: string;
  /** This environment's Anthropic budget in USD per calendar month (ADR 0021). Default 10. */
  ANTHROPIC_MONTHLY_BUDGET_USD?: string;
  /** "anthropic", the only provider (ADR 0021). Informational: code does not branch on it. */
  MODEL_PROVIDER?: string;
  /** "true" enables Opus; otherwise the opus tier runs on Sonnet (ADR 0021). */
  ALLOW_OPUS?: string;
  /** Sandbox seconds per calendar month on this environment's meter (ADR 0017). Default 36000. */
  SANDBOX_MONTHLY_SECONDS?: string;
}
