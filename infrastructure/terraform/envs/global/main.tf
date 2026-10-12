# Account-wide and zone-wide singletons. Exactly one state owns these, so prod's state never
# fights over the shared rhumbatron.com zone.

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

# Runaway-billing backstop (ADR 0019). Cloudflare has no hard spend cap, so the account emails the
# owner when usage-based spend crosses each level. Code guards (alarm-guard.ts, causal caps) are the
# first line; this alert catches anything they miss, in any product. An API adapter
# creates it: provider 5.27 rejects alert_type billing_budget_alert.
locals {
  # Relative to the root module, where Terraform runs local-exec. An absolute path would tie the
  # stored input, and the destroy provisioner that reads it, to one machine.
  repo_root = "../../../.."
}

# The adapter needs the `cf` CLI login of an operator, so CI never applies a change to it (see
# .github/workflows/production.yml). After a behavior change to scripts/budget-alerts.ts, run
# `bun run tf global apply -replace=terraform_data.budget_alerts` on an operator machine.
resource "terraform_data" "budget_alerts" {
  triggers_replace = {
    levels = jsonencode(var.budget_alert_usd)
    email  = sha256(var.alert_email)
  }
  input = {
    repo_root = local.repo_root
  }

  provisioner "local-exec" {
    command = "bun ${self.input.repo_root}/scripts/budget-alerts.ts"
    environment = {
      RHUMBATRON_INVOKED_BY = "terraform"
      BUDGET_MODE           = "sync"
      BUDGET_EMAILS         = var.alert_email
      BUDGET_LEVELS_USD     = jsonencode(var.budget_alert_usd)
    }
  }

  provisioner "local-exec" {
    when    = destroy
    command = "bun ${self.input.repo_root}/scripts/budget-alerts.ts"
    environment = {
      RHUMBATRON_INVOKED_BY = "terraform"
      BUDGET_MODE           = "destroy"
    }
  }
}
