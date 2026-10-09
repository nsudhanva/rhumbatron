// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/agents/.dev.vars. Remote: Terraform secret_text binding.
interface Env {
  /** OpenRouter key for free models through the AI Gateway (ADR 0007). */
  OPENROUTER_API_KEY: string;
}
