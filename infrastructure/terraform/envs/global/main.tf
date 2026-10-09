# Account-wide and zone-wide singletons. Exactly one state owns these, so dev and prod never
# fight over the shared rhumbatron.com zone.

module "dns" {
  source     = "../../modules/dns"
  account_id = var.account_id
  zone_name  = var.zone_name
}

# TLS settings. Every hostname is a Worker custom domain (no origin servers), so SSL is strict.
module "security" {
  source  = "../../modules/security"
  zone_id = module.dns.zone_id
  zone_settings = {
    always_use_https         = "on"
    automatic_https_rewrites = "on"
    min_tls_version          = "1.2"
    tls_1_3                  = "on"
    ssl                      = "strict"
  }
}

# www.rhumbatron.com is a custom domain of the prod web Worker, which redirects it to the apex
# (apps/web/src/server.ts). No zone redirect ruleset (ADR 0017).
