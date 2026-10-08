output "zone_settings" {
  description = "Enforced zone settings."
  value       = { for k, s in cloudflare_zone_setting.this : k => s.value }
}
