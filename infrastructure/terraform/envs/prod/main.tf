locals {
  environment = "prod"

  # Hostnames for Phase 2 custom domains. One label deep so Universal SSL covers them.
  hostnames = {
    web = "rhumbatron.com"
    api = "api.rhumbatron.com"
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

  # AGENTS.md section 43. Prod keeps Evidence until a retention need is defined.
  evidence_retention_days = {
    events   = 365
    evidence = null
    tmp      = 7
  }
}

module "async" {
  source      = "../../modules/async"
  account_id  = var.account_id
  environment = local.environment
}

# Vectorize (P1-10) is deferred: provider 5.27 has no resource. See docs/adr/0003.
