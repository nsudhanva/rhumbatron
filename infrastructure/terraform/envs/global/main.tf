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

# www.rhumbatron.com -> https://rhumbatron.com (ADR 0017). The zone's dynamic-redirect entrypoint
# is a zone-wide singleton, so global owns it. The proxied placeholder record only lets Cloudflare
# receive www requests; the redirect answers them before any origin. Single Redirects are free.
locals {
}

# www.rhumbatron.com is a custom domain of the prod web Worker, which redirects it to the apex
# (apps/web/src/server.ts). No zone redirect ruleset (ADR 0017).
