output "state_bucket_name" {
  description = "Name of the Terraform state bucket."
  value       = cloudflare_r2_bucket.terraform_state.name
}

output "state_backend_endpoint" {
  description = "R2 S3-compatible endpoint for the Terraform backend."
  value       = "https://${var.account_id}.r2.cloudflarestorage.com"
}
