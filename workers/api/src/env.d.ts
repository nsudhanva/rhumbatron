// Secrets and settings from the environment. services/core/src/config.ts reads them (compose.yaml).
interface Env {
  CLERK_SECRET_KEY: string;
  /** Sandbox seconds per calendar month on the usage meter. Compose sets 72000; the fallback is 36000. */
  SANDBOX_MONTHLY_SECONDS?: string;
  /** Browser seconds per UTC day on the usage meter. Compose sets 3600; the fallback is 500. */
  BROWSER_DAILY_SECONDS?: string;
  /** This environment's Anthropic budget in USD per calendar month (ADR 0021). Default 10. */
  ANTHROPIC_MONTHLY_BUDGET_USD?: string;
  /** Live apps domain (ADR 0020), for example `rhumbatron.localhost`. */
  APPS_DOMAIN?: string;
}
