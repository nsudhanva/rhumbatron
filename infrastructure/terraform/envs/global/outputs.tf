output "zone_id" {
  description = "rhumbatron.com zone ID."
  value       = module.dns.zone_id
}

output "zone_settings" {
  description = "Enforced zone settings."
  value       = module.security.zone_settings
}
