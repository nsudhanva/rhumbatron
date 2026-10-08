output "evidence_bucket_name" {
  description = "R2 bucket for Evidence and the event archive."
  value       = cloudflare_r2_bucket.evidence.name
}

output "d1_database_id" {
  description = "D1 control database ID."
  value       = cloudflare_d1_database.control.id
}

output "d1_database_name" {
  description = "D1 control database name."
  value       = cloudflare_d1_database.control.name
}

output "kv_namespace_id" {
  description = "KV config namespace ID."
  value       = cloudflare_workers_kv_namespace.config.id
}

output "bindings" {
  description = "Worker bindings for these resources. Names match every wrangler.jsonc."
  value = {
    DB       = { type = "d1", name = "DB", id = cloudflare_d1_database.control.id }
    CONFIG   = { type = "kv_namespace", name = "CONFIG", namespace_id = cloudflare_workers_kv_namespace.config.id }
    EVIDENCE = { type = "r2_bucket", name = "EVIDENCE", bucket_name = cloudflare_r2_bucket.evidence.name }
  }
}
