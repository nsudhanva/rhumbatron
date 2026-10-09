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
  www_hostname = "www.${var.zone_name}"
}

resource "cloudflare_dns_record" "www" {
  zone_id = module.dns.zone_id
  name    = local.www_hostname
  type    = "AAAA"
  content = "100::"
  proxied = true
  ttl     = 1
  comment = "Placeholder for the www -> apex redirect (managed by Terraform, envs/global)"
}

resource "cloudflare_ruleset" "redirects" {
  zone_id     = module.dns.zone_id
  name        = "rhumbatron-redirects-global"
  description = "Zone redirects (managed by Terraform, envs/global)"
  kind        = "zone"
  phase       = "http_request_dynamic_redirect"

  rules = [{
    ref         = "www_to_apex"
    description = "www to apex"
    enabled     = true
    expression  = "(http.host eq \"${local.www_hostname}\")"
    action      = "redirect"
    action_parameters = {
      from_value = {
        status_code           = 301
        preserve_query_string = true
        target_url = {
          expression = "concat(\"https://${var.zone_name}\", http.request.uri.path)"
        }
      }
    }
  }]
}
