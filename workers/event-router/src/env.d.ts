// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/event-router/.dev.vars. Remote: Terraform secret_text binding.
interface Env {
  /** K2 token with the Consume permission only. */
  K2_CONSUMER_TOKEN: string;
}
