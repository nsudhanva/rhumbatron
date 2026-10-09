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

module "ai" {
  source      = "../../modules/ai"
  account_id  = var.account_id
  environment = local.environment
}

# Vectorize (P1-10) is deferred: provider 5.27 has no resource. See docs/adr/0003.

# Pause switch: true stops everything that can run on its own (cron sweep, Sandbox starts) while
# keeping all data. Set to false to resume.
locals {
  paused = false
  # Fresh environment only: true breaks the coordinator <-> event router binding cycle for the first
  # apply (the cron sweep still delivers events); set false and apply again to add the nudge.
  bootstrap = false
}

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
    { type = "plain_text", name = "CLERK_AUTHORIZED_PARTIES", text = "https://${local.hostnames.web},http://localhost:5173" },
    { type = "secret_text", name = "CLERK_SECRET_KEY", text = var.clerk_secret_key },
    # Dev only: accept backend-minted smoke-test tokens without azp. Prod must set "false".
    { type = "plain_text", name = "CLERK_ALLOW_MISSING_AZP", text = "true" },
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
    # Starts one ChangeWorkflow per Change (AGENTS.md section 21.1).
    { type = "workflow", name = "CHANGE_WORKFLOW", workflow_name = cloudflare_workflow.change.workflow_name, class_name = "ChangeWorkflow", script_name = module.integration_worker.name },
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
    # Server functions call the API over this binding; the browser never calls it directly.
    { type = "service", name = "API", service = module.api_worker.name, environment = "production" },
  ]

  custom_domains = [{
    hostname = local.hostnames.web
    zone_id  = module.dns.zone_id
  }]
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
}

resource "terraform_data" "k2_streams" {
  triggers_replace = { config = jsonencode(local.k2_config) }

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

# Strong coordination Durable Objects (AGENTS.md section 12.3). SQLite-backed, Workers Free.
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


  # Durable Object migrations are a transition from the live tag (old_tag) to the target (new_tag).
  # v1 (ProjectRootDO, ResourceShardDO, ProjectViewDO as SQLite classes) is applied, so steady
  # state is v1 -> v1. To add a class: old_tag = "v1", new_tag = "v2", new_sqlite_classes = [...],
  # and add the same v2 entry to wrangler.jsonc. A fresh environment starts from
  # { new_tag = "v1", new_sqlite_classes = [...] } (ADR 0005).
  migrations = {
    old_tag = "v1"
    new_tag = "v1"
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
    # Audit archive target: events/ prefix, expired by the R2 lifecycle rule (30 days in dev).
    module.state.bindings.EVIDENCE,
    # Literal name (not a module output) avoids a cycle: the coordinator binds back to this Worker.
    { type = "durable_object_namespace", name = "PROJECT_VIEW", class_name = "ProjectViewDO", script_name = "rhumbatron-coordinator-${local.environment}" },
    # Causal Router (AGENTS.md section 31): wake commands, ready-task dispatch, Clef-flash.
    { type = "queue", name = "AGENT_WAKEUPS", queue_name = module.async.queues["agent-wakeups"].name },
    { type = "queue", name = "INTEGRATION_COMMANDS", queue_name = module.async.queues["integration"].name },
    # Workers AI for Clef-flash only, capped at 200 calls per day in code (rule 50).
    { type = "ai", name = "AI" },
  ]

  # Paused: no safety-net sweep; publish nudges still deliver events.
  # Binds the coordinator's ProjectViewDO class, which must exist first.
  depends_on = [module.coordinator_worker]

  cron_schedules = local.paused ? [] : ["* * * * *"]
}

# Candidate, verification, and Change orchestration (AGENTS.md section 12.6). Phase 5 runs
# ChangeWorkflow: Root Planner, Task persistence, ready-task dispatch.
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
    # Browser Run for the Candidate browser check (AGENTS.md section 35). Capped in code: one
    # session of at most 55 s per check, 2 per Candidate, 500 browser-seconds per UTC day (D1).
    { type = "browser", name = "BROWSER" },
  ]

  depends_on = [terraform_data.sandbox_worker]
}

# Workflows free plan: 3,000 steps per day. A Change uses about 7 steps.
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
    { type = "ai", name = "AI" },
  ]

  # v1 (AgentDO) is applied, so steady state is v1 -> v1. The Sandbox class lives in its own
  # Worker (ADR 0012).
  migrations = {
    old_tag = "v1"
    new_tag = "v1"
  }

  # The SANDBOX binding needs the Sandbox Worker and its class to exist first.
  depends_on = [terraform_data.sandbox_worker]
}

# Sandbox Worker (ADR 0012): hosts the Sandbox container class. Provider 5.27 cannot attach a
# container to a Durable Object class, so a temporary adapter deploys it in one upload (code,
# migration, container metadata) and creates the container application, as Wrangler does. It
# changes only when the Sandbox SDK bundle or its settings change. Caps (HOM-192): 1 instance,
# sleeps after 2 minutes idle (in code), 10-hour monthly meter in the agents Worker.
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

# Release target for the Acme Shop demo Project (AGENTS.md section 37, P11-07). Terraform owns the
# Worker; Workers Builds owns its versions: each promotion pushes canonical main, and the build
# deploys it (a Rhumbatron-triggered release is runtime data, section 2.1). The Builds connection
# to the Artifacts repo is a one-time dashboard step (ADR 0014).
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
