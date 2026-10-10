// Secrets and Terraform-only vars are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/api/.dev.vars. Remote: Terraform secret_text or plain_text binding.
interface Env {
  CLERK_SECRET_KEY: string;
  /** "true" serves the Wishlist fixture routes outside dev/local (ADR 0017). */
  FIXTURES_ENABLED?: string;
  /** Sandbox seconds per calendar month on this environment's meter (ADR 0017). Default 36000. */
  SANDBOX_MONTHLY_SECONDS?: string;
  /** This environment's AI Gateway Vertex cap in USD per 30 days (ADR 0017). Default 9. */
  VERTEX_SPEND_LIMIT_USD?: string;
  /** Live apps zone (ADR 0020), for example `rhumbatron.com`. Prod only, while app routing is on. */
  APPS_DOMAIN?: string;
}
