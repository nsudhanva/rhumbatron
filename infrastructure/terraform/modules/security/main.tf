resource "cloudflare_zone_setting" "this" {
  for_each = var.zone_settings

  zone_id    = var.zone_id
  setting_id = each.key
  value      = each.value
}

# WAF, rate limits, Access, and Turnstile are added only after the protected endpoint exists
# (AGENTS.md section 40.4).
