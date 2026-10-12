// Secrets and Terraform-only vars are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/api/.dev.vars. Remote: Terraform secret_text or plain_text binding.
// PLATFORM_ADMIN_USER_IDS (ADR 0033) is a wrangler.jsonc var, so `wrangler types` declares it.
interface Env {
  CLERK_SECRET_KEY: string;
  /** Sandbox seconds per calendar month on this environment's meter (ADR 0017). Default 36000. */
  SANDBOX_MONTHLY_SECONDS?: string;
  /** Browser Run seconds per UTC day on this environment's meter (ADR 0017). Default 500. */
  BROWSER_DAILY_SECONDS?: string;
  /** This environment's Anthropic budget in USD per calendar month (ADR 0021). Default 10. */
  ANTHROPIC_MONTHLY_BUDGET_USD?: string;
  /** Live apps zone (ADR 0020), for example `rhumbatron.com`. Prod only, while app routing is on. */
  APPS_DOMAIN?: string;
}
