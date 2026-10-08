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

# Worker bundles come from `bun run cf:bundle`. Run it before plan.
locals {
  repo_root = "${path.module}/../../../.."
  bundles   = jsondecode(file("${local.repo_root}/dist/bundles/manifest.json"))
}

module "api_worker" {
  source      = "../../modules/worker"
  account_id  = var.account_id
  component   = "api"
  environment = local.environment

  main_module         = local.bundles.api.main_module
  bundle_sha256       = local.bundles.api.bundle_sha256
  compatibility_date  = local.bundles.api.compatibility_date
  compatibility_flags = local.bundles.api.compatibility_flags
  modules = [for m in local.bundles.api.modules : {
    name         = m.name
    content_file = "${local.repo_root}/${m.content_file}"
    content_type = m.content_type
  }]

  bindings = [
    { type = "plain_text", name = "ENVIRONMENT", text = local.environment },
    { type = "plain_text", name = "SERVICE_NAME", text = "rhumbatron-api-${local.environment}" },
  ]

  custom_domains = [{
    hostname = local.hostnames.api
    zone_id  = module.dns.zone_id
  }]
}

module "web_worker" {
  source      = "../../modules/worker"
  account_id  = var.account_id
  component   = "web"
  environment = local.environment

  main_module         = local.bundles.web.main_module
  bundle_sha256       = local.bundles.web.bundle_sha256
  compatibility_date  = local.bundles.web.compatibility_date
  compatibility_flags = local.bundles.web.compatibility_flags
  assets_directory    = "${local.repo_root}/${local.bundles.web.assets_directory}"
  modules = [for m in local.bundles.web.modules : {
    name         = m.name
    content_file = "${local.repo_root}/${m.content_file}"
    content_type = m.content_type
  }]

  bindings = [
    { type = "plain_text", name = "ENVIRONMENT", text = local.environment },
    { type = "plain_text", name = "SERVICE_NAME", text = "rhumbatron-web-${local.environment}" },
    { type = "plain_text", name = "CLERK_SIGN_IN_URL", text = "/sign-in" },
    { type = "plain_text", name = "CLERK_SIGN_UP_URL", text = "/sign-up" },
    { type = "secret_text", name = "CLERK_SECRET_KEY", text = var.clerk_secret_key },
  ]

  custom_domains = [{
    hostname = local.hostnames.web
    zone_id  = module.dns.zone_id
  }]
}

# D1 schema migrations (AGENTS.md section 11.6). Re-runs when any migration file changes.
# The script applies only unapplied files and is safe to run again.
locals {
  migrations_dir = "${local.repo_root}/migrations/d1"
  migrations_hash = sha256(join(",", [
    for f in sort(fileset(local.migrations_dir, "*.sql")) : "${f}:${filesha256("${local.migrations_dir}/${f}")}"
  ]))
}

resource "terraform_data" "d1_migrations" {
  triggers_replace = {
    database_id     = module.state.d1_database_id
    migrations_hash = local.migrations_hash
  }

  provisioner "local-exec" {
    command = "bun ${local.repo_root}/scripts/d1-migrate.ts"
    # CLOUDFLARE_API_TOKEN is inherited from `bun run tf`; it is never written to state.
    environment = {
      RHUMBATRON_INVOKED_BY = "terraform"
      D1_ACCOUNT_ID         = var.account_id
      D1_DATABASE_ID        = module.state.d1_database_id
    }
  }
}
