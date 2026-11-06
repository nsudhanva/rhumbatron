// Secrets and settings from the environment. services/core/src/config.ts reads them (compose.yaml).
interface Env {
  CLERK_SECRET_KEY: string;
  /** Sandbox seconds per calendar month on this environment's meter (ADR 0017). Default 36000. */
  SANDBOX_MONTHLY_SECONDS?: string;
  /** Browser Run seconds per UTC day on this environment's meter (ADR 0017). Default 500. */
  BROWSER_DAILY_SECONDS?: string;
  /** This environment's Anthropic budget in USD per calendar month (ADR 0021). Default 10. */
  ANTHROPIC_MONTHLY_BUDGET_USD?: string;
  /** Live apps domain (ADR 0020), for example `rhumbatron.localhost`. */
  APPS_DOMAIN?: string;
}
