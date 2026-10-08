# Account-wide and zone-wide singletons. Exactly one state owns these, so dev and prod never
# fight over the shared rhumbatron.com zone.

module "dns" {
  source     = "../../modules/dns"
  account_id = var.account_id
  zone_name  = var.zone_name
}

# Safe, additive TLS settings only. SSL mode and the existing apex records stay untouched until
# Phase 2 moves the apex to the web Worker.
module "security" {
  source  = "../../modules/security"
  zone_id = module.dns.zone_id
  zone_settings = {
    always_use_https         = "on"
    automatic_https_rewrites = "on"
    min_tls_version          = "1.2"
    tls_1_3                  = "on"
  }
}
