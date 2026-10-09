// Secrets are not in wrangler.jsonc, so `wrangler types` cannot see them.
// Local: workers/integration/.dev.vars. Remote: Terraform secret_text binding.
interface Env {
  OPENROUTER_API_KEY: string;
  /** Base64 service account JSON with `region`. Optional: without it there is no Vertex backup. */
  VERTEX_SERVICE_ACCOUNT?: string;
  /** `vertex` routes every model call to Gemini (ADR 0016); anything else keeps OpenRouter first. */
  MODEL_PROVIDER?: string;
}
