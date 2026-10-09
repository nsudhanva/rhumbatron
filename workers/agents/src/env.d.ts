// Secrets and Terraform-only vars are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/agents/.dev.vars. Remote: Terraform secret_text or plain_text binding.
interface Env {
  /** OpenRouter key for free models through the AI Gateway (ADR 0007). */
  OPENROUTER_API_KEY: string;
  /** Base64 Vertex AI service account JSON: Gemini overflow through the gateway (ADR 0016). */
  VERTEX_SERVICE_ACCOUNT?: string;
  /** `vertex` routes every model call to Gemini (ADR 0016); anything else keeps OpenRouter first. */
  MODEL_PROVIDER?: string;
  /** This environment's AI Gateway Vertex cap in USD per 30 days, for budget-stop text (ADR 0017). */
  VERTEX_SPEND_LIMIT_USD?: string;
  /** Sandbox seconds per calendar month on this environment's meter (ADR 0017). Default 36000. */
  SANDBOX_MONTHLY_SECONDS?: string;
}
