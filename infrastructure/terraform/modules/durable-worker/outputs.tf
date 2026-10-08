output "name" {
  description = "Worker name."
  value       = cloudflare_workers_script.this.script_name
}
