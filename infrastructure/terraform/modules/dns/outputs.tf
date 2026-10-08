output "zone_id" {
  description = "Zone ID."
  value       = data.cloudflare_zone.this.zone_id
}

output "zone_name" {
  description = "Zone name."
  value       = data.cloudflare_zone.this.name
}
