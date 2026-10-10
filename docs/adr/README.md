# Decisions

Architecture Decision Records (ADRs) record each decision, its reason and its consequences. Each record keeps its original decision. Later facts go in a dated update.

| ADR | Decision |
|---|---|
| [0001](./0001-repository-tooling.md) | Repository tooling |
| [0002](./0002-clerk-authentication.md) | Clerk for user authentication |
| [0003](./0003-defer-vectorize.md) | Defer the Vectorize index until first-party Terraform support |
| [0004](./0004-resource-organization-and-bootstrap-credentials.md) | Resource organization and bootstrap credentials |
| [0005](./0005-durable-object-worker-deploys.md) | Deploy Durable Object Workers with cloudflare_workers_script |
| [0006](./0006-k2-terraform-adapter.md) | Temporary Terraform adapter for K2 streams |
| [0007](./0007-openrouter-free-models.md) | OpenRouter free models through AI Gateway, Gemini as a capped backup |
| [0008](./0008-change-workflow-and-causal-routing.md) | ChangeWorkflow, Work Graph persistence, and causal routing |
| [0009](./0009-agentdo-pi-harness.md) | AgentDO on the Agents SDK with the Pi Durable harness |
| [0010](./0010-artifacts-project-source.md) | Artifacts as Project source, seeded from fixtures |
| [0011](./0011-sandbox-workspaces.md) | Sandbox workspaces with a prebuilt image and a Terraform-run adapter |
| [0012](./0012-sandbox-worker.md) | Host the Sandbox class in its own Worker, deployed in one upload |
| [0013](./0013-promotion-preconditions.md) | Split promotion preconditions between the integration Worker and ProjectRootDO |
| [0014](./0014-workers-builds-artifacts-connection.md) | Workers Builds connection to an Artifacts repo is a one-time dashboard step |
| [0015](./0015-advisory-claims.md) | Advisory Claims for agent runs |
| [0016](./0016-gemini-overflow.md) | Gemini on Vertex AI as the agents' daily overflow |
| [0017](./0017-prod-environment.md) | Prod environment |
| [0018](./0018-release-via-workers-builds.md) | Release through Workers Builds on Artifacts |
| [0019](./0019-runaway-billing-guards.md) | Runaway-billing guards |
| [0020](./0020-live-apps-dynamic-workers.md) | Live apps on Dynamic Workers |
| [0021](./0021-anthropic-model-provider.md) | Anthropic as the model provider |
| [0022](./0022-empty-repositories.md) | Every Project starts from an empty repository |
| [0023](./0023-shared-projects-and-request-priority.md) | Shared Projects and request priority |
