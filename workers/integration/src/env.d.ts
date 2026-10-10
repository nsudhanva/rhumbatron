// Secrets and Terraform-only vars are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/integration/.dev.vars. Remote: Terraform secret_text or plain_text binding.
interface Env {
  /** Anthropic API key (organization-level) for the Root Planner through the AI Gateway (ADR 0021). */
  ANTHROPIC_API_KEY: string;
  /** Sent as `anthropic-workspace-id` on every Anthropic request. Not a secret. */
  ANTHROPIC_WORKSPACE_ID: string;
  /** This environment's Anthropic budget in USD per calendar month (ADR 0021). Default 10. */
  ANTHROPIC_MONTHLY_BUDGET_USD?: string;
  /** "true" enables Opus; otherwise the opus tier runs on Sonnet (ADR 0021). */
  ALLOW_OPUS?: string;
  /** Sandbox seconds per calendar month on this environment's meter (ADR 0017). Default 36000. */
  SANDBOX_MONTHLY_SECONDS?: string;
  /** Browser Run seconds per UTC day on this environment's meter (ADR 0017). Default 500. */
  BROWSER_DAILY_SECONDS?: string;
  /**
   * User-scoped API token for the release path (ADR 0018): Workers Builds Configuration Edit and
   * Workers Scripts Read, used for GET requests only. Never logged. Without it a release fails.
   */
  BUILDS_API_TOKEN?: string;
  /** Account of the release Workers (the Builds API path). */
  BUILDS_ACCOUNT_ID?: string;
  /**
   * Live apps bundle builder (ADR 0020): service binding to the apps Worker's `AppBuilder`
   * entrypoint. Prod only; absent on dev, where `app.provision` is a no-op.
   */
  APPS?: {
    build(
      input: import("@rhumbatron/protocol").AppBuildInput,
    ): Promise<import("@rhumbatron/protocol").AppBuildResult>;
    /** One GET through the apps router for an app host, fresh pointer read (release smoke). */
    probe(
      input: import("@rhumbatron/protocol").AppProbeInput,
    ): Promise<import("@rhumbatron/protocol").AppProbeResult>;
    /** Deletes app data stores (app removal, expired previews). */
    wipeData(storeNames: string[]): Promise<{ wiped: number }>;
    /** Dynamic Workers checker (docs/plans/checker-integration.md). */
    check(
      input: import("@rhumbatron/protocol").AppCheckInput,
    ): Promise<import("@rhumbatron/protocol").AppCheckResult>;
  };
}
