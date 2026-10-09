# Prod environment (AGENTS.md section 10, ADR 0017). Mirrors envs/dev resource for resource with
# `-prod` names and prod hostnames. Dev stays inline in its own root, so its state addresses never
# move; keep the two files in step by hand when dev gains a resource or binding.

locals {
  environment = "prod"

  # One label deep so Universal SSL covers them. `www` redirects to the apex (envs/global).
  hostnames = {
    web = "rhumbatron.com"
    api = "api.rhumbatron.com"
  }
}

# Switches. Read ADR 0017 before changing them.
locals {
  # true stops everything that can run on its own (cron sweep, Sandbox starts) while keeping all
  # data. Set to false to resume.
  paused = false

  # First apply only: true breaks the coordinator <-> event router binding cycle and uploads the
  # first Durable Object migrations (v1). After the first successful apply, set false and apply
  # again: that adds the EVENT_ROUTER nudge binding and moves migrations to steady state v1 -> v1.
  bootstrap = false

  # false until the legacy apex record is gone (ADR 0017 cutover). A Worker custom domain cannot
  # take over a hostname that still has its own DNS record, so the web Worker gets the apex only
  # after the cutover. The API on api.rhumbatron.com works before that.
  attach_apex = true
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

# Own gateway, own logs and rate limit; the Vertex cap is per gateway (ADR 0017).
module "ai" {
  source                 = "../../modules/ai"
  account_id             = var.account_id
  environment            = local.environment
  vertex_spend_limit_usd = var.vertex_spend_limit_usd
}

# Vectorize semantic memory (P1-10, P7-05). Provider 5.27 has no Vectorize index resource, so a
# temporary adapter creates it (ADR 0003). 384 dims for Workers AI bge-small-en-v1.5. Free plan:
# 5M stored dimensions = 13,020 vectors; the indexer caps the account at 10,000 vectors in code.
locals {
  vectorize_index = {
    name       = "rhumbatron-memory-${local.environment}"
    dimensions = 384
    metric     = "cosine"
  }
}

# Creates the index if missing and checks its shape. Never deletes on a config change.
resource "terraform_data" "vectorize_index" {
  triggers_replace = { config = jsonencode(local.vectorize_index) }

  provisioner "local-exec" {
    command = "bun ${local.repo_root}/scripts/vectorize-sync.ts"
    environment = {
      RHUMBATRON_INVOKED_BY = "terraform"
      VECTORIZE_MODE        = "sync"
      VECTORIZE_ACCOUNT_ID  = var.account_id
      VECTORIZE_CONFIG      = jsonencode(local.vectorize_index)
    }
  }

  depends_on = [terraform_data.vectorize_index_teardown]
}

# Deletes the index on a real destroy only. Keyed by the name alone. The index holds derived data
# that the indexer rebuilds, so deletion is safe (section 11.4 step 9).
resource "terraform_data" "vectorize_index_teardown" {
  input = {
    account_id = var.account_id
    repo_root  = local.repo_root
    config     = jsonencode({ name = local.vectorize_index.name, dimensions = 0, metric = "cosine" })
  }

  provisioner "local-exec" {
    when    = destroy
    command = "bun ${self.input.repo_root}/scripts/vectorize-sync.ts"
    environment = {
      RHUMBATRON_INVOKED_BY = "terraform"
      VECTORIZE_MODE        = "destroy"
      VECTORIZE_ACCOUNT_ID  = self.input.account_id
      VECTORIZE_CONFIG      = self.input.config
    }
  }
}

# DNS-only records for the Clerk production instance (frontend API, accounts portal, email). Clerk
# rejects proxied records. Empty until the instance exists (ADR 0017).
resource "cloudflare_dns_record" "clerk" {
  for_each = var.clerk_dns_records

  zone_id = module.dns.zone_id
  name    = join(".", [each.key, var.zone_name])
  type    = "CNAME"
  content = each.value
  proxied = false
  ttl     = 1
  comment = "Clerk production instance (managed by Terraform, envs/prod)"
}

# Per-environment caps (ADR 0017). The approved Sandbox (10 h/month, HOM-192) and Browser Run
# (500 s/day) budgets are split evenly between dev and prod; each Worker reads its share from a
# binding and enforces it on this environment's D1 meter. The Vertex cap is per gateway
# (var.vertex_spend_limit_usd) and is mirrored to the Workers for budget-stop and Costs page text.
locals {
  caps = {
    sandbox_monthly_seconds = 18000 # 5 h of the 10 h total
    browser_daily_seconds   = 250   # half of the 500 s guard, under the 600 s free figure
  }
  cap_bindings = {
    sandbox = { type = "plain_text", name = "SANDBOX_MONTHLY_SECONDS", text = tostring(local.caps.sandbox_monthly_seconds) }
    browser = { type = "plain_text", name = "BROWSER_DAILY_SECONDS", text = tostring(local.caps.browser_daily_seconds) }
    vertex  = { type = "plain_text", name = "VERTEX_SPEND_LIMIT_USD", text = tostring(var.vertex_spend_limit_usd) }
  }
}

# Prod temporarily uses the Clerk dev instance (ADR 0017). A warning, not an error, so the plan
# still runs; swap the Keychain items and set clerk_dns_records when the production instance exists.
check "clerk_production_instance" {
  assert {
    condition     = startswith(var.clerk_publishable_key, "pk_live_")
    error_message = "Prod uses a Clerk development key (pk_test_). Replace it with the production instance key and set clerk_dns_records (ADR 0017)."
  }
}

# Worker bundles come from `bun run cf:bundle`. Run it before plan. Bundles are the same for every
# environment; environment config travels in bindings.
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
    # Prod hosts only: no localhost.
    { type = "plain_text", name = "CLERK_AUTHORIZED_PARTIES", text = join(",", var.clerk_authorized_parties) },
    { type = "secret_text", name = "CLERK_SECRET_KEY", text = var.clerk_secret_key },
    # Prod rejects session tokens without azp (no backend-minted smoke tokens).
    { type = "plain_text", name = "CLERK_ALLOW_MISSING_AZP", text = "false" },
    module.state.bindings.DB,
    # Read-only: serves stored check output to the Candidate evidence view.
    module.state.bindings.EVIDENCE,
    { type = "durable_object_namespace", name = "PROJECT_ROOT", class_name = "ProjectRootDO", script_name = module.coordinator_worker.name },
    { type = "durable_object_namespace", name = "PROJECT_VIEW", class_name = "ProjectViewDO", script_name = module.coordinator_worker.name },
    # Sandbox smoke check RPC on the agents Worker (AGENTS.md section 49.3).
    { type = "service", name = "AGENTS", service = module.agents_worker.name, environment = "production" },
    # Approval and promotion RPC on the integration Worker (AGENTS.md section 36, ADR 0013).
    { type = "service", name = "INTEGRATION", service = module.integration_worker.name, environment = "production" },
    # Project source provisioning commands (ADR 0010).
    { type = "queue", name = "INTEGRATION_COMMANDS", queue_name = module.async.queues["integration"].name },
    # Dead-letter retry sends an `agent.wake` back to its original Queue (section 42.7).
    { type = "queue", name = "AGENT_WAKEUPS", queue_name = module.async.queues["agent-wakeups"].name },
    # Starts one ChangeWorkflow per Change (AGENTS.md section 21.1).
    { type = "workflow", name = "CHANGE_WORKFLOW", workflow_name = cloudflare_workflow.change.workflow_name, class_name = "ChangeWorkflow", script_name = module.integration_worker.name },
    # Wishlist design-conflict fixture routes for the section 55 demo (ADR 0017).
    { type = "plain_text", name = "FIXTURES_ENABLED", text = "true" },
    # The Costs page shows this environment's caps (ADR 0017).
    local.cap_bindings.sandbox,
    local.cap_bindings.vertex,
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
    # The bundle inlines the development key at build time. Clerk reads process.env before the
    # inlined value, so this runtime var selects the instance. Temporarily the dev instance's key
    # until the production instance exists (ADR 0017; check "clerk_production_instance" warns).
    { type = "plain_text", name = "VITE_CLERK_PUBLISHABLE_KEY", text = var.clerk_publishable_key },
    { type = "secret_text", name = "CLERK_SECRET_KEY", text = var.clerk_secret_key },
    # Server functions call the API over this binding; the browser never calls it directly.
    { type = "service", name = "API", service = module.api_worker.name, environment = "production" },
  ]

  # The apex serves the app; www redirects to it in the Worker (apps/web/src/server.ts).
  custom_domains = local.attach_apex ? [
    { hostname = local.hostnames.web, zone_id = module.dns.zone_id },
    { hostname = "www.${local.hostnames.web}", zone_id = module.dns.zone_id },
  ] : []
}

# K2 event streams (AGENTS.md section 19). Provider 5.27 has no K2 resource, so a temporary
# adapter creates them (ADR 0006). Names allow only letters, digits, and underscores.
locals {
  k2_config = {
    streams = [for i in range(8) : {
      name              = format("rhumbatron_events_%02d_%s", i, local.environment)
      retention_seconds = 604800 # 7 days
    }]
    subscriptions = ["causal-router", "project-view-projector", "audit-archiver", "analytics-projector"]
  }
  k2_stream_names = [for s in local.k2_config.streams : s.name]

  # K2 beta: 20 streams per account, shared with dev (8) and any other project (ADR 0017).
  k2_account_stream_limit = 20
  k2_account_streams      = compact(split(",", data.external.k2_inventory.result.names))
  k2_other_streams        = [for n in local.k2_account_streams : n if !contains(local.k2_stream_names, n)]
}

# Read at plan time, so an over-limit stream set fails the plan before anything is created.
data "external" "k2_inventory" {
  program = ["bun", "${local.repo_root}/scripts/k2-read.ts"]
  query   = { account_id = var.account_id, mode = "inventory" }
}

resource "terraform_data" "k2_streams" {
  triggers_replace = { config = jsonencode(local.k2_config) }

  lifecycle {
    precondition {
      condition     = length(local.k2_other_streams) + length(local.k2_stream_names) <= local.k2_account_stream_limit
      error_message = "K2 account limit: ${length(local.k2_other_streams)} other streams exist; ${length(local.k2_stream_names)} more for prod would exceed ${local.k2_account_stream_limit}."
    }
  }

  provisioner "local-exec" {
    command = "bun ${local.repo_root}/scripts/k2-sync.ts"
    environment = {
      RHUMBATRON_INVOKED_BY = "terraform"
      K2_ACCOUNT_ID         = var.account_id
      K2_CONFIG             = jsonencode(local.k2_config)
    }
  }
}

# Deferred to apply time by depends_on, so a fresh environment works in one apply.
data "external" "k2_streams" {
  program    = ["bun", "${local.repo_root}/scripts/k2-read.ts"]
  query      = { account_id = var.account_id, names = join(",", local.k2_stream_names) }
  depends_on = [terraform_data.k2_streams]
}

# Strong coordination Durable Objects (AGENTS.md section 12.3). SQLite-backed.
module "coordinator_worker" {
  source      = "../../modules/durable-worker"
  account_id  = var.account_id
  component   = "coordinator"
  environment = local.environment

  main_module         = local.bundles.coordinator.main_module
  compatibility_date  = local.bundles.coordinator.compatibility_date
  compatibility_flags = local.bundles.coordinator.compatibility_flags
  modules = [for m in local.bundles.coordinator.modules : {
    name         = m.name
    content_file = "${local.repo_root}/${m.content_file}"
    content_type = m.content_type
  }]

  bindings = concat(
    [
      { type = "plain_text", name = "ENVIRONMENT", text = local.environment },
      { type = "plain_text", name = "SERVICE_NAME", text = "rhumbatron-coordinator-${local.environment}" },
      { type = "durable_object_namespace", name = "PROJECT_ROOT", class_name = "ProjectRootDO" },
      { type = "durable_object_namespace", name = "RESOURCE_SHARD", class_name = "ResourceShardDO" },
      { type = "durable_object_namespace", name = "PROJECT_VIEW", class_name = "ProjectViewDO" },
    ],
    # Nudges the event router right after a publish (low-latency consume). Omitted while
    # bootstrapping: the router binds this Worker's class, so it can only exist after this Worker.
    local.bootstrap ? [] : [
      { type = "service", name = "EVENT_ROUTER", service = "rhumbatron-event-router-${local.environment}" },
    ],
    # Outbox publishers produce to EVENTS_00..EVENTS_07; a project hashes to one stream.
    [for i, name in local.k2_stream_names : {
      type   = "k2"
      name   = format("EVENTS_%02d", i)
      stream = data.external.k2_streams.result[name]
    }],
  )

  # ADR 0005: a transition from the live tag to the target tag. The first apply creates v1;
  # after it, steady state is v1 -> v1. To add a class later: old_tag = "v1", new_tag = "v2",
  # new_sqlite_classes = [...], and the same v2 entry in wrangler.jsonc (as in dev).
  migrations = {
    old_tag            = local.bootstrap ? null : "v1"
    new_tag            = "v1"
    new_sqlite_classes = local.bootstrap ? ["ProjectRootDO", "ResourceShardDO", "ProjectViewDO"] : null
  }
}

# K2 consumer: pulls events, deduplicates, projects into ProjectViewDO (AGENTS.md section 12.5).
# Fast path: the coordinator nudges it after each publish. Safety net: a 1-minute cron sweep.
module "event_router_worker" {
  source      = "../../modules/worker"
  account_id  = var.account_id
  component   = "event-router"
  environment = local.environment

  main_module         = local.bundles["event-router"].main_module
  bundle_sha256       = local.bundles["event-router"].bundle_sha256
  compatibility_date  = local.bundles["event-router"].compatibility_date
  compatibility_flags = local.bundles["event-router"].compatibility_flags
  modules = [for m in local.bundles["event-router"].modules : {
    name         = m.name
    content_file = "${local.repo_root}/${m.content_file}"
    content_type = m.content_type
  }]

  bindings = [
    { type = "plain_text", name = "ENVIRONMENT", text = local.environment },
    { type = "plain_text", name = "SERVICE_NAME", text = "rhumbatron-event-router-${local.environment}" },
    { type = "plain_text", name = "K2_STREAM_IDS", text = jsonencode([for n in local.k2_stream_names : data.external.k2_streams.result[n]]) },
    { type = "secret_text", name = "K2_CONSUMER_TOKEN", text = var.k2_consumer_token },
    module.state.bindings.DB,
    # Audit archive target: events/ prefix, expired by the R2 lifecycle rule (365 days in prod).
    module.state.bindings.EVIDENCE,
    # Literal name (not a module output) avoids a cycle: the coordinator binds back to this Worker.
    { type = "durable_object_namespace", name = "PROJECT_VIEW", class_name = "ProjectViewDO", script_name = "rhumbatron-coordinator-${local.environment}" },
    # Dead-letter consumer records `task.failed` through the Change's shard outbox (section 42.7).
    { type = "durable_object_namespace", name = "RESOURCE_SHARD", class_name = "ResourceShardDO", script_name = "rhumbatron-coordinator-${local.environment}" },
    # Causal Router (AGENTS.md section 31): wake commands, ready-task dispatch, Clef-flash.
    { type = "queue", name = "AGENT_WAKEUPS", queue_name = module.async.queues["agent-wakeups"].name },
    { type = "queue", name = "INTEGRATION_COMMANDS", queue_name = module.async.queues["integration"].name },
    # `index.build` on a new canonical tree, `index.purge` for archived Projects (section 12.7).
    { type = "queue", name = "INDEXING", queue_name = module.async.queues["indexing"].name },
    # Workers AI for Clef-flash only, capped at 200 calls per day in code (rule 50).
    { type = "ai", name = "AI" },
  ]

  # Binds the coordinator's ProjectViewDO class, which must exist first.
  depends_on = [module.coordinator_worker]

  # Paused: no safety-net sweep; publish nudges still deliver events.
  cron_schedules = local.paused ? [] : ["* * * * *"]
}

# Candidate, verification, and Change orchestration (AGENTS.md section 12.6).
module "integration_worker" {
  source      = "../../modules/worker"
  account_id  = var.account_id
  component   = "integration"
  environment = local.environment

  main_module         = local.bundles.integration.main_module
  bundle_sha256       = local.bundles.integration.bundle_sha256
  compatibility_date  = local.bundles.integration.compatibility_date
  compatibility_flags = local.bundles.integration.compatibility_flags
  modules = [for m in local.bundles.integration.modules : {
    name         = m.name
    content_file = "${local.repo_root}/${m.content_file}"
    content_type = m.content_type
  }]

  bindings = [
    { type = "plain_text", name = "ENVIRONMENT", text = local.environment },
    { type = "plain_text", name = "SERVICE_NAME", text = "rhumbatron-integration-${local.environment}" },
    module.state.bindings.DB,
    module.state.bindings.EVIDENCE,
    { type = "queue", name = "AGENT_WAKEUPS", queue_name = module.async.queues["agent-wakeups"].name },
    { type = "durable_object_namespace", name = "RESOURCE_SHARD", class_name = "ResourceShardDO", script_name = module.coordinator_worker.name },
    { type = "durable_object_namespace", name = "PROJECT_ROOT", class_name = "ProjectRootDO", script_name = module.coordinator_worker.name },
    # Candidate composition and checks run in the Project Sandbox (ADR 0012).
    { type = "durable_object_namespace", name = "SANDBOX", class_name = "Sandbox", script_name = local.sandbox_worker.script_name },
    # Self-binding to CandidateVerificationWorkflow (literal name avoids a cycle with the resource).
    { type = "workflow", name = "CANDIDATE_WORKFLOW", workflow_name = "rhumbatron-candidate-verification-${local.environment}", class_name = "CandidateVerificationWorkflow" },
    # One Artifacts repo per Project; the namespace is created on first use (ADR 0010).
    { type = "artifacts", name = "ARTIFACTS", namespace = "rhumbatron-projects-${local.environment}" },
    # Models go through the AI Gateway (ADR 0007): OpenRouter free models, Vertex AI backup.
    { type = "plain_text", name = "AI_ACCOUNT_ID", text = var.account_id },
    { type = "plain_text", name = "AI_GATEWAY_ID", text = module.ai.gateway_id },
    { type = "secret_text", name = "OPENROUTER_API_KEY", text = var.openrouter_api_key },
    { type = "secret_text", name = "VERTEX_SERVICE_ACCOUNT", text = var.vertex_service_account },
    { type = "plain_text", name = "MODEL_PROVIDER", text = var.model_provider },
    # Browser Run for the Candidate browser check (AGENTS.md section 35). Capped in code: one
    # session of at most 55 s per check, 2 per Candidate, BROWSER_DAILY_SECONDS per UTC day (D1).
    { type = "browser", name = "BROWSER" },
    local.cap_bindings.browser,
    local.cap_bindings.sandbox,
  ]

  depends_on = [terraform_data.sandbox_worker]
}

# Workflows: a Change uses about 7 steps.
resource "cloudflare_workflow" "change" {
  account_id    = var.account_id
  workflow_name = "rhumbatron-change-workflow-${local.environment}"
  class_name    = "ChangeWorkflow"
  script_name   = module.integration_worker.name
}

# AGENTS.md section 21.2. One instance per Candidate; about 10 to 14 steps per Candidate.
resource "cloudflare_workflow" "candidate_verification" {
  account_id    = var.account_id
  workflow_name = "rhumbatron-candidate-verification-${local.environment}"
  class_name    = "CandidateVerificationWorkflow"
  script_name   = module.integration_worker.name
}

# Agent Plane (AGENTS.md section 12.4): wake consumer plus AgentDO running Pi (ADR 0009).
module "agents_worker" {
  source      = "../../modules/durable-worker"
  account_id  = var.account_id
  component   = "agents"
  environment = local.environment

  main_module         = local.bundles.agents.main_module
  compatibility_date  = local.bundles.agents.compatibility_date
  compatibility_flags = local.bundles.agents.compatibility_flags
  modules = [for m in local.bundles.agents.modules : {
    name         = m.name
    content_file = "${local.repo_root}/${m.content_file}"
    content_type = m.content_type
  }]

  bindings = [
    { type = "plain_text", name = "ENVIRONMENT", text = local.environment },
    { type = "plain_text", name = "SERVICE_NAME", text = "rhumbatron-agents-${local.environment}" },
    module.state.bindings.DB,
    { type = "durable_object_namespace", name = "AGENT", class_name = "AgentDO" },
    # One Sandbox container per Project; a directory per Task (ADR 0011).
    { type = "durable_object_namespace", name = "SANDBOX", class_name = "Sandbox", script_name = local.sandbox_worker.script_name },
    { type = "durable_object_namespace", name = "PROJECT_ROOT", class_name = "ProjectRootDO", script_name = module.coordinator_worker.name },
    # Read-only canonical source for agent file tools (ADR 0010).
    { type = "artifacts", name = "ARTIFACTS", namespace = "rhumbatron-projects-${local.environment}" },
    # Context Packet snapshots under context/ (AGENTS.md section 27.5).
    module.state.bindings.EVIDENCE,
    { type = "durable_object_namespace", name = "RESOURCE_SHARD", class_name = "ResourceShardDO", script_name = module.coordinator_worker.name },
    # Analytics Engine datasets are created on first write. Wakeups, model calls, run outcomes.
    { type = "analytics_engine", name = "METRICS", dataset = "rhumbatron_metrics_${local.environment}" },
    # Models through the AI Gateway (ADR 0007); Workers AI only for Clef-flash, capped per day.
    { type = "plain_text", name = "AI_ACCOUNT_ID", text = var.account_id },
    { type = "plain_text", name = "AI_GATEWAY_ID", text = module.ai.gateway_id },
    { type = "secret_text", name = "OPENROUTER_API_KEY", text = var.openrouter_api_key },
    # Gemini overflow when OpenRouter is used up for the day; spend capped by the gateway (ADR 0016).
    { type = "secret_text", name = "VERTEX_SERVICE_ACCOUNT", text = var.vertex_service_account },
    { type = "plain_text", name = "MODEL_PROVIDER", text = var.model_provider },
    { type = "ai", name = "AI" },
    local.cap_bindings.sandbox,
    local.cap_bindings.vertex,
    # Semantic memory, read-only: one top-k query per agent run, capped at 1,000 per day (P7-06).
    { type = "vectorize", name = "MEMORY", index_name = local.vectorize_index.name },
  ]

  # First apply creates v1 (AgentDO); then steady state v1 -> v1. The Sandbox class lives in its
  # own Worker (ADR 0012).
  migrations = {
    old_tag            = local.bootstrap ? null : "v1"
    new_tag            = "v1"
    new_sqlite_classes = local.bootstrap ? ["AgentDO"] : null
  }

  # The SANDBOX binding needs the Sandbox Worker and its class to exist first; MEMORY its index.
  depends_on = [terraform_data.sandbox_worker, terraform_data.vectorize_index]
}

# Indexer (AGENTS.md section 12.7, Phase 7): exact symbol and dependency indexes, the Product Graph
# store, and Vectorize file summaries, once per canonical tree. Queue-driven only: no cron, no
# public route. Per build: about 5 Artifacts operations, 3 R2 writes, 1 Workers AI batch.
module "indexer_worker" {
  source      = "../../modules/worker"
  account_id  = var.account_id
  component   = "indexer"
  environment = local.environment

  main_module         = local.bundles.indexer.main_module
  bundle_sha256       = local.bundles.indexer.bundle_sha256
  compatibility_date  = local.bundles.indexer.compatibility_date
  compatibility_flags = local.bundles.indexer.compatibility_flags
  modules = [for m in local.bundles.indexer.modules : {
    name         = m.name
    content_file = "${local.repo_root}/${m.content_file}"
    content_type = m.content_type
  }]

  bindings = [
    { type = "plain_text", name = "ENVIRONMENT", text = local.environment },
    { type = "plain_text", name = "SERVICE_NAME", text = "rhumbatron-indexer-${local.environment}" },
    module.state.bindings.DB,
    # Reads source/<project>/<tree>/index.json; writes index/<project>/... (no lifecycle expiry).
    module.state.bindings.EVIDENCE,
    # Current canonical tree: only that tree is indexed.
    { type = "durable_object_namespace", name = "PROJECT_ROOT", class_name = "ProjectRootDO", script_name = module.coordinator_worker.name },
    # Read-only canonical source: one read token per build (ADR 0010).
    { type = "artifacts", name = "ARTIFACTS", namespace = "rhumbatron-projects-${local.environment}" },
    { type = "vectorize", name = "MEMORY", index_name = local.vectorize_index.name },
    # Embeddings only (bge-small-en-v1.5), capped at 2,000 texts per day in code (rule 50).
    { type = "ai", name = "AI" },
    { type = "analytics_engine", name = "METRICS", dataset = "rhumbatron_metrics_${local.environment}" },
  ]

  depends_on = [terraform_data.vectorize_index]
}

# Sandbox Worker (ADR 0012): hosts the Sandbox container class through the temporary adapter.
# Caps (HOM-192), per environment: 1 instance, sleeps after 2 minutes idle (in code), 5-hour
# monthly meter in this environment's D1 (local.caps; dev has the other 5 h, ADR 0017).
locals {
  sandbox_worker = {
    script_name         = "rhumbatron-sandbox-${local.environment}"
    app_name            = "rhumbatron-sandbox-${local.environment}"
    class_name          = "Sandbox"
    image               = "docker.io/cloudflare/sandbox:0.12.6"
    instance_type       = "basic"
    max_instances       = local.paused ? 0 : 1
    compatibility_date  = local.bundles.sandbox.compatibility_date
    compatibility_flags = local.bundles.sandbox.compatibility_flags
    main_module         = local.bundles.sandbox.main_module
    modules             = local.bundles.sandbox.modules
    bundle_sha256       = local.bundles.sandbox.bundle_sha256
  }
}

# Deploys on any config or bundle change (an in-place update of the Worker and container app).
# No destroy provisioner here: a replacement must never delete the live Worker (ADR 0012).
resource "terraform_data" "sandbox_worker" {
  triggers_replace = { config = jsonencode(local.sandbox_worker) }
  input = {
    account_id = var.account_id
    repo_root  = local.repo_root
    config     = jsonencode(local.sandbox_worker)
  }

  provisioner "local-exec" {
    command = "bun ${self.input.repo_root}/scripts/sandbox-deploy.ts"
    environment = {
      RHUMBATRON_INVOKED_BY = "terraform"
      SANDBOX_MODE          = "deploy"
      SANDBOX_ACCOUNT_ID    = self.input.account_id
      SANDBOX_REPO_ROOT     = self.input.repo_root
      SANDBOX_CONFIG        = self.input.config
    }
  }

  depends_on = [terraform_data.sandbox_worker_teardown]
}

# Deletes the container application and the Sandbox Worker on a real destroy only. Keyed by the
# names alone, so bundle and size changes never replace it.
resource "terraform_data" "sandbox_worker_teardown" {
  input = {
    account_id = var.account_id
    repo_root  = local.repo_root
    config = jsonencode({
      script_name = local.sandbox_worker.script_name
      app_name    = local.sandbox_worker.app_name
    })
  }

  provisioner "local-exec" {
    when    = destroy
    command = "bun ${self.input.repo_root}/scripts/sandbox-deploy.ts"
    environment = {
      RHUMBATRON_INVOKED_BY = "terraform"
      SANDBOX_MODE          = "destroy"
      SANDBOX_ACCOUNT_ID    = self.input.account_id
      SANDBOX_REPO_ROOT     = self.input.repo_root
      SANDBOX_CONFIG        = self.input.config
    }
  }
}

# Release target for the Acme Shop demo Project (AGENTS.md section 37, ADR 0014). Terraform owns
# the Worker; Workers Builds owns its versions after the one-time dashboard connection.
resource "cloudflare_worker" "acme_shop" {
  account_id = var.account_id
  name       = "rhumbatron-acme-shop-${local.environment}"

  subdomain = {
    enabled          = true
    previews_enabled = false
  }

  observability = {
    enabled = true
    logs = {
      enabled            = true
      invocation_logs    = true
      head_sampling_rate = 1
    }
  }
}

# One consumer for all wake commands. Poison commands go to the dead-letter Queue (section 42.7).
resource "cloudflare_queue_consumer" "agent_wakeups" {
  account_id        = var.account_id
  queue_id          = module.async.queues["agent-wakeups"].id
  script_name       = module.agents_worker.name
  type              = "worker"
  dead_letter_queue = module.async.queues["dead-letter"].name
  settings = {
    batch_size       = 10
    max_retries      = 3
    max_wait_time_ms = 1000
    retry_delay      = 30
  }
}

# `change.dispatch` commands from the Causal Router to the integration Worker.
resource "cloudflare_queue_consumer" "integration" {
  account_id        = var.account_id
  queue_id          = module.async.queues["integration"].id
  script_name       = module.integration_worker.name
  type              = "worker"
  dead_letter_queue = module.async.queues["dead-letter"].name
  settings = {
    batch_size       = 10
    max_retries      = 3
    max_wait_time_ms = 1000
    retry_delay      = 30
  }
}

# Index commands to the indexer. No dead-letter Queue: the dead-letter consumer retries commands on
# the integration Queue only, so the indexer records a build's last failed delivery in D1
# `project_indexes` itself. Queues: about 3 operations per index command.
resource "cloudflare_queue_consumer" "indexing" {
  account_id  = var.account_id
  queue_id    = module.async.queues["indexing"].id
  script_name = module.indexer_worker.name
  type        = "worker"
  # One build per invocation and one invocation at a time: about 25 subrequests each (under the
  # 50 of Workers Free), and builds of one Project never race on its vector manifest.
  settings = {
    batch_size       = 1
    max_concurrency  = 1
    max_retries      = 3
    max_wait_time_ms = 1000
    retry_delay      = 30
  }
}

# Poison commands (AGENTS.md section 42.7): the event router records each one in D1 and blocks its
# Task. No dead-letter Queue of its own; a storage failure retries 5 times, then is logged.
resource "cloudflare_queue_consumer" "dead_letter" {
  account_id  = var.account_id
  queue_id    = module.async.queues["dead-letter"].id
  script_name = module.event_router_worker.name
  type        = "worker"
  settings = {
    batch_size       = 5
    max_retries      = 5
    max_wait_time_ms = 1000
    retry_delay      = 60
  }
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
