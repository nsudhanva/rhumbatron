// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/api/.dev.vars. Remote: Terraform secret_text binding.
interface Env {
  CLERK_SECRET_KEY: string;
}
