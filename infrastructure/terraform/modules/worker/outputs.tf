output "name" {
  description = "Worker name."
  value       = cloudflare_worker.this.name
}

output "worker_id" {
  description = "Worker ID."
  value       = cloudflare_worker.this.id
}

output "version_id" {
  description = "Deployed Worker version ID."
  value       = cloudflare_worker_version.this.id
}
