// Secrets and Terraform-only vars are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/integration/.dev.vars. Remote: Terraform secret_text or plain_text binding.
interface Env {
  OPENROUTER_API_KEY: string;
  /** Base64 service account JSON with `region`. Optional: without it there is no Vertex backup. */
  VERTEX_SERVICE_ACCOUNT?: string;
  /** `vertex` routes every model call to Gemini (ADR 0016); anything else keeps OpenRouter first. */
  MODEL_PROVIDER?: string;
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
}
