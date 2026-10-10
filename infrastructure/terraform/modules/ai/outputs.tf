output "gateway_id" {
  description = "AI Gateway ID, used in https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic."
  value       = cloudflare_ai_gateway.this.id
}
