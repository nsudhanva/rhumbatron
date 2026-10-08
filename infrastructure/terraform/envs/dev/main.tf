locals {
  environment = "dev"

  # Hostnames for Phase 2 custom domains. One label deep so Universal SSL covers them.
  hostnames = {
    web = "dev.rhumbatron.com"
    api = "api-dev.rhumbatron.com"
  }
}

module "dns" {
  source     = "../../modules/dns"
  account_id = var.account_id
  zone_name  = var.zone_name
}

module "state" {
  source      = "../../modules/state"
  account_id  = var.account_id
  environment = local.environment

  # AGENTS.md section 43.
  evidence_retention_days = {
    events   = 30
    evidence = 30
    tmp      = 7
  }
}

module "async" {
  source      = "../../modules/async"
  account_id  = var.account_id
  environment = local.environment
}

# Vectorize (P1-10) is deferred: provider 5.27 has no resource. See docs/adr/0003.
